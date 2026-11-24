import { describe, expect, it } from 'vitest';
import { ImportError } from './errors';
import { draftFromMarkdown, parseMarkdown, stripInline } from './markdown';

const FILE = { fileName: 'my_notes.md', fingerprint: 'b'.repeat(64) };
const utf8 = (text: string) => new TextEncoder().encode(text);
const book = (markdown: string) => parseMarkdown(utf8(markdown), FILE);

describe('stripInline', () => {
  it.each([
    ['**bold** and __bold__', 'bold and bold'],
    ['*italic* and _italic_', 'italic and italic'],
    ['***both***', 'both'],
    ['snake_case_words stay', 'snake_case_words stay'],
    ['use `code` here', 'use code here'],
    ['``a `tick` inside``', 'a `tick` inside'],
    ['see [the docs](https://example.com/a) now', 'see the docs now'],
    ['see [the docs][ref] now', 'see the docs now'],
    ['see [ref] alone', 'see [ref] alone'],
    ['before ![alt text](pic.png) after', 'before after'],
    ['before ![alt][pic] after', 'before after'],
    ['visit <https://example.com> today', 'visit https://example.com today'],
    ['mail <mailto:a@b.example> now', 'mail mailto:a@b.example now'],
    ['a note[^1] here', 'a note here'],
    ['~~gone~~ stays', 'gone stays'],
    ['2 \\* 3 \\* 4', '2 * 3 * 4'],
    ['\\*not italic\\*', '*not italic*'],
    ['a <b>tag</b> and <br/> more', 'a tag and more'],
    ['Tom &amp; Jerry &mdash; &#233;', 'Tom & Jerry — é'],
    ['a <!-- hidden --> b', 'a b'],
    ['  lots   of \t space ', 'lots of space'],
    ['', ''],
  ])('turns %j into %j', (source, expected) => {
    expect(stripInline(source)).toBe(expected);
  });

  it('keeps a single star that does not close', () => {
    expect(stripInline('a * b')).toBe('a * b');
  });
});

describe('draftFromMarkdown structure', () => {
  it('reads a title and chapters from one # and several ##', () => {
    const draft = draftFromMarkdown('# My Book\n\n## One\n\nFirst body.\n\n## Two\n\nSecond body.');
    expect(draft.title).toBe('My Book');
    expect(draft.chapters).toEqual([
      { paragraphs: [] },
      { title: 'One', paragraphs: ['First body.'] },
      { title: 'Two', paragraphs: ['Second body.'] },
    ]);
  });

  it('makes several # headings into chapters and takes the title from the file name', () => {
    const result = book('# One\n\nFirst.\n\n# Two\n\nSecond.');
    expect(result.title).toBe('my notes');
    expect(result.chapters).toEqual([
      { title: 'One', paragraphs: ['First.'] },
      { title: 'Two', paragraphs: ['Second.'] },
    ]);
  });

  it('drops the book title heading, so it is not typed', () => {
    const result = book('# My Book\n\n## One\n\nFirst.\n\n## Two\n\nSecond.');
    expect(result.title).toBe('My Book');
    expect(result.chapters.map((chapter) => chapter.title)).toEqual(['One', 'Two']);
    expect(result.chapters.flatMap((chapter) => chapter.paragraphs)).toEqual(['First.', 'Second.']);
  });

  it('reads setext headings underlined with =', () => {
    const result = book('One\n===\n\nFirst.\n\nTwo\n===\n\nSecond.');
    expect(result.chapters.map((chapter) => chapter.title)).toEqual(['One', 'Two']);
    expect(result.chapters.map((chapter) => chapter.paragraphs)).toEqual([['First.'], ['Second.']]);
  });

  it('reads setext headings underlined with -', () => {
    const result = book('One\n---\n\nFirst.\n\nTwo\n---\n\nSecond.');
    expect(result.chapters.map((chapter) => chapter.title)).toEqual(['One', 'Two']);
  });

  it('keeps headings deeper than the chapter level as paragraphs', () => {
    const result = book('## One\n\nFirst.\n\n### A detail\n\nMore.\n\n## Two\n\nSecond.');
    expect(result.chapters[0]).toEqual({ title: 'One', paragraphs: ['First.', 'A detail', 'More.'] });
  });

  it('ignores closing hashes on a heading', () => {
    expect(book('# One #\n\nA.\n\n# Two ##\n\nB.').chapters.map((chapter) => chapter.title)).toEqual(['One', 'Two']);
  });

  it('gives a document with no headings a single chapter named after the book', () => {
    expect(book('Just a note.\n\nAnother line.').chapters).toEqual([
      { title: 'my notes', paragraphs: ['Just a note.', 'Another line.'] },
    ]);
  });

  it('gives a lone heading the book title and puts the text in one chapter', () => {
    const result = book('# Only Title\n\nSome text.');
    expect(result.title).toBe('Only Title');
    expect(result.chapters).toEqual([{ title: 'Only Title', paragraphs: ['Some text.'] }]);
  });

  it('titles text before the first chapter heading Opening', () => {
    const result = book('Preface words.\n\n# One\n\nA.\n\n# Two\n\nB.');
    expect(result.chapters.map((chapter) => chapter.title)).toEqual(['Opening', 'One', 'Two']);
  });

  it('joins the lines of a paragraph', () => {
    expect(book('one\ntwo\n\nthree').chapters[0]!.paragraphs).toEqual(['one two', 'three']);
  });

  it('has the text source, an unknown language and an import id', () => {
    expect(book('Words.')).toMatchObject({
      source: 'text',
      language: 'und',
      fingerprint: FILE.fingerprint,
      id: `import:${FILE.fingerprint}`,
    });
  });
});

