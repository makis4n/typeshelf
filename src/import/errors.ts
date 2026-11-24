/**
 * Why a file could not be imported. The parsers throw `ImportError`; the page
 * turns its `code` into a sentence with `importErrorMessage`.
 */

export type ImportErrorCode =
  /** Copy-protected (DRM): the text inside is encrypted. */
  | 'drm'
  /** Not a kind of file that can be imported (PDF, Kindle, Word, ...). */
  | 'unsupported'
  /** The right kind of file, but damaged or incomplete. */
  | 'unreadable'
  /** Read fine, but there is no text in it to type. */
  | 'empty'
  /** Bigger than any book, or far too slow to unpack: refused before it can use up the browser's memory or time. */
  | 'too-large';

export class ImportError extends Error {
  readonly code: ImportErrorCode;

  constructor(code: ImportErrorCode, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'ImportError';
    this.code = code;
  }
}

const MESSAGES: Record<ImportErrorCode, string> = {
  drm: 'This book is copy-protected (DRM), so it cannot be imported. Only EPUB files without copy protection work.',
  unsupported:
    'This kind of file cannot be imported. Choose an EPUB, plain text (.txt) or Markdown (.md) file. PDF and Kindle files are not supported.',
  unreadable: 'This file could not be read. It may be damaged or incomplete.',
  empty: 'There is no text to type in this file.',
  'too-large': 'This file is too large to import. Books of up to about 60 MB of text are supported.',
};

/** The sentence shown to the reader for anything thrown while importing. */
export function importErrorMessage(error: unknown): string {
  if (error instanceof ImportError) return MESSAGES[error.code];
  return 'Something went wrong while importing this file.';
}

/** Shown when a book was read but the browser would not keep it (storage blocked or full). */
export const NOT_SAVED_NOTICE =
  "This book could not be saved on this device, because the browser's storage is blocked or full. You can type it now, but it will be gone when you close the page.";
