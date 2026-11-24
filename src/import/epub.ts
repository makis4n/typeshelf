/**
 * EPUB import (versions 2 and 3), entirely in the browser.
 *
 * An EPUB is a zip file. `META-INF/container.xml` points at the package file,
 * which lists the book's details, every file in it, and the reading order
 * (the "spine"). Chapter titles come from the table of contents: the
 * navigation document in EPUB 3, the NCX file in EPUB 2. Where there is no
 * entry, a document's own first heading is used.
 *
 * Copy-protected books keep the same layout but their chapters are encrypted,
 * which `META-INF/encryption.xml` declares. Those are refused with a `drm`
 * error. Scrambled fonts ("font obfuscation") use the same file and are fine.
 */

import { unzipSync } from 'fflate';
import type { Book } from '../book/types';
import { decodeXml } from './decode';
import { ImportError } from './errors';
import { descendants, firstDescendant, parseMarkup, textOf, type Element } from './markup';
import { assembleBook, type DraftChapter, type FileInfo } from './shape';
import { extractBlocks, type Block } from './xhtml';

const CONTAINER = 'META-INF/container.xml';
const ENCRYPTION = 'META-INF/encryption.xml';

/** The two schemes that only scramble fonts. Anything else in encryption.xml is real encryption. */
const FONT_OBFUSCATION = new Set(['http://www.idpf.org/2008/embedding', 'http://ns.adobe.com/pdf/enc#RC']);

interface TocEntry {
  path: string;
  /** The part after `#`, or '' when the entry points at a whole document. */
  fragment: string;
  title: string;
}

function unzip(bytes: Uint8Array, wanted: (name: string) => boolean): Map<string, Uint8Array> {
  try {
    return new Map(Object.entries(unzipSync(bytes, { filter: (file) => wanted(file.name) })));
  } catch (cause) {
    throw new ImportError('unreadable', `not a readable zip file (${String(cause)})`);
  }
}

