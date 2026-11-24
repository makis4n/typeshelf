import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import { openBookStore } from '../store/books';
import { formatOf, importErrorMessage, importFile, ImportError, parseBook, type ImportErrorCode } from './index';
import { buildEpub, zipEpub } from './testing/epub';

const utf8 = (text: string) => new TextEncoder().encode(text);
const EPUB = buildEpub({
  title: 'Routed',
  chapters: [{ title: 'One', paragraphs: ['Some filler words.'] }],
});

/** The code of the error a promise or function rejects with. */
async function codeOf(attempt: () => unknown): Promise<ImportErrorCode | undefined> {
  try {
    await attempt();
  } catch (error) {
    return error instanceof ImportError ? error.code : undefined;
  }
  return undefined;
}

describe('formatOf', () => {
  it('routes by extension', () => {
    expect(formatOf({ name: 'a.epub', bytes: EPUB })).toBe('epub');
    expect(formatOf({ name: 'a.txt', bytes: utf8('x') })).toBe('text');
    expect(formatOf({ name: 'a.text', bytes: utf8('x') })).toBe('text');
    expect(formatOf({ name: 'a.md', bytes: utf8('x') })).toBe('markdown');
    expect(formatOf({ name: 'a.markdown', bytes: utf8('x') })).toBe('markdown');
  });

  it('ignores the case of the extension', () => {
    expect(formatOf({ name: 'A.EPUB', bytes: EPUB })).toBe('epub');
    expect(formatOf({ name: 'NOTES.TXT', bytes: utf8('x') })).toBe('text');
  });

  it('treats zip bytes under any name as a possible epub', () => {
    expect(formatOf({ name: 'book.zip', bytes: EPUB })).toBe('epub');
    expect(formatOf({ name: 'book', bytes: EPUB })).toBe('epub');
  });

  it('refuses PDF bytes whatever the name', () => {
    const pdf = utf8('%PDF-1.7\n...');
    expect(() => formatOf({ name: 'a.pdf', bytes: pdf })).toThrow(/^unsupported/);
    expect(() => formatOf({ name: 'a.txt', bytes: pdf })).toThrow(/^unsupported/);
  });

  it('refuses an unknown extension and a name without one', () => {
    expect(() => formatOf({ name: 'a.mobi', bytes: utf8('BOOKMOBI') })).toThrow(/^unsupported/);
    expect(() => formatOf({ name: 'readme', bytes: utf8('x') })).toThrow(/^unsupported/);
  });
});

describe('parseBook', () => {
  it('imports an epub', async () => {
    const book = await parseBook({ name: 'routed.epub', bytes: EPUB });
    expect(book).toMatchObject({ source: 'epub', title: 'Routed' });
  });

  it('imports an epub named .zip', async () => {
    const book = await parseBook({ name: 'routed.zip', bytes: EPUB });
    expect(book).toMatchObject({ source: 'epub', title: 'Routed' });
  });

  it('imports plain text from .txt', async () => {
    const book = await parseBook({ name: 'story.txt', bytes: utf8('Once upon a time.') });
    expect(book).toMatchObject({ source: 'text', title: 'story' });
    expect(book.chapters[0]!.paragraphs).toEqual(['Once upon a time.']);
  });

  it('imports Markdown from .md and .markdown', async () => {
    for (const name of ['notes.md', 'notes.markdown']) {
      const book = await parseBook({ name, bytes: utf8('# One\n\nA.\n\n# Two\n\nB.') });
      expect(book.chapters.map((chapter) => chapter.title)).toEqual(['One', 'Two']);
    }
  });

  it('sets the fingerprint from the file bytes and builds the id from it', async () => {
    const book = await parseBook({ name: 'a.txt', bytes: utf8('abc') });
    expect(book.fingerprint).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(book.id).toBe(`import:${book.fingerprint}`);
  });

  it('refuses a PDF as unsupported', async () => {
    expect(await codeOf(() => parseBook({ name: 'a.pdf', bytes: utf8('%PDF-1.4 stuff') }))).toBe('unsupported');
  });

  it('refuses a zip that is not an epub as unsupported', async () => {
    const zip = zipEpub({ 'word/document.xml': '<w:document/>' });
    expect(await codeOf(() => parseBook({ name: 'a.docx', bytes: zip }))).toBe('unsupported');
    expect(await codeOf(() => parseBook({ name: 'a.mobi', bytes: zip }))).toBe('unsupported');
  });

  it('calls a broken file named .epub unreadable, not unsupported', async () => {
    const zip = zipEpub({ 'word/document.xml': '<w:document/>' });
    expect(await codeOf(() => parseBook({ name: 'a.epub', bytes: zip }))).toBe('unreadable');
  });

  it('refuses an unknown extension as unsupported', async () => {
    expect(await codeOf(() => parseBook({ name: 'a.rtf', bytes: utf8('{\\rtf1 hi}') }))).toBe('unsupported');
  });

  it('reports zero bytes as empty', async () => {
    expect(await codeOf(() => parseBook({ name: 'a.txt', bytes: new Uint8Array() }))).toBe('empty');
    expect(await codeOf(() => parseBook({ name: 'a.epub', bytes: new Uint8Array() }))).toBe('empty');
  });

  it('refuses a .txt with NUL bytes as unsupported', async () => {
    const bytes = Uint8Array.from([0x68, 0x69, 0x00, 0x00, 0x21]);
    expect(await codeOf(() => parseBook({ name: 'a.txt', bytes }))).toBe('unsupported');
  });

  it('still reads UTF-16 text, which contains NUL bytes', async () => {
    const bytes = Uint8Array.from([0xff, 0xfe, 0x68, 0x00, 0x69, 0x00]);
    const book = await parseBook({ name: 'wide.txt', bytes });
    expect(book.chapters[0]!.paragraphs).toEqual(['hi']);
  });

  it('reports a text file of only whitespace as empty', async () => {
    expect(await codeOf(() => parseBook({ name: 'a.md', bytes: utf8('\n  \n') }))).toBe('empty');
  });
});

