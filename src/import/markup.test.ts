import { describe, expect, it } from 'vitest';
import { collapse, decodeEntities, descendants, firstDescendant, parseMarkup, textOf, type Element } from './markup';

const first = (source: string, name: string): Element => {
  const found = firstDescendant(parseMarkup(source), name);
  if (!found) throw new Error(`no <${name}> in ${source}`);
  return found;
};

describe('decodeEntities', () => {
  it('decodes the named XML entities', () => {
    expect(decodeEntities('a &amp; b &lt;c&gt; &quot;d&quot; &apos;e&apos;')).toBe('a & b <c> "d" \'e\'');
  });

  it('decodes common typographic and Latin-1 names', () => {
    expect(decodeEntities('&mdash;&hellip;&ldquo;&rdquo;&eacute;&nbsp;')).toBe('—…“”é ');
  });

  it('decodes decimal references', () => {
    expect(decodeEntities('&#8212; &#65;')).toBe('— A');
  });

  it('decodes hexadecimal references in either case', () => {
    expect(decodeEntities('&#x2014; &#X41; &#x1F600;')).toBe('— A 😀');
  });

  it('leaves unknown names alone', () => {
    expect(decodeEntities('&bogus; and &amp')).toBe('&bogus; and &amp');
  });

  it('leaves out-of-range and zero references alone', () => {
    expect(decodeEntities('&#0; &#x110000;')).toBe('&#0; &#x110000;');
  });

  it('returns text without ampersands unchanged', () => {
    expect(decodeEntities('plain')).toBe('plain');
  });
});

describe('parseMarkup attributes', () => {
  it('reads double-quoted attributes', () => {
    expect(first('<a href="x.html" id="one">t</a>', 'a').attrs).toEqual({ href: 'x.html', id: 'one' });
  });

  it('reads single-quoted attributes', () => {
    expect(first("<a href='x.html' id='one'>t</a>", 'a').attrs).toEqual({ href: 'x.html', id: 'one' });
  });

  it('reads unquoted attributes and bare flags', () => {
    expect(first('<p class=note hidden>t</p>', 'p').attrs).toEqual({ class: 'note', hidden: '' });
  });

  it('decodes entities inside attribute values', () => {
    expect(first('<a title="a &amp; b">t</a>', 'a').attrs['title']).toBe('a & b');
  });

  it('keeps a greater-than sign inside a quoted value', () => {
    const a = first('<a title="x > y">t</a>', 'a');
    expect(a.attrs['title']).toBe('x > y');
    expect(textOf(a)).toBe('t');
  });

  it('lower-cases element and attribute names but keeps prefixes', () => {
    const root = parseMarkup('<DIV EPUB:Type="x"></DIV>');
    expect(root.children).toEqual([{ name: 'div', attrs: { 'epub:type': 'x' }, children: [] }]);
  });
});

