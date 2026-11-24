/**
 * Markdown import.
 *
 * Headings become chapters, and everything else is reduced to the words a
 * reader would see: emphasis marks, link targets, code fences and list bullets
 * are stripped, images and footnotes are dropped.
 *
 * This reads the common subset of Markdown, not every corner of the spec.
 */

import type { Book } from '../book/types';
import { decodeText } from './decode';
import { collapse, decodeEntities } from './markup';
import { assembleBook, type Draft, type DraftChapter, type FileInfo } from './shape';

type Block = { kind: 'heading'; level: number; text: string } | { kind: 'para'; text: string };

const FENCE = /^(`{3,}|~{3,})/;
const ATX_HEADING = /^(#{1,6})(?:\s+(.*?))?(?:\s+#+)?\s*$/;
const RULE = /^(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$/;
const LIST_ITEM = /^(?:[-*+]|(\d{1,9})[.)])\s+(?:\[[ xX]\]\s+)?(.*)$/;
const LINK_DEFINITION = /^\[[^\]]+\]:\s*\S+/;
const FOOTNOTE_DEFINITION = /^\[\^[^\]]+\]:/;
/** "Part One", "Book II", "Volume 3": a heading that groups chapters. "Part of the Furniture" is not one. */
const PART_HEADING =
  /^(?:part|book|volume)\s+(?:the\s+)?(?:\d+|[ivxlcdm]+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|last)(?![\w'’])/i;
const TABLE_DIVIDER = /^\|?\s*:?-{2,}:?\s*(?:\|\s*:?-{2,}:?\s*)*\|?$/;

/** Removes `<!-- comments -->`. An opening with no closing is left as written. */
function removeComments(text: string): string {
  let out = '';
  let from = 0;
  for (;;) {
    const open = text.indexOf('<!--', from);
    const close = open < 0 ? -1 : text.indexOf('-->', open + 4);
    if (close < 0) return out + text.slice(from);
    out += text.slice(from, open);
    from = close + 3;
  }
}

/** Replaces `code` and ``code`` spans with their contents. A run of backticks closes at the next run of the same length. */
function unwrapCode(text: string): string {
  if (!text.includes('`')) return text;
  const runs = [...text.matchAll(/`+/g)].map((match) => ({ at: match.index, length: match[0].length }));
  // For each length, the runs of that length, and how far along that list we are.
  const sameLength = new Map<number, number[]>();
  runs.forEach((run, i) => {
    const list = sameLength.get(run.length);
    if (list) list.push(i);
    else sameLength.set(run.length, [i]);
  });
  const next = new Map<number, number>();

  let out = '';
  let from = 0;
  for (let i = 0; i < runs.length; i++) {
    const run = runs[i]!;
    const candidates = sameLength.get(run.length)!;
    let pointer = next.get(run.length) ?? 0;
    while (pointer < candidates.length && candidates[pointer]! <= i) pointer++;
    next.set(run.length, pointer);
    const closing = candidates[pointer];
    if (closing === undefined) continue; // no partner: the backticks stay as text
    out += text.slice(from, run.at) + text.slice(run.at + run.length, runs[closing]!.at).trim();
    from = runs[closing]!.at + run.length;
    i = closing;
  }
  return out + text.slice(from);
}

/** Reduces one line or paragraph of Markdown to the text a reader sees. */
export function stripInline(source: string): string {
  let text = source;
  // Backslash escapes are parked as private-use characters so the rules below leave them alone.
  const escaped: string[] = [];
  text = text.replace(/\\([!-/:-@[-`{-~])/g, (_, char: string) => {
    escaped.push(char);
    return String.fromCharCode(0xe000 + escaped.length - 1);
  });

  // Every rule below stops at the next character that could end it, so a long
  // paragraph of unclosed marks is still read in one pass.
  text = removeComments(text);
  text = unwrapCode(text);
  text = text.replace(/!\[[^[\]]*\](?:\((?:[^()]|\([^()]*\))*\)|\[[^[\]]*\])?/g, ''); // images
  text = text.replace(/\[\^[^[\]]+\]/g, ''); // footnote markers
  text = text.replace(/\[([^[\]]*)\]\((?:[^()]|\([^()]*\))*\)/g, '$1'); // [text](address)
  text = text.replace(/\[([^[\]]+)\]\[[^[\]]*\]/g, '$1'); // [text][reference]
  text = text.replace(/<((?:https?:\/\/|mailto:)[^<>\s]+)>/g, '$1'); // <address>
  text = text.replace(/<\/?[A-Za-z][^<>]*>/g, ''); // inline HTML tags
  text = text.replace(/(\*\*|__)(?=\S)((?:(?!\1)[\s\S])*?\S)\1/g, '$2');
  text = text.replace(/\*(?=\S)([^*]*?\S)\*/g, '$1');
  // Underscores only mark emphasis at the edges of words, so snake_case survives.
  text = text.replace(/(^|[^\p{L}\p{N}_])_(?=\S)([^_]*?\S)_(?![\p{L}\p{N}_])/gu, '$1$2');
  text = text.replace(/~~(?=\S)((?:(?!~~)[\s\S])*?\S)~~/g, '$1');
  text = decodeEntities(text);

  text = text.replace(/[-]/g, (char) => escaped[char.charCodeAt(0) - 0xe000] ?? char);
  return collapse(text);
}

