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
const LIST_ITEM = /^(?:[-*+]|\d{1,9}[.)])\s+(?:\[[ xX]\]\s+)?(.*)$/;
const LINK_DEFINITION = /^\[[^\]]+\]:\s*\S+/;
const FOOTNOTE_DEFINITION = /^\[\^[^\]]+\]:/;
const TABLE_DIVIDER = /^\|?\s*:?-{2,}:?\s*(?:\|\s*:?-{2,}:?\s*)*\|?$/;

/** Reduces one line or paragraph of Markdown to the text a reader sees. */
export function stripInline(source: string): string {
  let text = source;
  // Backslash escapes are parked as private-use characters so the rules below leave them alone.
  const escaped: string[] = [];
  text = text.replace(/\\([!-/:-@[-`{-~])/g, (_, char: string) => {
    escaped.push(char);
    return String.fromCharCode(0xe000 + escaped.length - 1);
  });

  text = text.replace(/<!--[\s\S]*?-->/g, '');
  text = text.replace(/(`+)([\s\S]*?)\1/g, (_, __, code: string) => code.trim());
  text = text.replace(/!\[[^\]]*\](?:\([^)]*\)|\[[^\]]*\])?/g, ''); // images
  text = text.replace(/\[\^[^\]]+\]/g, ''); // footnote markers
  text = text.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1'); // [text](address)
  text = text.replace(/\[([^\]]+)\]\[[^\]]*\]/g, '$1'); // [text][reference]
  text = text.replace(/<((?:https?:\/\/|mailto:)[^>\s]+)>/g, '$1'); // <address>
  text = text.replace(/<\/?[A-Za-z][^>]*>/g, ''); // inline HTML tags
  text = text.replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, '$2');
  text = text.replace(/\*(?=\S)([^*]*?\S)\*/g, '$1');
  // Underscores only mark emphasis at the edges of words, so snake_case survives.
  text = text.replace(/(^|[^\p{L}\p{N}_])_(?=\S)([^_]*?\S)_(?![\p{L}\p{N}_])/gu, '$1$2');
  text = text.replace(/~~(?=\S)([\s\S]*?\S)~~/g, '$1');
  text = decodeEntities(text);

  text = text.replace(/[-]/g, (char) => escaped[char.charCodeAt(0) - 0xe000] ?? char);
  return collapse(text);
}

/** `key: value` lines between `---` markers at the very top of the file. */
function frontMatter(lines: string[]): { fields: Record<string, string>; rest: string[] } {
  if (lines[0]?.trim() !== '---') return { fields: {}, rest: lines };
  const end = lines.findIndex((line, i) => i > 0 && /^(?:---|\.\.\.)\s*$/.test(line));
  if (end < 0) return { fields: {}, rest: lines };
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
  const flush = () => {
    if (paragraph.length > 0) blocks.push({ kind: 'para', text: stripInline(paragraph.join(' ')) });
    paragraph = [];
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
    if (item) {
      flush();
      paragraph.push(item[1]!);
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
  const chapterLevel = levels.find((level) => counts.get(level)! >= 2) ?? levels[0] ?? 0;

  const firstHeading = blocks.find((block) => block.kind === 'heading');
  let title: string | undefined;
  if (firstHeading && firstHeading.level < chapterLevel) title = firstHeading.text;
  else if (firstHeading && counts.size === 1 && counts.get(firstHeading.level) === 1) title = firstHeading.text;

  const chapters: DraftChapter[] = [];
  let current: DraftChapter = { paragraphs: [] };
  for (const block of blocks) {
    if (block.kind === 'para') {
      current.paragraphs.push(block.text);
    } else if (block === firstHeading && block.level < chapterLevel) {
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
