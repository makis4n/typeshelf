/**
 * Builds small EPUB files from code, for unit tests and for browser tests that
 * need a file to pick. Nothing here is a real book: the text is whatever the
 * caller passes in, so no binary or copyrighted file ever needs committing.
 *
 * Free of test-runner imports and Node-only APIs, so it runs anywhere.
 */

import { strToU8, zipSync, type Zippable } from 'fflate';

export interface EpubChapter {
  title: string;
  paragraphs: string[];
  /** Put the title in an `<h1>` at the top of the document. Default true. */
  heading?: boolean;
  /** List the chapter in the table of contents. Default true. */
  inToc?: boolean;
}

export interface EpubSpec {
  /** Left out of the package file when undefined. */
  title?: string;
  author?: string;
  language?: string;
  /** 2 gives an NCX table of contents, 3 a navigation document. Default 3. */
  version?: 2 | 3;
  chapters: EpubChapter[];
}

/** Where the package file lives. A subfolder, so relative paths are exercised. */
export const OPF_PATH = 'OEBPS/content.opf';

export const escapeXml = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** A complete XHTML document around some body markup. */
export function xhtmlPage(body: string, title = 'Page'): string {
  return (
    '<?xml version="1.0" encoding="utf-8"?>\n<!DOCTYPE html>\n' +
    '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">' +
    `<head><title>${escapeXml(title)}</title></head><body>${body}</body></html>`
  );
}

/** `META-INF/container.xml` pointing at a package file. */
export function containerXml(opfPath = OPF_PATH): string {
  return (
    '<?xml version="1.0"?>' +
    '<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles>' +
    `<rootfile full-path="${opfPath}" media-type="application/oebps-package+xml"/></rootfiles></container>`
  );
}

/** Zips text files (path to content) into EPUB bytes, with the `mimetype` file first and stored. */
export function zipEpub(files: Record<string, string>): Uint8Array {
  const entries: Zippable = { mimetype: [strToU8('application/epub+zip'), { level: 0 }] };
  for (const [path, content] of Object.entries(files)) entries[path] = strToU8(content);
  return zipSync(entries);
}

/**
 * Builds an EPUB. Chapter files are `OEBPS/text/chapter-N.xhtml`. The manifest
 * lists them in reverse, so the reading order (the spine) differs from it.
 */
export function buildEpub(spec: EpubSpec): Uint8Array {
  const version = spec.version ?? 3;
  const files: Record<string, string> = { 'META-INF/container.xml': containerXml() };
  const chapterPath = (i: number) => `text/chapter-${i + 1}.xhtml`;

  spec.chapters.forEach((chapter, i) => {
    const heading = chapter.heading === false ? '' : `<h1>${escapeXml(chapter.title)}</h1>`;
    const paragraphs = chapter.paragraphs.map((text) => `<p>${escapeXml(text)}</p>`).join('');
    files[`OEBPS/${chapterPath(i)}`] = xhtmlPage(heading + paragraphs, chapter.title);
  });

  const listed = spec.chapters.map((chapter, i) => ({ chapter, i })).filter(({ chapter }) => chapter.inToc !== false);
  if (version === 3) {
    const items = listed
      .map(({ chapter, i }) => `<li><a href="${chapterPath(i)}">${escapeXml(chapter.title)}</a></li>`)
      .join('');
    files['OEBPS/nav.xhtml'] = xhtmlPage(
      `<nav epub:type="toc"><h2>Contents</h2><ol>${items}</ol></nav>`,
      'Contents',
    );
  } else {
    const points = listed
      .map(
        ({ chapter, i }, n) =>
          `<navPoint id="np${n}" playOrder="${n + 1}"><navLabel><text>${escapeXml(chapter.title)}</text></navLabel>` +
          `<content src="${chapterPath(i)}"/></navPoint>`,
      )
      .join('');
    files['OEBPS/toc.ncx'] =
      '<?xml version="1.0" encoding="UTF-8"?><ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">' +
      `<head></head><docTitle><text>${escapeXml(spec.title ?? '')}</text></docTitle><navMap>${points}</navMap></ncx>`;
  }

  const metadata = [
    '<dc:identifier id="bookid">urn:uuid:00000000-0000-4000-8000-000000000000</dc:identifier>',
    spec.title === undefined ? '' : `<dc:title>${escapeXml(spec.title)}</dc:title>`,
    spec.author === undefined
      ? ''
      : version === 3
        ? `<dc:creator id="creator">${escapeXml(spec.author)}</dc:creator><meta refines="#creator" property="role">aut</meta>`
        : `<dc:creator opf:role="aut">${escapeXml(spec.author)}</dc:creator>`,
    spec.language === undefined ? '' : `<dc:language>${escapeXml(spec.language)}</dc:language>`,
  ].join('');

  const chapterItems = spec.chapters.map(
    (_, i) => `<item id="ch${i + 1}" href="${chapterPath(i)}" media-type="application/xhtml+xml"/>`,
  );
  const tocItem =
    version === 3
      ? '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>'
      : '<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>';
  const manifest = [tocItem, ...chapterItems.reverse()].join('');
  const spineItems = spec.chapters.map((_, i) => `<itemref idref="ch${i + 1}"/>`).join('');

  files[OPF_PATH] =
    '<?xml version="1.0" encoding="UTF-8"?>' +
    `<package xmlns="http://www.idpf.org/2007/opf" version="${version === 3 ? '3.0' : '2.0'}" unique-identifier="bookid">` +
    `<metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf">${metadata}</metadata>` +
    `<manifest>${manifest}</manifest>` +
    `<spine${version === 2 ? ' toc="ncx"' : ''}>${spineItems}</spine></package>`;

  return zipEpub(files);
}
