import { cleanGutenberg } from '../../src/gutenberg/clean';
import { handle, type BookCache } from './service';
import { upstreamCatalogue, upstreamSource } from './upstream';

// Just the slice of the KV API used here, so no @cloudflare/workers-types is needed.
interface KVNamespace {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
}

interface Env {
  BOOKS: KVNamespace;
  /** Comma-separated list of origins allowed by CORS. */
  ALLOWED_ORIGINS?: string;
}

function kvCache(kv: KVNamespace): BookCache {
  return {
    get: (id) => kv.get(`gutenberg:${id}`),
    put: (id, json) => kv.put(`gutenberg:${id}`, json),
  };
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return handle(request, {
      cache: kvCache(env.BOOKS),
      source: upstreamSource,
      catalogue: upstreamCatalogue,
      clean: cleanGutenberg,
      allowedOrigins: (env.ALLOWED_ORIGINS ?? '')
        .split(',')
        .map((o) => o.trim())
        .filter((o) => o !== ''),
    });
  },
};
