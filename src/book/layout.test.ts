import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  forgetLayout,
  join,
  keep,
  loadLayout,
  looksLikePageNumber,
  NO_LAYOUT,
  saveLayout,
  shownChapters,
  toBook,
  toShown,
  type Layout,
} from './layout';
import type { Chapter } from './types';

const words = (count: number): string => Array.from({ length: count }, (_, i) => `w${i}`).join(' ');
const chapter = (title: string, ...paragraphs: string[]): Chapter => ({ title, paragraphs });
const layout = (joined: number[] = [], kept: number[] = []): Layout => ({ joined, kept });

/** Five chapters; chapters 2 and 3 are joined in the layouts below. */
const book = {
  chapters: [
    chapter('One', 'a b c', 'd e'),
    chapter('Two', 'f g'),
    chapter('Three', 'h i', 'j k l', 'm'),
    chapter('Four', 'n o'),
    chapter('Five', 'p q', 'r'),
  ],
};

describe('shownChapters', () => {
  it('is the book as it is when nothing is joined', () => {
    const shown = shownChapters(book);
    expect(shown.map((c) => c.title)).toEqual(['One', 'Two', 'Three', 'Four', 'Five']);
    expect(shown.map((c) => c.paragraphs)).toEqual(book.chapters.map((c) => c.paragraphs));
    expect(shown.map((c) => c.first)).toEqual([0, 1, 2, 3, 4]);
    expect(shownChapters(book, layout())).toEqual(shown);
  });

  it('puts a joined chapter after the paragraphs of the one before it and drops its title', () => {
    const shown = shownChapters(book, layout([2]));
    expect(shown).toHaveLength(4);
    expect(shown[1].title).toBe('Two');
    expect(shown[1].paragraphs).toEqual(['f g', 'h i', 'j k l', 'm']);
    expect(shown[1].sizes).toEqual([1, 3]);
    expect(shown.map((c) => c.title)).not.toContain('Three');
    expect(shown[2].first).toBe(3);
  });

  it('never joins the first chapter to anything', () => {
    const shown = shownChapters(book, layout([0]));
    expect(shown).toHaveLength(5);
    expect(shown[0].paragraphs).toEqual(['a b c', 'd e']);
  });

  it('runs several consecutive joined chapters into the chapter before them', () => {
    const shown = shownChapters(book, layout([1, 2, 3]));
    expect(shown.map((c) => c.title)).toEqual(['One', 'Five']);
    expect(shown[0].paragraphs).toHaveLength(2 + 1 + 3 + 1);
    expect(shown[0].sizes).toEqual([2, 1, 3, 1]);
    expect(shown[1].first).toBe(4);
  });

  it('drops paragraphs without words, and does not count them', () => {
    const shown = shownChapters({
      chapters: [chapter('One', 'a b', '', '   ', '​'), chapter('Two', ' ', 'c')],
    }, layout([1]));
    expect(shown[0].paragraphs).toEqual(['a b', 'c']);
    expect(shown[0].sizes).toEqual([1, 1]);
  });

  it('does not change the book it is given', () => {
    const before = JSON.stringify(book);
    shownChapters(book, layout([1, 2]));
    expect(JSON.stringify(book)).toBe(before);
  });
});

