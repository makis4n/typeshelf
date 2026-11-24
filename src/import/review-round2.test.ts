/**
 * Second round of the adversarial review: one group per item that still
 * reproduced after the first fixes, each with the reported input.
 */
import { deflateSync, strToU8 } from 'fflate';
import { describe, expect, it } from 'vitest';
import { MAX_UNZIPPED_BYTES, parseEpub } from './epub';
import { ImportError } from './errors';
import { draftFromMarkdown, stripInline } from './markdown';
import { buildEpub, containerXml, OPF_PATH, xhtmlPage } from './testing/epub';
import { chaptersFromText, parseText, stripGutenbergNotice } from './text';

const FILE = { fileName: 'book.txt', fingerprint: 'd'.repeat(64) };
const bytesOf = (text: string) => new TextEncoder().encode(text);

function codeOf(work: () => unknown): string {
  try {
    work();
  } catch (error) {
    if (error instanceof ImportError) return error.code;
    throw error;
  }
  return 'no error';
}

function quickly<T>(work: () => T, limitMs = 1500): T {
  const start = performance.now();
  const result = work();
  expect(performance.now() - start).toBeLessThan(limitMs);
  return result;
}

/** One file's data as it sits in a zip, and what the zip's directory says about it. */
interface Part {
  data: Uint8Array;
  method: 0 | 8;
  /** The uncompressed size the directory claims. */
  claims: number;
}
const deflated = (content: Uint8Array | string, claims?: number): Part => {
  const raw = typeof content === 'string' ? strToU8(content) : content;
  return { data: deflateSync(raw, { level: 9 }), method: 8, claims: claims ?? raw.length };
};

/**
 * Writes a zip by hand, so the directory can say things an honest zip tool
 * never would: several names for one piece of data, and sizes that are not true.
 */
function handZip(parts: Part[], names: [name: string, part: number][]): Uint8Array {
  const chunks: Uint8Array[] = [];
  let length = 0;
  const add = (bytes: Uint8Array) => {
    chunks.push(bytes);
    length += bytes.length;
  };
  const record = (size: number, fill: (view: DataView) => void) => {
    const bytes = new Uint8Array(size);
    fill(new DataView(bytes.buffer));
    return bytes;
  };

  const offsets = parts.map((part) => {
    const at = length;
    add(
      record(30, (view) => {
        view.setUint32(0, 0x04034b50, true);
        view.setUint16(4, 20, true);
        view.setUint16(8, part.method, true);
        view.setUint32(18, part.data.length, true);
        view.setUint32(22, part.claims, true);
      }),
    );
    add(part.data);
    return at;
  });

  const directoryAt = length;
  for (const [name, index] of names) {
    const part = parts[index]!;
    const encoded = strToU8(name);
    add(
      record(46, (view) => {
        view.setUint32(0, 0x02014b50, true);
        view.setUint16(4, 20, true);
        view.setUint16(6, 20, true);
        view.setUint16(10, part.method, true);
        view.setUint32(20, part.data.length, true);
        view.setUint32(24, part.claims, true);
        view.setUint16(28, encoded.length, true);
        view.setUint32(42, offsets[index]!, true);
      }),
    );
    add(encoded);
  }
  const directorySize = length - directoryAt;
  add(
    record(22, (view) => {
      view.setUint32(0, 0x06054b50, true);
      view.setUint16(8, names.length, true);
      view.setUint16(10, names.length, true);
      view.setUint32(12, directorySize, true);
      view.setUint32(16, directoryAt, true);
    }),
  );

  const zip = new Uint8Array(length);
  let at = 0;
  for (const chunk of chunks) {
    zip.set(chunk, at);
    at += chunk.length;
  }
  return zip;
}

const packageOf = (count: number) => {
  const ids = Array.from({ length: count }, (_, i) => `c${i}`);
  return (
    '<package xmlns="http://www.idpf.org/2007/opf"><metadata/><manifest>' +
    ids.map((id) => `<item id="${id}" href="${id}.xhtml" media-type="application/xhtml+xml"/>`).join('') +
    '</manifest><spine>' +
    ids.map((id) => `<itemref idref="${id}"/>`).join('') +
    '</spine></package>'
  );
};

