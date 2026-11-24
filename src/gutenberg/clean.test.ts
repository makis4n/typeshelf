import { describe, expect, it } from 'vitest';
import { buildPassage } from '../engine/text';
import { cleanGutenberg, GutenbergFormatError } from './clean';

const HEADER = [
  'Title: The Quiet Harbour',
  '',
  'Author: Jane Example',
  '',
  'Language: English',
  '',
  '*** START OF THE PROJECT GUTENBERG EBOOK THE QUIET HARBOUR ***',
].join('\n');
const FOOTER = '*** END OF THE PROJECT GUTENBERG EBOOK THE QUIET HARBOUR ***\nLicense text here.';

/** A complete file around a body. */
const file = (body: string, header = HEADER, footer = FOOTER): string =>
  `${header}\n\n${body}\n\n${footer}\n`;

const paragraphsOf = async (body: string): Promise<string[]> =>
  (await cleanGutenberg(file(body), 1)).chapters.flatMap((c) => c.paragraphs);

describe('cleanGutenberg metadata', () => {
  it('reads title, author and language and builds the id', async () => {
    const book = await cleanGutenberg(file('Some text.'), 42);
    expect(book).toMatchObject({
      id: 'gutenberg:42',
      title: 'The Quiet Harbour',
      author: 'Jane Example',
      language: 'en',
      source: 'gutenberg',
    });
  });

  it('joins a title that wraps onto indented lines', async () => {
    const header = [
      'Title: A Very Long Title That',
      '       Wraps Twice,',
      '       Over Three Lines',
      'Author: Jane Example',
      '*** START OF THE PROJECT GUTENBERG EBOOK X ***',
    ].join('\n');
    const book = await cleanGutenberg(file('Text.', header), 1);
    expect(book.title).toBe('A Very Long Title That Wraps Twice, Over Three Lines');
    expect(book.author).toBe('Jane Example');
  });

  it('maps language names to BCP 47 and falls back to und', async () => {
    const cases: [string, string][] = [
      ['French', 'fr'],
      ['German', 'de'],
      ['Spanish', 'es'],
      ['Italian', 'it'],
      ['Portuguese', 'pt'],
      ['Dutch', 'nl'],
      ['Swedish', 'sv'],
      ['Finnish', 'fi'],
      ['Latin', 'la'],
      ['Klingon', 'und'],
    ];
    for (const [name, tag] of cases) {
      const header = `Title: T\nLanguage: ${name}\n*** START OF THE PROJECT GUTENBERG EBOOK T ***`;
      expect((await cleanGutenberg(file('Text.', header), 1)).language).toBe(tag);
    }
  });

  it('uses und without a Language line and Unknown without an Author line', async () => {
    const header = 'Title: T\n*** START OF THE PROJECT GUTENBERG EBOOK T ***';
    const book = await cleanGutenberg(file('Text.', header), 1);
    expect(book.language).toBe('und');
    expect(book.author).toBe('Unknown');
  });

  it('fingerprints the raw input as lowercase hex SHA-256', async () => {
    const book = await cleanGutenberg('Title: T\n*** START OF THE PROJECT GUTENBERG EBOOK T ***\nHi.\n', 1);
    const expected = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode('Title: T\n*** START OF THE PROJECT GUTENBERG EBOOK T ***\nHi.\n'),
    );
    const hex = Array.from(new Uint8Array(expected), (b) => b.toString(16).padStart(2, '0')).join('');
    expect(book.fingerprint).toBe(hex);
    expect(book.fingerprint).toMatch(/^[0-9a-f]{64}$/u);
  });
});

