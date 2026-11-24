import { describe, expect, it } from 'vitest';
import type { Book } from '../../src/book/types';
import { handle, type CatalogueEntry, type Deps } from './service';

const ORIGIN = 'http://localhost:5173';

function makeBook(id: number): Book {
  return {
    id: `gutenberg:${id}`,
    title: `Book ${id}`,
    author: 'Someone',
    language: 'en',
    source: 'gutenberg',
    fingerprint: 'abc',
    chapters: [{ title: 'One', paragraphs: ['Hello.'] }],
  };
}

interface Fakes {
  deps: Deps;
  store: Map<number, string>;
  fetchCalls: number[];
  searchCalls: { query: string; limit: number }[];
}

function setup(overrides: Partial<Deps> = {}, opts: { missing?: number[]; delay?: boolean } = {}): Fakes {
  const store = new Map<number, string>();
  const fetchCalls: number[] = [];
  const searchCalls: { query: string; limit: number }[] = [];
  const deps: Deps = {
    cache: {
      get: async (id) => store.get(id) ?? null,
      put: async (id, json) => void store.set(id, json),
    },
    source: {
      fetchText: async (id) => {
        fetchCalls.push(id);
        if (opts.delay) await new Promise((r) => setTimeout(r, 5));
        return opts.missing?.includes(id) ? null : `raw ${id}`;
      },
    },
    catalogue: {
      search: async (query, limit): Promise<CatalogueEntry[]> => {
        searchCalls.push({ query, limit });
        return [{ id: 1, title: 'T', author: 'A', language: 'en' }];
      },
    },
    clean: async (_raw, id) => makeBook(id),
    allowedOrigins: [ORIGIN],
    ...overrides,
  };
  return { deps, store, fetchCalls, searchCalls };
}

const get = (path: string, headers: Record<string, string> = {}) =>
  new Request(`https://books.test${path}`, { headers });

describe('GET /books/:id', () => {
  it('fetches on a miss, then serves from cache', async () => {
    const f = setup();
    const first = await handle(get('/books/84'), f.deps);
    expect(first.status).toBe(200);
    expect(first.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(first.headers.get('cache-control')).toContain('immutable');
    expect(await first.json()).toEqual(makeBook(84));
    const second = await handle(get('/books/84'), f.deps);
    expect(await second.json()).toEqual(makeBook(84));
    expect(f.fetchCalls).toEqual([84]);
  });

  it('shares one upstream fetch between concurrent misses', async () => {
    const f = setup({}, { delay: true });
    const responses = await Promise.all([
      handle(get('/books/7'), f.deps),
      handle(get('/books/7'), f.deps),
      handle(get('/books/7'), f.deps),
    ]);
    expect(responses.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(f.fetchCalls).toEqual([7]);
  });

  it.each(['abc', '0', '-5', '1.5', '12345678', '01', '1e3'])('rejects id %s with 400', async (id) => {
    const f = setup();
    const res = await handle(get(`/books/${id}`), f.deps);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: expect.any(String) });
    expect(f.fetchCalls).toEqual([]);
  });

  it('accepts a 7-digit id', async () => {
    const f = setup();
    expect((await handle(get('/books/9999999'), f.deps)).status).toBe(200);
  });

  it('returns 404 for an unknown book and does not cache it', async () => {
    const f = setup({}, { missing: [5] });
    const res = await handle(get('/books/5'), f.deps);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: expect.any(String) });
    expect(f.store.size).toBe(0);
    await handle(get('/books/5'), f.deps);
    expect(f.fetchCalls).toEqual([5, 5]);
  });

  it('returns 502 when upstream fails, and retries next time', async () => {
    let fail = true;
    const f = setup({
      source: {
        fetchText: async () => {
          if (fail) throw new Error('down');
          return 'raw';
        },
      },
    });
    const res = await handle(get('/books/9'), f.deps);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: expect.any(String) });
    expect(f.store.size).toBe(0);
    fail = false;
    expect((await handle(get('/books/9'), f.deps)).status).toBe(200);
  });

  it('returns 422 when cleaning fails and does not cache', async () => {
    const f = setup({
      clean: async () => {
        throw new Error('bad');
      },
    });
    const res = await handle(get('/books/3'), f.deps);
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: expect.any(String) });
    expect(f.store.size).toBe(0);
  });

  it('still serves the book when the cache write fails', async () => {
    const f = setup({
      cache: {
        get: async () => null,
        put: async () => {
          throw new Error('kv down');
        },
      },
    });
    expect((await handle(get('/books/2'), f.deps)).status).toBe(200);
  });
});

