/**
 * One group per finding of the adversarial review of the import milestone
 * (G5 and G6 are beside their modules, in epub.test.ts and text.test.ts).
 * Each group has the reported case and, for the heuristics, the opposite
 * case that already worked and must keep working.
 */
import { IDBFactory } from 'fake-indexeddb';
import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { buildPassage } from '../engine/text';
import { openBookStore, type BookStore } from '../store/books';
import { decodeText } from './decode';
import { MAX_UNZIPPED_BYTES, parseEpub } from './epub';
import { ImportError, importErrorMessage } from './errors';
import { importFile, MAX_FILE_BYTES, parseBook } from './index';
import { draftFromMarkdown, parseMarkdown, stripInline } from './markdown';
import { parseMarkup } from './markup';
import { buildEpub, containerXml, OPF_PATH, xhtmlPage, zipEpub } from './testing/epub';
import { chaptersFromText, parseText } from './text';
import { extractBlocks } from './xhtml';

const FILE = { fileName: 'book.txt', fingerprint: 'c'.repeat(64) };
const bytesOf = (text: string) => new TextEncoder().encode(text);

async function codeOf(work: () => unknown): Promise<string> {
  try {
    await work();
  } catch (error) {
    if (error instanceof ImportError) return error.code;
    throw error;
  }
  return 'no error';
}

/** Runs `work` and fails if it takes longer than a linear pass plausibly could. */
function quickly<T>(work: () => T): T {
  const start = performance.now();
  const result = work();
  expect(performance.now() - start).toBeLessThan(1500);
  return result;
}

describe('G1: size limits', () => {
  it('refuses an EPUB whose documents would unzip to more than the limit, without inflating them', async () => {
    const chapter = (i: number) =>
      `<item id="c${i}" href="c${i}.xhtml" media-type="application/xhtml+xml"/>`;
    const padding = new Uint8Array(MAX_UNZIPPED_BYTES / 2 + 1024).fill(0x20); // spaces zip to almost nothing
    const zip = zipSync({
      'META-INF/container.xml': strToU8(containerXml()),
      [OPF_PATH]: strToU8(
        `<package xmlns="http://www.idpf.org/2007/opf"><metadata/><manifest>${chapter(1)}${chapter(2)}</manifest>` +
          '<spine><itemref idref="c1"/><itemref idref="c2"/></spine></package>',
      ),
      'OEBPS/c1.xhtml': padding,
      'OEBPS/c2.xhtml': padding,
    });
    expect(zip.length).toBeLessThan(1024 * 1024);
    expect(await codeOf(() => quickly(() => parseEpub(zip, FILE)))).toBe('too-large');
  });

  it('refuses a text file larger than the text limit, and any file larger than the file limit', async () => {
    const text = new Uint8Array(MAX_UNZIPPED_BYTES + 1).fill(0x61);
    expect(await codeOf(() => parseBook({ name: 'huge.txt', bytes: text }))).toBe('too-large');
    // Only the length is looked at, so the test does not need 200 MB of real data.
    const huge = { length: MAX_FILE_BYTES + 1 } as Uint8Array;
    expect(await codeOf(() => parseBook({ name: 'huge.epub', bytes: huge }))).toBe('too-large');
  });

  it('has its own message', () => {
    expect(importErrorMessage(new ImportError('too-large'))).toMatch(/too large/);
  });

  it('still imports an ordinary EPUB', () => {
    const book = parseEpub(buildEpub({ chapters: [{ title: 'One', paragraphs: ['Fine.'] }] }), FILE);
    expect(book.chapters).toHaveLength(1);
  });
});

describe('G2: markup parsing stays linear', () => {
  it('reads tens of thousands of style elements quickly', () => {
    const root = quickly(() => parseMarkup(`${'<style>p{}</style>'.repeat(60_000)}<p>after</p>`));
    expect(root.children).toHaveLength(60_001);
  });

  it('reads tens of thousands of closing tags that match nothing quickly', () => {
    const root = quickly(() => parseMarkup(`${'<b>'.repeat(40_000)}${'</q>'.repeat(40_000)}text`));
    expect(root.children).toHaveLength(1);
  });

  it('still closes script and style whatever the case of the closing tag, and mismatched tags as before', () => {
    const root = parseMarkup('<STYLE>a<b</Style><p>one<i>two</p>three');
    expect(root.children.map((child) => (typeof child === 'string' ? child : child.name))).toEqual([
      'style',
      'p',
      'three',
    ]);
  });
});

