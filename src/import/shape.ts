/**
 * The last step every importer shares: tidy the chapters a parser found and
 * wrap them up as a `Book`.
 */

import type { Book, BookSource, Chapter } from '../book/types';
import { ImportError } from './errors';
import { importId } from './fingerprint';
import { collapse } from './markup';

/** What the importer knows about a file before looking inside it. */
export interface FileInfo {
  /** The file's name as the reader sees it, e.g. `emma.epub`. */
  fileName: string;
  /** Lowercase hex SHA-256 of the file's bytes. */
  fingerprint: string;
}

/** A chapter as a parser found it. A missing title is filled in by `assembleBook`. */
export interface DraftChapter {
  title?: string;
  paragraphs: string[];
}

export interface Draft {
  source: BookSource;
  title?: string;
  author?: string;
  language?: string;
  chapters: DraftChapter[];
}

/** A readable title from a file name: `my_book-final.txt` gives `my book-final`. */
export function titleFromFileName(fileName: string): string {
  const base = fileName.replace(/^.*[\\/]/, '').replace(/\.[A-Za-z0-9]{1,8}$/, '');
  return collapse(base.replace(/_+/g, ' ')) || 'Untitled';
}

/**
 * Builds the book. Paragraphs without text and chapters without paragraphs are
 * dropped; a book left with nothing to type is an `empty` error.
 */
export function assembleBook(draft: Draft, file: FileInfo): Book {
  const title = collapse(draft.title ?? '') || titleFromFileName(file.fileName);

  const kept = draft.chapters
    .map((chapter) => ({
      title: collapse(chapter.title ?? ''),
      paragraphs: chapter.paragraphs.map(collapse).filter((paragraph) => paragraph.length > 0),
    }))
    .filter((chapter) => chapter.paragraphs.length > 0);
  if (kept.length === 0) throw new ImportError('empty');

  const chapters: Chapter[] = kept.map((chapter, i) => ({
    // A book that is one untitled piece is named after itself.
    title: chapter.title || (kept.length === 1 ? title : `Section ${i + 1}`),
    paragraphs: chapter.paragraphs,
  }));

  return {
    id: importId(file.fingerprint),
    title,
    author: collapse(draft.author ?? ''),
    language: collapse(draft.language ?? '') || 'und',
    source: draft.source,
    fingerprint: file.fingerprint,
    chapters,
  };
}
