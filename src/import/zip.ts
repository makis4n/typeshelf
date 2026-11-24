/**
 * Reads files out of a zip (an EPUB is one) without trusting what the zip says
 * about itself.
 *
 * A zip's directory states each file's size, and a hostile file can lie: a few
 * hundred kilobytes can claim to be tiny and unpack to gigabytes, many times
 * over. So the work done here is bounded by what is really unpacked:
 * - the sizes the directory claims are added up against a byte budget before
 *   anything is unpacked, and
 * - unpacking a file stops the moment it yields more than it claimed.
 *
 * Only what EPUBs use is supported: stored and deflated entries, no zip64, no
 * zip-level passwords.
 */

import { Inflate } from 'fflate';
import { ImportError } from './errors';

interface Entry {
  /** 0 is stored as it is, 8 is deflated. */
  method: number;
  compressedSize: number;
  /** The unpacked size the directory claims. */
  size: number;
  /** Where the entry's own header starts in the file. */
  offset: number;
  passwordProtected: boolean;
}

export interface Zip {
  /** Every file name in the zip. */
  names: string[];
  /**
   * Unpacks the files `wanted` picks. Throws `too-large` once the files asked
   * for (over all calls) would pass the byte budget, and `unreadable` for a
   * file that is damaged or not what the directory says.
   */
  extract(wanted: (name: string) => boolean): Map<string, Uint8Array>;
}

const END_RECORD = 0x06054b50;
const DIRECTORY_RECORD = 0x02014b50;
const LOCAL_RECORD = 0x04034b50;
/** Compressed bytes handed to the inflater at a time. Deflate expands at most about 1000 times, so one step yields a few megabytes at worst. */
const STEP = 4096;

const broken = (detail: string) => new ImportError('unreadable', `zip: ${detail}`);

/**
 * A name as the package file would write it. Names are UTF-8 in practice,
 * whether or not the zip flags them as such; anything else is read one byte
 * per character. Composed and decomposed accents are treated as the same name.
 */
function decodeName(bytes: Uint8Array): string {
  let name: string;
  try {
    name = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    name = new TextDecoder('latin1').decode(bytes);
  }
  return name.normalize('NFC');
}

function readDirectory(bytes: Uint8Array, view: DataView): Map<string, Entry> {
  // The end record is the last thing in the file, followed only by an optional comment.
  let end = bytes.length - 22;
  const lowest = Math.max(0, end - 0xffff);
  while (end >= lowest && view.getUint32(end, true) !== END_RECORD) end--;
  if (end < lowest || end < 0) throw broken('no directory');

  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  if (count === 0xffff || at === 0xffffffff) throw broken('zip64 is not supported');

  const entries = new Map<string, Entry>();
  for (let i = 0; i < count; i++) {
    if (at + 46 > bytes.length || view.getUint32(at, true) !== DIRECTORY_RECORD) throw broken('damaged directory');
    const nameLength = view.getUint16(at + 28, true);
    const next = at + 46 + nameLength + view.getUint16(at + 30, true) + view.getUint16(at + 32, true);
    if (next > bytes.length) throw broken('damaged directory');
    entries.set(decodeName(bytes.subarray(at + 46, at + 46 + nameLength)), {
      passwordProtected: (view.getUint16(at + 8, true) & 1) === 1,
      method: view.getUint16(at + 10, true),
      compressedSize: view.getUint32(at + 20, true),
      size: view.getUint32(at + 24, true),
      offset: view.getUint32(at + 42, true),
    });
    at = next;
  }
  return entries;
}

function unpack(bytes: Uint8Array, view: DataView, name: string, entry: Entry): Uint8Array {
  if (entry.passwordProtected) throw broken(`"${name}" is password-protected`);
  const { offset } = entry;
  if (offset + 30 > bytes.length || view.getUint32(offset, true) !== LOCAL_RECORD) throw broken(`"${name}" is not where the directory says`);
  const start = offset + 30 + view.getUint16(offset + 26, true) + view.getUint16(offset + 28, true);
  const end = start + entry.compressedSize;
  if (end > bytes.length) throw broken(`"${name}" runs past the end of the file`);

  if (entry.method === 0) {
    if (entry.compressedSize !== entry.size) throw broken(`"${name}" has two different sizes`);
    return bytes.subarray(start, end);
  }
  if (entry.method !== 8) throw broken(`"${name}" uses an unsupported compression method`);

  const out = new Uint8Array(entry.size);
  let written = 0;
  const inflater = new Inflate((chunk) => {
    // More than the directory claimed: stop here, before unpacking the rest.
    if (written + chunk.length > out.length) throw broken(`"${name}" is larger than the zip says`);
    out.set(chunk, written);
    written += chunk.length;
  });
  try {
    for (let at = start; at < end; at += STEP) inflater.push(bytes.subarray(at, Math.min(at + STEP, end)), at + STEP >= end);
    if (start === end) inflater.push(new Uint8Array(0), true);
  } catch (cause) {
    if (cause instanceof ImportError) throw cause;
    throw broken(`"${name}" could not be unpacked (${String(cause)})`);
  }
  if (written !== out.length) throw broken(`"${name}" is smaller than the zip says`);
  return out;
}

/** Opens a zip. `maxBytes` is the most unpacked data it will hand out in total. */
export function openZip(bytes: Uint8Array, maxBytes: number): Zip {
  if (bytes.length < 22) throw broken('too short');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const entries = readDirectory(bytes, view);
  let handedOut = 0;

  return {
    names: [...entries.keys()],
    extract(wanted) {
      const picked = [...entries].filter(([name]) => wanted(name));
      // The whole request is checked against the budget before any of it is unpacked.
      for (const [, entry] of picked) handedOut += entry.size;
      if (handedOut > maxBytes) throw new ImportError('too-large', 'unzipped text');
      return new Map(picked.map(([name, entry]) => [name, unpack(bytes, view, name, entry)]));
    },
  };
}