/** `key: value` lines between `---` markers at the very top of the file. */
function frontMatter(lines: string[]): { fields: Record<string, string>; rest: string[] } {
  if (lines[0]?.trim() !== '---') return { fields: {}, rest: lines };
  const end = lines.findIndex((line, i) => i > 0 && /^(?:---|\.\.\.)\s*$/.test(line));
  if (end < 0) return { fields: {}, rest: lines };
  // A file can also simply open with a `---` rule. It is front matter only when
  // what follows reads as settings: `key: value` lines, list items, indented values, comments.
  const inside = lines.slice(1, end).filter((line) => line.trim().length > 0);
  const settings = inside.every((line) => /^(?:[A-Za-z_][\w-]*:(?:\s|$)|\s+\S|-\s|#)/.test(line));
  if (!settings || !inside.some((line) => /^[A-Za-z_][\w-]*:(?:\s|$)/.test(line))) return { fields: {}, rest: lines };
  const fields: Record<string, string> = {};
  for (const line of lines.slice(1, end)) {
    const match = /^([A-Za-z_-]+):\s*(.*)$/.exec(line);
    if (match) fields[match[1]!.toLowerCase()] = match[2]!.trim().replace(/^(["'])(.*)\1$/, '$2');
  }
  return { fields, rest: lines.slice(end + 1) };
}

function blocksOf(lines: string[]): Block[] {
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  /** True while `paragraph` is a list item, so the next numbered line is the next item. */
  let inList = false;
  const flush = () => {
    if (paragraph.length > 0) blocks.push({ kind: 'para', text: stripInline(paragraph.join(' ')) });
    paragraph = [];
    inList = false;
  };

  for (let i = 0; i < lines.length; i++) {
    // Quote marks at the start of a line are dropped; the quoted text is kept.
    const line = lines[i]!.replace(/^\s*(?:>\s?)+/, '').trim();

    const fence = FENCE.exec(line);
    if (fence) {
      flush();
      // Code is kept as written, one paragraph per line.
      for (i++; i < lines.length && !lines[i]!.trim().startsWith(fence[1]!); i++) {
        const code = collapse(lines[i]!);
        if (code.length > 0) blocks.push({ kind: 'para', text: code });
      }
      continue;
    }

    if (line.length === 0) {
      flush();
      continue;
    }
    // A line of = or - under a paragraph makes that paragraph a heading.
    if (paragraph.length > 0 && /^(?:=+|-+)$/.test(line)) {
      const text = stripInline(paragraph.join(' '));
      paragraph = [];
      blocks.push({ kind: 'heading', level: line[0] === '=' ? 1 : 2, text });
      continue;
    }
    if (RULE.test(line) || LINK_DEFINITION.test(line) || FOOTNOTE_DEFINITION.test(line) || TABLE_DIVIDER.test(line)) {
      flush();
      continue;
    }
    const heading = ATX_HEADING.exec(line);
    if (heading) {
      flush();
      blocks.push({ kind: 'heading', level: heading[1]!.length, text: stripInline(heading[2] ?? '') });
      continue;
    }
    const item = LIST_ITEM.exec(line);
    // In the middle of a paragraph only "1." starts a numbered list (the Markdown rule);
    // a wrapped line that happens to begin "1945." is still the same sentence.
    if (item && (paragraph.length === 0 || inList || item[1] === undefined || Number(item[1]) === 1)) {
      flush();
      paragraph.push(item[2]!);
      inList = true;
      continue;
    }
    if (line.startsWith('|')) {
      // A table row: its cells, read left to right.
      flush();
      paragraph.push(line.replace(/\|/g, ' '));
      flush();
      continue;
    }
    paragraph.push(line.replace(/\\$/, ''));
  }
  flush();
  return blocks.filter((block) => block.text.length > 0);
}

/** Splits Markdown into a title and chapters. Exported for tests. */
export function draftFromMarkdown(markdown: string): Draft {
  const { fields, rest } = frontMatter(markdown.replace(/\r\n?/g, '\n').split('\n'));
  const blocks = blocksOf(rest);

  // Chapters start at the highest heading level that is used more than once.
  // A single higher heading above them (usually "# Book title") is the title.
  const counts = new Map<number, number>();
  for (const block of blocks) if (block.kind === 'heading') counts.set(block.level, (counts.get(block.level) ?? 0) + 1);
  const levels = [...counts.keys()].sort((a, b) => a - b);
  let chapterLevel = levels.find((level) => counts.get(level)! >= 2) ?? levels[0] ?? 0;
  // "Part One", "Book II" over a repeated lower level: the parts group chapters, they are not the chapters.
  const below = levels.find((level) => level > chapterLevel && counts.get(level)! >= 2);
  // Other headings may sit beside the parts ("Prologue", "Epilogue"), as long as every lower heading is inside a part.
  if (below !== undefined) {
    let insidePart = false;
    let parts = 0;
    let strays = 0;
    for (const block of blocks) {
      if (block.kind !== 'heading') continue;
      if (block.level === chapterLevel) {
        insidePart = PART_HEADING.test(block.text);
        if (insidePart) parts++;
      } else if (block.level === below && !insidePart) {
        strays++;
      }
    }
    if (parts > 0 && strays === 0) chapterLevel = below;
  }

  const firstHeading = blocks.find((block) => block.kind === 'heading');
  const titleHeading =
    firstHeading && firstHeading.level < chapterLevel && counts.get(firstHeading.level) === 1 ? firstHeading : undefined;
  let title: string | undefined = titleHeading?.text;
  if (!title && firstHeading && counts.size === 1 && counts.get(firstHeading.level) === 1) title = firstHeading.text;

  const chapters: DraftChapter[] = [];
  let current: DraftChapter = { paragraphs: [] };
  for (const block of blocks) {
    if (block.kind === 'para') {
      current.paragraphs.push(block.text);
    } else if (block === titleHeading) {
      // The book's title: not a chapter, and not text to type.
    } else if (block.level <= chapterLevel) {
      chapters.push(current);
      current = { title: block.text, paragraphs: [] };
    } else {
      // A heading inside a chapter is typed like any other line.
      current.paragraphs.push(block.text);
    }
  }
  chapters.push(current);
  if (chapters.length > 1 && chapters[0]!.paragraphs.length > 0 && !chapters[0]!.title) chapters[0]!.title = 'Opening';

  return {
    source: 'text',
    title: fields['title'] || title,
    author: fields['author'],
    language: fields['lang'] || fields['language'],
    chapters,
  };
}

/** Imports a Markdown file. */
export function parseMarkdown(bytes: Uint8Array, file: FileInfo): Book {
  return assembleBook(draftFromMarkdown(decodeText(bytes)), file);
}
