/**
 * Converts between a saved place in a book and a spot in a passage.
 *
 * A `Position` counts paragraphs of the passage built from the chapter, and
 * characters within the paragraph: each word's characters plus one for the
 * space after it. Paragraph indexes are passage paragraphs. `buildPassage`
 * drops paragraphs with no words, so books must not contain empty paragraphs
 * (the cleaners guarantee it), or the indexes would shift.
 *
 * Saves happen after each completed word, so resuming restores to the start
 * of a word, never to the middle of one.
 */

import type { Passage } from '../engine/text';
import type { Position } from './types';

/**
 * The saved place for a caret.
 *
 * @param passage The passage the caret belongs to.
 * @param chapter Index of the chapter the passage was built from.
 * @param caret A word and how many characters of it are typed.
 * @returns The paragraph of the word, and the paragraph's characters before the caret.
 */
export function positionOf(passage: Passage, chapter: number, caret: { word: number; char: number }): Position {
  const word = passage.words[caret.word];
  if (word === undefined) return { chapter, paragraph: 0, char: 0 };
  let char = caret.char;
  for (let i = passage.paraStart[word.para]; i < caret.word; i++) char += passage.words[i].chars.length + 1;
  return { chapter, paragraph: word.para, char };
}

/**
 * The word that contains a saved place.
 *
 * Out-of-range values are clamped: a paragraph past the end gives the last
 * word, a character past the end of the paragraph gives the paragraph's last
 * word, and negative values give the first. An offset exactly on a word
 * boundary (just after the space) belongs to the next word.
 *
 * @returns An index into `passage.words`, or 0 for an empty passage.
 */
export function wordAt(passage: Passage, position: Position): number {
  const count = passage.words.length;
  if (count === 0) return 0;
  if (!(position.paragraph >= 0)) return 0;
  if (position.paragraph >= passage.paraStart.length) return count - 1;

  const start = passage.paraStart[position.paragraph];
  const end = passage.paraStart[position.paragraph + 1] ?? count;
  let left = position.char >= 0 ? position.char : 0;
  for (let i = start; i < end; i++) {
    const span = passage.words[i].chars.length + 1;
    if (left < span) return i;
    left -= span;
  }
  return end - 1;
}

/** The saved place at the start of a word. */
export function positionAtWordStart(passage: Passage, chapter: number, word: number): Position {
  return positionOf(passage, chapter, { word, char: 0 });
}
