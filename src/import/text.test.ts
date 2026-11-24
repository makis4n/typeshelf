import { describe, expect, it } from 'vitest';
import { ImportError } from './errors';
import { chaptersFromText, parseText } from './text';

const FILE = { fileName: 'my_story.txt', fingerprint: 'a'.repeat(64) };
const utf8 = (text: string) => new TextEncoder().encode(text);
const paragraphsOf = (text: string) => chaptersFromText(text).flatMap((chapter) => chapter.paragraphs);
/** The chapters a reader gets: empty ones are dropped and untitled ones named. */
const chaptersOf = (text: string) => parseText(utf8(text), FILE).chapters;
const titlesOf = (text: string) => chaptersOf(text).map((chapter) => chapter.title);

/** A body paragraph under each heading, so headings are not dropped for being empty. */
const withBodies = (headings: string[]) => headings.map((heading) => `${heading}\n\nSome words follow.`).join('\n\n');

describe('paragraphs', () => {
  it('splits paragraphs on blank lines', () => {
    expect(paragraphsOf('First one.\n\nSecond one.\n\n\n\nThird one.')).toEqual(['First one.', 'Second one.', 'Third one.']);
  });

  it('joins hard-wrapped lines into one paragraph', () => {
    expect(paragraphsOf('The quick brown fox\njumps over the\nlazy dog.\n\nNext paragraph\nis here.')).toEqual([
      'The quick brown fox jumps over the lazy dog.',
      'Next paragraph is here.',
    ]);
  });

  it('handles Windows line endings', () => {
    expect(paragraphsOf('One\r\ntwo.\r\n\r\nThree.\r\n')).toEqual(['One two.', 'Three.']);
  });

  it('handles old Mac line endings', () => {
    expect(paragraphsOf('One\rtwo.\r\rThree.')).toEqual(['One two.', 'Three.']);
  });

  it('gives one paragraph per line when lines are long and there are no blank lines', () => {
    const line = (word: string) => `${word} `.repeat(40).trim();
    expect(paragraphsOf([line('alpha'), line('beta'), line('gamma')].join('\n'))).toEqual([
      line('alpha'),
      line('beta'),
      line('gamma'),
    ]);
  });

  it('trims leading and trailing spaces on lines', () => {
    expect(paragraphsOf('   indented line   \n   another   ')).toEqual(['indented line another']);
  });
});

describe('headings', () => {
  it.each([
    ['Chapter 1', 'Chapter 1'],
    ['CHAPTER IV.', 'CHAPTER IV'],
    ['Chapter Twenty-One', 'Chapter Twenty-One'],
    ['Book the First', 'Book the First'],
    ['PART TWO: Winter', 'PART TWO: Winter'],
    ['Prologue', 'Prologue'],
    ['Chapter 3. The Storm', 'Chapter 3. The Storm'],
  ])('recognises "%s" as a heading', (heading, title) => {
    const chapters = chaptersOf(`Intro words here.\n\n${heading}\n\nBody words here.`);
    expect(chapters.map((chapter) => chapter.title)).toEqual(['Opening', title]);
    expect(chapters[1]!.paragraphs).toEqual(['Body words here.']);
  });

  it('joins a heading with its title on the next line', () => {
    const chapters = chaptersOf('CHAPTER I.\nDown the Hole\n\nAlice was beginning to get tired.');
    expect(chapters).toEqual([{ title: 'CHAPTER I: Down the Hole', paragraphs: ['Alice was beginning to get tired.'] }]);
  });

  it('does not treat a sentence that starts with "Part one" as a heading', () => {
    expect(chaptersOf('Part one of the plan failed.\n\nSecond paragraph.')).toEqual([
      { title: 'my story', paragraphs: ['Part one of the plan failed.', 'Second paragraph.'] },
    ]);
  });

  it('does not treat a longer sentence that starts with "Chapter 2" prose as a heading', () => {
    expect(titlesOf('Chapter 2 of the report was late, and everyone knew it by now.\n\nMore.')).toEqual(['my story']);
  });

  it('treats lone roman numerals as headings when there are at least two', () => {
    const chapters = chaptersOf('I.\n\nFirst body.\n\nII.\n\nSecond body.');
    expect(chapters.map((chapter) => chapter.title)).toEqual(['I', 'II']);
    expect(chapters.map((chapter) => chapter.paragraphs)).toEqual([['First body.'], ['Second body.']]);
  });

  it('does not treat a single lone numeral as a heading', () => {
    expect(chaptersOf('Some words.\n\nIV.\n\nMore words.')).toEqual([
      { title: 'my story', paragraphs: ['Some words.', 'IV.', 'More words.'] },
    ]);
  });

  it('titles a file with no headings as one chapter named after the book', () => {
    const book = parseText(utf8('Just words.\n\nMore words.'), FILE);
    expect(book.chapters).toEqual([{ title: 'my story', paragraphs: ['Just words.', 'More words.'] }]);
  });

  it('puts text before the first heading in a chapter titled Opening', () => {
    expect(titlesOf('A dedication.\n\nChapter 1\n\nBody.')).toEqual(['Opening', 'Chapter 1']);
  });

  it('names no chapter Opening when the file starts with a heading', () => {
    expect(titlesOf('Chapter 1\n\nBody.\n\nChapter 2\n\nMore.')).toEqual(['Chapter 1', 'Chapter 2']);
  });

  it('drops headings with nothing under them', () => {
    const book = parseText(utf8('Chapter 1\n\nChapter 2\n\nBody of two.\n\nChapter 3'), FILE);
    expect(book.chapters).toEqual([{ title: 'Chapter 2', paragraphs: ['Body of two.'] }]);
  });

  it('keeps chapters in file order', () => {
    expect(titlesOf(withBodies(['Chapter 1', 'Chapter 2', 'Chapter 3']))).toEqual(['Chapter 1', 'Chapter 2', 'Chapter 3']);
  });
});

