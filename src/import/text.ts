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
const ORDINAL_UNITS = 'first|second|third|fourth|fifth|sixth|seventh|eighth|ninth';
const TENS = 'twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety';
const NUMBER_WORDS =
  `(?:(?:${TENS})(?:[ -](?:${UNITS}|${ORDINAL_UNITS}))?|${UNITS}|${ORDINAL_UNITS}` +
  '|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen' +
  '|tenth|eleventh|twelfth|thirteenth|fourteenth|fifteenth|sixteenth|seventeenth|eighteenth|nineteenth' +
  '|twentieth|thirtieth|fortieth|fiftieth|sixtieth|seventieth|eightieth|ninetieth|last)';
/** A number as headings write it: digits, a roman numeral, or words up to ninety-nine ("Twenty-One", "Thirteenth"). Regex source, case to be ignored. */
export const HEADING_NUMBER = `(?:\\d{1,4}|[ivxlcdm]+|${NUMBER_WORDS})`;
const NUMBER = HEADING_NUMBER;

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
  const close = () => {
    // A long run of lines that wrapping did not produce: each line is its own paragraph.
    if (isUnwrapped(current)) for (const line of current) blocks.push([line]);
    else if (current.length > 0) blocks.push(current);
    current = [];
  };
  for (const line of lines) {
    if (line.length > 0) current.push(line);
    else close();
  }
  close();
  return blocks;
}

/** More lines than a wrapped paragraph plausibly has before its line breaks are questioned. */
const LONG_BLOCK = 40;

/** Ends a sentence, in Latin and in CJK writing, with any closing quotes or brackets after it. */
const SENTENCE_END = /[.!?…。！？‥][\s"'”’»）)」』\]]*$/u;

/**
 * True for a long block that is a list of one-line paragraphs written without
 * blank lines between them, not one wrapped paragraph. Either sign is enough:
 *
 * - Its lines are of very uneven length. Wrapping fills every line but the
 *   last to nearly the same width. (The width is taken a little under the
 *   longest line, so that a single overlong line does not make the rest look short.)
 * - Nearly every line ends a sentence. Wrapping breaks lines wherever the
 *   width runs out, which is rarely at a full stop.
 */
function isUnwrapped(block: string[]): boolean {
  if (block.length <= LONG_BLOCK) return false;
  const body = block.slice(0, -1);
  const lengths = body.map((line) => line.length).sort((a, b) => a - b);
  const widest = lengths[Math.floor((lengths.length - 1) * 0.95)]!;
  const full = body.filter((line) => line.length >= widest * 0.6).length;
  if (full < body.length * 0.85) return true;
  return body.filter((line) => SENTENCE_END.test(line)).length >= body.length * 0.9;
}

/** "Title: Emma" and "Author: Jane Austen" lines, as found at the top of Project Gutenberg files. */
function headerField(text: string, name: string): string | undefined {
  const top = text.slice(0, 5000);
  return new RegExp(`^[ \\t]*${name}:[ \\t]*(\\S.*)$`, 'im').exec(top)?.[1]?.trim();
}

const GUTENBERG_START = /^[ \t]*\*{3} ?START OF (?:THE|THIS) PROJECT GUTENBERG EBOOK[^*]{0,400}\*{3}[ \t]*$/m;
/** The END line, or its older wording, which only counts as a line standing on its own. */
const GUTENBERG_END = /^[ \t]*\*{3} ?END OF (?:THE|THIS) PROJECT GUTENBERG EBOOK\b/;
const GUTENBERG_OLD_END = /^[ \t]*End of (?:[Tt]he )?Project Gutenberg(?:['’]s| E[Bb]ook| Etext)\b/;

/**
 * Project Gutenberg files wrap the book in a notice at the top and a long
 * licence at the bottom. Only the book between the two marker lines is kept.
 * The markers are matched exactly as Project Gutenberg writes them, and an
 * ending is only looked for after a START line: a book that merely mentions
 * Project Gutenberg is returned as it is.
 */
export function stripGutenbergNotice(text: string): string {
  const unix = text.replace(/\r\n?/g, '\n');
  const start = GUTENBERG_START.exec(unix);
  if (!start) return text;
  const lines = unix.slice(start.index + start[0].length).split('\n');
  const blank = (line: string | undefined) => line === undefined || line.trim() === '';
  const end = lines.findIndex(
    (line, i) =>
      GUTENBERG_END.test(line) || (GUTENBERG_OLD_END.test(line) && blank(lines[i - 1]) && blank(lines[i + 1])),
  );
  return (end < 0 ? lines : lines.slice(0, end)).join('\n');
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
