import { describe, expect, it } from 'vitest';
import { extractBlocks } from './xhtml';

const page = (body: string) => `<html xmlns:epub="http://www.idpf.org/2007/ops"><head><title>T</title></head><body>${body}</body></html>`;
const textsOf = (body: string) =>
  extractBlocks(page(body)).flatMap((block) => (block.kind === 'anchor' ? [] : [block.text]));

describe('extractBlocks text', () => {
  it('reads paragraphs and headings in order', () => {
    expect(extractBlocks(page('<h1>One</h1><p>First.</p><h2>Two</h2><p>Second.</p>'))).toEqual([
      { kind: 'heading', level: 1, text: 'One' },
      { kind: 'para', text: 'First.' },
      { kind: 'heading', level: 2, text: 'Two' },
      { kind: 'para', text: 'Second.' },
    ]);
  });

  it('reports the level of each heading', () => {
    const levels = extractBlocks(page('<h1>a</h1><h3>b</h3><h6>c</h6>')).map((b) => (b.kind === 'heading' ? b.level : 0));
    expect(levels).toEqual([1, 3, 6]);
  });

  it('collapses whitespace inside a paragraph', () => {
    expect(textsOf('<p>  one\n   two\t three </p>')).toEqual(['one two three']);
  });

  it('turns a line break into a space', () => {
    expect(textsOf('<p>one<br/>two<br>three</p>')).toEqual(['one two three']);
  });

  it('keeps inline tags in the same paragraph', () => {
    expect(textsOf('<p>a <em>b</em> <span>c</span> <a href="x.html">d</a>e</p>')).toEqual(['a b c de']);
  });

  it('decodes entities', () => {
    expect(textsOf('<p>Tom &amp; Jerry &mdash; friends</p>')).toEqual(['Tom & Jerry — friends']);
  });

  it('reads text in nested blocks as separate paragraphs', () => {
    expect(textsOf('<div>loose<p>inner</p>after</div>')).toEqual(['loose', 'inner', 'after']);
  });

  it('reads list items and blockquotes as paragraphs', () => {
    expect(textsOf('<ul><li>a</li><li>b</li></ul><blockquote>q</blockquote>')).toEqual(['a', 'b', 'q']);
  });

  it('splits paragraphs at a horizontal rule', () => {
    expect(textsOf('<div>a<hr/>b</div>')).toEqual(['a', 'b']);
  });

  it('reads a heading with inline markup as one heading', () => {
    expect(extractBlocks(page('<h2>The <em>End</em></h2>'))).toEqual([{ kind: 'heading', level: 2, text: 'The End' }]);
  });

  it('skips empty paragraphs', () => {
    expect(textsOf('<p> </p><p></p><p>x</p>')).toEqual(['x']);
  });

  it('gives nothing for an empty document', () => {
    expect(extractBlocks('')).toEqual([]);
    expect(extractBlocks(page(''))).toEqual([]);
  });

  it('ignores the head', () => {
    expect(textsOf('<p>x</p>')).toEqual(['x']);
  });
});

describe('extractBlocks dropped content', () => {
  it('drops images, svg and figures', () => {
    expect(textsOf('<p>a</p><img src="x.png" alt="Alt text"/><svg><text>svg text</text></svg><figure><img src="y.png"/><figcaption>Caption</figcaption></figure><p>b</p>')).toEqual(['a', 'b']);
  });

  it('drops a navigation list', () => {
    expect(textsOf('<nav epub:type="toc"><ol><li><a href="a.xhtml">Chapter</a></li></ol></nav><p>x</p>')).toEqual(['x']);
  });

  it('drops a note reference link', () => {
    expect(textsOf('<p>Word<a epub:type="noteref" href="notes.xhtml#n1">note</a> goes on.</p>')).toEqual(['Word goes on.']);
  });

  it('drops a footnote aside', () => {
    expect(textsOf('<p>Body.</p><aside epub:type="footnote" id="fn1"><p>The note.</p></aside>')).toEqual(['Body.']);
  });

  it('drops a superscript link marker', () => {
    expect(textsOf('<p>Claim.<sup><a href="#fn1">1</a></sup> More.</p>')).toEqual(['Claim. More.']);
  });

  it('drops a bracketed link marker', () => {
    expect(textsOf('<p>Claim.<a href="#n2">[2]</a> More.</p>')).toEqual(['Claim. More.']);
  });

  it('drops a page number span', () => {
    expect(textsOf('<p>Before<span class="pagenum">[Pg 12]</span> after.</p>')).toEqual(['Before after.']);
  });

  it('drops an epub pagebreak span', () => {
    expect(textsOf('<p>Before<span epub:type="pagebreak" id="p5" title="5"/> after.</p>')).toEqual(['Before after.']);
  });

  it('drops hidden content', () => {
    expect(textsOf('<p hidden>no</p><p>yes</p>')).toEqual(['yes']);
  });

  it('drops content styled display:none', () => {
    expect(textsOf('<div style="color: red; display: none">no</div><p>yes</p>')).toEqual(['yes']);
  });

  it('keeps a number in a superscript that is not a link', () => {
    expect(textsOf('<p>m<sup>2</sup> is area</p>')).toEqual(['m2 is area']);
  });

  it('keeps an ordinary link that points at an id', () => {
    expect(textsOf('<p>See <a href="#intro">the introduction</a> first.</p>')).toEqual(['See the introduction first.']);
  });

  it('keeps a long text with a pagenum class', () => {
    const long = 'This is a whole paragraph of real text wrongly classed.';
    expect(textsOf(`<p class="pagenum">${long}</p>`)).toEqual([long]);
  });
});

describe('extractBlocks anchors', () => {
  const anchors = new Set(['c2', 'inline']);

  it('reports a block element whose id is wanted, before its content', () => {
    expect(extractBlocks(page('<p>a</p><h2 id="c2">Two</h2><p>b</p>'), anchors)).toEqual([
      { kind: 'para', text: 'a' },
      { kind: 'anchor', id: 'c2' },
      { kind: 'heading', level: 2, text: 'Two' },
      { kind: 'para', text: 'b' },
    ]);
  });

  it('reports an inline anchor inside a heading without splitting the heading', () => {
    expect(extractBlocks(page('<h2><a id="inline"></a>Two</h2><p>b</p>'), anchors)).toEqual([
      { kind: 'anchor', id: 'inline' },
      { kind: 'heading', level: 2, text: 'Two' },
      { kind: 'para', text: 'b' },
    ]);
  });

  it('ignores ids that are not wanted', () => {
    expect(extractBlocks(page('<p id="other">a</p>'), anchors)).toEqual([{ kind: 'para', text: 'a' }]);
  });

  it('reports nothing when no anchors are given', () => {
    expect(extractBlocks(page('<p id="c2">a</p>'))).toEqual([{ kind: 'para', text: 'a' }]);
  });

  it('reports an old-style named anchor', () => {
    expect(extractBlocks(page('<p><a name="c2"></a>a</p>'), anchors)).toEqual([
      { kind: 'anchor', id: 'c2' },
      { kind: 'para', text: 'a' },
    ]);
  });
});
