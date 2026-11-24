import { describe, expect, it } from 'vitest';
import { buildPassage, countWords, isAccepted, type TargetChar } from './text';

const glyphs = (word: { chars: TargetChar[] }): string => word.chars.map((c) => c.glyph).join('');
const wordsOf = (paragraphs: string[], options = {}): string[] =>
  buildPassage(paragraphs, options).words.map(glyphs);

describe('buildPassage word splitting', () => {
  it('splits on plain spaces', () => {
    expect(wordsOf(['one two  three'])).toEqual(['one', 'two', 'three']);
  });

  it('splits on non-breaking spaces', () => {
    expect(wordsOf(['one two'])).toEqual(['one', 'two']);
  });

  it('splits on line breaks and tabs', () => {
    expect(wordsOf(['one\ntwo\r\nthree\tfour'])).toEqual(['one', 'two', 'three', 'four']);
  });

  it('ignores leading and trailing whitespace', () => {
    expect(wordsOf(['    hello \n'])).toEqual(['hello']);
  });

  it('returns an empty passage for no paragraphs', () => {
    expect(buildPassage([])).toEqual({ words: [], paraStart: [] });
  });

  it('drops paragraphs with no words', () => {
    const passage = buildPassage(['', '   \n ', 'real words', '​']);
    expect(passage.words.map(glyphs)).toEqual(['real', 'words']);
    expect(passage.paraStart).toEqual([0]);
  });
});

describe('buildPassage paragraph bookkeeping', () => {
  it('sets para, paraStart and endsPara across several paragraphs', () => {
    const passage = buildPassage(['a b c', '', 'd', 'e f']);
    expect(passage.paraStart).toEqual([0, 3, 4]);
    expect(passage.words.map((w) => w.para)).toEqual([0, 0, 0, 1, 2, 2]);
    expect(passage.words.map((w) => w.endsPara)).toEqual([false, false, true, true, false, true]);
  });

  it('numbers paragraphs after dropped ones without gaps', () => {
    const passage = buildPassage(['', 'x', '  ', 'y']);
    expect(passage.words.map((w) => w.para)).toEqual([0, 1]);
    expect(passage.paraStart).toEqual([0, 1]);
  });
});

describe('buildPassage accepted keys', () => {
  it('lets a plain character accept only itself', () => {
    const [word] = buildPassage(['a']).words;
    expect(word.chars[0]).toEqual({ glyph: 'a', accepts: 'a' });
  });

  it('lets curly single quotes accept themselves and the straight apostrophe', () => {
    const [word] = buildPassage(['‘’']).words;
    for (const char of word.chars) {
      expect(isAccepted(char, char.glyph)).toBe(true);
      expect(isAccepted(char, "'")).toBe(true);
      expect(isAccepted(char, '"')).toBe(false);
    }
  });

  it('lets curly double quotes accept themselves and the straight quote', () => {
    const [word] = buildPassage(['“”']).words;
    for (const char of word.chars) {
      expect(isAccepted(char, char.glyph)).toBe(true);
      expect(isAccepted(char, '"')).toBe(true);
      expect(isAccepted(char, "'")).toBe(false);
    }
  });

  it('lets en and em dashes accept a hyphen', () => {
    const [word] = buildPassage(['–—']).words;
    for (const char of word.chars) {
      expect(isAccepted(char, char.glyph)).toBe(true);
      expect(isAccepted(char, '-')).toBe(true);
    }
  });

  it('keeps the printed glyph for display', () => {
    expect(wordsOf(['“hi”'])).toEqual(['“hi”']);
  });
});

describe('buildPassage rewrites', () => {
  it('turns an ellipsis into three dots', () => {
    const [word] = buildPassage(['wait…']).words;
    expect(glyphs(word)).toBe('wait...');
    expect(word.chars.slice(4).map((c) => c.accepts)).toEqual(['.', '.', '.']);
  });

  it('expands ligatures into plain letters', () => {
    expect(wordsOf(['ﬁsh ﬂy ﬀ oﬃce baﬄe'])).toEqual([
      'fish',
      'fly',
      'ff',
      'office',
      'baffle',
    ]);
  });

  it('removes soft hyphens and zero-width characters', () => {
    expect(wordsOf(['co­op​er‌at‍e⁠d﻿'])).toEqual(['cooperated']);
  });

  it('does not split a word on a removed invisible character', () => {
    expect(wordsOf(['a​b'])).toEqual(['ab']);
  });
});

describe('buildPassage normalisation', () => {
  it('composes "e" plus a combining acute into one glyph', () => {
    const [word] = buildPassage(['é']).words;
    expect(word.chars).toHaveLength(1);
    expect(word.chars[0].glyph).toBe('é');
  });

  it('makes a decomposed accent typeable with the composed character', () => {
    const [word] = buildPassage(['caf' + 'é']).words;
    expect(isAccepted(word.chars[3], 'é')).toBe(true);
  });
});

describe('buildPassage relaxedAccents', () => {
  it('does not accept the plain letter by default', () => {
    const [word] = buildPassage(['é']).words;
    expect(isAccepted(word.chars[0], 'é')).toBe(true);
    expect(isAccepted(word.chars[0], 'e')).toBe(false);
  });

  it('does not accept the plain letter when the option is false', () => {
    const [word] = buildPassage(['é'], { relaxedAccents: false }).words;
    expect(isAccepted(word.chars[0], 'e')).toBe(false);
  });

  it('accepts the plain letter when the option is on', () => {
    const [word] = buildPassage(['é'], { relaxedAccents: true }).words;
    expect(isAccepted(word.chars[0], 'é')).toBe(true);
    expect(isAccepted(word.chars[0], 'e')).toBe(true);
  });

  it('does not accept an unrelated letter when the option is on', () => {
    const [word] = buildPassage(['é'], { relaxedAccents: true }).words;
    expect(isAccepted(word.chars[0], 'a')).toBe(false);
  });

  it('leaves unaccented characters unchanged when the option is on', () => {
    const [word] = buildPassage(['a'], { relaxedAccents: true }).words;
    expect(word.chars[0].accepts).toBe('a');
  });
});

describe('isAccepted', () => {
  it('is false for an empty string', () => {
    const [word] = buildPassage(['a']).words;
    expect(isAccepted(word.chars[0], '')).toBe(false);
  });

  it('is false for the wrong character', () => {
    const [word] = buildPassage(['a']).words;
    expect(isAccepted(word.chars[0], 'b')).toBe(false);
  });

  it('is true for the right character', () => {
    const [word] = buildPassage(['a']).words;
    expect(isAccepted(word.chars[0], 'a')).toBe(true);
  });
});

describe('countWords', () => {
  it.each([
    ['plain text', 'one two three'],
    ['extra whitespace', '  one \t two\n\n three   '],
    ['non-breaking spaces', 'one\u00a0two\u00a0\u00a0three'],
    ['ligatures and an ellipsis', 'o\ufb03ce \ufb01ne\u2026 and then\u2026'],
    ['zero-width characters', 'one\u200btwo \u200b three\ufeff four'],
    ['only zero-width characters', '\u200b \u200b'],
    ['an empty text', ''],
    ['only whitespace', ' \n\t '],
    ['a combining accent', 'cafe\u0301 au lait'],
  ])('equals the words buildPassage makes of %s', (_name, text) => {
    expect(countWords(text)).toBe(buildPassage([text]).words.length);
  });

  it('counts the words of a plain sentence', () => {
    expect(countWords('It is a truth')).toBe(4);
  });

  it('is 0 for empty text', () => {
    expect(countWords('')).toBe(0);
  });
});
