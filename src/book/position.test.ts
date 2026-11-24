import { describe, expect, it } from 'vitest';
import { buildPassage } from '../engine/text';
import { positionAtWordStart, positionOf, wordAt } from './position';

// Words: ab(0) cd(1) ef(2) | ghi(3) j(4) | kl(5)
const passage = buildPassage(['ab cd ef', 'ghi j', 'kl']);

describe('positionOf', () => {
  it('counts the characters and spaces of earlier words in the paragraph', () => {
    expect(positionOf(passage, 2, { word: 0, char: 0 })).toEqual({ chapter: 2, paragraph: 0, char: 0 });
    expect(positionOf(passage, 2, { word: 2, char: 0 })).toEqual({ chapter: 2, paragraph: 0, char: 6 });
    expect(positionOf(passage, 2, { word: 4, char: 0 })).toEqual({ chapter: 2, paragraph: 1, char: 4 });
  });

  it('adds the caret offset inside the current word', () => {
    expect(positionOf(passage, 0, { word: 1, char: 1 })).toEqual({ chapter: 0, paragraph: 0, char: 4 });
  });

  it('starts each paragraph from zero', () => {
    expect(positionOf(passage, 0, { word: 5, char: 0 })).toEqual({ chapter: 0, paragraph: 2, char: 0 });
  });
});

describe('wordAt', () => {
  it('round-trips every word start across paragraphs', () => {
    passage.words.forEach((_, w) => {
      expect(wordAt(passage, positionAtWordStart(passage, 0, w))).toBe(w);
    });
  });

  it('finds the word containing an offset in the middle of a word', () => {
    expect(wordAt(passage, { chapter: 0, paragraph: 0, char: 4 })).toBe(1);
    expect(wordAt(passage, { chapter: 0, paragraph: 1, char: 2 })).toBe(3);
  });

  it('gives the next word for an offset just after a space', () => {
    expect(wordAt(passage, { chapter: 0, paragraph: 0, char: 2 })).toBe(0); // the space after "ab"
    expect(wordAt(passage, { chapter: 0, paragraph: 0, char: 3 })).toBe(1);
    expect(wordAt(passage, { chapter: 0, paragraph: 1, char: 4 })).toBe(4);
  });

  it('clamps a paragraph past the end to the last word', () => {
    expect(wordAt(passage, { chapter: 0, paragraph: 3, char: 0 })).toBe(5);
    expect(wordAt(passage, { chapter: 0, paragraph: 99, char: 2 })).toBe(5);
  });

  it('clamps a char past the paragraph end to the paragraph last word', () => {
    expect(wordAt(passage, { chapter: 0, paragraph: 0, char: 999 })).toBe(2);
    expect(wordAt(passage, { chapter: 0, paragraph: 1, char: 999 })).toBe(4);
  });

  it('gives the first word for negative values', () => {
    expect(wordAt(passage, { chapter: 0, paragraph: -1, char: 5 })).toBe(0);
    expect(wordAt(passage, { chapter: 0, paragraph: 1, char: -5 })).toBe(3);
  });

  it('copes with an empty passage', () => {
    expect(wordAt(buildPassage([]), { chapter: 0, paragraph: 2, char: 2 })).toBe(0);
  });

  it('resumes at the start of the word for a mid-word caret saved earlier', () => {
    const saved = positionOf(passage, 0, { word: 2, char: 1 });
    expect(wordAt(passage, saved)).toBe(2);
  });
});
