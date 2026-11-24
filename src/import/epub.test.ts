import { strToU8 } from 'fflate';
import { describe, expect, it } from 'vitest';
import { ImportError } from './errors';
import { encryptedPaths, parseEpub, resolveHref } from './epub';
import { buildEpub, containerXml, OPF_PATH, xhtmlPage, zipEpub, type EpubSpec } from './testing/epub';

const FILE = { fileName: 'my_book.epub', fingerprint: 'f'.repeat(64) };

const SPEC: EpubSpec = {
  title: 'The Garden Gate',
  author: 'Ada Example',
  language: 'en-GB',
  chapters: [
    { title: 'Arrival', paragraphs: ['The train was late.', 'Rain fell on the platform.'] },
    { title: 'The Gate', paragraphs: ['A green gate stood open.'] },
    { title: 'Departure', paragraphs: ['Nobody waved.', 'The lamps came on.', 'It was over.'] },
  ],
};

/** The error a parse throws, so a test can look at its code. */
function failure(bytes: Uint8Array): ImportError {
  try {
    parseEpub(bytes, FILE);
  } catch (error) {
    if (error instanceof ImportError) return error;
    throw error;
  }
  throw new Error('expected parseEpub to throw');
}

/** A package file built from pieces, for documents the helper cannot produce. */
function pkg(manifest: string, spine: string, metadata = '<dc:title>Hand Made</dc:title>', spineAttrs = ''): string {
  return (
    '<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0">' +
    `<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">${metadata}</metadata>` +
    `<manifest>${manifest}</manifest><spine${spineAttrs}>${spine}</spine></package>`
  );
}

const doc = (id: string, href = `${id}.xhtml`, extra = '') =>
  `<item id="${id}" href="${href}" media-type="application/xhtml+xml"${extra}/>`;
const NAV_ITEM = doc('nav', 'nav.xhtml', ' properties="nav"');
const nav = (entries: string) =>
  xhtmlPage(`<nav epub:type="toc"><ol>${entries}</ol></nav>`, 'Contents');

/** Zips hand-written files together with a container pointing at `OEBPS/content.opf`. */
const handMade = (files: Record<string, string>) => zipEpub({ 'META-INF/container.xml': containerXml(), ...files });

describe.each([2, 3] as const)('parseEpub, EPUB %i', (version) => {
  const book = () => parseEpub(buildEpub({ ...SPEC, version }), FILE);

  it('reads the title, author and language', () => {
    expect(book()).toMatchObject({ title: 'The Garden Gate', author: 'Ada Example', language: 'en-GB' });
  });

  it('marks the book as an epub with an id made from the fingerprint', () => {
    expect(book()).toMatchObject({
      source: 'epub',
      fingerprint: FILE.fingerprint,
      id: `import:${FILE.fingerprint}`,
    });
  });

  it('takes chapter titles from the table of contents, in spine order', () => {
    expect(book().chapters.map((chapter) => chapter.title)).toEqual(['Arrival', 'The Gate', 'Departure']);
  });

  it('keeps each chapter\'s paragraphs in order, without the heading', () => {
    expect(book().chapters.map((chapter) => chapter.paragraphs)).toEqual([
      ['The train was late.', 'Rain fell on the platform.'],
      ['A green gate stood open.'],
      ['Nobody waved.', 'The lamps came on.', 'It was over.'],
    ]);
  });

  it('prefers the table of contents title to the heading in the document', () => {
    const bytes = buildEpub({
      ...SPEC,
      version,
      chapters: [{ title: 'Toc Name', paragraphs: ['Some words here.'], heading: false }],
    });
    expect(parseEpub(bytes, FILE).chapters[0]!.title).toBe('Toc Name');
  });

  it('takes a chapter title from its first heading when the table of contents has no entry', () => {
    const bytes = buildEpub({
      ...SPEC,
      version,
      chapters: [
        { title: 'Listed', paragraphs: ['One.'] },
        { title: 'Heading Only', paragraphs: ['Two.'], inToc: false },
      ],
    });
    expect(parseEpub(bytes, FILE).chapters.map((chapter) => chapter.title)).toEqual(['Listed', 'Heading Only']);
  });

  it('appends a document with no heading and no table of contents entry to the previous chapter', () => {
    const bytes = buildEpub({
      ...SPEC,
      version,
      chapters: [
        { title: 'First', paragraphs: ['One.'] },
        { title: '', paragraphs: ['Two.', 'Three.'], heading: false, inToc: false },
        { title: 'Third', paragraphs: ['Four.'] },
      ],
    });
    const { chapters } = parseEpub(bytes, FILE);
    expect(chapters.map((chapter) => chapter.title)).toEqual(['First', 'Third']);
    expect(chapters[0]!.paragraphs).toEqual(['One.', 'Two.', 'Three.']);
  });

  it('falls back to the file name when the package has no title', () => {
    const bytes = buildEpub({ ...SPEC, version, title: undefined });
    expect(parseEpub(bytes, FILE).title).toBe('my book');
  });

  it('uses und when the package has no language', () => {
    expect(parseEpub(buildEpub({ ...SPEC, version, language: undefined }), FILE).language).toBe('und');
  });

  it('gives an empty author when the package names none', () => {
    expect(parseEpub(buildEpub({ ...SPEC, version, author: undefined }), FILE).author).toBe('');
  });
});