describe('G1 again: sizes the zip lies about', () => {
  it('reads a hand-written zip that tells the truth (the builder itself is sound)', () => {
    const zip = handZip(
      [deflated(containerXml()), deflated(packageOf(1)), deflated(xhtmlPage('<h1>One</h1><p>Honest text.</p>'))],
      [
        ['META-INF/container.xml', 0],
        [OPF_PATH, 1],
        ['OEBPS/c0.xhtml', 2],
      ],
    );
    expect(parseEpub(zip, FILE).chapters).toEqual([{ title: 'One', paragraphs: ['Honest text.'] }]);
  });

  it('stops at once when many entries share one huge stream and each claims to be 100 bytes', () => {
    const count = 64;
    const bomb = deflated(new Uint8Array(256 * 1024 * 1024).fill(0x20), 100);
    const zip = handZip(
      [deflated(containerXml()), deflated(packageOf(count)), bomb],
      [
        ['META-INF/container.xml', 0],
        [OPF_PATH, 1],
        ...Array.from({ length: count }, (_, i): [string, number] => [`OEBPS/c${i}.xhtml`, 2]),
      ],
    );
    expect(zip.length).toBeLessThan(1024 * 1024);
    // The old code inflated all 256 MB once per entry. Now the first byte past the claimed size ends it.
    expect(quickly(() => codeOf(() => parseEpub(zip, FILE)), 500)).toBe('unreadable');
  }, 60_000);

  it('counts stored (uncompressed) entries against the limit too', () => {
    const half = { data: new Uint8Array(MAX_UNZIPPED_BYTES / 2 + 1024).fill(0x20), method: 0 as const, claims: 0 };
    half.claims = half.data.length;
    const zip = handZip(
      [deflated(containerXml()), deflated(packageOf(2)), half, half],
      [
        ['META-INF/container.xml', 0],
        [OPF_PATH, 1],
        ['OEBPS/c0.xhtml', 2],
        ['OEBPS/c1.xhtml', 3],
      ],
    );
    expect(quickly(() => codeOf(() => parseEpub(zip, FILE)))).toBe('too-large');
  });

  it('refuses a stored entry whose two sizes disagree, and data that runs past the end of the file', () => {
    const page = strToU8(xhtmlPage('<p>Text.</p>'));
    const names: [string, number][] = [
      ['META-INF/container.xml', 0],
      [OPF_PATH, 1],
      ['OEBPS/c0.xhtml', 2],
    ];
    const mismatched = handZip(
      [deflated(containerXml()), deflated(packageOf(1)), { data: page, method: 0, claims: 5 }],
      names,
    );
    expect(codeOf(() => parseEpub(mismatched, FILE))).toBe('unreadable');

    const honest = handZip([deflated(containerXml()), deflated(packageOf(1)), deflated(page)], names);
    const cut = honest.slice();
    // Point the chapter's entry far past the end of the file.
    const view = new DataView(cut.buffer);
    for (let i = cut.length - 22; i > 0; i--) {
      if (view.getUint32(i, true) === 0x02014b50 && cut[i + 46 + 5] === 0x2f && cut[i + 46 + 6] === 0x63) {
        view.setUint32(i + 42, 0x7fffffff, true);
      }
    }
    expect(codeOf(() => parseEpub(cut, FILE))).toBe('unreadable');
  });

  it('still reads an ordinary EPUB made by a zip library', () => {
    const book = parseEpub(buildEpub({ chapters: [{ title: 'One', paragraphs: ['Fine.'] }] }), FILE);
    expect(book.chapters).toEqual([{ title: 'One', paragraphs: ['Fine.'] }]);
  });
});

describe('N2: text that only mentions Project Gutenberg is never cut', () => {
  const novel = [
    'CHAPTER 1',
    '',
    'She worked through the queue all winter, but the',
    'end of the Project Gutenberg backlog was nowhere in sight,',
    'and she said so.',
    '',
    'CHAPTER 2',
    '',
    'End of Project Gutenberg, she thought. Then she went home.',
    '',
    'CHAPTER 3',
    '',
    'Spring came.',
  ].join('\n');

  it('keeps every chapter of a book with no START line', () => {
    expect(stripGutenbergNotice(novel)).toBe(novel);
    const book = parseText(bytesOf(novel), FILE);
    expect(book.chapters.map((chapter) => chapter.title)).toEqual(['CHAPTER 1', 'CHAPTER 2', 'CHAPTER 3']);
    expect(book.chapters[0]!.paragraphs[0]).toMatch(/nowhere in sight, and she said so\.$/);
  });

  it('keeps such sentences inside a real Gutenberg file, and still cuts at its END line', () => {
    const file = `Title: T\n\n*** START OF THE PROJECT GUTENBERG EBOOK T ***\n\n${novel}\n\n*** END OF THE PROJECT GUTENBERG EBOOK T ***\n\nLicence.`;
    const chapters = chaptersFromText(stripGutenbergNotice(file));
    expect(chapters.filter((chapter) => chapter.paragraphs.length > 0).map((chapter) => chapter.title)).toEqual([
      'CHAPTER 1',
      'CHAPTER 2',
      'CHAPTER 3',
    ]);
    expect(chapters.at(-1)!.paragraphs).toEqual(['Spring came.']);
  });

  it('still cuts at the older ending, written as a line of its own', () => {
    for (const ending of [
      'End of the Project Gutenberg EBook of Old One, by Nobody',
      "End of Project Gutenberg's Old One, by Nobody",
      'End of The Project Gutenberg Etext of Old One',
    ]) {
      const file = `*** START OF THIS PROJECT GUTENBERG EBOOK OLD ONE ***\n\nThe book.\n\n${ending}\n\nLicence.`;
      expect(stripGutenbergNotice(file).trim()).toBe('The book.');
    }
  });
});

