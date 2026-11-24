/**
 * Plain text import.
 *
 * Paragraphs are separated by blank lines, and lines broken at a fixed width
 * ("hard-wrapped", as in Project Gutenberg files) are joined back together.
 * Lines such as "Chapter 1" or "CHAPTER IV." start a new chapter; a file with
 * no such lines is one chapter.
 */

import type { Book } from '../book/types';
import { decodeText } from './decode';
import { collapse } from './markup';
import { assembleBook, type Draft, type DraftChapter, type FileInfo } from './shape';

const UNITS = 'one|two|three|four|five|six|seven|eight|nine';
const NUMBER_WORDS =
  `(?:${UNITS}|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen` +
  `|(?:twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)(?:[ -](?:${UNITS}))?` +
  `|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth|last)`;
const NUMBER = `(?:\\d{1,4}|[ivxlcdm]+|${NUMBER_WORDS})`;

/** "Chapter 1", "CHAPTER IV. The Storm", "Book the First", "Part Two: Winter". */
const KEYWORD_HEADING = new RegExp(
  `^(?:chapter|book|part|volume|act|canto|stave|letter|section)\\s+(?:the\\s+)?${NUMBER}(?![\\w'’])\\s*[.:—–-]?\\s*(.*)$`,
  'i',
);
/** A heading that is one word on its own. */
const NAMED_HEADING = /^(?:prologue|epilogue|preface|introduction|foreword|afterword|interlude)\.?$/i;
/** A number alone on a line: "IV." or "12". Only trusted when a file has several. */
const NUMERAL_HEADING = /^(?:[IVXLCDM]+|\d{1,3})\.?$/;

const MAX_HEADING_LENGTH = 80;
/** Lines in hard-wrapped text are at most about 80 characters; allow some slack. */
const WRAP_WIDTH = 100;

type HeadingKind = 'keyword' | 'numeral';

function headingKind(line: string): HeadingKind | undefined {
  if (line.length > MAX_HEADING_LENGTH) return undefined;
  if (NAMED_HEADING.test(line)) return 'keyword';
  if (NUMERAL_HEADING.test(line)) return 'numeral';
  const match = KEYWORD_HEADING.exec(line);
  if (!match) return undefined;
  // "Part one of the plan failed." is a sentence, not a heading: after the
  // number, a heading's own title starts with a capital (or the line is all capitals).
  const rest = match[1]!;
  if (rest.length > 0 && /^\p{Ll}/u.test(rest) && line !== line.toUpperCase()) return undefined;
  return 'keyword';
}

/** "CHAPTER I." gives "CHAPTER I"; inner spacing is tidied. */
function headingTitle(lines: string[]): string {
  return lines
    .map((line) => collapse(line).replace(/[.:]$/, ''))
    .filter((line) => line.length > 0)
    .join(': ');
}

/**
 * Splits text into blocks of lines. In hard-wrapped text a block is the lines
 * between blank lines; otherwise every line is a paragraph of its own.
 */
function blocksOf(text: string): string[][] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n').map((line) => line.trim());
  const filled = lines.filter((line) => line.length > 0);
  const long = filled.filter((line) => line.length > WRAP_WIDTH).length;
  const wrapped = long <= filled.length * 0.02;
  if (!wrapped) return filled.map((line) => [line]);

  const blocks: string[][] = [];
  let current: string[] = [];
  for (const line of lines) {
    if (line.length > 0) {
      current.push(line);
    } else if (current.length > 0) {
      blocks.push(current);
      current = [];
    }
  }
  if (current.length > 0) blocks.push(current);
  return blocks;
}

/** "Title: Emma" and "Author: Jane Austen" lines, as found at the top of Project Gutenberg files. */
function headerField(text: string, name: string): string | undefined {
  const top = text.slice(0, 5000);
  return new RegExp(`^[ \\t]*${name}:[ \\t]*(\\S.*)$`, 'im').exec(top)?.[1]?.trim();
}

const GUTENBERG_START = /^[ \t]*\*{3}\s*START OF (?:THE|THIS) PROJECT GUTENBERG EBOOK[^*]{0,400}\*{3}[ \t]*$/im;
const GUTENBERG_END =
  /^[ \t]*(?:\*{3}\s*END OF (?:THE|THIS) PROJECT GUTENBERG EBOOK|End of (?:the )?Project Gutenberg(?:['’]s)? )/im;

/**
 * Project Gutenberg files wrap the book in a notice at the top and a long
 * licence at the bottom. Only the book between the two marker lines is kept.
 * Text without the markers is returned as it is.
 */
export function stripGutenbergNotice(text: string): string {
  const start = GUTENBERG_START.exec(text);
  const book = start ? text.slice(start.index + start[0].length) : text;
  const end = GUTENBERG_END.exec(book);
  return end ? book.slice(0, end.index) : book;
}

/** Splits decoded text into chapters. Exported for tests. */
export function chaptersFromText(text: string): DraftChapter[] {
  const blocks = blocksOf(text);

  // Find the headings first: a lone number only counts when the file has several.
  const kinds = blocks.map((block) => {
    if (block.length === 1) return headingKind(block[0]!);
    // "CHAPTER I." with its title on the next line.
    if (block.length === 2 && block[1]!.length <= MAX_HEADING_LENGTH) {
      const kind = headingKind(block[0]!);
      return kind === 'keyword' && KEYWORD_HEADING.exec(block[0]!)?.[1] === '' ? kind : undefined;
    }
    return undefined;
  });
  const numerals = kinds.filter((kind) => kind === 'numeral').length;

  const chapters: DraftChapter[] = [];
  let current: DraftChapter = { paragraphs: [] };
  blocks.forEach((block, i) => {
    const kind = kinds[i];
    if (kind === 'keyword' || (kind === 'numeral' && numerals >= 2)) {
      chapters.push(current);
      current = { title: headingTitle(block), paragraphs: [] };
    } else {
      current.paragraphs.push(block.join(' '));
    }
  });
  chapters.push(current);

  // Text before the first heading (a title page, a dedication) is kept as its own chapter.
  if (chapters.length > 1 && chapters[0]!.paragraphs.length > 0) chapters[0]!.title = 'Opening';
  return chapters;
}

/** Imports a plain text file. */
export function parseText(bytes: Uint8Array, file: FileInfo): Book {
  const text = decodeText(bytes);
  const draft: Draft = {
    source: 'text',
    title: headerField(text, 'Title'),
    author: headerField(text, 'Author'),
    chapters: chaptersFromText(stripGutenbergNotice(text)),
  };
  return assembleBook(draft, file);
}
