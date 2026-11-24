/**
 * Turns one XHTML document from an EPUB into plain text: a list of headings
 * and paragraphs, in reading order.
 *
 * Left out, because they are not text to type: images and other media,
 * footnote markers and the notes themselves, printed page numbers, navigation
 * lists and anything hidden.
 */

import { collapse, parseMarkup, textOf, type Element, type Node } from './markup';

export type Block =
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'para'; text: string }
  /** The place a table-of-contents entry points at (`chapter.xhtml#id`). */
  | { kind: 'anchor'; id: string };

/** Elements that are skipped with everything inside them. */
const DROPPED = new Set([
  'head', 'script', 'style', 'svg', 'math', 'img', 'image', 'picture', 'figure', 'audio', 'video', 'object',
  'embed', 'iframe', 'canvas', 'nav', 'form', 'button', 'input', 'select', 'textarea', 'map', 'noscript',
  'template', 'rt', 'rp',
]);

/** Elements that start and end a paragraph. */
const BLOCKS = new Set([
  'address', 'article', 'aside', 'blockquote', 'body', 'caption', 'center', 'dd', 'details', 'div', 'dl', 'dt',
  'figcaption', 'footer', 'header', 'hgroup', 'html', 'li', 'main', 'ol', 'p', 'pre', 'section', 'summary',
  'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'ul',
]);

const NOTE_TYPES = new Set(['noteref', 'footnote', 'footnotes', 'endnote', 'endnotes', 'rearnote', 'rearnotes']);
const NOTE_ROLES = new Set(['doc-noteref', 'doc-footnote', 'doc-endnote', 'doc-endnotes']);
/** What a footnote marker looks like: "1", "[12]", "(3)", "*", "†". */
const MARKER = /^[[(]?(?:\d{1,4}|[*†‡§¶]+)[\])]?$/;
const BRACKETED_MARKER = /^(?:[[(]\d{1,4}[\])]|[*†‡§¶]+)$/;
const PAGE_CLASS = /(?:^|\s)(?:pagenum|pageno|pagenumber|page-number|page_number)(?:\s|$)/i;

const tokens = (value: string | undefined) => (value ?? '').toLowerCase().split(/\s+/).filter(Boolean);

function hasLink(element: Element): boolean {
  return element.children.some((child) => typeof child !== 'string' && (child.name === 'a' || hasLink(child)));
}

/** Words in a link's address, class or id that say it leads to a note. */
const NOTE_HINT = /note|\bfn|ftn/i;

/**
 * `attached` is true when the element directly follows a word (no space) or
 * starts its paragraph, which is where a footnote marker sits.
 */
function isSkipped(element: Element, attached: boolean): boolean {
  const { name, attrs } = element;
  if (DROPPED.has(name)) return true;
  if ('hidden' in attrs || attrs['aria-hidden'] === 'true') return true;
  if (/display\s*:\s*none|visibility\s*:\s*hidden/i.test(attrs['style'] ?? '')) return true;

  const types = tokens(attrs['epub:type']);
  const roles = tokens(attrs['role']);
  // Footnote markers and the notes they point to.
  if (types.some((type) => NOTE_TYPES.has(type)) || roles.some((role) => NOTE_ROLES.has(role))) return true;
  // Page numbers carried over from the printed edition.
  if (types.includes('pagebreak') || roles.includes('doc-pagebreak')) return true;
  if (PAGE_CLASS.test(attrs['class'] ?? '') && textOf(element).length <= 20) return true;

  // Markers without any labelling: a small raised number that is a link.
  if (name === 'a' && (attrs['href'] ?? '').includes('#')) {
    const text = textOf(element);
    // A bare number after a space ("the treaty of 1815", "see chapter 3") is a reference in the sentence,
    // unless the link itself says it goes to a note.
    const hinted = NOTE_HINT.test(`${attrs['href']} ${attrs['class'] ?? ''} ${attrs['id'] ?? ''}`);
    if (BRACKETED_MARKER.test(text) || (MARKER.test(text) && (attached || hinted))) return true;
  }
  if (name === 'sup') {
    const text = textOf(element);
    if (BRACKETED_MARKER.test(text) || (hasLink(element) && MARKER.test(text))) return true;
  }
  return false;
}

/**
 * Reads a document into blocks. `anchors` are the ids that table-of-contents
 * entries point at; each one found is reported in place, so the caller can
 * split the document into chapters there.
 */
export function extractBlocks(source: string, anchors: ReadonlySet<string> = new Set()): Block[] {
  const blocks: Block[] = [];
  let buffer = '';
  let headingLevel = 0;

  const flush = () => {
    const text = collapse(buffer);
    buffer = '';
    if (text.length === 0) return;
    blocks.push(headingLevel > 0 ? { kind: 'heading', level: headingLevel, text } : { kind: 'para', text });
  };

  const walk = (node: Node) => {
    if (typeof node === 'string') {
      buffer += node;
      return;
    }
    if (isSkipped(node, buffer.trim() === '' || !/\s$/.test(buffer))) return;

    const { name } = node;
    const heading = /^h([1-6])$/.exec(name);
    const isBlock = heading !== null || BLOCKS.has(name);
    if (isBlock) flush();

    const id = node.attrs['id'] ?? node.attrs['xml:id'] ?? (name === 'a' ? node.attrs['name'] : undefined);
    // An anchor inside a paragraph is reported before it, so the paragraph is not cut in two.
    if (id !== undefined && anchors.has(id)) blocks.push({ kind: 'anchor', id });

    if (name === 'br') {
      buffer += ' ';
    } else if (name === 'hr') {
      flush();
    } else if (heading && headingLevel === 0) {
      headingLevel = Number(heading[1]);
      node.children.forEach(walk);
      flush();
      headingLevel = 0;
    } else {
      node.children.forEach(walk);
      if (isBlock) flush();
    }
  };

  walk(parseMarkup(source));
  flush();
  return blocks;
}
