import { describe, expect, it } from 'vitest';
import { shownChapters } from './layout';
import { bookProgress, percentOf } from './progress';
import type { Chapter, Position } from './types';

const at = (chapter: number, paragraph: number, char: number): Position => ({ chapter, paragraph, char });
const chapter = (title: string, ...paragraphs: string[]): Chapter => ({ title, paragraphs });

/** Chapter words: 5 (3 + 2), 2, 4 (3 + 1). Total 11. */
const book = {
  chapters: [chapter('One', 'aa bb cc', 'dd ee'), chapter('Two', 'ff gg'), chapter('Three', 'hh ii jj', 'kk')],
};
const shown = shownChapters(book);
const progressAt = (place: Position | undefined) => bookProgress(shown, book.chapters.length, place);

describe('bookProgress', () => {
  it('says nothing is done when there is no saved place', () => {
    expect(progressAt(undefined)).toEqual({
      words: [5, 2, 4],
      total: 11,
      started: false,
      finished: false,
      current: 0,
      currentDone: 0,
      done: 0,
    });
  });

  it('counts words done in the chapter and in the book mid-chapter', () => {
    // The start of "ee": 'aa bb cc' and 'dd' are behind the reader.
    const middle = progressAt(at(0, 1, 'dd '.length));
    expect(middle).toMatchObject({ started: true, finished: false, current: 0, currentDone: 4, done: 4 });

    // The start of "gg" in chapter 2.
    const later = progressAt(at(1, 0, 'ff '.length));
    expect(later).toMatchObject({ started: true, finished: false, current: 1, currentDone: 1, done: 6 });
  });

  it('is started with nothing done at the start of the first chapter', () => {
    expect(progressAt(at(0, 0, 0))).toMatchObject({ started: true, current: 0, currentDone: 0, done: 0 });
  });

  it('counts whole earlier chapters when a later one is begun', () => {
    expect(progressAt(at(2, 0, 0))).toMatchObject({ current: 2, currentDone: 0, done: 7 });
  });

  it('follows the shown chapters when one is joined to the one before it', () => {
    const joined = shownChapters(book, { joined: [1], kept: [] });
    // Book chapter 1 ("Two") now runs on from chapter 0's paragraphs.
    const progress = bookProgress(joined, book.chapters.length, at(1, 0, 'ff '.length));
    expect(progress.words).toEqual([7, 4]);
    expect(progress.total).toBe(11);
    expect(progress).toMatchObject({ current: 0, currentDone: 6, done: 6, finished: false });

    // A place in book chapter 2 is the start of the second shown chapter.
    expect(bookProgress(joined, book.chapters.length, at(2, 0, 0))).toMatchObject({ current: 1, currentDone: 0, done: 7 });
  });

  it('is finished at the very end of the last chapter, with everything done', () => {
    const end = progressAt(at(2, 1, 'kk'.length));
    expect(end).toMatchObject({ started: true, finished: true, current: 2, currentDone: 4, done: 11, total: 11 });
  });

  it('is not finished one word before the end', () => {
    const near = progressAt(at(2, 1, 0));
    expect(near.finished).toBe(false);
    expect(near.done).toBe(10);
  });

  it('is not finished at the start of the last chapter', () => {
    expect(progressAt(at(2, 0, 0)).finished).toBe(false);
  });

  it('is finished at the end of a book whose last chapter is joined', () => {
    const joined = shownChapters(book, { joined: [2], kept: [] });
    const progress = bookProgress(joined, book.chapters.length, at(2, 1, 'kk'.length));
    expect(progress).toMatchObject({ finished: true, done: 11, total: 11, current: 1 });
  });

  it('opens the last chapter from its start when the place is past the end of the book', () => {
    expect(progressAt(at(9, 0, 0))).toMatchObject({ started: true, finished: false, current: 2, currentDone: 0, done: 7 });
  });

  it('starts from the first chapter for a place that is not a whole number', () => {
    expect(progressAt(at(-1, 0, 0))).toMatchObject({ started: true, current: 0, done: 0 });
    expect(progressAt(at(1.5, 0, 0))).toMatchObject({ started: true, current: 0, done: 0 });
  });

  it('is not started for a book with no chapters', () => {
    expect(bookProgress([], 0, at(0, 0, 0))).toEqual({
      words: [],
      total: 0,
      started: false,
      finished: false,
      current: 0,
      currentDone: 0,
      done: 0,
    });
  });
});

describe('percentOf', () => {
  it('is 0 when nothing is done', () => {
    expect(percentOf(0, 1000)).toBe(0);
  });

  it('is at least 1 once anything is done', () => {
    expect(percentOf(1, 1000)).toBe(1);
  });

  it('is at most 99 until everything is done', () => {
    expect(percentOf(999, 1000)).toBe(99);
  });

  it('is 100 when done equals the total, and beyond', () => {
    expect(percentOf(1000, 1000)).toBe(100);
    expect(percentOf(1200, 1000)).toBe(100);
  });

  it('is 0 when the total is 0', () => {
    expect(percentOf(0, 0)).toBe(0);
    expect(percentOf(5, 0)).toBe(0);
  });

  it('rounds to the nearest whole percent in between', () => {
    expect(percentOf(1, 3)).toBe(33);
    expect(percentOf(2, 3)).toBe(67);
    expect(percentOf(1, 2)).toBe(50);
  });

  it('is 0 for a negative amount done', () => {
    expect(percentOf(-4, 10)).toBe(0);
  });
});