describe('toShown and toBook', () => {
  const joinedBook = {
    chapters: [chapter('One', 'a b', 'c d'), chapter('Two', 'e'), chapter('Three', 'f', 'g', 'h'), chapter('Four', 'i j')],
  };

  it.each([
    ['no joins', layout()],
    ['one join', layout([1])],
    ['joins in the middle', layout([2])],
    ['consecutive joins', layout([1, 2, 3])],
    ['separate joins', layout([1, 3])],
  ])('are inverses for every paragraph of every chapter with %s', (_name, chosen) => {
    const shown = shownChapters(joinedBook, chosen);
    joinedBook.chapters.forEach((c, chapterIndex) => {
      c.paragraphs.forEach((_p, paragraph) => {
        for (const char of [0, 1]) {
          const place = { chapter: chapterIndex, paragraph, char };
          expect(toBook(shown, toShown(shown, place))).toEqual(place);
        }
      });
    });
  });

  it('shows a place in a joined chapter as a later paragraph of the chapter it joined', () => {
    const shown = shownChapters(joinedBook, layout([1]));
    expect(toShown(shown, { chapter: 1, paragraph: 0, char: 1 })).toEqual({ chapter: 0, paragraph: 2, char: 1 });
    expect(toShown(shown, { chapter: 2, paragraph: 1, char: 0 })).toEqual({ chapter: 1, paragraph: 1, char: 0 });
  });

  it('reads a paragraph of a joined chapter as a place in the book chapter it came from', () => {
    const shown = shownChapters(joinedBook, layout([1]));
    expect(toBook(shown, { chapter: 0, paragraph: 2, char: 1 })).toEqual({ chapter: 1, paragraph: 0, char: 1 });
  });

  it('clamps a chapter past the end to the last one, and a negative one to the first', () => {
    const shown = shownChapters(joinedBook, layout([3]));
    expect(toShown(shown, { chapter: 99, paragraph: 0, char: 0 }).chapter).toBe(shown.length - 1);
    expect(toShown(shown, { chapter: -3, paragraph: 0, char: 0 }).chapter).toBe(0);
    expect(toBook(shown, { chapter: 99, paragraph: 0, char: 0 }).chapter).toBeGreaterThanOrEqual(2);
    expect(toBook(shown, { chapter: -3, paragraph: -2, char: 4 })).toEqual({ chapter: 0, paragraph: 0, char: 4 });
  });

  it('gives the start of the book when there are no chapters', () => {
    expect(toShown([], { chapter: 3, paragraph: 2, char: 1 })).toEqual({ chapter: 0, paragraph: 0, char: 0 });
    expect(toBook([], { chapter: 3, paragraph: 2, char: 1 })).toEqual({ chapter: 0, paragraph: 0, char: 0 });
  });
});

describe('looksLikePageNumber and flagged chapters', () => {
  const flaggedIn = (chapters: Chapter[], chosen = NO_LAYOUT) => shownChapters({ chapters }, chosen).map((c) => c.flagged);

  it('flags a digits-only title with a few words', () => {
    expect(looksLikePageNumber(chapter('117', 'a few words here'))).toBe(true);
    expect(looksLikePageNumber(chapter(' 42 ', ''))).toBe(true);
  });

  it('flags up to 60 words and not 61', () => {
    expect(looksLikePageNumber(chapter('9', words(60)))).toBe(true);
    expect(looksLikePageNumber(chapter('9', words(61)))).toBe(false);
    expect(looksLikePageNumber(chapter('9', words(30), words(31)))).toBe(false);
  });

  it('does not flag titles that are not only digits', () => {
    expect(looksLikePageNumber(chapter('Chapter 7', 'x'))).toBe(false);
    expect(looksLikePageNumber(chapter('7a', 'x'))).toBe(false);
    expect(looksLikePageNumber(chapter('', 'x'))).toBe(false);
  });

  it('does not flag a title of more than five digits', () => {
    expect(looksLikePageNumber(chapter('123456', 'x'))).toBe(false);
  });

  it('never flags the first chapter', () => {
    expect(flaggedIn([chapter('12', 'x'), chapter('13', 'y')])).toEqual([false, true]);
  });

  it('stops flagging a chapter once it is kept', () => {
    const chapters = [chapter('One', 'x'), chapter('117', 'y'), chapter('118', 'z')];
    expect(flaggedIn(chapters)).toEqual([false, true, true]);
    expect(flaggedIn(chapters, layout([], [1]))).toEqual([false, false, true]);
  });
});

