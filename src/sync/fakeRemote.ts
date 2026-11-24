/**
 * An in-memory account for tests. It follows the same rules as the real
 * database: the most recent save of a book wins, a save stamped far in the
 * future is pulled back to the account's own clock, a row that breaks a
 * table rule is refused together with the request that carried it, sessions
 * are stored once, counts are kept per device, and the local-only progress
 * fields are never stored. Two `Sync` instances sharing one `FakeRemote` stand in for two
 * devices on one account.
 */

import type { KeyCount, ProgressRecord, SessionRecord, WordCount } from '../store/types';
import { RejectedError, type Remote, type RemoteSettings, type StoredStamp } from './remote';

export interface RemoteCall {
  method: string;
  /** The rows sent (empty for pulls). */
  rows: readonly unknown[];
}

const pair = (deviceId: string, name: string) => `${deviceId}\u0000${name}`;

/** The database pulls a save time more than this far ahead of its own clock back to now. */
const FUTURE_ALLOWANCE_MS = 5 * 60_000;

const whole = (value: unknown) => typeof value === 'number' && Number.isInteger(value) && value >= 0;
const amount = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const short = (value: unknown, max: number) => typeof value === 'string' && value.length >= 1 && value.length <= max;

/** The table rules of `supabase/migrations`: a row that breaks one is refused, and the whole request with it. */
function refuseUnless(ok: boolean, what: string): void {
  if (!ok) throw new RejectedError(`violates check constraint: ${what}`);
}

export class FakeRemote implements Remote {
  /** While true, every call rejects. */
  offline = false;
  /** Every call made, including ones that were rejected. */
  readonly calls: RemoteCall[] = [];
  /** Runs at the start of `pushProgress`, so a test can hold a push in flight. */
  onPushProgress: (() => Promise<void> | void) | undefined;
  /** A rule of the account's that a test makes up: a request carrying a row it returns true for is refused. */
  refuses: ((row: unknown) => boolean) | undefined;

  readonly progress = new Map<string, ProgressRecord>();
  readonly sessions = new Map<string, SessionRecord>();
  private readonly keys = new Map<string, KeyCount & { deviceId: string }>();
  private readonly words = new Map<string, WordCount & { deviceId: string }>();
  settings: RemoteSettings | null = null;

  /**
   * @param clock the account's own clock. A save stamped far ahead of it is pulled back to it.
   *   Tests that run on made-up device times leave it out: the account then cannot be asked
   *   the time (like a database without the time function), and only real time is "too far ahead".
   */
  constructor(private readonly clock?: () => number) {}

  private clamp(updatedAt: number): number {
    refuseUnless(Number.isFinite(updatedAt), 'updated_at');
    const now = (this.clock ?? Date.now)();
    return updatedAt > now + FUTURE_ALLOWANCE_MS ? now : updatedAt;
  }

  async serverTime(): Promise<number> {
    await this.enter('serverTime', []);
    if (!this.clock) throw new Error('function server_time() does not exist');
    return this.clock();
  }

  /** Number of calls made to one method. */
  count(method: keyof Remote): number {
    return this.calls.filter((call) => call.method === method).length;
  }

  /** The row lists sent by each call to one method, in order. */
  sent(method: keyof Remote): readonly unknown[][] {
    return this.calls.filter((call) => call.method === method).map((call) => [...call.rows]);
  }

  keyRow(deviceId: string, key: string): KeyCount | undefined {
    const row = this.keys.get(pair(deviceId, key));
    return row && { key: row.key, hits: row.hits, misses: row.misses, totalMs: row.totalMs };
  }

  wordRow(deviceId: string, word: string): WordCount | undefined {
    const row = this.words.get(pair(deviceId, word));
    return row && { word: row.word, hits: row.hits, misses: row.misses };
  }

  /** One key's totals added up across every device. */
  totalForKey(key: string): { hits: number; misses: number; totalMs: number } {
    const total = { hits: 0, misses: 0, totalMs: 0 };
    for (const row of this.keys.values()) {
      if (row.key !== key) continue;
      total.hits += row.hits;
      total.misses += row.misses;
      total.totalMs += row.totalMs;
    }
    return total;
  }

