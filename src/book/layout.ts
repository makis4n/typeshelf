/**
 * How a book's chapters are shown on this device.
 *
 * Importing can mistake something for a chapter heading, most often a bare
 * page number. The reader can join such a "chapter" to the one before it.
 * The book itself is never changed: a saved place always names a chapter of
 * the book as it was imported, so it means the same on every device,
 * whatever each device has joined. Only what is shown and typed as one
 * chapter differs, and this file converts between the two.
 */

import { countWords, hasWords } from '../engine/text';
import type { Book, Chapter, Position } from './types';

/** The reader's choices for one book. Indexes are chapters of the book as imported. */
export interface Layout {
  /** Chapters shown as part of the chapter before them. Never 0. */
  joined: number[];
  /** Chapters that looked like a page number, which the reader said to keep as chapters. */
  kept: number[];
}

export const NO_LAYOUT: Layout = { joined: [], kept: [] };

/** One chapter as shown and typed: one or more chapters of the book, run together. */
export interface ShownChapter {
  title: string;
  paragraphs: string[];
  /** Index in the book of the first chapter in it. */
  first: number;
  /** How many paragraphs each of its book chapters contributes, in order. */
  sizes: number[];
  /** True when it looks like a page number rather than a chapter, and the reader has not said otherwise. */
  flagged: boolean;
}

/** A page number mistaken for a heading has a title of digits only, and next to no text under it. */
const MOST_WORDS_UNDER_A_PAGE_NUMBER = 60;

export function looksLikePageNumber(chapter: Chapter): boolean {
  if (!/^\d{1,5}$/.test(chapter.title.trim())) return false;
  let words = 0;
  for (const paragraph of chapter.paragraphs) words += countWords(paragraph);
  return words <= MOST_WORDS_UNDER_A_PAGE_NUMBER;
}

/** The book's chapters as this device shows them. */
export function shownChapters(book: Pick<Book, 'chapters'>, layout: Layout = NO_LAYOUT): ShownChapter[] {
  const shown: ShownChapter[] = [];
  book.chapters.forEach((chapter, index) => {
    // Paragraphs with no words never reach the page, so they are not counted either.
    const paragraphs = chapter.paragraphs.filter(hasWords);
    const last = shown[shown.length - 1];
    if (last && index > 0 && layout.joined.includes(index)) {
      last.paragraphs.push(...paragraphs);
      last.sizes.push(paragraphs.length);
      return;
    }
    shown.push({
      title: chapter.title,
      paragraphs: [...paragraphs],
      first: index,
      sizes: [paragraphs.length],
      flagged: index > 0 && !layout.kept.includes(index) && looksLikePageNumber(chapter),
    });
  });
  return shown;
}

/**
 * A place in the book, as a place in the shown chapters.
 *
 * @param position A place whose `chapter` is a chapter of the book. Out of range values clamp.
 * @returns The same place with `chapter` an index into `shown`.
 */
export function toShown(shown: readonly ShownChapter[], position: Position): Position {
  if (shown.length === 0) return { chapter: 0, paragraph: 0, char: 0 };
  let at = shown.length - 1;
  while (at > 0 && shown[at].first > position.chapter) at -= 1;
  const chapter = shown[at];
  const within = Math.min(Math.max(position.chapter - chapter.first, 0), chapter.sizes.length - 1);
  let paragraph = position.paragraph;
  for (let i = 0; i < within; i++) paragraph += chapter.sizes[i];
  return { chapter: at, paragraph, char: position.char };
}

/**
 * A place in the shown chapters, as a place in the book.
 *
 * @param place A place whose `chapter` is an index into `shown`. Out of range values clamp.
 */
export function toBook(shown: readonly ShownChapter[], place: Position): Position {
  if (shown.length === 0) return { chapter: 0, paragraph: 0, char: 0 };
  const chapter = shown[Math.min(Math.max(place.chapter, 0), shown.length - 1)];
  let paragraph = Math.max(place.paragraph, 0);
  let within = 0;
  while (within < chapter.sizes.length - 1 && paragraph >= chapter.sizes[within]) {
    paragraph -= chapter.sizes[within];
    within += 1;
  }
  return { chapter: chapter.first + within, paragraph, char: place.char };
}

/** The layout with a shown chapter joined to the one before it. The first chapter cannot be joined. */
export function join(layout: Layout, chapter: ShownChapter): Layout {
  if (chapter.first === 0 || layout.joined.includes(chapter.first)) return layout;
  return { joined: [...layout.joined, chapter.first].sort((a, b) => a - b), kept: layout.kept };
}

/** The layout with a flagged chapter kept as a chapter, so it is not asked about again. */
export function keep(layout: Layout, chapter: ShownChapter): Layout {
  if (layout.kept.includes(chapter.first)) return layout;
  return { joined: layout.joined, kept: [...layout.kept, chapter.first].sort((a, b) => a - b) };
}

// ---- kept in the browser -----------------------------------------------------

const KEY = 'typeshelf:layout:';

function indexes(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is number => Number.isInteger(item) && item >= 0);
}

/** The reader's choices for a book on this device. Nothing chosen, or storage refused, gives no changes. */
export function loadLayout(bookId: string): Layout {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(KEY + bookId) ?? 'null');
    if (typeof stored !== 'object' || stored === null) return NO_LAYOUT;
    const { joined, kept } = stored as { joined?: unknown; kept?: unknown };
    return { joined: indexes(joined).filter((index) => index > 0), kept: indexes(kept) };
  } catch {
    return NO_LAYOUT;
  }
}

/** @returns false when the browser would not keep it; the choice then lasts until the page is closed, at most. */
export function saveLayout(bookId: string, layout: Layout): boolean {
  try {
    if (layout.joined.length === 0 && layout.kept.length === 0) localStorage.removeItem(KEY + bookId);
    else localStorage.setItem(KEY + bookId, JSON.stringify(layout));
    return true;
  } catch {
    return false;
  }
}

export function forgetLayout(bookId: string): void {
  saveLayout(bookId, NO_LAYOUT);
}
