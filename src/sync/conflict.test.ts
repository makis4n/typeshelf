import { describe, expect, it } from 'vitest';
import type { Position } from '../book/types';
import { saveTag, type ProgressRecord } from '../store/types';
import { comparePositions, resolveProgress } from './conflict';

const ME = 'device-me';
const OTHER = 'device-other';

const at = (chapter: number, paragraph: number, char: number): Position => ({ chapter, paragraph, char });

function record(overrides: Partial<ProgressRecord> = {}): ProgressRecord {
  return {
    bookId: 'book',
    fingerprint: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    position: at(1, 1, 1),
    updatedAt: 1000,
    deviceId: ME,
    ...overrides,
  };
}

describe('comparePositions', () => {
  it('is zero for the same place', () => {
    expect(comparePositions(at(2, 3, 4), at(2, 3, 4))).toBe(0);
  });

  it('orders by chapter first', () => {
    expect(comparePositions(at(1, 9, 9), at(2, 0, 0))).toBeLessThan(0);
    expect(comparePositions(at(2, 0, 0), at(1, 9, 9))).toBeGreaterThan(0);
  });

  it('orders by paragraph when the chapter is the same', () => {
    expect(comparePositions(at(2, 1, 9), at(2, 2, 0))).toBeLessThan(0);
    expect(comparePositions(at(2, 2, 0), at(2, 1, 9))).toBeGreaterThan(0);
  });

  it('orders by character when chapter and paragraph are the same', () => {
    expect(comparePositions(at(2, 2, 3), at(2, 2, 4))).toBeLessThan(0);
    expect(comparePositions(at(2, 2, 4), at(2, 2, 3))).toBeGreaterThan(0);
  });
});

describe('resolveProgress', () => {
  it('takes the account place when this device has none', () => {
    expect(resolveProgress(undefined, record({ deviceId: OTHER }), ME)).toBe('take-remote');
  });

  it('keeps the local place when the account copy came from this same device', () => {
    const local = record({ position: at(1, 1, 1) });
    const remote = record({ position: at(5, 0, 0), updatedAt: 9999, deviceId: ME });
    expect(resolveProgress(local, remote, ME)).toBe('keep-local');
  });

  it('keeps the local place when both are at the same position', () => {
    const local = record({ position: at(2, 2, 2), updatedAt: 100 });
    const remote = record({ position: at(2, 2, 2), updatedAt: 900, deviceId: OTHER });
    expect(resolveProgress(local, remote, ME)).toBe('keep-local');
  });

  it('asks when the other device is in a later chapter', () => {
    const local = record({ position: at(1, 5, 5) });
    const remote = record({ position: at(2, 0, 0), deviceId: OTHER });
    expect(resolveProgress(local, remote, ME)).toBe('ask');
  });

  it('asks when the other device is in the same chapter but a later paragraph', () => {
    const local = record({ position: at(1, 1, 50) });
    const remote = record({ position: at(1, 2, 0), deviceId: OTHER });
    expect(resolveProgress(local, remote, ME)).toBe('ask');
  });

  it('asks when the other device is in the same paragraph but a later character', () => {
    const local = record({ position: at(1, 1, 10) });
    const remote = record({ position: at(1, 1, 11), deviceId: OTHER });
    expect(resolveProgress(local, remote, ME)).toBe('ask');
  });

  it('asks when the other device is further on even if its save is older', () => {
    const local = record({ position: at(1, 1, 1), updatedAt: 5000 });
    const remote = record({ position: at(3, 0, 0), updatedAt: 100, deviceId: OTHER });
    expect(resolveProgress(local, remote, ME)).toBe('ask');
  });

  it('asks when the other device is further on and its save is newer', () => {
    const local = record({ position: at(1, 1, 1), updatedAt: 100 });
    const remote = record({ position: at(3, 0, 0), updatedAt: 5000, deviceId: OTHER });
    expect(resolveProgress(local, remote, ME)).toBe('ask');
  });

  it('keeps the local place when that very save was already turned down', () => {
    const remote = record({ position: at(3, 0, 0), updatedAt: 500, deviceId: OTHER });
    const local = record({ position: at(1, 1, 1), declined: saveTag(remote) });
    expect(resolveProgress(local, remote, ME)).toBe('keep-local');
  });

  it('asks again when the other device makes a newer save after one was turned down', () => {
    const turnedDown = record({ position: at(3, 0, 0), updatedAt: 500, deviceId: OTHER });
    const local = record({ position: at(1, 1, 1), declined: saveTag(turnedDown) });
    const newer = record({ position: at(3, 1, 0), updatedAt: 600, deviceId: OTHER });
    expect(resolveProgress(local, newer, ME)).toBe('ask');
  });

  it('takes the account place when it is further back and newer', () => {
    const local = record({ position: at(3, 0, 0), updatedAt: 100 });
    const remote = record({ position: at(1, 0, 0), updatedAt: 200, deviceId: OTHER });
    expect(resolveProgress(local, remote, ME)).toBe('take-remote');
  });

  it('keeps the local place when the account place is further back and older', () => {
    const local = record({ position: at(3, 0, 0), updatedAt: 200 });
    const remote = record({ position: at(1, 0, 0), updatedAt: 100, deviceId: OTHER });
    expect(resolveProgress(local, remote, ME)).toBe('keep-local');
  });

  it('keeps the local place when the account place is further back and saved at the same moment', () => {
    const local = record({ position: at(3, 0, 0), updatedAt: 100 });
    const remote = record({ position: at(1, 0, 0), updatedAt: 100, deviceId: OTHER });
    expect(resolveProgress(local, remote, ME)).toBe('keep-local');
  });
});