describe('GET /search', () => {
  it('returns results with a short cache and passes a trimmed query and limit 20', async () => {
    const f = setup();
    const res = await handle(get('/search?q=%20moby%20dick%20'), f.deps);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([{ id: 1, title: 'T', author: 'A', language: 'en' }]);
    expect(res.headers.get('cache-control')).not.toContain('immutable');
    expect(f.searchCalls).toEqual([{ query: 'moby dick', limit: 20 }]);
  });

  it.each(['/search', '/search?q=', '/search?q=%20%20'])('requires q: %s', async (path) => {
    const f = setup();
    expect((await handle(get(path), f.deps)).status).toBe(400);
    expect(f.searchCalls).toEqual([]);
  });

  it('rejects a query over 100 characters but accepts exactly 100', async () => {
    const f = setup();
    expect((await handle(get(`/search?q=${'a'.repeat(101)}`), f.deps)).status).toBe(400);
    expect((await handle(get(`/search?q=${'a'.repeat(100)}`), f.deps)).status).toBe(200);
  });

  it('returns 502 when the catalogue fails', async () => {
    const f = setup({
      catalogue: {
        search: async () => {
          throw new Error('down');
        },
      },
    });
    const res = await handle(get('/search?q=x'), f.deps);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: expect.any(String) });
  });
});

describe('other routes', () => {
  it('GET /health returns ok', async () => {
    const res = await handle(get('/health'), setup().deps);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');
  });

  it.each(['/', '/nope', '/books', '/books/1/extra'])('404 for %s', async (path) => {
    const res = await handle(get(path), setup().deps);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: expect.any(String) });
  });

  it.each(['POST', 'PUT', 'DELETE'])('405 for %s', async (method) => {
    const res = await handle(new Request('https://books.test/books/1', { method }), setup().deps);
    expect(res.status).toBe(405);
    expect(await res.json()).toEqual({ error: expect.any(String) });
  });
});

describe('CORS', () => {
  it('allows a listed origin and always varies on origin', async () => {
    const res = await handle(get('/books/1', { origin: ORIGIN }), setup().deps);
    expect(res.headers.get('access-control-allow-origin')).toBe(ORIGIN);
    expect(res.headers.get('vary')).toBe('origin');
  });

  it('omits the allow header for an unlisted origin', async () => {
    const res = await handle(get('/books/1', { origin: 'https://evil.example' }), setup().deps);
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
    expect(res.headers.get('vary')).toBe('origin');
  });

  it('adds CORS headers to error responses too', async () => {
    const res = await handle(get('/books/abc', { origin: ORIGIN }), setup().deps);
    expect(res.status).toBe(400);
    expect(res.headers.get('access-control-allow-origin')).toBe(ORIGIN);
  });

  it('answers OPTIONS preflight for an allowed origin', async () => {
    const req = new Request('https://books.test/books/1', { method: 'OPTIONS', headers: { origin: ORIGIN } });
    const res = await handle(req, setup().deps);
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe(ORIGIN);
    expect(res.headers.get('access-control-allow-methods')).toContain('GET');
  });

  it('answers OPTIONS without allow-origin for an unlisted origin', async () => {
    const req = new Request('https://books.test/books/1', { method: 'OPTIONS', headers: { origin: 'https://evil.example' } });
    const res = await handle(req, setup().deps);
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });
});