describe('G3: Markdown inline rules stay linear', () => {
  const hostile: [string, string][] = [
    ['bold openers that never close', '**a '.repeat(60_000)],
    ['strikethrough openers that never close', '~~a '.repeat(60_000)],
    ['comment openers that never close', '<!-- a '.repeat(60_000)],
    ['a closed comment followed by openers', `<!-- x -->${'<!-- a '.repeat(60_000)}`],
    ['link openers that never close', '[]('.repeat(60_000)],
    ['brackets that never close', '['.repeat(100_000)],
    ['tags that never close', '<a '.repeat(60_000)],
    ['backtick runs with no partner', Array.from({ length: 600 }, (_, i) => `${'`'.repeat(i + 1)} a `).join('')],
  ];
  it.each(hostile)('reads %s quickly', (_, text) => {
    expect(typeof quickly(() => stripInline(text))).toBe('string');
  });

  it('gives the same text as before for ordinary marks', () => {
    expect(stripInline('**bold** and __bold__, ~~gone~~, `code` and ``a ` b``')).toBe('bold and bold, gone, code and a ` b');
    expect(stripInline('<!-- hidden -->seen <!-- unclosed')).toBe('seen <!-- unclosed');
    expect(stripInline('[a](http://x/y_(z)) ![alt](p.png "t") [b][ref] [^1]')).toBe('a b');
    expect(stripInline('[spaced](my file.md) <em>kept</em> <https://example.com>')).toBe('spaced kept https://example.com');
  });
});

describe('G4: paragraphs the engine cannot type are not stored', () => {
  const invisible = ['​', '­', '‌‍', '⁠ ﻿'];

  it('drops paragraphs made only of zero-width characters and soft hyphens, from every importer', () => {
    const text = parseText(bytesOf(`One.\n\n${invisible.join('\n\n')}\n\nTwo.`), FILE);
    const markdown = parseMarkdown(bytesOf(`One.\n\n${invisible.join('\n\n')}\n\nTwo.`), FILE);
    const epub = parseEpub(
      zipEpub({
        'META-INF/container.xml': containerXml(),
        [OPF_PATH]:
          '<package xmlns="http://www.idpf.org/2007/opf"><metadata/><manifest><item id="a" href="a.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="a"/></spine></package>',
        'OEBPS/a.xhtml': xhtmlPage('<p>One.</p><p>&#8203;</p><p>&shy;</p><p>Two.</p>'),
      }),
      FILE,
    );
    for (const book of [text, markdown, epub]) {
      const { paragraphs } = book.chapters[0]!;
      expect(paragraphs).toEqual(['One.', 'Two.']);
      // The book and the passage built from it number paragraphs the same way.
      expect(buildPassage(paragraphs).paraStart).toHaveLength(paragraphs.length);
    }
  });

  it('keeps a paragraph that has such characters inside real words', () => {
    expect(parseText(bytesOf('co­operate'), FILE).chapters[0]!.paragraphs).toEqual(['co­operate']);
  });
});

describe('G8: many uneven lines with no blank lines are one paragraph each', () => {
  const lines = Array.from({ length: 300 }, (_, i) => (i % 3 === 0 ? `Line ${i} is short.` : `Line ${i} ${'runs on a good deal longer than that '.repeat(2)}.`));

  it('does not merge 300 one-line paragraphs into one', () => {
    const chapters = chaptersFromText(lines.join('\n'));
    expect(chapters).toHaveLength(1);
    expect(chapters[0]!.paragraphs).toHaveLength(300);
  });

  it('still joins a long hard-wrapped paragraph, whose lines are evenly filled', () => {
    const words = 'the quick brown fox jumps over the lazy dog and keeps on running '.repeat(60).trim().split(' ');
    const wrapped: string[] = [];
    let line = '';
    for (const word of words) {
      if (line.length + word.length + 1 > 70) {
        wrapped.push(line);
        line = word;
      } else {
        line = line ? `${line} ${word}` : word;
      }
    }
    wrapped.push(line);
    expect(wrapped.length).toBeGreaterThan(40);
    expect(chaptersFromText(wrapped.join('\n'))[0]!.paragraphs).toEqual([words.join(' ')]);
  });

  it('still joins a short uneven block, as wrapped text with no blank lines always was', () => {
    expect(chaptersFromText('A short line\nthen a rather longer line to follow it\nend.')[0]!.paragraphs).toEqual([
      'A short line then a rather longer line to follow it end.',
    ]);
  });
});

describe('G9: a wrapped line starting with a number is not a list item', () => {
  const paragraphs = (markdown: string) => draftFromMarkdown(markdown).chapters[0]!.paragraphs;

  it('keeps "1945." in the sentence it belongs to', () => {
    expect(paragraphs('The war ended in\n1945. Then peace came.')).toEqual(['The war ended in 1945. Then peace came.']);
  });

  it('still reads a numbered list that follows a line of text without a blank line', () => {
    expect(paragraphs('Steps:\n1. Open the box.\n2. Close the box.\n10. Rest.')).toEqual([
      'Steps:',
      'Open the box.',
      'Close the box.',
      'Rest.',
    ]);
  });

  it('still reads a list that starts at another number after a blank line, and bullets anywhere', () => {
    expect(paragraphs('Later:\n\n3. Third.\n4. Fourth.')).toEqual(['Later:', 'Third.', 'Fourth.']);
    expect(paragraphs('Things:\n- one\n- two')).toEqual(['Things:', 'one', 'two']);
  });
});

describe('G10: Parts over Chapters', () => {
  it('makes the chapters the chapters when the level above is only Part headings', () => {
    const draft = draftFromMarkdown(
      '# Part One\n\n## Chapter 1\n\nA.\n\n## Chapter 2\n\nB.\n\n# Part Two\n\n## Chapter 3\n\nC.\n',
    );
    const filled = draft.chapters.filter((chapter) => chapter.paragraphs.length > 0);
    expect(filled).toEqual([
      { title: 'Chapter 1', paragraphs: ['A.'] },
      { title: 'Chapter 2', paragraphs: ['B.'] },
      { title: 'Chapter 3', paragraphs: ['C.'] },
    ]);
    expect(draft.title).toBeUndefined();
  });

  it('still keeps scenes inside chapters when the top level is not Parts', () => {
    const draft = draftFromMarkdown('# Chapter 1\n\n## Morning\n\nA.\n\n## Evening\n\nB.\n\n# Chapter 2\n\nC.\n');
    expect(draft.chapters.filter((chapter) => chapter.paragraphs.length > 0)).toEqual([
      { title: 'Chapter 1', paragraphs: ['Morning', 'A.', 'Evening', 'B.'] },
      { title: 'Chapter 2', paragraphs: ['C.'] },
    ]);
  });

  it('still treats a single top heading over repeated ones as the title', () => {
    const draft = draftFromMarkdown('# Part of the Furniture\n\n## One\n\nA.\n\n## Two\n\nB.\n');
    expect(draft.title).toBe('Part of the Furniture');
    expect(draft.chapters.filter((chapter) => chapter.paragraphs.length > 0).map((chapter) => chapter.title)).toEqual([
      'One',
      'Two',
    ]);
  });
});

describe('G11: a file that opens with a rule', () => {
  it('keeps the first scene', () => {
    const draft = draftFromMarkdown('---\n\nIt was a dark night.\n\n---\n\nNext scene.');
    expect(draft.chapters[0]!.paragraphs).toEqual(['It was a dark night.', 'Next scene.']);
  });

  it('still reads real front matter, including lists and indented values', () => {
    const draft = draftFromMarkdown(
      '---\ntitle: "Winter"\nauthor: Ada Quill\ntags:\n  - snow\n- ice\n# a comment\n\nlang: en\n---\n\nSnow fell.',
    );
    expect(draft).toMatchObject({ title: 'Winter', author: 'Ada Quill', language: 'en' });
    expect(draft.chapters[0]!.paragraphs).toEqual(['Snow fell.']);
  });
});

describe('G12: a few damaged bytes in a UTF-8 file', () => {
  it('keeps the file as UTF-8 and drops the damaged byte', () => {
    const sound = bytesOf('It’s a café.');
    const damaged = new Uint8Array([...sound, 0x20, 0xff]);
    expect(decodeText(damaged)).toBe('It’s a café. ');
  });

  it('still reads a Windows-1252 file as Windows-1252', () => {
    // “Café”, déjà vu, in Windows-1252.
    const bytes = new Uint8Array([0x93, 0x43, 0x61, 0x66, 0xe9, 0x94, 0x2c, 0x20, 0x64, 0xe9, 0x6a, 0xe0, 0x20, 0x76, 0x75]);
    expect(decodeText(bytes)).toBe('“Café”, déjà vu');
  });
});

describe('G13: numbers that are links', () => {
  const text = (body: string) =>
    extractBlocks(`<html><body>${body}</body></html>`).map((block) => ('text' in block ? block.text : ''));

  it('keeps a year or a chapter number that is a link inside the sentence', () => {
    expect(
      text('<p>The treaty of <a href="#y1815">1815</a> ended it; see chapter <a href="ch3.xhtml#c3">3</a>.</p>'),
    ).toEqual(['The treaty of 1815 ended it; see chapter 3.']);
  });

  it('still drops a marker stuck to the word before it, however its link is named', () => {
    expect(text('<p>She climbed the stairs<a href="#x7">1</a> slowly.<a href="back.xhtml#a">12</a></p>')).toEqual([
      'She climbed the stairs slowly.',
    ]);
  });

  it('still drops a marker after a space when the link says it is a note, and bracketed markers anywhere', () => {
    expect(text('<p>Stairs <a href="notes.xhtml#fn3">3</a> and more <a href="#q">[4]</a> and <a class="footnote-ref" href="#z9">5</a>.</p>')).toEqual([
      'Stairs and more and .',
    ]);
  });

  it('still drops the number that starts a note and links back to the text', () => {
    expect(text('<p>\n  <a href="ch1.xhtml#r1">1</a> The note itself.</p>')).toEqual(['The note itself.']);
  });
});

describe('G14: storage that does not work', () => {
  const file = { name: 'tale.txt', bytes: bytesOf('Once.\n\nTwice.') };
  const working = () => openBookStore(new IDBFactory());
  const broken = (parts: Partial<BookStore>): BookStore => ({ ...working(), ...parts });
  const refuse = () => Promise.reject(new DOMException('blocked', 'SecurityError'));

  it('still returns the parsed book when storage cannot be read or written, and says it was not stored', async () => {
    const result = await importFile(broken({ findByFingerprint: refuse, get: refuse, save: refuse }), file);
    expect(result.book.chapters[0]!.paragraphs).toEqual(['Once.', 'Twice.']);
    expect(result).toMatchObject({ stored: false, alreadyHad: false });
    expect(result.summary).toMatchObject({ id: result.book.id, title: 'tale', chapters: 1 });
  });

  it('still returns the parsed book when only the write fails (storage full)', async () => {
    const full = () => Promise.reject(new DOMException('full', 'QuotaExceededError'));
    expect(await importFile(broken({ save: full }), file)).toMatchObject({ stored: false });
  });

  it('reports a stored book as stored, and a bad file as its own error', async () => {
    const store = working();
    expect(await importFile(store, file)).toMatchObject({ stored: true, alreadyHad: false });
    expect(await importFile(store, file)).toMatchObject({ stored: true, alreadyHad: true });
    const pdf = { name: 'x.pdf', bytes: bytesOf('%PDF-1.7') };
    expect(await codeOf(() => importFile(broken({ findByFingerprint: refuse }), pdf))).toBe('unsupported');
  });
});
