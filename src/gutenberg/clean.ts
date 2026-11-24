/**
 * Turns the plain-text (UTF-8) file of a Project Gutenberg ebook into a
 * `Book`: boilerplate, credits, footnotes and markup are removed, wrapped
 * lines become paragraphs, and the text is split into chapters.
 *
 * Framework-free and free of Node-only APIs, so it runs in the browser and in
 * a Cloudflare Worker.
 */

import type { Book } from '../book/types';
import { buildChapters, type Block } from './chapters';
import { parseHeader } from './metadata';

/** Thrown when the text is not a Project Gutenberg ebook (no start marker). */
export class GutenbergFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GutenbergFormatError';
  }
}

const START_MARKER = /^\s*\*{3}\s*START OF (?:THE|THIS)\s+PROJECT GUTENBERG/iu;
const END_MARKER = /^\s*\*{3}\s*END OF (?:THE|THIS)\s+PROJECT GUTENBERG/iu;
/** Older files, and files whose end marker is missing. */
const FALLBACK_END = /^\s*End of (?:the )?Project Gutenberg(?:'s|\s+EBook)/iu;
const FOOTNOTES_HEADING = /^\s*FOOTNOTES?:?\s*$/u;
const CREDITS =
  /^(?:produced by|e-?text (?:prepared|produced) by|transcribed (?:from|by)|prepared by|this e-?text was (?:produced|prepared))/iu;
const TRANSCRIBER_NOTE = /^transcriber['’]?s?\s+notes?\b/iu;
const BRACKET_OPEN = /\[(?:Illustration|Footnote|Transcriber)/giu;
const FOOTNOTE_MARKER = /[ \t]*\[(?:\d{1,3}|[A-Z]|\*)\]/gu;
const UNDERSCORE_EMPHASIS = /(?<![\p{L}\p{N}_])_((?:[^_\n]|\n(?![ \t]*\n))+?)_(?![\p{L}\p{N}_])/gu;
const ASTERISK_EMPHASIS = /\*(?=\S)((?:[^*\n]|\n(?![ \t]*\n))+?)(?<=\S)\*/gu;

/** Lowercase hex SHA-256 of the text's UTF-8 bytes. */
async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Removes `[Illustration…]`, `[Footnote N: …]` and `[Transcriber's Note: …]`
 * wherever they are, including ones that span lines and paragraphs. Brackets
 * inside them are matched in pairs. One that never closes is cut at the end
 * of its paragraph.
 */
function stripBracketed(text: string): string {
  let out = '';
  let pos = 0;
  for (;;) {
    BRACKET_OPEN.lastIndex = pos;
    const open = BRACKET_OPEN.exec(text);
    if (open === null) break;
    out += text.slice(pos, open.index);

    let end = -1;
    let depth = 0;
    for (let i = open.index; i < text.length; i++) {
      if (text[i] === '[') depth++;
      else if (text[i] === ']' && --depth === 0) {
        end = i + 1;
        break;
      }
    }
    if (end < 0) {
      const blank = text.indexOf('\n\n', open.index);
      end = blank < 0 ? text.length : blank;
    }
    pos = end;
  }
  return out + text.slice(pos);
}

/** Cuts a trailing FOOTNOTES section (from its last heading to the end). */
function stripFootnoteSection(lines: string[]): string[] {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (FOOTNOTES_HEADING.test(lines[i])) return lines.slice(0, i);
  }
  return lines;
}

/** Splits lines into blocks at blank lines. Each line is trimmed. */
function toBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  let current: Block = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '') {
      if (current.length > 0) blocks.push(current);
      current = [];
    } else {
      current.push(line);
    }
  }
  if (current.length > 0) blocks.push(current);
  return blocks;
}

/** Drops production credits right after the start marker, and transcriber's note blocks. */
function dropCreditsAndNotes(blocks: Block[]): Block[] {
  let first = 0;
  while (first < blocks.length && CREDITS.test(blocks[first][0])) first++;
  return blocks.slice(first).filter((block) => !TRANSCRIBER_NOTE.test(block[0]));
}

/**
 * Cleans the raw text of a Project Gutenberg ebook into a `Book`.
 *
 * @param raw The downloaded plain-text file (a leading BOM and CRLF are fine).
 * @param id The Gutenberg ebook number.
 * @returns The book, with `id` `gutenberg:<id>` and the SHA-256 of `raw` as fingerprint.
 * @throws GutenbergFormatError When no "*** START OF THE PROJECT GUTENBERG EBOOK" line exists.
 */
export async function cleanGutenberg(raw: string, id: number): Promise<Book> {
  const lines = raw.replace(/^\uFEFF/u, '').replace(/\r\n?/gu, '\n').split('\n');

  const start = lines.findIndex((line) => START_MARKER.test(line));
  if (start < 0) throw new GutenbergFormatError('No "START OF THE PROJECT GUTENBERG EBOOK" line found');

  const after = lines.slice(start + 1);
  let end = after.findIndex((line) => END_MARKER.test(line));
  if (end < 0) end = after.findIndex((line) => FALLBACK_END.test(line));
  const body = stripFootnoteSection(end < 0 ? after : after.slice(0, end));

  const meta = parseHeader(lines.slice(0, start));
  const title = meta.title ?? 'Untitled';

  const text = stripBracketed(body.join('\n'))
    .replace(FOOTNOTE_MARKER, '')
    .replace(UNDERSCORE_EMPHASIS, '$1')
    .replace(ASTERISK_EMPHASIS, '$1');

  return {
    id: `gutenberg:${id}`,
    title,
    author: meta.author ?? 'Unknown',
    language: meta.language,
    source: 'gutenberg',
    fingerprint: await sha256Hex(raw),
    chapters: buildChapters(dropCreditsAndNotes(toBlocks(text)), title),
  };
}
