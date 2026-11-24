/**
 * Turns a file's bytes into a string. Most files are UTF-8; older plain text
 * is often Windows-1252 (Western European), and a few are UTF-16.
 */

function decodeAs(label: string, bytes: Uint8Array, fatal = false): string {
  return new TextDecoder(label, { fatal }).decode(bytes);
}

/** The encoding named by a byte-order mark, if the file starts with one. */
function encodingFromMark(bytes: Uint8Array): string | undefined {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return 'utf-8';
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return 'utf-16le';
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return 'utf-16be';
  return undefined;
}

/**
 * Decodes plain text. A byte-order mark decides; otherwise UTF-8 if the bytes
 * are valid UTF-8, and Windows-1252 if they are not.
 */
export function decodeText(bytes: Uint8Array): string {
  const marked = encodingFromMark(bytes);
  if (marked) return decodeAs(marked, bytes); // the decoder drops the mark itself
  try {
    return decodeAs('utf-8', bytes, true);
  } catch {
    return decodeAs('windows-1252', bytes);
  }
}

/**
 * Decodes an XML or XHTML file from inside an EPUB: a byte-order mark first,
 * then the encoding named in the `<?xml ... ?>` line, then UTF-8.
 */
export function decodeXml(bytes: Uint8Array): string {
  const marked = encodingFromMark(bytes);
  if (marked) return decodeAs(marked, bytes);
  const start = decodeAs('latin1', bytes.subarray(0, 200));
  const declared = /^\s*<\?xml[^>]*\bencoding\s*=\s*["']([\w.-]+)["']/i.exec(start)?.[1];
  if (declared && !/^utf-?8$/i.test(declared)) {
    try {
      return decodeAs(declared, bytes);
    } catch {
      // An encoding the browser does not know: fall through to UTF-8.
    }
  }
  return decodeAs('utf-8', bytes);
}