describe('parseText', () => {
  it('reads Title and Author header lines', () => {
    const book = parseText(utf8('Title: The Long Road\nAuthor: Ada Example\n\nChapter 1\n\nBody.'), FILE);
    expect(book.title).toBe('The Long Road');
    expect(book.author).toBe('Ada Example');
  });

  it('takes the title from the file name when there is no header', () => {
    const book = parseText(utf8('Body.'), FILE);
    expect(book.title).toBe('my story');
    expect(book.author).toBe('');
  });

  it('has an unknown language, the text source and an import id', () => {
    expect(parseText(utf8('Body.'), FILE)).toMatchObject({
      language: 'und',
      source: 'text',
      fingerprint: FILE.fingerprint,
      id: `import:${FILE.fingerprint}`,
    });
  });

  it('decodes Windows-1252 bytes', () => {
    const book = parseText(Uint8Array.from([0x63, 0x61, 0x66, 0xe9, 0x20, 0x93, 0x68, 0x69, 0x94]), FILE);
    expect(book.chapters[0]!.paragraphs).toEqual(['café “hi”']);
  });

  it('decodes UTF-8', () => {
    expect(parseText(utf8('café “hi” — ok'), FILE).chapters[0]!.paragraphs).toEqual(['café “hi” — ok']);
  });

  it('strips a UTF-8 byte-order mark', () => {
    const bytes = Uint8Array.from([0xef, 0xbb, 0xbf, ...utf8('Title: Marked\n\nBody.')]);
    const book = parseText(bytes, FILE);
    expect(book.title).toBe('Marked');
    expect(book.chapters[0]!.paragraphs).toContain('Body.');
    expect(book.chapters[0]!.paragraphs[0]).not.toMatch(/^\uFEFF/);
  });

  it('decodes UTF-16LE with a byte-order mark', () => {
    const units = [...'Title: Wide\n\nBody ü.'].map((char) => char.charCodeAt(0));
    const bytes = new Uint8Array([0xff, 0xfe, ...units.flatMap((unit) => [unit & 0xff, unit >> 8])]);
    const book = parseText(bytes, FILE);
    expect(book.title).toBe('Wide');
    expect(book.chapters[0]!.paragraphs).toContain('Body ü.');
  });

  it('rejects a file with only whitespace as empty', () => {
    const attempt = () => parseText(utf8('  \n\n \t\r\n'), FILE);
    expect(attempt).toThrow(ImportError);
    expect(attempt).toThrow(/^empty/);
  });

  it('rejects zero bytes as empty', () => {
    expect(() => parseText(new Uint8Array(), FILE)).toThrow(/^empty/);
  });
});

describe('Project Gutenberg files (review G6)', () => {
  const gutenberg = [
    'The Project Gutenberg eBook of The Quiet Shore',
    '',
    'This ebook is for the use of anyone anywhere in the United States and',
    'most other parts of the world at no cost.',
    '',
    'Title: The Quiet Shore',
    '',
    'Author: Ada Example',
    '',
    'Language: English',
    '',
    '*** START OF THE PROJECT GUTENBERG EBOOK THE QUIET SHORE ***',
    '',
    'CHAPTER I.',
    '',
    'The boat came in',
    'before the light.',
    '',
    'CHAPTER II.',
    '',
    'Nobody met it.',
    '',
    '*** END OF THE PROJECT GUTENBERG EBOOK THE QUIET SHORE ***',
    '',
    'Updated editions will replace the previous one.',
    '',
    'Section 1. General Terms of Use and Redistributing Project Gutenberg™',
    'electronic works',
    '',
    'You may copy it.',
    '',
    'Section 2. Information about the Mission of Project Gutenberg™',
    '',
    'Volunteers keep it going.',
    '',
  ].join('\r\n');

  it('keeps only the book between the START and END lines', () => {
    const book = parseText(new TextEncoder().encode(gutenberg), FILE);
    expect(book.title).toBe('The Quiet Shore');
    expect(book.author).toBe('Ada Example');
    expect(book.chapters).toEqual([
      { title: 'CHAPTER I', paragraphs: ['The boat came in before the light.'] },
      { title: 'CHAPTER II', paragraphs: ['Nobody met it.'] },
    ]);
  });

  it('handles a START line that runs over two lines, and the older "End of Project Gutenberg\'s" ending', () => {
    const older = [
      'Title: Old One',
      '',
      '*** START OF THIS PROJECT GUTENBERG EBOOK OLD ONE, WITH A VERY LONG',
      'TITLE ***',
      '',
      'Only this is the book.',
      '',
      "End of Project Gutenberg's Old One, by Nobody",
      '',
      'Section 3. Information about the Foundation',
      '',
      'Not the book.',
    ].join('\n');
    expect(parseText(new TextEncoder().encode(older), FILE).chapters).toEqual([
      { title: 'Old One', paragraphs: ['Only this is the book.'] },
    ]);
  });

  it('leaves a book that only mentions Project Gutenberg alone', () => {
    const plain = 'I found it on Project Gutenberg.\n\n*** A row of stars ***\n\nThe end of it.';
    expect(parseText(new TextEncoder().encode(plain), FILE).chapters[0]!.paragraphs).toHaveLength(3);
  });
});
