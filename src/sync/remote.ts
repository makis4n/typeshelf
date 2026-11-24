/**
 * What the sync needs from the account's database, and nothing more. The
 * real one talks to Supabase (`supabaseRemote.ts`); tests use an in-memory
 * stand-in that follows the same rules.
 *
 * Every call may reject (offline, signed out, server trouble). The sync
 * treats a rejection as "not sent" and tries again later.
 */

import type { KeyCount, ProgressRecord, SessionRecord, WordCount } from '../store/types';

/** A copy of the settings as the account holds it. */
export interface RemoteSettings {
  /** The settings object, unchecked: the app validates every value before using it. */
  data: unknown;
  updatedAt: number;
  deviceId: string;
}

export interface Remote {
  /** Save places. The account keeps whichever save of a book is most recent. */
  pushProgress(rows: readonly ProgressRecord[]): Promise<void>;
  /** Add sessions. One sent twice is stored once. */
  pushSessions(rows: readonly SessionRecord[]): Promise<void>;
  /** Replace this device's running totals for these keys. */
  pushKeyCounts(deviceId: string, rows: readonly KeyCount[]): Promise<void>;
  /** Replace this device's running totals for these words. */
  pushWordCounts(deviceId: string, rows: readonly WordCount[]): Promise<void>;
  /** Save the settings. The account keeps whichever copy is most recent. */
  pushSettings(settings: RemoteSettings): Promise<void>;

  /** The account's place in every book (one row per book). */
  pullProgress(): Promise<ProgressRecord[]>;
  /** The account's settings, or null if it has none yet. */
  pullSettings(): Promise<RemoteSettings | null>;
}