describe('N1: many backtick runs of one length', () => {
  it('reads unclosed single backticks quickly', () => {
    const text = '`a '.repeat(60_000);
    // They pair up two by two, exactly as before: `a ` is code, the next a is text, and so on.
    const result = quickly(() => stripInline(text));
    expect(result).not.toContain('`');
    expect(result.startsWith('aa aa aa')).toBe(true);
  });

  it('reads many code spans quickly', () => {
    expect(quickly(() => stripInline('`a` '.repeat(30_000)))).toBe('a '.repeat(30_000).trim());
  });

  it('gives the same text as before', () => {
    expect(stripInline('`one` and ``two ` three`` and ` lone')).toBe('one and two ` three and ` lone');
    expect(draftFromMarkdown('Use `x_y` and `**z**` here.').chapters[0]!.paragraphs).toEqual(['Use x_y and z here.']);
  });
});

/** Breaks words into lines the way a wrapping editor does: a word moves down only when it does not fit. */
function wrap(words: string[], width: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    if (line.length > 0 && line.length + 1 + word.length > width) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  lines.push(line);
  return lines;
}

describe('G8 again: one line per paragraph, with fairly even lines', () => {
  const vocabulary = 'a the of rain window garden yesterday remembered and under quietly bridge stood waiting river'.split(' ');
  /** A sentence of roughly `length` characters, different for every `seed`. */
  const sentence = (seed: number, length: number) => {
    let text = '';
    for (let i = 0; text.length < length; i++) text += `${text ? ' ' : ''}${vocabulary[(seed * 7 + i * 3) % vocabulary.length]}`;
    return `${text}.`;
  };

  it('keeps 300 lines of 40 to 70 characters as 300 paragraphs', () => {
    const lines = Array.from({ length: 300 }, (_, i) => sentence(i, 40 + ((i * 13) % 30)));
    expect(chaptersFromText(lines.join('\n'))[0]!.paragraphs).toHaveLength(300);
  });

  it('keeps 120 short lines that each end a sentence as one paragraph per line', () => {
    const lines = Array.from({ length: 120 }, (_, i) => sentence(i, 25 + ((i * 11) % 20)));
    expect(chaptersFromText(lines.join('\n'))[0]!.paragraphs).toHaveLength(120);
  });

  it('still joins a very long wrapped paragraph, even with one line longer than the rest', () => {
    const words = Array.from({ length: 900 }, (_, i) => vocabulary[(i * 5 + (i % 7)) % vocabulary.length]!);
    const lines = wrap(words, 72);
    lines[10] = `${lines[10]} https://example.com/a-long-address-nobody-could-break`;
    expect(lines.length).toBeGreaterThan(60);
    expect(chaptersFromText(lines.join('\n'))[0]!.paragraphs).toEqual([lines.join(' ')]);
  });

  it('still joins wrapped paragraphs of any length when blank lines separate them', () => {
    const one = wrap(Array.from({ length: 700 }, (_, i) => vocabulary[(i * 3) % vocabulary.length]!), 60);
    const two = ['A short', 'uneven pair.'];
    expect(chaptersFromText(`${one.join('\n')}\n\n${two.join('\n')}`)[0]!.paragraphs).toEqual([
      one.join(' '),
      'A short uneven pair.',
    ]);
  });
});

describe('G10 again: Parts beside other top-level headings', () => {
  const titles = (markdown: string) =>
    draftFromMarkdown(markdown)
      .chapters.filter((chapter) => chapter.paragraphs.length > 0)
      .map((chapter) => chapter.title);

  it('reads Prologue, the chapters inside the Parts, and Epilogue as the chapters', () => {
    expect(
      titles(
        '# Prologue\n\nP.\n\n# Part One\n\n## Chapter 1\n\nA.\n\n## Chapter 2\n\nB.\n\n# Part Two\n\n## Chapter 3\n\nC.\n\n# Epilogue\n\nE.\n',
      ),
    ).toEqual(['Prologue', 'Chapter 1', 'Chapter 2', 'Chapter 3', 'Epilogue']);
  });

  it('still keeps sub-headings inside chapters when one of them is outside any Part', () => {
    expect(titles('# Part One\n\n## A\n\nA.\n\n# Notes\n\n## B\n\nB.\n')).toEqual(['Part One', 'Notes']);
  });

  it('still treats a heading that only begins with the word as an ordinary chapter beside others', () => {
    expect(titles('# Part of the Furniture\n\n## A\n\nA.\n\n## B\n\nB.\n\n# Reviews\n\nR.\n')).toEqual([
      'Part of the Furniture',
      'Reviews',
    ]);
  });
});
