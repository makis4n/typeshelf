import type { Book } from '../../src/book/types';

/** Stores the cleaned book as a JSON string, keyed by Gutenberg id. */
export interface BookCache {
  get(id: number): Promise<string | null>;
  put(id: number, json: string): Promise<void>;
}

/** Where raw book text comes from. */
export interface BookSource {
  /** Resolves to the raw text, or `null` when no such book exists. Rejects on upstream failure. */
  fetchText(id: number): Promise<string | null>;
}

export interface CatalogueEntry {
  id: number;
  title: string;
  author: string;
  language: string;
}

export interface Catalogue {
  search(query: string, limit: number): Promise<CatalogueEntry[]>;
}

export interface Deps {
  cache: BookCache;
  source: BookSource;
  catalogue: Catalogue;
  /** Converts raw Gutenberg text into a `Book`. Rejects when the text cannot be cleaned. */
  clean: (raw: string, id: number) => Promise<Book>;
  allowedOrigins: string[];
}

const MAX_QUERY_LENGTH = 100;
const SEARCH_LIMIT = 20;
const BOOK_CACHE_CONTROL = 'public, max-age=86400, immutable';
const SEARCH_CACHE_CONTROL = 'public, max-age=300';

type LoadResult = { ok: true; json: string } | { ok: false; status: 404 | 422 | 502; error: string };

// One upstream fetch per id per isolate, however many requests miss at once.
const inFlight = new Map<number, Promise<LoadResult>>();

function corsHeaders(request: Request, deps: Deps): Record<string, string> {
  const headers: Record<string, string> = { vary: 'origin' };
  const origin = request.headers.get('origin');
  if (origin !== null && deps.allowedOrigins.includes(origin)) {
    headers['access-control-allow-origin'] = origin;
  }
  return headers;
}

function json(body: string, status: number, extra: Record<string, string>): Response {
  return new Response(body, {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...extra },
  });
}

function errorResponse(status: number, error: string, cors: Record<string, string>): Response {
  return json(JSON.stringify({ error }), status, { ...cors, 'cache-control': 'no-store' });
}

async function loadFromUpstream(id: number, deps: Deps): Promise<LoadResult> {
  let raw: string | null;
  try {
    raw = await deps.source.fetchText(id);
  } catch {
    return { ok: false, status: 502, error: 'Upstream fetch failed' };
  }
  if (raw === null) return { ok: false, status: 404, error: 'Book not found' };

  let serialized: string;
  try {
    serialized = JSON.stringify(await deps.clean(raw, id));
  } catch {
    return { ok: false, status: 422, error: 'Book could not be cleaned' };
  }

  // A failed write only costs a refetch next time, so it must not fail the request.
  try {
    await deps.cache.put(id, serialized);
  } catch {
    // ignored on purpose
  }
  return { ok: true, json: serialized };
}

function load(id: number, deps: Deps): Promise<LoadResult> {
  const existing = inFlight.get(id);
  if (existing) return existing;
  const started = loadFromUpstream(id, deps).finally(() => inFlight.delete(id));
  inFlight.set(id, started);
  return started;
}

async function handleBook(rawId: string, deps: Deps, cors: Record<string, string>): Promise<Response> {
  if (!/^[1-9]\d{0,6}$/.test(rawId)) {
    return errorResponse(400, 'Book id must be a positive integer of up to 7 digits', cors);
  }
  const id = Number(rawId);
  const headers = { ...cors, 'cache-control': BOOK_CACHE_CONTROL };

  let cached: string | null = null;
  try {
    cached = await deps.cache.get(id);
  } catch {
    // A broken cache read falls through to a fresh fetch.
  }
  if (cached !== null) return json(cached, 200, headers);

  const result = await load(id, deps);
  if (!result.ok) return errorResponse(result.status, result.error, cors);
  return json(result.json, 200, headers);
}

async function handleSearch(url: URL, deps: Deps, cors: Record<string, string>): Promise<Response> {
  const q = (url.searchParams.get('q') ?? '').trim();
  if (q === '') return errorResponse(400, 'Query parameter q is required', cors);
  if (q.length > MAX_QUERY_LENGTH) {
    return errorResponse(400, `Query parameter q must be at most ${MAX_QUERY_LENGTH} characters`, cors);
  }
  let results: CatalogueEntry[];
  try {
    results = await deps.catalogue.search(q, SEARCH_LIMIT);
  } catch {
    return errorResponse(502, 'Catalogue search failed', cors);
  }
  return json(JSON.stringify(results), 200, { ...cors, 'cache-control': SEARCH_CACHE_CONTROL });
}

/**
 * Handles one book-service request.
 *
 * @param request Incoming request.
 * @param deps Injected cache, upstream source, catalogue, cleaner and CORS allow-list.
 * @returns The response; never rejects for expected failures, which become JSON `{ error }`.
 */
export async function handle(request: Request, deps: Deps): Promise<Response> {
  const cors = corsHeaders(request, deps);

  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        ...cors,
        'access-control-allow-methods': 'GET, OPTIONS',
        'access-control-allow-headers': 'content-type',
        'access-control-max-age': '86400',
      },
    });
  }
  if (request.method !== 'GET') {
    return errorResponse(405, 'Method not allowed', { ...cors, allow: 'GET, OPTIONS' });
  }

  const url = new URL(request.url);
  if (url.pathname === '/health') {
    return new Response('ok', {
      status: 200,
      headers: { ...cors, 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
    });
  }
  if (url.pathname === '/search') return handleSearch(url, deps, cors);
  const match = /^\/books\/([^/]+)$/.exec(url.pathname);
  if (match) return handleBook(match[1], deps, cors);
  return errorResponse(404, 'Not found', cors);
}
