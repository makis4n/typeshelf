/**
 * Turns book text into what the typing engine works on: paragraphs of words,
 * each word a list of characters to type.
 *
 * Books are printed with characters most keyboards cannot type directly
 * (curly quotes, long dashes). Each character keeps its printed form for
 * display and lists every key that is accepted for it.
 */

/** One character the reader has to type. */
export interface TargetChar {
  /** The character as printed in the book. */
  glyph: string;
  /** Every character the keyboard may send for it, concatenated. */
  accepts: string;
}

export interface Word {
  chars: TargetChar[];
  /** Index of the paragraph the word belongs to. */
  para: number;
  /** True for the last word of its paragraph. */
  endsPara: boolean;
}

export interface Passage {
  words: Word[];
  /** Index into `words` of the first word of each paragraph. */
  paraStart: number[];
}

export interface TextOptions {
  /** Accept the plain letter for an accented one ("e" for "é"). Default false. */
  relaxedAccents?: boolean;
}

/** Printed characters that have a plain key on every keyboard. */
const KEYBOARD_EQUIVALENT: Record<string, string> = {
  '‘': "'", // ‘
  '’': "'", // ’
  '‚': "'", // ‚
  '‛': "'", // ‛
  '′': "'", // ′
  '“': '"', // “
  '”': '"', // ”
  '„': '"', // „
  '″': '"', // ″
  '«': '"', // «
  '»': '"', // »
  '‐': '-', // hyphen
  '‑': '-', // non-breaking hyphen
  '‒': '-', // figure dash
  '–': '-', // en dash
  '—': '-', // em dash
  '―': '-', // horizontal bar
  '−': '-', // minus sign
};

/**
 * Characters rewritten before the text is split, so that every glyph left on
 * the page is exactly one key press.
 */
const REWRITES: [RegExp, string][] = [
  [/…/g, '...'], // ellipsis
  [/ﬀ/g, 'ff'],
  [/ﬁ/g, 'fi'],
  [/ﬂ/g, 'fl'],
  [/ﬃ/g, 'ffi'],
  [/ﬄ/g, 'ffl'],
  // Soft hyphens and zero-width characters are invisible and cannot be typed.
  [/[­​‌‍⁠﻿]/g, ''],
];

function clean(text: string): string {
  let out = text.normalize('NFC');
  for (const [pattern, replacement] of REWRITES) out = out.replace(pattern, replacement);
  return out;
}

function target(glyph: string, options: TextOptions): TargetChar {
  let accepts = glyph;
  const plain = KEYBOARD_EQUIVALENT[glyph];
  if (plain !== undefined) accepts += plain;
  if (options.relaxedAccents) {
    const base = glyph.normalize('NFD').replace(/\p{M}+/gu, '');
    if (base.length > 0 && !accepts.includes(base)) accepts += base;
  }
  return { glyph, accepts };
}

/** True when text has at least one word to type, which is when `buildPassage` keeps it as a paragraph. */
export function hasWords(text: string): boolean {
  return /\S/u.test(clean(text));
}

/** True when `typed` (one character) is an accepted key for `char`. */
export function isAccepted(char: TargetChar, typed: string): boolean {
  return typed.length > 0 && char.accepts.includes(typed);
}

/**
 * Builds a passage from paragraphs of plain text. Runs of whitespace of any
 * kind (including non-breaking spaces and line breaks) separate words, and
 * paragraphs with no words are dropped.
 */
export function buildPassage(paragraphs: readonly string[], options: TextOptions = {}): Passage {
  const words: Word[] = [];
  const paraStart: number[] = [];

  for (const raw of paragraphs) {
    const tokens = clean(raw).split(/\s+/u).filter((token) => token.length > 0);
    if (tokens.length === 0) continue;

    const para = paraStart.length;
    paraStart.push(words.length);
    tokens.forEach((token, i) => {
      words.push({
        chars: Array.from(token, (glyph) => target(glyph, options)),
        para,
        endsPara: i === tokens.length - 1,
      });
    });
  }

  return { words, paraStart };
}
