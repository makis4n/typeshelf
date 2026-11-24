import { describe, expect, it } from 'vitest';
import { fingerprintFromId, fingerprintOf, importId, isSameBook } from './fingerprint';

const bytes = (text: string) => new TextEncoder().encode(text);

const EMPTY = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const ABC = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';

describe('fingerprintOf', () => {
  it('matches the known SHA-256 of empty input', async () => {
    expect(await fingerprintOf(new Uint8Array())).toBe(EMPTY);
  });

  it('matches the known SHA-256 of "abc"', async () => {
    expect(await fingerprintOf(bytes('abc'))).toBe(ABC);
  });

  it('gives 64 lowercase hex characters', async () => {
    expect(await fingerprintOf(bytes('anything at all'))).toMatch(/^[0-9a-f]{64}$/);
  });

  it('gives different fingerprints for different bytes', async () => {
    expect(await fingerprintOf(bytes('abc'))).not.toBe(await fingerprintOf(bytes('abd')));
  });

  it('hashes only the visible part of a subarray', async () => {
    expect(await fingerprintOf(bytes('xxabcxx').subarray(2, 5))).toBe(ABC);
  });
});

describe('importId and fingerprintFromId', () => {
  it('prefixes the fingerprint with import:', () => {
    expect(importId(ABC)).toBe(`import:${ABC}`);
  });

  it('round-trips a fingerprint', () => {
    expect(fingerprintFromId(importId(ABC))).toBe(ABC);
  });

  it('gives undefined for ids of other kinds', () => {
    expect(fingerprintFromId('gutenberg:1342')).toBeUndefined();
    expect(fingerprintFromId('')).toBeUndefined();
  });
});

describe('isSameBook', () => {
  it('is true for the same bytes', async () => {
    expect(await isSameBook(ABC, bytes('abc'))).toBe(true);
  });

  it('is false when one byte differs', async () => {
    expect(await isSameBook(ABC, bytes('abd'))).toBe(false);
  });

  it('accepts an uppercase fingerprint', async () => {
    expect(await isSameBook(ABC.toUpperCase(), bytes('abc'))).toBe(true);
  });

  it('accepts the import id form', async () => {
    expect(await isSameBook(importId(ABC), bytes('abc'))).toBe(true);
    expect(await isSameBook(importId(ABC), bytes('abd'))).toBe(false);
  });

  it('accepts surrounding whitespace', async () => {
    expect(await isSameBook(`  ${ABC}\n`, bytes('abc'))).toBe(true);
  });

  it('is false for malformed input', async () => {
    expect(await isSameBook('', bytes('abc'))).toBe(false);
    expect(await isSameBook('abc', bytes('abc'))).toBe(false);
    expect(await isSameBook(ABC.slice(1), bytes('abc'))).toBe(false);
    expect(await isSameBook(`${ABC}0`, bytes('abc'))).toBe(false);
    expect(await isSameBook('z'.repeat(64), bytes('abc'))).toBe(false);
    expect(await isSameBook('gutenberg:1342', bytes('abc'))).toBe(false);
    expect(await isSameBook('import:', bytes('abc'))).toBe(false);
  });

  it('is false for the empty-input fingerprint against other bytes', async () => {
    expect(await isSameBook(EMPTY, bytes('abc'))).toBe(false);
    expect(await isSameBook(EMPTY, new Uint8Array())).toBe(true);
  });
});
