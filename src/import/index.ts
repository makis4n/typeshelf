/**
 * Importing a reader's own file: work out what kind of file it is, hand it to
 * the right parser, and get back a `Book`.
 *
 * Everything here runs in the browser. The file is never uploaded.
 */

import type { Book } from '../book/types';
import { summaryOf, type BookStore, type BookSummary } from '../store/books';
import { MAX_UNZIPPED_BYTES, parseEpub } from './epub';
import { ImportError } from './errors';
import { fingerprintOf } from './fingerprint';
import { parseMarkdown } from './markdown';
import { parseText } from './text';

export { ImportError, importErrorMessage, NOT_SAVED_NOTICE, type ImportErrorCode } from './errors';
export { fingerprintOf, fingerprintFromId, importId, isSameBook } from './fingerprint';

/** A file as picked by the reader: its name and its bytes. */
export interface PickedFile {
  name: string;
  bytes: Uint8Array;
}

/** What the file picker offers. */
export const ACCEPTED_FILES = '.epub,.txt,.text,.md,.markdown,application/epub+zip,text/plain,text/markdown';

/** The largest file that is read at all. EPUBs with many pictures are big; nothing real is this big. */
export const MAX_FILE_BYTES = 200 * 1024 * 1024;

type Format = 'epub' | 'text' | 'markdown';

const startsWith = (bytes: Uint8Array, signature: number[]) => signature.every((byte, i) => bytes[i] === byte);

/** Decides the format from the file's name and first bytes. Throws `unsupported` for anything else. */
export function formatOf(file: PickedFile): Format {
  const extension = /\.([A-Za-z0-9]+)$/.exec(file.name)?.[1]?.toLowerCase() ?? '';
  const isZip = startsWith(file.bytes, [0x50, 0x4b, 0x03, 0x04]);

  if (extension === 'epub') return 'epub';
  // A zip under another name may still be an EPUB; `parseBook` checks.
  if (isZip) return 'epub';
  if (startsWith(file.bytes, [0x25, 0x50, 0x44, 0x46])) throw new ImportError('unsupported', 'PDF');
  if (extension === 'md' || extension === 'markdown') return 'markdown';
  if (extension === 'txt' || extension === 'text') return 'text';
  throw new ImportError('unsupported', extension || 'unknown file type');
}

/** Reads a picked file into a `Book`. Throws `ImportError` when it cannot. */
export async function parseBook(file: PickedFile): Promise<Book> {
  if (file.bytes.length === 0) throw new ImportError('empty');
  if (file.bytes.length > MAX_FILE_BYTES) throw new ImportError('too-large', 'file');
  const format = formatOf(file);
  // A text file is all text, so it gets the limit an EPUB's unzipped text gets.
  if (format !== 'epub' && file.bytes.length > MAX_UNZIPPED_BYTES) throw new ImportError('too-large', 'text');
  const info = { fileName: file.name, fingerprint: await fingerprintOf(file.bytes) };

  if (format === 'epub') {
    try {
      return parseEpub(file.bytes, info);
    } catch (error) {
      // A zip that is not an EPUB at all (a Word document, an archive) is the wrong kind of file, not a broken one.
      const named = /\.epub$/i.test(file.name);
      if (!named && error instanceof ImportError && error.code === 'unreadable') throw new ImportError('unsupported', 'zip');
      throw error;
    }
  }
  // Text never contains a zero byte (UTF-16 aside, which starts with a marker); other binary files do.
  const marked = startsWith(file.bytes, [0xff, 0xfe]) || startsWith(file.bytes, [0xfe, 0xff]);
  if (!marked && file.bytes.subarray(0, 8192).includes(0)) throw new ImportError('unsupported', 'binary data');
  return format === 'markdown' ? parseMarkdown(file.bytes, info) : parseText(file.bytes, info);
}

export interface Imported {
  book: Book;
  summary: BookSummary;
  /** True when this exact file was already on the device; nothing new was stored. */
  alreadyHad: boolean;
  /**
   * False when the browser would not keep the book (storage blocked or full).
   * The book is still returned and can be typed; it is just not on the device.
   */
  stored: boolean;
}

/**
 * Imports a file and keeps it on the device. The same file imported twice is
 * recognised by its fingerprint and stored once.
 */
export async function importFile(store: BookStore, file: PickedFile): Promise<Imported> {
  if (file.bytes.length === 0) throw new ImportError('empty');
  if (file.bytes.length > MAX_FILE_BYTES) throw new ImportError('too-large', 'file');
  try {
    const known = await store.findByFingerprint(await fingerprintOf(file.bytes));
    const kept = known && (await store.get(known.id));
    if (known && kept) return { book: kept, summary: known, alreadyHad: true, stored: true };
  } catch {
    // Storage cannot be read. The file itself may be fine, so carry on and parse it.
  }

  const book = await parseBook(file);
  try {
    return { book, summary: await store.save(book), alreadyHad: false, stored: true };
  } catch {
    return { book, summary: summaryOf(book, Date.now()), alreadyHad: false, stored: false };
  }
}
