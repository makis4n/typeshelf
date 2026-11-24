/**
 * Reads files out of a zip (an EPUB is one) without trusting what the zip says
 * about itself.
 *
 * A zip's directory states each file's size, and a hostile file can lie: a few
 * hundred kilobytes can claim to be tiny and unpack to gigabytes, many times
 * over. So the work done here is bounded by what is really unpacked:
 * - the sizes the directory claims are added up against a byte budget before
 *   anything is unpacked,
 * - unpacking a file stops the moment it yields more than it claimed, as soon
 *   as it has yielded all it claimed, or when it stops yielding anything, and
 * - no two entries may share bytes of the file, so the compressed data read
 *   is never more than the file itself, and
 * - unpacking has a time limit. Compressed data can be written so that a few
 *   bytes cost the inflater millions of steps and yield nothing, which no
 *   count of bytes can catch; the clock is checked between small steps.
 *
 * Unpacking still runs on the page's own thread, so a hostile file can hold
 * the page for about the time limit before it is refused.
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
   * for (over all calls) would pass the byte budget or the time limit, and `unreadable` for a
   * file that is damaged or not what the directory says.
   */
  extract(wanted: (name: string) => boolean): Map<string, Uint8Array>;
}

const END_RECORD = 0x06054b50;
const DIRECTORY_RECORD = 0x02014b50;
const LOCAL_RECORD = 0x04034b50;
/**
 * Compressed bytes handed to the inflater at a time. Small, because the clock
 * can only be checked between steps, and the costliest input known takes a
 * few hundred milliseconds for this much.
 */
const STEP = 2048;
/**
 * The longest all unpacking for one book may take. A long novel takes a few
 * hundredths of a second, and the full 64 MB allowance under a second on a laptop.
 */
export const MAX_UNPACK_MS = 2000;
/**
 * The most compressed input that can pass without any output in a sound
 * stream: one block stored without compression (65,535 bytes and its header),
 * which the inflater only hands over whole. Past this, the stream has ended or
 * is padding, and feeding it more would only pile up unread input.
 */
const MAX_SILENT_INPUT = 80_000;

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
  /** Where each entry's header and data start and (at the earliest) end. */
  const spans: [start: number, end: number][] = [];
  for (let i = 0; i < count; i++) {
    if (at + 46 > bytes.length || view.getUint32(at, true) !== DIRECTORY_RECORD) throw broken('damaged directory');
    const nameLength = view.getUint16(at + 28, true);
    const next = at + 46 + nameLength + view.getUint16(at + 30, true) + view.getUint16(at + 32, true);
    if (next > bytes.length) throw broken('damaged directory');
    const entry: Entry = {
      passwordProtected: (view.getUint16(at + 8, true) & 1) === 1,
      method: view.getUint16(at + 10, true),
      compressedSize: view.getUint32(at + 20, true),
      size: view.getUint32(at + 24, true),
      offset: view.getUint32(at + 42, true),
    };
    spans.push([entry.offset, entry.offset + 30 + entry.compressedSize]);
    entries.set(decodeName(bytes.subarray(at + 46, at + 46 + nameLength)), entry);
    at = next;
  }

  // Every entry owns its own stretch of the file. A directory that points two
  // names at the same bytes could have them unpacked over and over.
  spans.sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < spans.length; i++) {
    if (spans[i]![0] < spans[i - 1]![1]) throw broken('two entries share the same data');
  }
  return entries;
}

/** Time spent unpacking so far, against the limit. Shared by every entry of one zip. */
interface Clock {
  now: () => number;
  spent: number;
  limit: number;
}

function unpack(bytes: Uint8Array, view: DataView, name: string, entry: Entry, clock: Clock): Uint8Array {
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
  let silent = 0;
  const inflater = new Inflate((chunk) => {
    // More than the directory claimed: stop here, before unpacking the rest.
    if (written + chunk.length > out.length) throw broken(`"${name}" is larger than the zip says`);
    out.set(chunk, written);
    written += chunk.length;
    if (chunk.length > 0) silent = 0;
  });
  try {
    // Stops as soon as everything claimed has come out: whatever follows is not part of the file.
    for (let at = start; at < end && written < out.length; at += STEP) {
      const step = bytes.subarray(at, Math.min(at + STEP, end));
      silent += step.length;
      const began = clock.now();
      inflater.push(step, at + STEP >= end);
      clock.spent += clock.now() - began;
      if (clock.spent > clock.limit) throw new ImportError('too-large', `unpacking took over ${clock.limit} ms`);
      if (silent > MAX_SILENT_INPUT) throw broken(`"${name}" stops before the size the zip says`);
    }
  } catch (cause) {
    if (cause instanceof ImportError) throw cause;
    throw broken(`"${name}" could not be unpacked (${String(cause)})`);
  }
  if (written !== out.length) throw broken(`"${name}" is smaller than the zip says`);
  return out;
}

/**
 * Opens a zip. `maxBytes` is the most unpacked data it will hand out in total.
 * `maxMs` is the most time it will spend unpacking, measured with `now`
 * (tests pass their own clock).
 */
export function openZip(
  bytes: Uint8Array,
  maxBytes: number,
  { maxMs = MAX_UNPACK_MS, now = () => performance.now() }: { maxMs?: number; now?: () => number } = {},
): Zip {
  if (bytes.length < 22) throw broken('too short');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const entries = readDirectory(bytes, view);
  let handedOut = 0;
  const clock: Clock = { now, spent: 0, limit: maxMs };

  return {
    names: [...entries.keys()],
    extract(wanted) {
      const picked = [...entries].filter(([name]) => wanted(name));
      // The whole request is checked against the budget before any of it is unpacked.
      for (const [, entry] of picked) handedOut += entry.size;
      if (handedOut > maxBytes) throw new ImportError('too-large', 'unzipped text');
      return new Map(picked.map(([name, entry]) => [name, unpack(bytes, view, name, entry, clock)]));
    },
  };
}