describe('cleanGutenberg markers', () => {
  const variants: [string, string, string][] = [
    ['THE', '*** START OF THE PROJECT GUTENBERG EBOOK X ***', '*** END OF THE PROJECT GUTENBERG EBOOK X ***'],
    ['THIS', '*** START OF THIS PROJECT GUTENBERG EBOOK X ***', '*** END OF THIS PROJECT GUTENBERG EBOOK X ***'],
    ['no space', '***START OF THE PROJECT GUTENBERG EBOOK X***', '***END OF THE PROJECT GUTENBERG EBOOK X***'],
  ];
  for (const [name, start, end] of variants) {
    it(`handles the "${name}" variant`, async () => {
      const raw = `Title: T\n${start}\n\nInside text here.\n\n${end}\nOutside text.\n`;
      const book = await cleanGutenberg(raw, 1);
      expect(book.chapters.flatMap((c) => c.paragraphs)).toEqual(['Inside text here.']);
    });
  }

  it('cuts at the old "End of the Project Gutenberg EBook" line when there is no end marker', async () => {
    const raw = `${HEADER}\n\nKept.\n\nEnd of the Project Gutenberg EBook of The Quiet Harbour\n\nLicense.\n`;
    expect(await paragraphsOf('Kept.').then(() => cleanGutenberg(raw, 1))).toMatchObject({
      chapters: [{ paragraphs: ['Kept.'] }],
    });
  });

  it("cuts at \"End of Project Gutenberg's\" when there is no end marker", async () => {
    const raw = `${HEADER}\n\nKept.\n\nEnd of Project Gutenberg's The Quiet Harbour, by Jane\n\nLicense.\n`;
    expect((await cleanGutenberg(raw, 1)).chapters[0].paragraphs).toEqual(['Kept.']);
  });

  it('keeps everything to the end of the file when no end form exists', async () => {
    const raw = `${HEADER}\n\nOne.\n\nTwo.\n`;
    expect((await cleanGutenberg(raw, 1)).chapters[0].paragraphs).toEqual(['One.', 'Two.']);
  });

  it('throws GutenbergFormatError without a start marker', async () => {
    await expect(cleanGutenberg('Just some text.\n\nMore text.', 1)).rejects.toBeInstanceOf(GutenbergFormatError);
  });
});

describe('cleanGutenberg input normalisation', () => {
  it('strips a BOM', async () => {
    const book = await cleanGutenberg(`﻿${file('Text.')}`, 1);
    expect(book.title).toBe('The Quiet Harbour');
  });

  it('handles CRLF and lone CR line endings', async () => {
    const crlf = file('First line\nwrapped on.\n\nSecond paragraph.').replace(/\n/gu, '\r\n');
    expect((await cleanGutenberg(crlf, 1)).chapters[0].paragraphs).toEqual([
      'First line wrapped on.',
      'Second paragraph.',
    ]);
    const cr = file('Alpha\nbeta.\n\nGamma.').replace(/\n/gu, '\r');
    expect((await cleanGutenberg(cr, 1)).chapters[0].paragraphs).toEqual(['Alpha beta.', 'Gamma.']);
  });
});

describe('cleanGutenberg removals', () => {
  it('drops production credits after the start marker', async () => {
    const body = 'Produced by Some Volunteers and the\nOnline Team\n\nE-text prepared by Someone\n\nReal text.';
    expect(await paragraphsOf(body)).toEqual(['Real text.']);
  });

  it('drops Transcribed from credits but not the same words later in the text', async () => {
    const body = 'Transcribed from the 1900 edition by A. Person\n\nReal text.\n\nProduced by hand, she said.';
    expect(await paragraphsOf(body)).toEqual(['Real text.', 'Produced by hand, she said.']);
  });

  it("drops transcriber's notes, bracketed or not", async () => {
    const body = [
      "Transcriber's Note:\nSpelling is as printed.",
      "[Transcriber's Note: The cover\n\nis public domain.]",
      'Real text.',
    ].join('\n\n');
    expect(await paragraphsOf(body)).toEqual(['Real text.']);
  });

  it('drops [Illustration] lines, with and without captions', async () => {
    const body = '[Illustration]\n\nBefore.\n\n[Illustration: A boat on\nthe water]\n\nAfter.';
    expect(await paragraphsOf(body)).toEqual(['Before.', 'After.']);
  });

  it('drops a table of contents ended by a repeated heading', async () => {
    const body = [
      'CONTENTS',
      'CHAPTER I. The Arrival\nCHAPTER II. The Storm\nCHAPTER III. The Leaving',
      'CHAPTER I',
      'The Arrival',
      'The boat came into the harbour on a grey morning with all the villagers watching.',
      'CHAPTER II',
      'The Storm',
      'The wind rose before noon and the sea turned white against the long stone wall.',
    ].join('\n\n');
    const book = await cleanGutenberg(file(body), 1);
    expect(book.chapters.map((c) => c.title)).toEqual(['CHAPTER I: The Arrival', 'CHAPTER II: The Storm']);
    expect(book.chapters.flatMap((c) => c.paragraphs).join(' ')).not.toMatch(/CONTENTS|Leaving/u);
  });

  it('drops a contents list with one entry per paragraph, ended by prose', async () => {
    const body = [
      'CONTENTS',
      'Arrival',
      'Storm',
      'Leaving',
      'The boat came into the harbour on a grey morning with all the villagers watching.',
    ].join('\n\n');
    expect(await paragraphsOf(body)).toEqual([
      'The boat came into the harbour on a grey morning with all the villagers watching.',
    ]);
  });

  it('does not treat a lone "Contents" line as a table of contents', async () => {
    const body = 'Contents\n\nThe boat came into the harbour on a grey morning with all the villagers watching.';
    expect(await paragraphsOf(body)).toHaveLength(2);
  });

  it('drops scene-break lines made only of symbols', async () => {
    expect(await paragraphsOf('One.\n\n* * * * *\n\nTwo.')).toEqual(['One.', 'Two.']);
  });
});

