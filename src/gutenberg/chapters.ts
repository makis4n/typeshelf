/**
 * Splits cleaned blocks of text into chapters: finds headings ("CHAPTER I",
 * "Book Two", a bare "IV."), drops a table of contents, and decides what to
 * do with the text before the first heading.
 */

import type { Chapter } from '../book/types';

/** A block is the trimmed, non-empty lines between two blank lines. */
export type Block = string[];

const KEYWORDS = 'chapter|book|part|act|scene|volume|letter|stave|section';
const KEYWORD_LINE = new RegExp(`^(${KEYWORDS})\\s+(.+)$`, 'iu');
const NUMBER_WORDS = new Set(
  (
    'one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen ' +
    'sixteen seventeen eighteen nineteen twenty thirty forty fifty sixty seventy eighty ninety ' +
    'hundred first second third fourth fifth sixth seventh eighth ninth tenth last final'
  ).split(' '),
);
const ROMAN = /^(?=[IVXLCDM])M{0,3}(CM|CD|D?C{0,3})(XC|XL|L?X{0,3})(IX|IV|V?I{0,3})$/u;
const CONTENTS_LINE = /^(?:table of )?contents\.?$/iu;
const SEPARATOR = /[.:]|—|–|--|\s-\s/u;

/** Longest line that can belong to a heading, subtitle or contents entry. */
const SHORT_LINE = 70;
/** A heading with an inline subtitle is never longer than this. */
const LONG_SUBTITLE = 80;
/** Prose paragraphs needed before the text ahead of the first heading is kept. */
const PRELUDE_PROSE_PARAGRAPHS = 3;
const PROSE_WORDS = 8;

function isNumeral(label: string): boolean {
  const text = label.trim().replace(/^the\s+/iu, '');
  if (/^\d{1,4}$/u.test(text)) return true;
  if (/^[ivxlcdm]+$/iu.test(text)) return ROMAN.test(text.toUpperCase());
  const words = text.toLowerCase().split(/[\s-]+/u);
  return words.length <= 3 && words.every((word) => NUMBER_WORDS.has(word));
}

interface ParsedHeading {
  /** "CHAPTER I", as printed but without trailing punctuation. */
  label: string;
  /** Subtitle written on the same line, or an empty string. */
  after: string;
}

/** Reads one line as a heading, or returns null when it is not one. */
export function parseHeading(line: string): ParsedHeading | null {
  const text = line.trim();

  const bare = /^([IVXLCDM]+)\.?$/u.exec(text);
  if (bare !== null) return ROMAN.test(bare[1]) ? { label: bare[1], after: '' } : null;

  const keyword = KEYWORD_LINE.exec(text);
  if (keyword === null) return null;
  const rest = keyword[2];
  const cut = SEPARATOR.exec(rest);
  const label = (cut === null ? rest : rest.slice(0, cut.index)).trim();
  const after = cut === null ? '' : rest.slice(cut.index).replace(/^[\s.:—–-]+/u, '').trim();
  if (!isNumeral(label) || after.length > LONG_SUBTITLE) return null;
  return { label: `${keyword[1]} ${label}`, after };
}

function headingOfBlock(block: Block): ParsedHeading | null {
  if (block.length > 3 || block.slice(1).some((line) => line.length > SHORT_LINE)) return null;
  return parseHeading(block[0]);
}

const isAllCaps = (text: string): boolean => /\p{L}/u.test(text) && text === text.toUpperCase();

/** True for a short block with no sentence ending, which reads as a chapter's title. */
function isSubtitle(block: Block): boolean {
  if (block.length > 2 || block.some((line) => line.length > SHORT_LINE)) return false;
  if (headingOfBlock(block) !== null) return false;
  const text = block.join(' ');
  return !/[.,;:?!"'”’)]$/u.test(text) || isAllCaps(text);
}

/**
 * Removes a "CONTENTS" block and the short entries after it. The list ends at
 * the first block with a long line (prose) or at the first heading that the
 * list already mentioned, which is the real start of the text. Nothing is
 * removed unless at least three entries follow, so a stray word "contents" is safe.
 */
function dropContents(blocks: Block[]): Block[] {
  const start = blocks.findIndex((block) => CONTENTS_LINE.test(block[0]));
  if (start < 0) return blocks;

  const seen = new Set<string>();
  let entries = blocks[start].length - 1;
  let end = start + 1;
  for (; end < blocks.length; end++) {
    const block = blocks[end];
    if (block.some((line) => line.length > SHORT_LINE)) break;
    const first = parseHeading(block[0]);
    if (first !== null && seen.has(first.label.toUpperCase())) break;
    for (const line of block) {
      const heading = parseHeading(line);
      if (heading !== null) seen.add(heading.label.toUpperCase());
    }
    entries += block.length;
  }
  if (blocks[start].some((line) => line.length > SHORT_LINE) || entries < 3) return blocks;
  return [...blocks.slice(0, start), ...blocks.slice(end)];
}

/** Joins wrapped lines with one space; a line ending in a hyphen is joined without one. */
export function joinLines(lines: readonly string[]): string {
  let out = '';
  for (const raw of lines) {
    const line = raw.replace(/\s+/gu, ' ').trim();
    if (line === '') continue;
    if (out === '') out = line;
    else out += /\S-$/u.test(out) ? line : ` ${line}`;
  }
  return out;
}

const hasContent = (text: string): boolean => /[\p{L}\p{N}]/u.test(text);
const wordCount = (text: string): number => text.split(/\s+/u).length;

/**
 * Turns blocks into chapters.
 *
 * Text before the first heading is kept, titled with the book title, only
 * when it holds a few paragraphs of prose. With no headings at all the whole
 * text is one chapter. Chapters without paragraphs are dropped.
 *
 * @param blocks Blocks of text, credits and notes already removed.
 * @param bookTitle Title used for text that is not under a heading.
 */
export function buildChapters(blocks: readonly Block[], bookTitle: string): Chapter[] {
  const items = dropContents([...blocks]);

  const prelude: string[] = [];
  const chapters: Chapter[] = [];
  let current: Chapter | undefined;

  for (let i = 0; i < items.length; i++) {
    const block = items[i];
    const heading = headingOfBlock(block);
    if (heading !== null) {
      let subtitle = [heading.after, ...block.slice(1)].filter(Boolean).join(' ');
      if (subtitle === '' && block.length === 1 && i + 1 < items.length && isSubtitle(items[i + 1])) {
        subtitle = joinLines(items[++i]);
      }
      current = {
        title: subtitle === '' ? heading.label : `${heading.label}: ${subtitle}`,
        paragraphs: [],
      };
      chapters.push(current);
      continue;
    }
    const paragraph = joinLines(block);
    // Lines of "* * *" or dashes are scene breaks; there is nothing to type in them.
    if (!hasContent(paragraph)) continue;
    (current === undefined ? prelude : current.paragraphs).push(paragraph);
  }

  const prose = prelude.filter((p) => wordCount(p) >= PROSE_WORDS).length;
  if (chapters.length === 0 || prose >= PRELUDE_PROSE_PARAGRAPHS) {
    chapters.unshift({ title: bookTitle, paragraphs: prelude });
  }
  return chapters.filter((chapter) => chapter.paragraphs.length > 0);
}