describe('parseEpub documents', () => {
  it('produces no chapter for a cover page with only an image, or for a nav document in the spine', () => {
    const bytes = handMade({
      [OPF_PATH]: pkg(
        [NAV_ITEM, doc('cover'), doc('one')].join(''),
        '<itemref idref="cover"/><itemref idref="nav"/><itemref idref="one"/>',
      ),
      'OEBPS/cover.xhtml': xhtmlPage('<div><img src="cover.jpg" alt="Cover"/></div>'),
      'OEBPS/nav.xhtml': nav('<li><a href="one.xhtml">Only</a></li>'),
      'OEBPS/one.xhtml': xhtmlPage('<h1>Only</h1><p>The one chapter.</p>'),
    });
    expect(parseEpub(bytes, FILE).chapters).toEqual([{ title: 'Only', paragraphs: ['The one chapter.'] }]);
  });

  it('splits one file into chapters at table of contents entries with fragments', () => {
    const bytes = handMade({
      [OPF_PATH]: pkg([NAV_ITEM, doc('all')].join(''), '<itemref idref="all"/>'),
      'OEBPS/nav.xhtml': nav('<li><a href="all.xhtml#a">Alpha</a></li><li><a href="all.xhtml#b">Beta</a></li>'),
      'OEBPS/all.xhtml': xhtmlPage(
        '<h2 id="a">Alpha heading</h2><p>Alpha one.</p><p>Alpha two.</p><h2 id="b">Beta heading</h2><p>Beta one.</p>',
      ),
    });
    expect(parseEpub(bytes, FILE).chapters).toEqual([
      { title: 'Alpha', paragraphs: ['Alpha one.', 'Alpha two.'] },
      { title: 'Beta', paragraphs: ['Beta one.'] },
    ]);
  });

  it('keeps text before the first fragment as its own part of the file', () => {
    const bytes = handMade({
      [OPF_PATH]: pkg([NAV_ITEM, doc('all')].join(''), '<itemref idref="all"/>'),
      'OEBPS/nav.xhtml': nav('<li><a href="all.xhtml#b">Beta</a></li>'),
      'OEBPS/all.xhtml': xhtmlPage('<p>Preface words.</p><h2 id="b">Beta</h2><p>Beta one.</p>'),
    });
    const { chapters } = parseEpub(bytes, FILE);
    expect(chapters.map((chapter) => chapter.paragraphs)).toEqual([['Preface words.'], ['Beta one.']]);
    expect(chapters[1]!.title).toBe('Beta');
  });

  it('skips spine items marked linear="no"', () => {
    const bytes = handMade({
      [OPF_PATH]: pkg(
        [doc('one'), doc('extra'), doc('two')].join(''),
        '<itemref idref="one"/><itemref idref="extra" linear="no"/><itemref idref="two"/>',
      ),
      'OEBPS/one.xhtml': xhtmlPage('<h1>One</h1><p>Body one.</p>'),
      'OEBPS/extra.xhtml': xhtmlPage('<h1>Extra</h1><p>Bonus material.</p>'),
      'OEBPS/two.xhtml': xhtmlPage('<h1>Two</h1><p>Body two.</p>'),
    });
    expect(parseEpub(bytes, FILE).chapters.map((chapter) => chapter.title)).toEqual(['One', 'Two']);
  });

  it('finds files whose paths are percent-encoded in the package and the table of contents', () => {
    const bytes = handMade({
      [OPF_PATH]: pkg(
        [NAV_ITEM, doc('one', 'chapter%201.xhtml')].join(''),
        '<itemref idref="one"/>',
      ),
      'OEBPS/nav.xhtml': nav('<li><a href="chapter%201.xhtml">Spaced Out</a></li>'),
      'OEBPS/chapter 1.xhtml': xhtmlPage('<p>Words in a spaced file.</p>'),
    });
    expect(parseEpub(bytes, FILE).chapters).toEqual([{ title: 'Spaced Out', paragraphs: ['Words in a spaced file.'] }]);
  });

  it('resolves table of contents links relative to the navigation document', () => {
    const bytes = handMade({
      [OPF_PATH]: pkg([doc('nav', 'toc/nav.xhtml', ' properties="nav"'), doc('one', 'text/one.xhtml')].join(''), '<itemref idref="one"/>'),
      'OEBPS/toc/nav.xhtml': nav('<li><a href="../text/one.xhtml">Deep</a></li>'),
      'OEBPS/text/one.xhtml': xhtmlPage('<p>Words.</p>'),
    });
    expect(parseEpub(bytes, FILE).chapters[0]!.title).toBe('Deep');
  });

  it('names a text-less title page after the text that follows it', () => {
    const bytes = handMade({
      [OPF_PATH]: pkg([doc('t'), doc('b')].join(''), '<itemref idref="t"/><itemref idref="b"/>'),
      'OEBPS/t.xhtml': xhtmlPage('<h1>Chapter 1</h1>'),
      'OEBPS/b.xhtml': xhtmlPage('<p>The story starts here.</p>'),
    });
    expect(parseEpub(bytes, FILE).chapters).toEqual([{ title: 'Chapter 1', paragraphs: ['The story starts here.'] }]);
  });

  it('skips spine documents that are missing from the zip', () => {
    const bytes = handMade({
      [OPF_PATH]: pkg([doc('one'), doc('gone')].join(''), '<itemref idref="gone"/><itemref idref="one"/>'),
      'OEBPS/one.xhtml': xhtmlPage('<h1>One</h1><p>Present.</p>'),
    });
    expect(parseEpub(bytes, FILE).chapters.map((chapter) => chapter.title)).toEqual(['One']);
  });

  it('joins several authors and ignores non-author creators', () => {
    const bytes = handMade({
      [OPF_PATH]: pkg(
        doc('one'),
        '<itemref idref="one"/>',
        '<dc:title>T</dc:title><dc:creator opf:role="aut">Ann</dc:creator><dc:creator opf:role="aut">Bo</dc:creator>' +
          '<dc:creator opf:role="trl">Cy</dc:creator>',
      ),
      'OEBPS/one.xhtml': xhtmlPage('<p>Words.</p>'),
    });
    expect(parseEpub(bytes, FILE).author).toBe('Ann, Bo');
  });

  it('reads the package file named by the container, wherever it is', () => {
    const bytes = zipEpub({
      'META-INF/container.xml': containerXml('content/book.opf'),
      'content/book.opf': pkg(doc('one'), '<itemref idref="one"/>'),
      'content/one.xhtml': xhtmlPage('<p>Words.</p>'),
    });
    expect(parseEpub(bytes, FILE).chapters[0]!.paragraphs).toEqual(['Words.']);
  });
});