describe('draftFromMarkdown front matter', () => {
  const doc = '---\ntitle: "Quoted Title"\nauthor: Ada Example\nlang: fr\n---\n\n# One\n\nA.\n\n# Two\n\nB.';

  it('reads title, author and language', () => {
    expect(book(doc)).toMatchObject({ title: 'Quoted Title', author: 'Ada Example', language: 'fr' });
  });

  it('does not type the front matter', () => {
    expect(book(doc).chapters.flatMap((chapter) => chapter.paragraphs)).toEqual(['A.', 'B.']);
  });

  it('prefers the front matter title to a heading', () => {
    expect(book('---\ntitle: From Front\n---\n# From Heading\n\n## One\n\nA.\n\n## Two\n\nB.').title).toBe('From Front');
  });

  it('reads language from a language key too', () => {
    expect(draftFromMarkdown('---\nlanguage: de\n---\nWords.').language).toBe('de');
  });

  it('leaves a document alone when the front matter never closes', () => {
    expect(book('---\ntitle: Oops\n\nWords.').chapters[0]!.paragraphs).toContain('Words.');
  });
});

describe('draftFromMarkdown blocks', () => {
  const paragraphs = (markdown: string) => book(markdown).chapters.flatMap((chapter) => chapter.paragraphs);

  it('keeps code fence lines as paragraphs without the fence', () => {
    expect(paragraphs('Before.\n\n```js\nlet a = 1;\n\nlet b = 2;\n```\n\nAfter.')).toEqual([
      'Before.',
      'let a = 1;',
      'let b = 2;',
      'After.',
    ]);
  });

  it('keeps tilde fences too, and does not read markup inside them', () => {
    expect(paragraphs('~~~\n# not a heading\n**raw**\n~~~')).toEqual(['# not a heading', '**raw**']);
  });

  it('turns list items into one paragraph each without bullets', () => {
    expect(paragraphs('- one\n* two\n+ three\n1. four\n2) five')).toEqual(['one', 'two', 'three', 'four', 'five']);
  });

  it('drops task list boxes', () => {
    expect(paragraphs('- [ ] todo\n- [x] done')).toEqual(['todo', 'done']);
  });

  it('removes blockquote markers', () => {
    expect(paragraphs('> quoted line\n> > nested line')).toEqual(['quoted line nested line']);
  });

  it('drops horizontal rules', () => {
    expect(paragraphs('above\n\n---\n\n***\n\n___\n\nbelow')).toEqual(['above', 'below']);
  });

  it('drops link definitions', () => {
    expect(paragraphs('[a link][ref]\n\n[ref]: https://example.com "Title"')).toEqual(['a link']);
  });

  it('drops footnote definitions and markers', () => {
    expect(paragraphs('A claim.[^1]\n\n[^1]: The footnote text.')).toEqual(['A claim.']);
  });

  it('reads table rows left to right and drops the divider', () => {
    expect(paragraphs('| a | b |\n|---|---|\n| c | d |')).toEqual(['a b', 'c d']);
  });

  it('strips inline markup inside paragraphs', () => {
    expect(paragraphs('Some **bold** and [a link](x.html).')).toEqual(['Some bold and a link.']);
  });

  it('rejects a document with nothing to type as empty', () => {
    expect(() => book('---\ntitle: X\n---\n\n---\n')).toThrow(ImportError);
    expect(() => book('   \n\n')).toThrow(/^empty/);
  });
});