describe('cleanGutenberg paragraphs', () => {
  it('joins hard-wrapped lines with a single space and collapses spaces', async () => {
    expect(await paragraphsOf('The first   line\n   continues here\nand ends.\n\n\n\nNext one.')).toEqual([
      'The first line continues here and ends.',
      'Next one.',
    ]);
  });

  it('joins a hyphenated line break without inventing a space or removing the hyphen', async () => {
    expect(await paragraphsOf('A well-\nknown fact about the har-\nbour.')).toEqual([
      'A well-known fact about the har-bour.',
    ]);
  });

  it('does not join a spaced dash onto the next word', async () => {
    expect(await paragraphsOf('Wait -\nthen go.')).toEqual(['Wait - then go.']);
  });

  it('never returns an empty paragraph', async () => {
    const body = '\n   \n\n[Illustration]\n\nText.\n\n   \t\n\n[Footnote 1: Gone.]\n\n';
    const paragraphs = await paragraphsOf(body);
    expect(paragraphs).toEqual(['Text.']);
    expect(paragraphs.every((p) => p.trim() !== '')).toBe(true);
  });

  it('leaves punctuation and curly quotes as printed', async () => {
    const text = '“Hello,” she said — it’s “fine”...';
    expect(await paragraphsOf(text)).toEqual([text]);
  });
});

describe('cleanGutenberg emphasis', () => {
  it('removes _underscore_ and *asterisk* markers', async () => {
    expect(await paragraphsOf('It was _very_ cold and *quite* dark.')).toEqual(['It was very cold and quite dark.']);
  });

  it('removes emphasis that wraps across lines', async () => {
    expect(await paragraphsOf('She said _it was\nvery late_ and left.')).toEqual(['She said it was very late and left.']);
  });

  it('keeps underscores inside words', async () => {
    expect(await paragraphsOf('The file_name stays and so_does_this.')).toEqual(['The file_name stays and so_does_this.']);
  });
});

describe('cleanGutenberg footnotes', () => {
  it('removes inline markers like [1], [12], [A] and [*]', async () => {
    expect(await paragraphsOf('One[1] two [12] three [A] four[*] five.')).toEqual(['One two three four five.']);
  });

  it('removes [Footnote N: …] bodies on one line', async () => {
    expect(await paragraphsOf('Text before.[1]\n\n[Footnote 1: A short note.]\n\nText after.')).toEqual([
      'Text before.',
      'Text after.',
    ]);
  });

  it('removes a [Footnote] that spans lines and paragraphs, with brackets inside', async () => {
    const body = 'Before.\n\n[Footnote 2: First part of the note [sic]\nstill going.\n\nSecond paragraph of the note.]\n\nAfter.';
    expect(await paragraphsOf(body)).toEqual(['Before.', 'After.']);
  });

  it('removes a footnote written in the middle of a paragraph', async () => {
    expect(await paragraphsOf('Start [Footnote 3: aside] finish.')).toEqual(['Start finish.']);
  });

  it('removes a trailing FOOTNOTES section', async () => {
    const body = 'Main text here.[1]\n\nMore text.\n\nFOOTNOTES\n\n[1] The first note.\n\n[2] The second note.';
    expect(await paragraphsOf(body)).toEqual(['Main text here.', 'More text.']);
  });
});

