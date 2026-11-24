/**
 * Third round: findings of the review of the zip reader and of the second
 * round's own heuristics. Each group has the reported input.
 */
import { deflateSync, strToU8 } from 'fflate';
import { describe, expect, it } from 'vitest';
import { ImportError } from './errors';
import { draftFromMarkdown } from './markdown';
import { chaptersFromText } from './text';
import { openZip } from './zip';

const BUDGET = 64 * 1024 * 1024;

function codeOf(work: () => unknown): string {
  try {
    work();
  } catch (error) {
    if (error instanceof ImportError) return error.code;
    throw error;
  }
  return 'no error';
}

function quickly<T>(work: () => T, limitMs = 1000): T {
  const start = performance.now();
  const result = work();
  expect(performance.now() - start).toBeLessThan(limitMs);
  return result;
}

interface Part {
  data: Uint8Array;
  method: 0 | 8;
  claims: number;
}

/** A zip written by hand: `names` says which part each name points at, so the directory can lie. */
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

const extractAll = (zip: Uint8Array) => openZip(zip, BUDGET).extract(() => true);

/** Bytes that do not compress, different on every call position. */
function noise(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  let state = 0x2545f491;
  for (let i = 0; i < length; i++) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    bytes[i] = state & 0xff;
  }
  return bytes;
}

describe('zip: compressed data that runs on after the stream has ended', () => {
  const content = strToU8('<container>the real file</container>');
  const stream = deflateSync(content);
  const padded = (junk: number) => {
    const data = new Uint8Array(stream.length + junk);
    data.set(stream);
    data.set(noise(junk), stream.length);
    return data;
  };

  it('returns the file at once when 16 MB of junk follows a stream of the claimed size', () => {
    const zip = handZip([{ data: padded(16 * 1024 * 1024), method: 8, claims: content.length }], [['a.xml', 0]]);
    expect(quickly(() => extractAll(zip)).get('a.xml')).toEqual(content);
  });

  it('fails at once when the stream ends short of the claimed size and junk follows', () => {
    const zip = handZip([{ data: padded(16 * 1024 * 1024), method: 8, claims: content.length + 1 }], [['a.xml', 0]]);
    expect(quickly(() => codeOf(() => extractAll(zip)))).toBe('unreadable');
  });

  it('fails at once on megabytes of blocks that unpack to nothing', () => {
    // 5 bytes each: a stored block of length zero, not the last one.
    const empty = [0x00, 0x00, 0x00, 0xff, 0xff];
    const data = new Uint8Array(2 * 1024 * 1024);
    for (let i = 0; i + 5 <= data.length; i += 5) data.set(empty, i);
    const zip = handZip([{ data, method: 8, claims: 70 }], [['a.xml', 0]]);
    expect(quickly(() => codeOf(() => extractAll(zip)))).toBe('unreadable');
  });
});

describe('zip: entries that share data', () => {
  it('refuses a directory with many names for one piece of data', () => {
    const page = deflateSync(strToU8('<p>One chapter, claimed two hundred times.</p>'));
    const names = Array.from({ length: 200 }, (_, i): [string, number] => [`c${i}.xhtml`, 0]);
    const zip = handZip([{ data: page, method: 8, claims: 46 }], names);
    expect(quickly(() => codeOf(() => openZip(zip, BUDGET)))).toBe('unreadable');
  });

  it('refuses entries that overlap only in part', () => {
    const a = strToU8('a'.repeat(100));
    const zip = handZip(
      [
        { data: a, method: 0, claims: 100 },
        { data: a, method: 0, claims: 100 },
      ],
      [
        ['a.txt', 0],
        ['b.txt', 1],
      ],
    );
    // Stretch the first entry's compressed size so that it runs into the second.
    const view = new DataView(zip.buffer);
    for (let i = 0; i < zip.length - 4; i++) {
      if (view.getUint32(i, true) === 0x02014b50 && view.getUint32(i + 42, true) === 0) view.setUint32(i + 20, 160, true);
    }
    expect(codeOf(() => openZip(zip, BUDGET))).toBe('unreadable');
  });
});