describe('importFile', () => {
  const freshStore = () => openBookStore(new IDBFactory());

  it('stores a new file and says it was not there before', async () => {
    const store = freshStore();
    const result = await importFile(store, { name: 'story.txt', bytes: utf8('Once upon a time.') });
    expect(result.alreadyHad).toBe(false);
    expect(result.summary).toMatchObject({ id: result.book.id, title: 'story', chapters: 1 });
    expect(await store.get(result.book.id)).toEqual(result.book);
  });

  it('recognises identical bytes under a different file name', async () => {
    const store = freshStore();
    const bytes = utf8('Once upon a time.');
    const first = await importFile(store, { name: 'story.txt', bytes });
    const second = await importFile(store, { name: 'renamed copy.txt', bytes: bytes.slice() });
    expect(second.alreadyHad).toBe(true);
    expect(second.book).toEqual(first.book);
    expect(second.summary).toEqual(first.summary);
    expect(await store.list()).toHaveLength(1);
  });

  it('keeps two different files apart', async () => {
    const store = freshStore();
    const a = await importFile(store, { name: 'a.txt', bytes: utf8('First story.') });
    const b = await importFile(store, { name: 'b.txt', bytes: utf8('Second story.') });
    expect([a.alreadyHad, b.alreadyHad]).toEqual([false, false]);
    expect(a.book.id).not.toBe(b.book.id);
    expect(await store.list()).toHaveLength(2);
  });

  it('imports an epub into the store', async () => {
    const store = freshStore();
    const result = await importFile(store, { name: 'routed.epub', bytes: EPUB });
    expect(result.book.source).toBe('epub');
    expect((await store.list()).map((summary) => summary.title)).toEqual(['Routed']);
  });

  it('imports a file again after it was deleted', async () => {
    const store = freshStore();
    const file = { name: 'a.txt', bytes: utf8('Words.') };
    const first = await importFile(store, file);
    await store.delete(first.book.id);
    expect((await importFile(store, file)).alreadyHad).toBe(false);
  });

  it('stores nothing when the file cannot be imported', async () => {
    const store = freshStore();
    expect(await codeOf(() => importFile(store, { name: 'a.pdf', bytes: utf8('%PDF-1.4') }))).toBe('unsupported');
    expect(await codeOf(() => importFile(store, { name: 'a.txt', bytes: new Uint8Array() }))).toBe('empty');
    expect(await store.list()).toEqual([]);
  });
});

describe('importErrorMessage', () => {
  const codes: ImportErrorCode[] = ['drm', 'unsupported', 'unreadable', 'empty'];

  it('gives a non-empty sentence for each code', () => {
    for (const code of codes) {
      const message = importErrorMessage(new ImportError(code));
      expect(message.length).toBeGreaterThan(10);
      expect(message).toMatch(/\.$/);
    }
  });

  it('gives a different sentence for each code', () => {
    const messages = codes.map((code) => importErrorMessage(new ImportError(code)));
    expect(new Set(messages).size).toBe(codes.length);
  });

  it('mentions copy protection for drm', () => {
    expect(importErrorMessage(new ImportError('drm'))).toMatch(/copy.protect/i);
  });

  it('does not put the technical detail in the sentence', () => {
    expect(importErrorMessage(new ImportError('unreadable', 'no META-INF/container.xml'))).not.toContain('META-INF');
  });

  it('gives a generic sentence for anything else', () => {
    const generic = importErrorMessage(new Error('boom'));
    expect(generic.length).toBeGreaterThan(10);
    expect(generic).not.toContain('boom');
    expect(codes.map((code) => importErrorMessage(new ImportError(code)))).not.toContain(generic);
    expect(importErrorMessage('a string')).toBe(generic);
    expect(importErrorMessage(undefined)).toBe(generic);
  });
});

describe('ImportError', () => {
  it('carries its code and a name', () => {
    const error = new ImportError('drm', 'detail');
    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe('drm');
    expect(error.name).toBe('ImportError');
    expect(error.message).toBe('drm: detail');
  });
});