describe('cleanGutenberg chapters', () => {
  const prose = (n: number): string => `Paragraph ${n} has enough plain words in it to count as prose here.`;

  it('makes one chapter titled with the book title when there are no headings', async () => {
    const book = await cleanGutenberg(file('A short tale.\n\nThe end.'), 1);
    expect(book.chapters).toEqual([{ title: 'The Quiet Harbour', paragraphs: ['A short tale.', 'The end.'] }]);
  });

  it('detects the heading forms', async () => {
    const headings = [
      'CHAPTER I',
      'Chapter 1',
      'CHAPTER I.',
      'CHAPTER ONE',
      'BOOK I',
      'PART ONE',
      'ACT I',
      'IV',
      'V.',
      'Chapter twenty-one',
    ];
    const body = headings.map((h, i) => `${h}\n\n${prose(i)}`).join('\n\n');
    const book = await cleanGutenberg(file(body), 1);
    expect(book.chapters.map((c) => c.title)).toEqual([
      'CHAPTER I',
      'Chapter 1',
      'CHAPTER I',
      'CHAPTER ONE',
      'BOOK I',
      'PART ONE',
      'ACT I',
      'IV',
      'V',
      'Chapter twenty-one',
    ]);
    expect(book.chapters.every((c) => c.paragraphs.length === 1)).toBe(true);
  });

  it('adds a subtitle from the same line, the same block or the next block', async () => {
    const body = [
      'CHAPTER I. Down the Hole',
      prose(1),
      'CHAPTER II\nThe Pool\nof Tears',
      prose(2),
      'CHAPTER III',
      'A MAD TEA-PARTY',
      prose(3),
    ].join('\n\n');
    const book = await cleanGutenberg(file(body), 1);
    expect(book.chapters.map((c) => c.title)).toEqual([
      'CHAPTER I: Down the Hole',
      'CHAPTER II: The Pool of Tears',
      'CHAPTER III: A MAD TEA-PARTY',
    ]);
  });

  it('does not take a sentence as a subtitle', async () => {
    const book = await cleanGutenberg(file(`CHAPTER I\n\nIt rained.\n\n${prose(1)}`), 1);
    expect(book.chapters).toEqual([{ title: 'CHAPTER I', paragraphs: ['It rained.', prose(1)] }]);
  });

  it('does not treat ordinary lines that start with a heading word as headings', async () => {
    const body = ['Part of the road was flooded.', 'Book learning is not everything.'].join('\n\n');
    const book = await cleanGutenberg(file(body), 1);
    expect(book.chapters).toHaveLength(1);
    expect(book.chapters[0].title).toBe('The Quiet Harbour');
  });

  it('keeps text before the first heading only with enough prose', async () => {
    const withPreface = await cleanGutenberg(file(`${prose(1)}\n\n${prose(2)}\n\n${prose(3)}\n\nCHAPTER I\n\n${prose(4)}`), 1);
    expect(withPreface.chapters.map((c) => c.title)).toEqual(['The Quiet Harbour', 'CHAPTER I']);
    expect(withPreface.chapters[0].paragraphs).toHaveLength(3);

    const titlePage = await cleanGutenberg(file(`THE QUIET HARBOUR\n\nby Jane Example\n\nCHAPTER I\n\n${prose(4)}`), 1);
    expect(titlePage.chapters.map((c) => c.title)).toEqual(['CHAPTER I']);
  });

  it('drops chapters with no paragraphs', async () => {
    const book = await cleanGutenberg(file(`BOOK I\n\nCHAPTER I\n\n${prose(1)}\n\nCHAPTER II\n\n[Illustration]`), 1);
    expect(book.chapters.map((c) => c.title)).toEqual(['CHAPTER I']);
  });

  it('returns no chapters for an empty body', async () => {
    expect((await cleanGutenberg(file(''), 1)).chapters).toEqual([]);
  });
});

describe('cleanGutenberg output feeds the typing engine', () => {
  it('keeps every paragraph when passed to buildPassage', async () => {
    const body = [
      'Produced by Volunteers',
      'CHAPTER I',
      'The boat came in\nwith the tide.[1] It was _late_.',
      '[Footnote 1: Gone.]',
      '“Hello,” she said — softly.',
      'CHAPTER II',
      'Another well-\nknown scene.',
    ].join('\n\n');
    const book = await cleanGutenberg(file(body.replace(/\n/gu, '\r\n')), 7);
    for (const chapter of book.chapters) {
      const passage = buildPassage(chapter.paragraphs);
      expect(passage.paraStart).toHaveLength(chapter.paragraphs.length);
    }
    expect(book.chapters.flatMap((c) => c.paragraphs)).toHaveLength(3);
  });
});
