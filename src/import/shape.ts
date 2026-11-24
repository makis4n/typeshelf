/**
 * The last step every importer shares: tidy the chapters a parser found and
 * wrap them up as a `Book`.
 */

import type { Book, BookSource, Chapter } from '../book/types';
import { hasWords } from '../engine/text';
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

/** More combining marks on one letter than any writing system uses. */
const MARK_RUN = /(\p{M}{8})\p{M}+/gu;

/**
 * Collapses whitespace and cuts absurd runs of combining marks (accents piled
 * on one letter by the thousand). Such runs are not text anyone can type, and
 * normalising them, which the typing engine does to every paragraph, takes
 * time that grows with the square of their length.
 */
export function tidy(text: string): string {
  return collapse(text.replace(MARK_RUN, '$1'));
}

/** A readable title from a file name: `my_book-final.txt` gives `my book-final`. */
export function titleFromFileName(fileName: string): string {
  const base = fileName.replace(/^.*[\\/]/, '').replace(/\.[A-Za-z0-9]{1,8}$/, '');
  return collapse(base.replace(/_+/g, ' ')) || 'Untitled';
}

/**
 * Builds the book. Paragraphs without words and chapters without paragraphs are
 * dropped; a book left with nothing to type is an `empty` error.
 */
export function assembleBook(draft: Draft, file: FileInfo): Book {
  const title = tidy(draft.title ?? '') || tidy(titleFromFileName(file.fileName));

  const kept = draft.chapters
    .map((chapter) => ({
      title: tidy(chapter.title ?? ''),
      // Exactly the paragraphs the typing engine keeps, so paragraph numbers mean the same in both.
      paragraphs: chapter.paragraphs.map(tidy).filter(hasWords),
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
    author: tidy(draft.author ?? ''),
    language: tidy(draft.language ?? '') || 'und',
    source: draft.source,
    fingerprint: file.fingerprint,
    chapters,
  };
}
