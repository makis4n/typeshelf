/**
 * What the local store keeps for one person on one device: their place in
 * each book, their typing sessions, weak-key counts, and the queue of
 * changes still to be sent to their account.
 */

import type { Position } from '../book/types';

/** A place saved on some other device that is further on than this device's. */
export interface AheadPlace {
  position: Position;
  /** When that device saved it, in milliseconds since 1970. */
  updatedAt: number;
  deviceId: string;
}

export interface ProgressRecord {
  bookId: string;
  /** The book's fingerprint, so another device can match an imported file. */
  fingerprint: string;
  position: Position;
  /** When this place was saved, in milliseconds since 1970 (the saving device's clock). */
  updatedAt: number;
  /** The device that saved it. */
  deviceId: string;
  /** Set while the reader has yet to answer "continue from there?". */
  ahead?: AheadPlace;
  /** The other device's save the reader last said no to, so it is not asked again. */
  declined?: string;
}

/** One sitting with a book. */
export interface SessionRecord {
  /** Made up on the device (a UUID), so sending it twice is harmless. */
  id: string;
  bookId: string;
  startedAt: number;
  endedAt: number;
  /** Typing time with pauses taken out. */
  activeMs: number;
  words: number;
  wpm: number;
  /** Share of key presses that were right, 0 to 1. */
  accuracy: number;
  deviceId: string;
}

/** This device's running totals for one key. Counts only, never the order of presses. */
export interface KeyCount {
  /** The character that was expected, or a pair of characters. */
  key: string;
  hits: number;
  misses: number;
  /** Time spent on the correct presses. */
  totalMs: number;
}

/** This device's running totals for one word. */
export interface WordCount {
  word: string;
  hits: number;
  misses: number;
}

export type OutboxKind = 'progress' | 'session' | 'key' | 'word' | 'settings';

/**
 * A note that something changed and has not reached the account yet. It
 * names the thing, not its contents: the newest contents are read when it is
 * sent, so ten saves of one book are still one entry.
 */
export interface OutboxEntry {
  /** `<kind>:<ref>`. */
  id: string;
  kind: OutboxKind;
  /** Book id, session id, key or word; empty for settings. */
  ref: string;
  /** Goes up with every change, so a change made while sending is not lost. */
  seq: number;
}

/**
 * What an account had not yet managed to send when its time on this browser
 * ended. It is kept apart from the live store, belongs to that account
 * alone, and is sent the next time that same account signs in here.
 */
export interface Parked {
  /** Given by the database when it is stored. */
  id?: number;
  userId: string;
  /** The device id the rows were made under. */
  deviceId: string;
  progress: ProgressRecord[];
  /** Places with an unanswered "continue from there?". Never sent: put back so the reader is still asked. */
  held: ProgressRecord[];
  sessions: SessionRecord[];
  keys: KeyCount[];
  words: WordCount[];
  settings?: { data: unknown; updatedAt: number };
}

/** Limits shared with the database, so a row it would refuse is never queued. */
export const MAX_KEY_LENGTH = 8;
export const MAX_WORD_LENGTH = 64;
export const MAX_BOOK_ID_LENGTH = 200;
export const FINGERPRINT = /^[0-9a-f]{64}$/;

/** A name for one particular save by one device, to remember that the reader said no to it. */
export function saveTag(save: { deviceId: string; updatedAt: number }): string {
  return `${save.deviceId}@${save.updatedAt}`;
}
