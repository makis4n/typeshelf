/**
 * An in-memory account for tests. It follows the same rules as the real
 * database: the most recent save of a book wins, sessions are stored once,
 * counts are kept per device, and the local-only progress fields are never
 * stored. Two `Sync` instances sharing one `FakeRemote` stand in for two
 * devices on one account.
 */

import type { KeyCount, ProgressRecord, SessionRecord, WordCount } from '../store/types';
import type { Remote, RemoteSettings } from './remote';

export interface RemoteCall {
  method: string;
  /** The rows sent (empty for pulls). */
  rows: readonly unknown[];
}

const pair = (deviceId: string, name: string) => `${deviceId}\u0000${name}`;

export class FakeRemote implements Remote {
  /** While true, every call rejects. */
  offline = false;
  /** Every call made, including ones that were rejected. */
  readonly calls: RemoteCall[] = [];
  /** Runs at the start of `pushProgress`, so a test can hold a push in flight. */
  onPushProgress: (() => Promise<void> | void) | undefined;

  readonly progress = new Map<string, ProgressRecord>();
  readonly sessions = new Map<string, SessionRecord>();
  private readonly keys = new Map<string, KeyCount & { deviceId: string }>();
  private readonly words = new Map<string, WordCount & { deviceId: string }>();
  settings: RemoteSettings | null = null;

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
  }

  async pushProgress(rows: readonly ProgressRecord[]): Promise<void> {
    await this.enter('pushProgress', rows);
    await this.onPushProgress?.();
    if (this.offline) throw new Error('offline');
    for (const row of rows) {
      const stored = this.progress.get(row.bookId);
      if (stored && row.updatedAt < stored.updatedAt) continue;
      const { ahead: _ahead, declined: _declined, ...clean } = row;
      this.progress.set(row.bookId, { ...clean, position: { ...row.position } });
    }
  }

  async pushSessions(rows: readonly SessionRecord[]): Promise<void> {
    await this.enter('pushSessions', rows);
    for (const row of rows) this.sessions.set(row.id, { ...row });
  }

  async pushKeyCounts(deviceId: string, rows: readonly KeyCount[]): Promise<void> {
    await this.enter('pushKeyCounts', rows);
    for (const row of rows) this.keys.set(pair(deviceId, row.key), { ...row, deviceId });
  }

  async pushWordCounts(deviceId: string, rows: readonly WordCount[]): Promise<void> {
    await this.enter('pushWordCounts', rows);
    for (const row of rows) this.words.set(pair(deviceId, row.word), { ...row, deviceId });
  }

  async pushSettings(settings: RemoteSettings): Promise<void> {
    await this.enter('pushSettings', [settings]);
    if (this.settings && settings.updatedAt < this.settings.updatedAt) return;
    this.settings = { ...settings };
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
