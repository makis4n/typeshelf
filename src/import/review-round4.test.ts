/**
 * Fourth round: inputs that held the page for tens of seconds outside the
 * unzip step, and the background parse that now stands between any such file
 * and the page.
 */
import { IDBFactory } from 'fake-indexeddb';
import { strToU8 } from 'fflate';
import { describe, expect, it, vi } from 'vitest';
import { buildPassage } from '../engine/text';
import { openBookStore } from '../store/books';
import { parseInBackground, type ParseReply, type ParseWorker } from './background';
import { ImportError } from './errors';
import { importFile, parseBook, type PickedFile } from './index';
import { tidy } from './shape';
import { containerXml, OPF_PATH, xhtmlPage, zipEpub } from './testing/epub';

const ACUTE = '́';
const GRAVE_BELOW = '̖';
/** Accents piled on one letter: slow to normalise, in time that grows with the square of the pile. */
const pile = (marks: number) => `a${ACUTE.repeat(marks)}${GRAVE_BELOW.repeat(marks)}`;

async function timed<T>(work: () => Promise<T>, limitMs = 1500): Promise<T | ImportError> {
  const start = performance.now();
  let result: T | ImportError;
  try {
    result = await work();
  } catch (error) {
    if (!(error instanceof ImportError)) throw error;
    result = error;
  }
  expect(performance.now() - start).toBeLessThan(limitMs);
  return result;
}

describe('piles of combining marks', () => {
  it('reads a text file holding one quickly, and keeps what can be typed', async () => {
    const book = await timed(() => parseBook({ name: 'marks.txt', bytes: strToU8(`Hello world. ${pile(131_072)} end.`) }));
    if (book instanceof ImportError) throw book;
    const [paragraph] = book.chapters[0]!.paragraphs;
    expect(paragraph).toMatch(/^Hello world\. a\p{M}{8} end\.$/u);
    // The typing engine normalises every paragraph it is given; that is quick now too.
    const start = performance.now();
    expect(buildPassage([paragraph!]).words).toHaveLength(4);
    expect(performance.now() - start).toBeLessThan(200);
  });

  it('leaves ordinary accents and stacked marks as they are', () => {
    expect(tidy('  Việt   Nam,  café́ ')).toBe('Việt Nam, café́');
    expect(tidy(`x${ACUTE.repeat(8)}`)).toBe(`x${ACUTE.repeat(8)}`);
    expect(tidy(`x${ACUTE.repeat(9)}y`)).toBe(`x${ACUTE.repeat(8)}y`);
  });

  it('reads an EPUB quickly when its container names a package file with one', async () => {
    const zip = zipEpub({ 'META-INF/container.xml': containerXml(pile(131_072)) });
    expect(await timed(() => parseBook({ name: 'path.epub', bytes: zip }))).toMatchObject({ code: 'unreadable' });
  });

  it('reads an EPUB quickly when its files and links are named with them', async () => {
    const name = `${pile(16_000)}.xhtml`;
    const zip = zipEpub({
      'META-INF/container.xml': containerXml(),
      [OPF_PATH]:
        '<package xmlns="http://www.idpf.org/2007/opf"><metadata/><manifest>' +
        `<item id="a" href="${name}" media-type="application/xhtml+xml"/>` +
        '</manifest><spine><itemref idref="a"/></spine></package>',
      [`OEBPS/${name}`]: xhtmlPage('<p>Found.</p>'),
      ...Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`${i}${pile(16_000)}`, 'x'])),
    });
    const book = await timed(() => parseBook({ name: 'names.epub', bytes: zip }));
    // The same overlong name on both sides still matches, so nothing is lost by not normalising it.
    expect(book).toMatchObject({ chapters: [{ paragraphs: ['Found.'] }] });
  });

  it('still matches a file whose name is written with composed accents in one place and decomposed in the other', async () => {
    const zip = zipEpub({
      'META-INF/container.xml': containerXml(),
      [OPF_PATH]:
        '<package xmlns="http://www.idpf.org/2007/opf"><metadata/><manifest>' +
        '<item id="a" href="café.xhtml" media-type="application/xhtml+xml"/>' +
        '</manifest><spine><itemref idref="a"/></spine></package>',
      'OEBPS/café.xhtml': xhtmlPage('<p>Found.</p>'),
    });
    expect(await parseBook({ name: 'accents.epub', bytes: zip })).toMatchObject({ chapters: [{ paragraphs: ['Found.'] }] });
  });
});