  /** One word's totals added up across every device. */
  totalForWord(word: string): { hits: number; misses: number } {
    const total = { hits: 0, misses: 0 };
    for (const row of this.words.values()) {
      if (row.word !== word) continue;
      total.hits += row.hits;
      total.misses += row.misses;
    }
    return total;
  }

  private async enter(method: keyof Remote, rows: readonly unknown[]): Promise<void> {
    this.calls.push({ method, rows });
    if (this.offline) throw new Error('offline');
    if (this.refuses && rows.some((row) => this.refuses!(row))) throw new RejectedError('violates a rule of the account');
  }

  async pushProgress(rows: readonly ProgressRecord[]): Promise<StoredStamp[]> {
    await this.enter('pushProgress', rows);
    await this.onPushProgress?.();
    if (this.offline) throw new Error('offline');
    for (const row of rows) {
      refuseUnless(short(row.bookId, 200), 'book_id');
      refuseUnless(/^[0-9a-f]{64}$/.test(row.fingerprint), 'fingerprint');
      refuseUnless(whole(row.position.chapter) && whole(row.position.paragraph) && whole(row.position.char), 'position');
      refuseUnless(short(row.deviceId, 64), 'device_id');
    }
    const kept: StoredStamp[] = [];
    for (const row of rows) {
      const updatedAt = this.clamp(row.updatedAt);
      const stored = this.progress.get(row.bookId);
      if (stored && updatedAt < stored.updatedAt) continue;
      const { ahead: _ahead, declined: _declined, ...clean } = row;
      this.progress.set(row.bookId, { ...clean, updatedAt, position: { ...row.position } });
      kept.push({ bookId: row.bookId, updatedAt });
    }
    return kept;
  }

  async pushSessions(rows: readonly SessionRecord[]): Promise<void> {
    await this.enter('pushSessions', rows);
    for (const row of rows) {
      refuseUnless(short(row.bookId, 200), 'book_id');
      refuseUnless(Number.isFinite(row.startedAt) && Number.isFinite(row.endedAt), 'started_at, ended_at');
      refuseUnless(row.endedAt >= row.startedAt, 'ended_at >= started_at');
      refuseUnless(whole(Math.round(row.activeMs)) && whole(Math.round(row.words)), 'active_ms, words');
      refuseUnless(amount(row.wpm), 'wpm');
      refuseUnless(amount(row.accuracy) && row.accuracy <= 1, 'accuracy');
      refuseUnless(short(row.deviceId, 64), 'device_id');
    }
    // A session is written once: one sent again is left alone.
    for (const row of rows) if (!this.sessions.has(row.id)) this.sessions.set(row.id, { ...row });
  }

  async pushKeyCounts(deviceId: string, rows: readonly KeyCount[]): Promise<void> {
    await this.enter('pushKeyCounts', rows);
    for (const row of rows) {
      refuseUnless(short(row.key, 8), 'key');
      refuseUnless(whole(row.hits) && whole(row.misses) && whole(row.totalMs), 'hits, misses, total_ms');
    }
    for (const row of rows) this.keys.set(pair(deviceId, row.key), { ...row, deviceId });
  }

  async pushWordCounts(deviceId: string, rows: readonly WordCount[]): Promise<void> {
    await this.enter('pushWordCounts', rows);
    for (const row of rows) {
      refuseUnless(short(row.word, 64), 'word');
      refuseUnless(whole(row.hits) && whole(row.misses), 'hits, misses');
    }
    for (const row of rows) this.words.set(pair(deviceId, row.word), { ...row, deviceId });
  }

  async pushSettings(settings: RemoteSettings): Promise<number | undefined> {
    await this.enter('pushSettings', [settings]);
    refuseUnless(typeof settings.data === 'object' && settings.data !== null && !Array.isArray(settings.data), 'data');
    const updatedAt = this.clamp(settings.updatedAt);
    if (this.settings && updatedAt < this.settings.updatedAt) return undefined;
    this.settings = { ...settings, updatedAt };
    return updatedAt;
  }

  async pullProgress(): Promise<ProgressRecord[]> {
    await this.enter('pullProgress', []);
    return [...this.progress.values()].map((row) => ({ ...row, position: { ...row.position } }));
  }

  async pullSettings(): Promise<RemoteSettings | null> {
    await this.enter('pullSettings', []);
    return this.settings && { ...this.settings };
  }
}
