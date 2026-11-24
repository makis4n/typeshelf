/**
 * What the sync needs from the account's database, and nothing more. The
 * real one talks to Supabase (`supabaseRemote.ts`); tests use an in-memory
 * stand-in that follows the same rules.
 *
 * Every call may reject (offline, signed out, server trouble). The sync
 * treats a rejection as "not sent" and tries again later, unless it is a
 * `RejectedError`: then the rows themselves are the problem.
 */

import type { KeyCount, ProgressRecord, SessionRecord, WordCount } from '../store/types';

/**
 * The account refused these rows for what they are (a broken rule, a value
 * it cannot store), not because of the connection. Sending them again can
 * never work, so the sync sets them aside instead of retrying for ever.
 */
export class RejectedError extends Error {
  override readonly name = 'RejectedError';
}

/** A copy of the settings as the account holds it. */
export interface RemoteSettings {
  /** The settings object, unchecked: the app validates every value before using it. */
  data: unknown;
  updatedAt: number;
  deviceId: string;
}

/** The save time the account now holds for a place it accepted. */
export interface StoredStamp {
  bookId: string;
  updatedAt: number;
}

export interface Remote {
  /**
   * Save places. The account keeps whichever save of a book is most recent.
   *
   * Resolves with the save times the account stored for the rows it kept.
   * They can differ from what was sent: a stamp from a clock that runs
   * ahead is pulled back to the account's own time.
   */
  pushProgress(rows: readonly ProgressRecord[]): Promise<StoredStamp[]>;
  /** Add sessions. One sent twice is stored once. */
  pushSessions(rows: readonly SessionRecord[]): Promise<void>;
  /** Replace this device's running totals for these keys. */
  pushKeyCounts(deviceId: string, rows: readonly KeyCount[]): Promise<void>;
  /** Replace this device's running totals for these words. */
  pushWordCounts(deviceId: string, rows: readonly WordCount[]): Promise<void>;
  /**
   * Save the settings. The account keeps whichever copy is most recent.
   * Resolves with the time it stored them under, or undefined if it kept a newer copy.
   */
  pushSettings(settings: RemoteSettings): Promise<number | undefined>;

  /** The account's place in every book (one row per book). */
  pullProgress(): Promise<ProgressRecord[]>;
  /** The account's settings, or null if it has none yet. */
  pullSettings(): Promise<RemoteSettings | null>;
}
