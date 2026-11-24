/**
 * Books kept on this device, in their own IndexedDB database
 * (`typeshelf-books`). Imported books live only here: they are never uploaded.
 *
 * Two object stores share one key, the book's id:
 * - `books` holds whole books, text included.
 * - `summaries` holds a few lines per book, so a list can be shown without
 *   loading any text. It is indexed by fingerprint.
 */

import type { Book, BookSource } from '../book/types';

export const BOOKS_DB_NAME = 'typeshelf-books';
const VERSION = 1;
const BOOKS = 'books';
const SUMMARIES = 'summaries';
const BY_FINGERPRINT = 'fingerprint';

/** A book without its text. */
export interface BookSummary {
  id: string;
  title: string;
  author: string;
  language: string;
  source: BookSource;
  fingerprint: string;
  /** How many chapters the book has. */
  chapters: number;
  /** When the book was first saved, in milliseconds since 1970. */
  addedAt: number;
}

export interface BookStore {
  /** Saves a book. Saving the same id again replaces it and keeps its original `addedAt`. */
  save(book: Book): Promise<BookSummary>;
  get(id: string): Promise<Book | undefined>;
  /** Every stored book, oldest first, without loading any text. */
  list(): Promise<BookSummary[]>;
  delete(id: string): Promise<void>;
  findByFingerprint(fingerprint: string): Promise<BookSummary | undefined>;
  /** Closes the database connection. The store reopens it if used again. */
  close(): void;
}

/** The summary of a book first saved at `addedAt`. */
export function summaryOf(book: Book, addedAt: number): BookSummary {
  return {
    id: book.id,
    title: book.title,
    author: book.author,
    language: book.language,
    source: book.source,
    fingerprint: book.fingerprint,
    chapters: book.chapters.length,
    addedAt,
  };
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function finished(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

function open(factory: IDBFactory): Promise<IDBDatabase> {
  const req = factory.open(BOOKS_DB_NAME, VERSION);
  req.onupgradeneeded = () => {
    const db = req.result;
    if (!db.objectStoreNames.contains(BOOKS)) db.createObjectStore(BOOKS, { keyPath: 'id' });
    if (!db.objectStoreNames.contains(SUMMARIES)) {
      db.createObjectStore(SUMMARIES, { keyPath: 'id' }).createIndex(BY_FINGERPRINT, 'fingerprint');
    }
  };
  return request(req);
}

/** Opens the book store. Pass a factory to use a database other than the browser's own (tests do). */
export function openBookStore(factory: IDBFactory = indexedDB): BookStore {
  let opening: Promise<IDBDatabase> | undefined;
  const db = () => (opening ??= open(factory));

  return {
    async save(book) {
      const transaction = (await db()).transaction([BOOKS, SUMMARIES], 'readwrite');
      const done = finished(transaction);
      const summaries = transaction.objectStore(SUMMARIES);
      const existing = (await request(summaries.get(book.id))) as BookSummary | undefined;
      const summary = summaryOf(book, existing?.addedAt ?? Date.now());
      transaction.objectStore(BOOKS).put(book);
      summaries.put(summary);
      await done;
      return summary;
    },

    async get(id) {
      return request<Book | undefined>((await db()).transaction(BOOKS).objectStore(BOOKS).get(id));
    },

    async list() {
      const all = await request<BookSummary[]>((await db()).transaction(SUMMARIES).objectStore(SUMMARIES).getAll());
      return all.sort((a, b) => a.addedAt - b.addedAt || a.title.localeCompare(b.title));
    },

    async delete(id) {
      const transaction = (await db()).transaction([BOOKS, SUMMARIES], 'readwrite');
      const done = finished(transaction);
      transaction.objectStore(BOOKS).delete(id);
      transaction.objectStore(SUMMARIES).delete(id);
      await done;
    },

    async findByFingerprint(fingerprint) {
      const index = (await db()).transaction(SUMMARIES).objectStore(SUMMARIES).index(BY_FINGERPRINT);
      return request<BookSummary | undefined>(index.get(fingerprint.toLowerCase()));
    },

    close() {
      void opening?.then((database) => database.close());
      opening = undefined;
    },
  };
}