describe('parseEpub copy protection', () => {
  const encryption = (algorithm: string, uri: string) =>
    '<?xml version="1.0"?><encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container" ' +
    'xmlns:enc="http://www.w3.org/2001/04/xmlenc#"><enc:EncryptedData>' +
    `<enc:EncryptionMethod Algorithm="${algorithm}"/>` +
    `<enc:CipherData><enc:CipherReference URI="${uri}"/></enc:CipherData></enc:EncryptedData></encryption>`;

  const withEncryption = (xml: string) =>
    handMade({
      [OPF_PATH]: pkg(
        [doc('one'), '<item id="font" href="fonts/f.otf" media-type="font/otf"/>'].join(''),
        '<itemref idref="one"/>',
      ),
      'OEBPS/one.xhtml': xhtmlPage('<h1>One</h1><p>Body one.</p>'),
      'OEBPS/fonts/f.otf': 'not really a font',
      'META-INF/encryption.xml': xml,
    });

  it('refuses a book whose spine document is encrypted', () => {
    const error = failure(withEncryption(encryption('http://www.w3.org/2001/04/xmlenc#aes256-cbc', 'OEBPS/one.xhtml')));
    expect(error.code).toBe('drm');
  });

  it('refuses a book whose package file is encrypted', () => {
    const error = failure(withEncryption(encryption('http://www.w3.org/2001/04/xmlenc#aes256-cbc', OPF_PATH)));
    expect(error.code).toBe('drm');
  });

  it('imports a book whose only encrypted file is an obfuscated font', () => {
    const book = parseEpub(withEncryption(encryption('http://www.idpf.org/2008/embedding', 'OEBPS/fonts/f.otf')), FILE);
    expect(book.chapters).toEqual([{ title: 'One', paragraphs: ['Body one.'] }]);
  });

  it('imports a book where real encryption covers only an image', () => {
    const book = parseEpub(
      withEncryption(encryption('http://www.w3.org/2001/04/xmlenc#aes256-cbc', 'OEBPS/images/cover.jpg')),
      FILE,
    );
    expect(book.chapters).toHaveLength(1);
  });

  it('encryptedPaths lists only the files that are really encrypted', () => {
    const xml = encryption('http://www.w3.org/2001/04/xmlenc#aes256-cbc', 'OEBPS/one.xhtml');
    expect([...encryptedPaths(xml)]).toEqual(['OEBPS/one.xhtml']);
    expect(encryptedPaths(encryption('http://www.idpf.org/2008/embedding', 'OEBPS/fonts/f.otf')).size).toBe(0);
    expect(encryptedPaths(encryption('http://ns.adobe.com/pdf/enc#RC', 'OEBPS/fonts/f.otf')).size).toBe(0);
  });

  it('encryptedPaths decodes percent-encoded paths', () => {
    const xml = encryption('http://www.w3.org/2001/04/xmlenc#aes256-cbc', 'OEBPS/chapter%201.xhtml');
    expect([...encryptedPaths(xml)]).toEqual(['OEBPS/chapter 1.xhtml']);
  });
});