describe('parseMarkup structure', () => {
  it('nests elements and text', () => {
    const p = first('<div><p>one <em>two</em> three</p></div>', 'p');
    expect(p.children).toHaveLength(3);
    expect(textOf(p)).toBe('one two three');
  });

  it('treats a self-closing tag as empty and keeps what follows as a sibling', () => {
    const root = parseMarkup('<p>a<br/>b</p>');
    const p = root.children[0] as Element;
    expect(p.children).toHaveLength(3);
    expect((p.children[1] as Element).name).toBe('br');
    expect((p.children[1] as Element).children).toEqual([]);
  });

  it('treats void tags without a slash as empty', () => {
    const p = first('<p>a<br>b<img src="x.png">c</p>', 'p');
    expect(p.children.map((c) => (typeof c === 'string' ? c : c.name))).toEqual(['a', 'br', 'b', 'img', 'c']);
  });

  it('skips comments', () => {
    expect(textOf(parseMarkup('<p>a<!-- <b>no</b> -->b</p>'))).toBe('ab');
  });

  it('keeps CDATA content as text', () => {
    expect(textOf(parseMarkup('<p><![CDATA[a <b> & c]]></p>'))).toBe('a <b> & c');
  });

  it('skips a doctype', () => {
    expect(textOf(parseMarkup('<!DOCTYPE html><p>x</p>'))).toBe('x');
  });

  it('skips a doctype with an internal subset', () => {
    expect(textOf(parseMarkup('<!DOCTYPE html [ <!ENTITY e "v"> ]><p>x</p>'))).toBe('x');
  });

  it('skips processing instructions and the xml declaration', () => {
    expect(textOf(parseMarkup('<?xml version="1.0"?><?pi stuff?><p>x</p>'))).toBe('x');
  });

  it('does not treat script content as markup', () => {
    const root = parseMarkup('<body><script>if (a < b) { x = "<p>no</p>"; }</script><p>yes</p></body>');
    expect([...descendants(root, 'p')].map(textOf)).toEqual(['yes']);
    expect(textOf(first('<script>var a = "<b>";</script>', 'script'))).toBe('');
  });

  it('does not treat style content as markup', () => {
    const root = parseMarkup('<style>p > a { color: red }</style><p>yes</p>');
    expect([...descendants(root, 'p')].map(textOf)).toEqual(['yes']);
    expect(textOf(root)).toBe('yes');
  });

  it('finds the closing script tag in any case', () => {
    expect(textOf(parseMarkup('<SCRIPT>x<b></SCRIPT><p>y</p>'))).toBe('y');
  });
});

describe('parseMarkup forgiveness', () => {
  it('keeps a stray less-than sign as text', () => {
    expect(textOf(parseMarkup('<p>1 < 2</p>'))).toBe('1 < 2');
  });

  it('does not throw on unclosed tags', () => {
    const root = parseMarkup('<div><p>one<p>two');
    expect(textOf(root)).toBe('onetwo');
  });

  it('ignores a closing tag that matches nothing', () => {
    expect(textOf(parseMarkup('<p>a</b>b</p>'))).toBe('ab');
  });

  it('closes inner elements when an outer one closes', () => {
    const root = parseMarkup('<div><span>a</div>b');
    expect(root.children).toHaveLength(2);
    expect(root.children[1]).toBe('b');
  });

  it('does not throw on an unterminated tag, comment or CDATA', () => {
    expect(() => parseMarkup('<p>a <b')).not.toThrow();
    expect(() => parseMarkup('<p>a <!-- never ends')).not.toThrow();
    expect(() => parseMarkup('<p>a <![CDATA[ never ends')).not.toThrow();
    expect(() => parseMarkup('<p>a </p')).not.toThrow();
    expect(() => parseMarkup('<script>never ends')).not.toThrow();
  });

  it('returns an empty root for empty input', () => {
    expect(parseMarkup('')).toEqual({ name: '#root', attrs: {}, children: [] });
  });
});

describe('descendants', () => {
  it('finds prefixed names by their local name', () => {
    const root = parseMarkup('<metadata><dc:title>Emma</dc:title><dc:creator>A</dc:creator></metadata>');
    expect([...descendants(root, 'title')].map(textOf)).toEqual(['Emma']);
  });

  it('also finds unprefixed names', () => {
    expect([...descendants(parseMarkup('<title>x</title>'), 'title')]).toHaveLength(1);
  });

  it('returns elements in document order, nested ones included', () => {
    const root = parseMarkup('<div id="1"><div id="2"></div></div><div id="3"></div>');
    expect([...descendants(root, 'div')].map((d) => d.attrs['id'])).toEqual(['1', '2', '3']);
  });

  it('yields nothing when there is no match', () => {
    expect([...descendants(parseMarkup('<p>x</p>'), 'h1')]).toEqual([]);
    expect(firstDescendant(parseMarkup('<p>x</p>'), 'h1')).toBeUndefined();
  });
});

describe('textOf and collapse', () => {
  it('collapses whitespace runs and trims', () => {
    expect(textOf(parseMarkup('<p>  a \n\t b  <em> c </em></p>'))).toBe('a b c');
  });

  it('collapse turns every whitespace run into one space', () => {
    expect(collapse('  a\n\n b c  ')).toBe('a b c');
  });
});