describe('join and keep', () => {
  const shown = shownChapters(book);

  it('add the chapter to the layout', () => {
    expect(join(NO_LAYOUT, shown[2])).toEqual({ joined: [2], kept: [] });
    expect(keep(NO_LAYOUT, shown[2])).toEqual({ joined: [], kept: [2] });
  });

  it('do nothing the second time', () => {
    const once = join(NO_LAYOUT, shown[2]);
    expect(join(once, shown[2])).toEqual(once);
    const kept = keep(NO_LAYOUT, shown[2]);
    expect(keep(kept, shown[2])).toEqual(kept);
  });

  it('keep the indexes sorted', () => {
    let chosen = join(NO_LAYOUT, shown[4]);
    chosen = join(chosen, shown[1]);
    chosen = join(chosen, shown[3]);
    expect(chosen.joined).toEqual([1, 3, 4]);
    let kept = keep(NO_LAYOUT, shown[3]);
    kept = keep(kept, shown[1]);
    expect(kept.kept).toEqual([1, 3]);
  });

  it('refuse to join the first chapter', () => {
    expect(join(NO_LAYOUT, shown[0])).toEqual(NO_LAYOUT);
  });

  it('use the first book chapter of a chapter that already has others joined to it', () => {
    const wide = shownChapters(book, layout([2]));
    expect(join(layout([2]), wide[1])).toEqual({ joined: [1, 2], kept: [] });
  });

  it('leave the layout they were given unchanged', () => {
    const before = layout([2], [3]);
    join(before, shown[4]);
    keep(before, shown[4]);
    expect(before).toEqual({ joined: [2], kept: [3] });
  });
});

describe('saved layouts', () => {
  const data = new Map<string, string>();

  beforeEach(() => {
    data.clear();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => void data.set(key, value),
      removeItem: (key: string) => void data.delete(key),
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('gives back what was saved', () => {
    expect(saveLayout('b1', layout([2, 4], [3]))).toBe(true);
    expect(loadLayout('b1')).toEqual({ joined: [2, 4], kept: [3] });
  });

  it('keeps each book apart', () => {
    saveLayout('b1', layout([2]));
    expect(loadLayout('b2')).toEqual(NO_LAYOUT);
    expect(data.has('typeshelf:layout:b1')).toBe(true);
  });

  it('gives no changes for a book with nothing saved', () => {
    expect(loadLayout('never')).toEqual(NO_LAYOUT);
  });

  it('removes the entry when the layout is empty', () => {
    saveLayout('b1', layout([2]));
    saveLayout('b1', NO_LAYOUT);
    expect(data.has('typeshelf:layout:b1')).toBe(false);
  });

  it('forgets a saved layout', () => {
    saveLayout('b1', layout([2], [1]));
    forgetLayout('b1');
    expect(loadLayout('b1')).toEqual(NO_LAYOUT);
    expect(data.size).toBe(0);
  });

  it.each(['not json {', '"text"', '42', 'null', 'true', '{}', '[1,2]'])('gives no layout for %s in storage', (garbage) => {
    data.set('typeshelf:layout:b1', garbage);
    expect(loadLayout('b1')).toEqual(NO_LAYOUT);
  });

  it('ignores indexes that are not whole non-negative numbers, and a join of the first chapter', () => {
    data.set(
      'typeshelf:layout:b1',
      JSON.stringify({ joined: [0, 2, -1, 1.5, '3', null, 4], kept: [0, 'x', 2] }),
    );
    expect(loadLayout('b1')).toEqual({ joined: [2, 4], kept: [0, 2] });
  });

  it('copes when the fields are not lists', () => {
    data.set('typeshelf:layout:b1', JSON.stringify({ joined: 3, kept: 'x' }));
    expect(loadLayout('b1')).toEqual(NO_LAYOUT);
  });

  it('does not throw when the browser refuses storage', () => {
    const refuse = () => {
      throw new DOMException('blocked', 'SecurityError');
    };
    vi.stubGlobal('localStorage', { getItem: refuse, setItem: refuse, removeItem: refuse });
    expect(loadLayout('b1')).toEqual(NO_LAYOUT);
    expect(saveLayout('b1', layout([2]))).toBe(false);
    expect(saveLayout('b1', NO_LAYOUT)).toBe(false);
    expect(() => forgetLayout('b1')).not.toThrow();
  });

  it('does not throw when there is no localStorage at all', () => {
    vi.unstubAllGlobals();
    expect(loadLayout('b1')).toEqual(NO_LAYOUT);
    expect(saveLayout('b1', layout([2]))).toBe(false);
  });
});