describe('parseEpub errors', () => {
  it('reports a file that is not a zip as unreadable', () => {
    expect(failure(strToU8('this is just some text, not a zip file at all')).code).toBe('unreadable');
  });

  it('reports a zip without container.xml as unreadable', () => {
    expect(failure(zipEpub({ 'hello.txt': 'hi' })).code).toBe('unreadable');
  });

  it('reports a container that points at a missing package file as unreadable', () => {
    expect(failure(zipEpub({ 'META-INF/container.xml': containerXml('nowhere.opf') })).code).toBe('unreadable');
  });

  it('reports a package with an empty spine as unreadable', () => {
    const bytes = handMade({ [OPF_PATH]: pkg(doc('one'), ''), 'OEBPS/one.xhtml': xhtmlPage('<p>x</p>') });
    expect(failure(bytes).code).toBe('unreadable');
  });

  it('reports documents with no text as empty', () => {
    const bytes = buildEpub({
      ...SPEC,
      chapters: [
        { title: '', paragraphs: [], heading: false },
        { title: '', paragraphs: [' '], heading: false },
      ],
    });
    expect(failure(bytes).code).toBe('empty');
  });

  it('reports documents with only images as empty', () => {
    const bytes = handMade({
      [OPF_PATH]: pkg(doc('one'), '<itemref idref="one"/>'),
      'OEBPS/one.xhtml': xhtmlPage('<img src="a.png"/>'),
    });
    expect(failure(bytes).code).toBe('empty');
  });
});

describe('resolveHref', () => {
  it('resolves a sibling file', () => {
    expect(resolveHref('OEBPS/nav.xhtml', 'text/one.xhtml')).toEqual({ path: 'OEBPS/text/one.xhtml', fragment: '' });
  });

  it('resolves parent folders and splits off the fragment', () => {
    expect(resolveHref('OEBPS/text/a.xhtml', '../b.xhtml#top')).toEqual({ path: 'OEBPS/b.xhtml', fragment: 'top' });
  });

  it('treats a leading slash as the root of the zip', () => {
    expect(resolveHref('OEBPS/a.xhtml', '/x/b.xhtml').path).toBe('x/b.xhtml');
  });

  it('resolves a bare fragment to the same file', () => {
    expect(resolveHref('OEBPS/a.xhtml', '#frag')).toEqual({ path: 'OEBPS/a.xhtml', fragment: 'frag' });
  });

  it('decodes percent escapes and tolerates malformed ones', () => {
    expect(resolveHref('a.xhtml', 'my%20file.xhtml').path).toBe('my file.xhtml');
    expect(resolveHref('a.xhtml', 'bad%zz.xhtml').path).toBe('bad%zz.xhtml');
  });
});