describe('a long spine and a long table of contents', () => {
  const count = 30_000;
  const pkg = (spine: string) =>
    '<package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata/><manifest>' +
    '<item id="c" href="c.xhtml" media-type="application/xhtml+xml"/>' +
    '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>' +
    `</manifest><spine>${spine}</spine></package>`;
  const links = Array.from({ length: count }, (_, i) => `<li><a href="c.xhtml#x${i}">Part ${i}</a></li>`).join('');

  it('reads 30,000 references to one document and 30,000 links into it quickly, and reads the document once', async () => {
    const zip = zipEpub({
      'META-INF/container.xml': containerXml(),
      [OPF_PATH]: pkg('<itemref idref="c"/>'.repeat(count)),
      'OEBPS/nav.xhtml': xhtmlPage(`<nav epub:type="toc"><ol>${links}</ol></nav>`),
      'OEBPS/c.xhtml': xhtmlPage('<h1 id="x0">Only</h1><p>Once.</p>'),
    });
    const book = await timed(() => parseBook({ name: 'spine.epub', bytes: zip }), 3000);
    expect(book).toMatchObject({ chapters: [{ title: 'Part 0', paragraphs: ['Once.'] }] });
  });

  it('splits one document at 30,000 linked places quickly', async () => {
    const body = Array.from({ length: count }, (_, i) => `<h2 id="x${i}">H</h2><p>Text ${i}.</p>`).join('');
    const zip = zipEpub({
      'META-INF/container.xml': containerXml(),
      [OPF_PATH]: pkg('<itemref idref="c"/>'),
      'OEBPS/nav.xhtml': xhtmlPage(`<nav epub:type="toc"><ol>${links}</ol></nav>`),
      'OEBPS/c.xhtml': xhtmlPage(body),
    });
    const book = await timed(() => parseBook({ name: 'toc.epub', bytes: zip }), 3000);
    if (book instanceof ImportError) throw book;
    expect(book.chapters).toHaveLength(count);
    expect(book.chapters[count - 1]).toEqual({ title: `Part ${count - 1}`, paragraphs: [`Text ${count - 1}.`] });
  });
});

describe('parsing in the background', () => {
  const file: PickedFile = { name: 'tale.txt', bytes: strToU8('Once.\n\nTwice.') };

  /** A stand-in worker that answers (or never answers) as the test says. */
  function fakeWorker(answer?: (file: PickedFile) => Promise<ParseReply>) {
    const worker: ParseWorker & { stopped: number } = {
      stopped: 0,
      onmessage: null,
      onerror: null,
      terminate: () => void worker.stopped++,
      postMessage: (posted) => void answer?.(posted).then((data) => worker.onmessage?.({ data })),
    };
    return worker;
  }
  const real = (posted: PickedFile): Promise<ParseReply> =>
    parseBook(posted).then(
      (book) => ({ ok: true, book }),
      (error: unknown) => ({ ok: false, code: error instanceof ImportError ? error.code : undefined, detail: String(error) }),
    );

  it('returns the book the worker parsed, and stops the worker', async () => {
    const worker = fakeWorker(real);
    const book = await parseInBackground(file, { start: () => worker });
    expect(book.chapters[0]!.paragraphs).toEqual(['Once.', 'Twice.']);
    expect(worker.stopped).toBe(1);
  });

  it('passes on the worker\'s import error with its code', async () => {
    const worker = fakeWorker(real);
    const failure = parseInBackground({ name: 'x.pdf', bytes: strToU8('%PDF-1.7') }, { start: () => worker });
    await expect(failure).rejects.toMatchObject({ name: 'ImportError', code: 'unsupported' });
    expect(worker.stopped).toBe(1);
  });

  it('stops a parse that never finishes and reports the file as too large', async () => {
    vi.useFakeTimers();
    try {
      const worker = fakeWorker(); // never answers
      const failure = parseInBackground(file, { start: () => worker, timeoutMs: 15_000 });
      const settled = expect(failure).rejects.toMatchObject({ name: 'ImportError', code: 'too-large' });
      await vi.advanceTimersByTimeAsync(14_999);
      expect(worker.stopped).toBe(0);
      await vi.advanceTimersByTimeAsync(1);
      await settled;
      expect(worker.stopped).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports a worker that breaks as a plain failure', async () => {
    const worker = fakeWorker();
    const failure = parseInBackground(file, { start: () => worker });
    worker.onerror?.(new Error('boom'));
    await expect(failure).rejects.toThrow('the import worker failed');
    expect(worker.stopped).toBe(1);
  });

  it('is what importFile uses when the page hands it over, and nothing is stored when it fails', async () => {
    const store = openBookStore(new IDBFactory());
    const slow = () => Promise.reject(new ImportError('too-large', 'parsing took too long'));
    await expect(importFile(store, file, slow)).rejects.toMatchObject({ code: 'too-large' });
    expect(await store.list()).toEqual([]);
    const worker = fakeWorker(real);
    const result = await importFile(store, file, (picked) => parseInBackground(picked, { start: () => worker }));
    expect(result).toMatchObject({ stored: true, alreadyHad: false });
    expect(await store.list()).toHaveLength(1);
  });
});
