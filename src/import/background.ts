/**
 * Parses a file in a background worker, with a time limit.
 *
 * A book file is untrusted input, and parsers have slow corners that a crafted
 * file can find. On the page's own thread such a file would freeze the page;
 * in a worker the page stays usable, and a parse that runs too long is simply
 * stopped and reported as an import error.
 */

import type { Book } from '../book/types';
import { ImportError, type ImportErrorCode } from './errors';
import { parseBook, type PickedFile } from './index';

/** What the worker sends back. */
export type ParseReply =
  | { ok: true; book: Book }
  | { ok: false; code: ImportErrorCode | undefined; detail: string };

/** The part of a `Worker` this module uses, so tests can stand in for one. */
export interface ParseWorker {
  postMessage(file: PickedFile): void;
  terminate(): void;
  onmessage: ((event: { data: ParseReply }) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

/** A long novel parses in well under a second; anything near this is not a book. */
export const PARSE_TIMEOUT_MS = 15_000;

const startWorker = (): ParseWorker =>
  new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' }) as unknown as ParseWorker;

/**
 * Like `parseBook`, but off the page's thread. Rejects with `too-large` when
 * parsing takes longer than `timeoutMs`, and the worker is stopped.
 */
export function parseInBackground(
  file: PickedFile,
  { timeoutMs = PARSE_TIMEOUT_MS, start = startWorker }: { timeoutMs?: number; start?: () => ParseWorker } = {},
): Promise<Book> {
  // No workers here (a very old browser): parse in place, as before.
  if (start === startWorker && typeof Worker === 'undefined') return parseBook(file);

  return new Promise<Book>((resolve, reject) => {
    const worker = start();
    const finish = (settle: () => void) => {
      clearTimeout(timer);
      worker.terminate();
      settle();
    };
    const timer = setTimeout(
      () => finish(() => reject(new ImportError('too-large', `parsing took over ${timeoutMs} ms`))),
      timeoutMs,
    );
    worker.onmessage = ({ data }) =>
      finish(() => {
        if (data.ok) resolve(data.book);
        else reject(data.code ? new ImportError(data.code, data.detail) : new Error(data.detail));
      });
    worker.onerror = () => finish(() => reject(new Error('the import worker failed')));
    worker.postMessage(file);
  });
}