function decodePath(path: string): string {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

/** Resolves a link found in the file at `from` to a path inside the zip, plus its `#fragment`. */
export function resolveHref(from: string, href: string): { path: string; fragment: string } {
  const hash = href.indexOf('#');
  const fragment = hash < 0 ? '' : decodePath(href.slice(hash + 1));
  const target = decodePath(hash < 0 ? href : href.slice(0, hash));
  if (target.length === 0) return { path: from, fragment };

  const parts = target.startsWith('/') ? [] : from.split('/').slice(0, -1);
  for (const part of target.split('/')) {
    if (part === '..') parts.pop();
    else if (part !== '.' && part !== '') parts.push(part);
  }
  return { path: parts.join('/'), fragment };
}

/**
 * The files `encryption.xml` says are truly encrypted (font obfuscation left out).
 * Exported for tests.
 */
export function encryptedPaths(encryptionXml: string): Set<string> {
  const paths = new Set<string>();
  for (const data of descendants(parseMarkup(encryptionXml), 'encrypteddata')) {
    const algorithm = firstDescendant(data, 'encryptionmethod')?.attrs['algorithm'] ?? '';
    const uri = firstDescendant(data, 'cipherreference')?.attrs['uri'];
    if (uri !== undefined && !FONT_OBFUSCATION.has(algorithm)) paths.add(resolveHref('', uri).path);
  }
  return paths;
}

function tocFromNav(navPath: string, source: string): TocEntry[] {
  const root = parseMarkup(source);
  const navs = [...descendants(root, 'nav')];
  const toc = navs.find((nav) => (nav.attrs['epub:type'] ?? '').split(/\s+/).includes('toc')) ?? navs[0];
  if (!toc) return [];
  const entries: TocEntry[] = [];
  for (const link of descendants(toc, 'a')) {
    const href = link.attrs['href'];
    if (href !== undefined) entries.push({ ...resolveHref(navPath, href), title: textOf(link) });
  }
  return entries;
}

function tocFromNcx(ncxPath: string, source: string): TocEntry[] {
  const entries: TocEntry[] = [];
  for (const point of descendants(parseMarkup(source), 'navpoint')) {
    const label = firstDescendant(point, 'navlabel');
    const src = firstDescendant(point, 'content')?.attrs['src'];
    if (label && src !== undefined) entries.push({ ...resolveHref(ncxPath, src), title: textOf(label) });
  }
  return entries;
}

/** The author: creators marked as authors, or the first creator when none are marked. */
function authorOf(metadata: Element): string {
  const creators = [...descendants(metadata, 'creator')];
  // EPUB 3 states a creator's role in a separate <meta refines="#id" property="role">.
  const refined = new Map<string, string>();
  for (const meta of descendants(metadata, 'meta')) {
    if (meta.attrs['property'] === 'role' && meta.attrs['refines']) refined.set(meta.attrs['refines'].replace(/^#/, ''), textOf(meta));
  }
  const roleOf = (creator: Element) => creator.attrs['opf:role'] ?? refined.get(creator.attrs['id'] ?? '') ?? 'aut';
  const authors = creators.filter((creator) => roleOf(creator) === 'aut');
  return (authors.length > 0 ? authors : creators.slice(0, 1)).map(textOf).filter(Boolean).join(', ');
}

/** Splits one document's blocks into chapters, at the places the table of contents points to. */
function chaptersOfDocument(blocks: Block[], entries: TocEntry[]): { tocTitle?: string; blocks: Block[] }[] {
  const segments = [{ tocTitle: entries.find((entry) => entry.fragment === '')?.title, blocks: [] as Block[] }];
  for (const block of blocks) {
    if (block.kind === 'anchor') {
      segments.push({ tocTitle: entries.find((entry) => entry.fragment === block.id)?.title, blocks: [] });
    } else {
      segments[segments.length - 1]!.blocks.push(block);
    }
  }
  return segments;
}

/** Imports an EPUB file. */
export function parseEpub(bytes: Uint8Array, file: FileInfo): Book {
  // First pass: only the small files that describe the book.
  const meta = unzip(bytes, (name) => name.startsWith('META-INF/') || /\.opf$/i.test(name));
  const containerBytes = meta.get(CONTAINER);
  if (!containerBytes) throw new ImportError('unreadable', 'no META-INF/container.xml');

  const rootfiles = [...descendants(parseMarkup(decodeXml(containerBytes)), 'rootfile')];
  const opfPath = decodePath(
    (rootfiles.find((rootfile) => rootfile.attrs['media-type'] === 'application/oebps-package+xml') ?? rootfiles[0])
      ?.attrs['full-path'] ?? '',
  );
  const encryptionBytes = meta.get(ENCRYPTION);
  const encrypted = encryptionBytes ? encryptedPaths(decodeXml(encryptionBytes)) : new Set<string>();
  if (encrypted.has(opfPath)) throw new ImportError('drm');
  const opfBytes = meta.get(opfPath) ?? unzip(bytes, (name) => name === opfPath).get(opfPath);
  if (!opfBytes) throw new ImportError('unreadable', 'no package file');

  const pkg = parseMarkup(decodeXml(opfBytes));
  const metadata = firstDescendant(pkg, 'metadata') ?? pkg;
  const field = (name: string) => {
    for (const element of descendants(metadata, name)) {
      const text = textOf(element);
      if (text.length > 0) return text;
    }
    return undefined;
  };

  // Every file in the book, by id.
  const items = new Map<string, { path: string; mediaType: string; properties: string[] }>();
  for (const item of descendants(pkg, 'item')) {
    const { id, href } = item.attrs;
    if (id === undefined || href === undefined) continue;
    items.set(id, {
      path: resolveHref(opfPath, href).path,
      mediaType: item.attrs['media-type'] ?? '',
      properties: (item.attrs['properties'] ?? '').split(/\s+/),
    });
  }

  // The reading order. Items marked linear="no" are extras outside the main text.
  const spineElement = firstDescendant(pkg, 'spine');
  const spine: string[] = [];
  for (const ref of spineElement ? descendants(spineElement, 'itemref') : []) {
    const item = items.get(ref.attrs['idref'] ?? '');
    if (item && ref.attrs['linear'] !== 'no') spine.push(item.path);
  }
  if (spine.length === 0) throw new ImportError('unreadable', 'the package lists no documents to read');

  // Copy protection: the chapters themselves are encrypted.
  if (spine.some((path) => encrypted.has(path))) throw new ImportError('drm');

  const navPath = [...items.values()].find((item) => item.properties.includes('nav'))?.path;
  const ncxPath = (
    items.get(spineElement?.attrs['toc'] ?? '') ??
    [...items.values()].find((item) => item.mediaType === 'application/x-dtbncx+xml')
  )?.path;

  // Second pass: the documents themselves. Images, fonts and styles stay zipped.
  const needed = new Set([...spine, navPath, ncxPath]);
  const files = unzip(bytes, (name) => needed.has(name));
  const read = (path: string | undefined) => {
    const found = path !== undefined && !encrypted.has(path) ? files.get(path) : undefined;
    return found ? decodeXml(found) : undefined;
  };

  let toc: TocEntry[] = [];
  const nav = read(navPath);
  if (nav !== undefined) toc = tocFromNav(navPath!, nav);
  const ncx = toc.length === 0 ? read(ncxPath) : undefined;
  if (ncx !== undefined) toc = tocFromNcx(ncxPath!, ncx);

  const chapters: DraftChapter[] = [];
  let pendingTitle = '';
  for (const path of spine) {
    const source = read(path);
    if (source === undefined) continue; // listed but missing from the zip
    const entries = toc.filter((entry) => entry.path === path);
    const anchors = new Set(entries.map((entry) => entry.fragment).filter(Boolean));

    for (const segment of chaptersOfDocument(extractBlocks(source, anchors), entries)) {
      // Headings before the first paragraph name the chapter; later ones are typed as text.
      const firstPara = segment.blocks.findIndex((block) => block.kind === 'para');
      const lead = (firstPara < 0 ? segment.blocks : segment.blocks.slice(0, firstPara)) as { text: string }[];
      const body = (firstPara < 0 ? [] : segment.blocks.slice(firstPara)) as { text: string }[];
      const title = segment.tocTitle || lead.map((heading) => heading.text).join(': ');
      const paragraphs = body.map((block) => block.text);

      const previous = chapters[chapters.length - 1];
      if (title.length > 0) {
        // A titled page with no text of its own (a bare "Chapter 1" page) names the text that follows it.
        if (paragraphs.length > 0) chapters.push({ title, paragraphs });
        pendingTitle = paragraphs.length > 0 ? '' : title;
      } else if (paragraphs.length === 0) {
        continue;
      } else if (pendingTitle.length > 0 || !previous) {
        chapters.push({ title: pendingTitle, paragraphs });
        pendingTitle = '';
      } else {
        // No entry and no heading: the previous chapter carries on in a new file.
        previous.paragraphs.push(...paragraphs);
      }
    }
  }

  return assembleBook(
    { source: 'epub', title: field('title'), author: authorOf(metadata), language: field('language'), chapters },
    file,
  );
}
