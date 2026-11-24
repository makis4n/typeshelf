/**
 * A small, forgiving parser for the XML and XHTML found inside EPUB files.
 *
 * It is not a full XML parser. It builds a plain tree of elements and text,
 * which is all the importer needs, and it runs the same in the browser and in
 * unit tests (no DOM). Broken markup never throws: stray `<`, unclosed tags and
 * mismatched closing tags are read as leniently as a browser would.
 *
 * Element and attribute names are lower-cased and keep their prefix
 * (`dc:title`, `epub:type`).
 */

export interface Element {
  name: string;
  attrs: Record<string, string>;
  children: Node[];
}

export type Node = Element | string;

/** HTML elements that never have a closing tag. */
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
/** Elements whose content is not markup. */
const RAW = new Set(['script', 'style']);

const RAW_CLOSE = { script: /<\/script/gi, style: /<\/style/gi };

const OPEN_TAG =
  /<([A-Za-z_][\w:.-]*)((?:\s+[^\s"'<>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'<>]+))?)*)\s*(\/?)>/y;
const ATTRIBUTE = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'<>]+)))?/g;

// Named characters 160 to 255, in order.
const LATIN_1 =
  'nbsp iexcl cent pound curren yen brvbar sect uml copy ordf laquo not shy reg macr deg plusmn sup2 sup3 acute micro para middot cedil sup1 ordm raquo frac14 frac12 frac34 iquest Agrave Aacute Acirc Atilde Auml Aring AElig Ccedil Egrave Eacute Ecirc Euml Igrave Iacute Icirc Iuml ETH Ntilde Ograve Oacute Ocirc Otilde Ouml times Oslash Ugrave Uacute Ucirc Uuml Yacute THORN szlig agrave aacute acirc atilde auml aring aelig ccedil egrave eacute ecirc euml igrave iacute icirc iuml eth ntilde ograve oacute ocirc otilde ouml divide oslash ugrave uacute ucirc uuml yacute thorn yuml';

const NAMED: Record<string, number> = {
  amp: 38, lt: 60, gt: 62, quot: 34, apos: 39,
  OElig: 338, oelig: 339, Scaron: 352, scaron: 353, Yuml: 376, circ: 710, tilde: 732,
  ensp: 8194, emsp: 8195, thinsp: 8201, zwnj: 8204, zwj: 8205,
  ndash: 8211, mdash: 8212, lsquo: 8216, rsquo: 8217, sbquo: 8218, ldquo: 8220, rdquo: 8221, bdquo: 8222,
  dagger: 8224, Dagger: 8225, bull: 8226, hellip: 8230, permil: 8240, prime: 8242, Prime: 8243,
  lsaquo: 8249, rsaquo: 8250, euro: 8364, trade: 8482, minus: 8722,
};
LATIN_1.split(' ').forEach((name, i) => {
  NAMED[name] = 160 + i;
});

/** Replaces `&amp;`, `&#8212;`, `&#x2014;` and the common named characters. Unknown names are left as written. */
export function decodeEntities(text: string): string {
  if (!text.includes('&')) return text;
  return text.replace(/&(#[xX][0-9a-fA-F]+|#\d+|\w+);/g, (whole, body: string) => {
    let code: number | undefined;
    if (body[0] === '#') {
      code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
    } else {
      code = NAMED[body];
    }
    if (code === undefined || !Number.isFinite(code) || code <= 0 || code > 0x10ffff) return whole;
    return String.fromCodePoint(code);
  });
}

/** Parses markup into a tree. The returned element is a wrapper named `#root`. */
export function parseMarkup(source: string): Element {
  const root: Element = { name: '#root', attrs: {}, children: [] };
  const stack: Element[] = [root];
  // How many elements of each name are open, so a closing tag that matches nothing costs nothing.
  const openCount = new Map<string, number>();
  const top = () => stack[stack.length - 1]!;
  const text = (raw: string) => {
    if (raw.length > 0) top().children.push(decodeEntities(raw));
  };
  const skipTo = (marker: string, from: number) => {
    const end = source.indexOf(marker, from);
    return end < 0 ? source.length : end + marker.length;
  };

  let i = 0;
  while (i < source.length) {
    const lt = source.indexOf('<', i);
    if (lt < 0) {
      text(source.slice(i));
      break;
    }
    text(source.slice(i, lt));

    if (source.startsWith('<!--', lt)) {
      i = skipTo('-->', lt + 4);
    } else if (source.startsWith('<![CDATA[', lt)) {
      const end = source.indexOf(']]>', lt + 9);
      const raw = source.slice(lt + 9, end < 0 ? source.length : end);
      if (raw.length > 0) top().children.push(raw);
      i = end < 0 ? source.length : end + 3;
    } else if (source.startsWith('<?', lt)) {
      i = skipTo('?>', lt + 2);
    } else if (source.startsWith('<!', lt)) {
      // A doctype, possibly with definitions in [ ] before its closing bracket.
      const close = source.indexOf('>', lt);
      const subset = source.indexOf('[', lt);
      i = subset >= 0 && close >= 0 && subset < close ? skipTo('>', skipTo(']', subset)) : skipTo('>', lt);
    } else if (source[lt + 1] === '/') {
      const end = source.indexOf('>', lt);
      const name = source.slice(lt + 2, end < 0 ? source.length : end).trim().toLowerCase();
      // Close the nearest open element of that name; ignore a closing tag that matches nothing.
      if ((openCount.get(name) ?? 0) > 0) {
        while (stack.length > 1) {
          const closed = stack.pop()!.name;
          openCount.set(closed, openCount.get(closed)! - 1);
          if (closed === name) break;
        }
      }
      i = end < 0 ? source.length : end + 1;
    } else {
      OPEN_TAG.lastIndex = lt;
      const tag = OPEN_TAG.exec(source);
      if (!tag) {
        // A bare "<" in running text.
        text('<');
        i = lt + 1;
        continue;
      }
      const name = tag[1]!.toLowerCase();
      const attrs: Record<string, string> = {};
      for (const match of tag[2]!.matchAll(ATTRIBUTE)) {
        attrs[match[1]!.toLowerCase()] = decodeEntities(match[2] ?? match[3] ?? match[4] ?? '');
      }
      const element: Element = { name, attrs, children: [] };
      top().children.push(element);
      i = lt + tag[0].length;

      const selfClosed = tag[3] === '/' || VOID.has(name);
      if (selfClosed) continue;
      if (RAW.has(name)) {
        const closer = name === 'script' ? RAW_CLOSE.script : RAW_CLOSE.style;
        closer.lastIndex = i;
        const close = closer.exec(source);
        i = close ? skipTo('>', close.index) : source.length;
        continue;
      }
      stack.push(element);
      openCount.set(name, (openCount.get(name) ?? 0) + 1);
    }
  }
  return root;
}

/** A name without its prefix: `dc:title` gives `title`. */
export function localName(name: string): string {
  const colon = name.indexOf(':');
  return colon < 0 ? name : name.slice(colon + 1);
}

/** Every element below `parent` with this name (prefix ignored), in document order. */
export function* descendants(parent: Element, name: string): Generator<Element> {
  for (const child of parent.children) {
    if (typeof child === 'string') continue;
    if (localName(child.name) === name) yield child;
    yield* descendants(child, name);
  }
}

/** The first element below `parent` with this name, if any. */
export function firstDescendant(parent: Element, name: string): Element | undefined {
  for (const found of descendants(parent, name)) return found;
  return undefined;
}

/** All the text inside an element, with runs of whitespace collapsed. */
export function textOf(node: Node): string {
  const parts: string[] = [];
  const walk = (current: Node) => {
    if (typeof current === 'string') parts.push(current);
    else current.children.forEach(walk);
  };
  walk(node);
  return collapse(parts.join(''));
}

/** Trims and turns every run of whitespace into one space. */
export function collapse(text: string): string {
  return text.replace(/\s+/gu, ' ').trim();
}