describe('zip: sound files are read exactly, whatever their blocks look like', () => {
  const cases: [string, Uint8Array, 0 | 6 | 9][] = [
    ['2 MB that does not compress, as stored blocks', noise(2 * 1024 * 1024), 0],
    ['2 MB that does not compress, deflated', noise(2 * 1024 * 1024), 6],
    ['5 MB of one byte', new Uint8Array(5 * 1024 * 1024).fill(0x20), 9],
    ['an empty file', new Uint8Array(0), 6],
    ['one byte', new Uint8Array([7]), 6],
  ];
  it.each(cases)('%s', (_, content, level) => {
    const zip = handZip(
      [
        { data: deflateSync(content, { level }), method: 8, claims: content.length },
        { data: content.subarray(0, 1000), method: 0, claims: Math.min(1000, content.length) },
      ],
      [
        ['deflated.bin', 0],
        ['stored.bin', 1],
      ],
    );
    const files = extractAll(zip);
    expect(files.get('deflated.bin')!.length).toBe(content.length);
    expect(Buffer.compare(files.get('deflated.bin')!, content)).toBe(0);
    expect(files.get('stored.bin')!.length).toBe(Math.min(1000, content.length));
  });
});

describe('text: one line per paragraph in writing without spaces', () => {
  const glyphs = '天地玄黄宇宙洪荒日月盈昃辰宿列张寒来暑往秋收冬藏闰余成岁律吕调阳云腾致雨露结为霜';
  const line = (seed: number, length: number) =>
    `${Array.from({ length }, (_, i) => glyphs[(seed * 5 + i * 3) % glyphs.length]).join('')}。`;

  it('keeps 80 lines of 30 to 60 characters as 80 paragraphs', () => {
    const lines = Array.from({ length: 80 }, (_, i) => line(i, 30 + ((i * 7) % 30)));
    expect(chaptersFromText(lines.join('\n'))[0]!.paragraphs).toEqual(lines);
  });

  it('keeps short dialogue alternating with narration as one paragraph per line', () => {
    const lines = Array.from({ length: 120 }, (_, i) => (i % 2 === 0 ? '“好。”' : line(i, 40)));
    expect(chaptersFromText(lines.join('\n'))[0]!.paragraphs).toHaveLength(120);
  });
});

describe('text: wrapping that aims below its widest line', () => {
  /** Like BSD `fmt`: aims for `goal` columns and takes one more word when that lands nearer, up to `max`. */
  function fmt(words: string[], goal: number, max: number): string[] {
    const lines: string[] = [];
    let current = '';
    for (const word of words) {
      const longer = current ? `${current} ${word}` : word;
      const nearer = Math.abs(longer.length - goal) <= Math.abs(current.length - goal);
      if (current && (longer.length > max || (longer.length > goal && !nearer))) {
        lines.push(current);
        current = word;
      } else {
        current = longer;
      }
    }
    lines.push(current);
    return lines;
  }

  it('still joins a 700-word paragraph wrapped that way', () => {
    const vocabulary =
      'a the of rain window garden yesterday remembered and under quietly bridge stood waiting river it was in'.split(' ');
    const words = Array.from({ length: 700 }, (_, i) => vocabulary[(i * 5 + (i % 11)) % vocabulary.length]!);
    const lines = fmt(words, 65, 75);
    expect(lines.length).toBeGreaterThan(40);
    expect(Math.min(...lines.slice(0, -1).map((text) => text.length))).toBeLessThan(64);
    expect(chaptersFromText(lines.join('\n'))[0]!.paragraphs).toEqual([words.join(' ')]);
  });
});

describe('markdown: Part headings of every kind', () => {
  const titles = (markdown: string) =>
    draftFromMarkdown(markdown)
      .chapters.filter((chapter) => chapter.paragraphs.length > 0)
      .map((chapter) => chapter.title);
  const book = (parts: string[]) =>
    parts.map((part, i) => `# ${part}\n\n## Chapter ${i * 2 + 1}\n\nText.\n\n## Chapter ${i * 2 + 2}\n\nText.\n`).join('\n');
  const chapters = (count: number) => Array.from({ length: count }, (_, i) => `Chapter ${i + 1}`);

  it.each([
    [['Book First', 'Book Eleventh', 'Book Twelfth', 'Book Thirteenth']],
    [['Part One', 'Part Two', 'Part Thirteen']],
    [['Part A', 'Part B']],
    [['Book Thirteen', 'Book Fourteen']],
    [['Volume the Twenty-First', 'Volume the Twenty-Second']],
  ])('splits at the chapters under %j', (parts) => {
    expect(titles(book(parts))).toEqual(chapters(parts.length * 2));
  });

  it('splits at the chapters when a Prologue sits beside parts numbered past twelve', () => {
    expect(titles(`# Prologue\n\nBefore.\n\n${book(['Part Thirteen', 'Part Fourteen'])}`)).toEqual([
      'Prologue',
      ...chapters(4),
    ]);
  });
});
