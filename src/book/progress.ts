/** How far a reader is through a book, in the chapters as this device shows them. */

import { buildPassage, countWords } from '../engine/text';
import { toBook, toShown, type ShownChapter } from './layout';
import { openingPlace, placeAfterChapter, samePlace } from './place';
import { wordAt } from './position';
import type { Position } from './types';

export interface BookProgress {
  /** Words in each shown chapter. */
  words: number[];
  /** Words in the whole book. */
  total: number;
  /** True once a place has been saved for the book. */
  started: boolean;
  /** True when the place is the very end of the last chapter. */
  finished: boolean;
  /** Index of the shown chapter the reader is in. The last one when finished. */
  current: number;
  /** Words of the current chapter behind the reader. */
  currentDone: number;
  /** Words of the whole book behind the reader. */
  done: number;
}

/**
 * @param shown The book's chapters as shown.
 * @param chapters How many chapters the book itself has (what a saved place counts in).
 * @param saved The saved place, in the book's own chapters. Undefined when the book is not started.
 */
export function bookProgress(
  shown: readonly ShownChapter[],
  chapters: number,
  saved: Position | undefined,
): BookProgress {
  const words = shown.map((chapter) => chapter.paragraphs.reduce((sum, paragraph) => sum + countWords(paragraph), 0));
  const total = words.reduce((sum, count) => sum + count, 0);
  const none = { words, total, started: false, finished: false, current: 0, currentDone: 0, done: 0 };
  if (saved === undefined || shown.length === 0) return none;

  const { chapter, place } = openingPlace(chapters, saved);
  const at = toShown(shown, place ?? { chapter, paragraph: 0, char: 0 });
  const passage = buildPassage(shown[at.chapter].paragraphs);

  let finished = false;
  if (at.chapter === shown.length - 1) {
    const end = toBook(shown, placeAfterChapter(shown.length, passage, at.chapter));
    finished = samePlace(end, saved);
  }
  const currentDone = finished ? words[at.chapter] : wordAt(passage, at);
  let done = currentDone;
  for (let i = 0; i < at.chapter; i++) done += words[i];
  return { words, total, started: true, finished, current: at.chapter, currentDone, done };
}

/** A whole percentage that only says 100 when everything is done, and only 0 when nothing is. */
export function percentOf(done: number, total: number): number {
  if (total <= 0 || done <= 0) return 0;
  if (done >= total) return 100;
  return Math.min(99, Math.max(1, Math.round((done / total) * 100)));
}
