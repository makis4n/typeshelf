/**
 * Sends what the local store has queued to the reader's account, and brings
 * the account's copy down.
 *
 * - Local changes go out in batches: about every 12 seconds while typing,
 *   and at once when asked (`flushNow`, for a pause, the end of a session,
 *   or the tab being hidden).
 * - Nothing is ever lost to a bad connection. A change stays queued until
 *   the account has confirmed it, and failed attempts are retried with
 *   growing gaps.
 * - The first time an account meets this browser, the guest's progress is
 *   merged into it (see `pull`).
 * - If another device is further on in a book, the place is not moved. It
 *   is kept as a question for the reader: `aheadFor` and `answerAhead`.
 */

import type { Position } from '../book/types';
import type { AheadPlace, OutboxEntry, OutboxKind, ProgressRecord } from '../store/types';
import type { UserStore } from '../store/userStore';
import { resolveProgress } from './conflict';
import type { Remote } from './remote';

/** How the sync reaches the settings, which live outside the local store. */
export interface SettingsPort {
  /** The settings on this device right now. */
  read(): unknown;
  /** Replace this device's settings with the account's copy. */
  apply(data: unknown): void;
}

export type SyncState =
  /** Everything is sent. */
  | 'synced'
  /** Changes are queued and will go out with the next batch. */
  | 'waiting'
  /** Talking to the account right now. */
  | 'syncing'
  /** The last attempt failed; it will be tried again. */
  | 'failed';

/** The two places the reader chooses between when another device is further on. */
export interface AheadQuestion {
  bookId: string;
  here: Position;
  there: AheadPlace;
}

export interface Timers {
  set(run: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export interface SyncOptions {
  store: UserStore;
  remote: Remote;
  /** The signed-in account. */
  userId: string;
  settings: SettingsPort;
  /** The gap between batches while typing. */
  intervalMs?: number;
  now?: () => number;
  timers?: Timers;
}

export const DEFAULT_INTERVAL_MS = 12_000;
const MAX_RETRY_MS = 5 * 60_000;
/** Rows per request, so one huge backlog is not one huge request. */
const CHUNK = 200;
/** The order kinds are sent in: the reader's place matters most. */
const ORDER: readonly OutboxKind[] = ['progress', 'settings', 'session', 'key', 'word'];

function chunks<T>(items: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let at = 0; at < items.length; at += CHUNK) out.push(items.slice(at, at + CHUNK));
  return out;
}

export class Sync {
  private readonly store: UserStore;
  private readonly remote: Remote;
  private readonly userId: string;
  private readonly settings: SettingsPort;
  private readonly intervalMs: number;
  private readonly now: () => number;
  private readonly timers: Timers;

  private state: SyncState = 'synced';
  private readonly stateListeners = new Set<(state: SyncState) => void>();
  private readonly aheadListeners = new Set<(bookId: string) => void>();

  private started = false;
  private stopped = false;
  /** Whether this browser's contents have been merged into the account yet. */
  private joined = false;
  private timer: unknown;
  private failures = 0;
  private running: Promise<void> | undefined;
  private unsubscribe: (() => void) | undefined;
  /** True while the account's settings are being applied, so that is not mistaken for the reader changing them. */
  private applyingSettings = false;

  constructor(options: SyncOptions) {
    this.store = options.store;
    this.remote = options.remote;
    this.userId = options.userId;
    this.settings = options.settings;
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.now = options.now ?? Date.now;
    this.timers = options.timers ?? {
      set: (run, ms) => setTimeout(run, ms),
      clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    };
  }

  // ---- lifecycle ------------------------------------------------------------

  /**
   * Begin syncing for the signed-in account: bring its copy down, merge
   * what this browser has, send what is queued, and from then on send local
   * changes in batches.
   *
   * Resolves once the first round is over, whether or not it got through.
   */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    const previous = await this.store.owner();
    // Another account's leftovers must not be merged into this one.
    if (previous !== null && previous !== this.userId) await this.store.clear();
    this.joined = previous === this.userId;
    this.unsubscribe = this.store.onChange(() => this.schedule());
    await this.refresh();
  }

  /** Stop sending. Whatever is queued stays queued in the local store. */
  stop(): void {
    this.stopped = true;
    this.unsubscribe?.();
    this.cancelTimer();
  }

  // ---- state ----------------------------------------------------------------

  current(): SyncState {
    return this.state;
  }

  /** Be told when the state changes. Returns the way to stop. */
  onState(listener: (state: SyncState) => void): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  private setState(next: SyncState): void {
    if (next === this.state) return;
    this.state = next;
    for (const listener of this.stateListeners) listener(next);
  }

  // ---- the reader's settings ------------------------------------------------

  /** Call when the reader changes a setting on this device. */
  async settingsChanged(): Promise<void> {
    // The account's copy being applied is not a change by the reader.
    if (this.applyingSettings) return;
    await this.store.markSettingsChanged(this.now());
  }

  // ---- another device is further on -----------------------------------------

  /** Be told when a book gains a "continue from there?" question. Returns the way to stop. */
  onAhead(listener: (bookId: string) => void): () => void {
    this.aheadListeners.add(listener);
    return () => this.aheadListeners.delete(listener);
  }

  /** The question to put to the reader as this book is opened, if there is one. */
  async aheadFor(bookId: string): Promise<AheadQuestion | undefined> {
    const record = await this.store.progress(bookId);
    if (!record?.ahead) return undefined;
    return { bookId, here: record.position, there: record.ahead };
  }

  /**
   * Record the reader's answer. Returns the place to carry on from.
   * The answer is sent to the account straight away.
   */
  async answerAhead(bookId: string, continueFromThere: boolean): Promise<Position | undefined> {
    const record = await this.store.answerAhead(bookId, continueFromThere, this.now());
    void this.flushNow();
    return record?.position;
  }

  // ---- sending and fetching -------------------------------------------------

  /**
   * Bring the account's copy down, then send what is queued. Call it when a
   * book is opened and when the tab comes back into view.
   */
  refresh(): Promise<void> {
    return this.exclusive(async () => {
      await this.pull();
      await this.push();
    });
  }

  /** Send what is queued now, without waiting for the next batch. */
  flushNow(): Promise<void> {
    return this.exclusive(async () => {
      // Nothing may be sent before this browser has been merged into the account.
      if (!this.joined) await this.pull();
      await this.push();
    });
  }

  /** One round at a time. A call made during a round waits for it, then runs its own. */
  private exclusive(round: () => Promise<void>): Promise<void> {
    const run = async () => {
      if (this.stopped) return;
      this.cancelTimer();
      this.setState('syncing');
      try {
        await round();
        this.failures = 0;
      } catch {
        // Offline, signed out or server trouble: everything is still queued.
        this.failures += 1;
      }
      await this.settle();
    };
    const next = (this.running ?? Promise.resolve()).then(run);
    this.running = next;
    void next.finally(() => {
      if (this.running === next) this.running = undefined;
    });
    return next;
  }

  /** After a round: report how things stand and book the next one if needed. */
  private async settle(): Promise<void> {
    if (this.stopped) return;
    // A change made during the round booked a timer with the old gap; start clean.
    this.cancelTimer();
    const waiting = (await this.store.pendingCount()) > 0;
    if (this.failures > 0) {
      this.setState('failed');
      this.schedule();
    } else if (waiting || !this.joined) {
      this.setState('waiting');
      this.schedule();
    } else {
      this.setState('synced');
    }
  }

  private schedule(): void {
    if (this.stopped || this.timer !== undefined) return;
    if (this.state === 'synced') this.setState('waiting');
    const delay = Math.min(this.intervalMs * 2 ** this.failures, MAX_RETRY_MS);
    this.timer = this.timers.set(() => {
      this.timer = undefined;
      void this.flushNow();
    }, delay);
  }

  private cancelTimer(): void {
    if (this.timer === undefined) return;
    this.timers.clear(this.timer);
    this.timer = undefined;
  }

  /**
   * Bring the account's copy down and settle it against this device's.
   *
   * The first time an account meets this browser (`joined` is false), what
   * the browser holds is a guest's progress, or nothing. It is merged by the
   * same rules as any two devices: a book only the guest has typed is kept
   * and sent up, and where both have a place, the newest wins unless the
   * account is further on, in which case the reader is asked. The guest's
   * sessions and counts are already queued and go up with the next push.
   * Settings are the exception: an account that already has settings keeps
   * them, so signing in on a new browser never resets them to that
   * browser's.
   */
  private async pull(): Promise<void> {
    const deviceId = await this.store.deviceId();
    const [rows, remoteSettings] = await Promise.all([this.remote.pullProgress(), this.remote.pullSettings()]);

    for (const remote of rows) {
      const verdict = await this.store.reconcileProgress(remote, (local) => {
        const decided = resolveProgress(local, remote, deviceId);
        // The same question is not raised twice.
        if (decided === 'ask' && sameAhead(local, remote)) return 'keep-local';
        return decided;
      });
      if (verdict === 'ask') for (const listener of this.aheadListeners) listener(remote.bookId);
    }

    const localAt = await this.store.settingsChangedAt();
    if (remoteSettings === null) {
      // The account has none: this device's become the account's.
      if (!this.joined || localAt !== undefined) await this.store.markSettingsChanged(localAt ?? this.now());
    } else if (!this.joined || localAt === undefined || remoteSettings.updatedAt > localAt) {
      this.applyingSettings = true;
      try {
        this.settings.apply(remoteSettings.data);
      } finally {
        this.applyingSettings = false;
      }
      await this.store.adoptSettings(remoteSettings.updatedAt);
    }

    if (!this.joined) {
      await this.store.setOwner(this.userId);
      this.joined = true;
    }
  }

  /** Send everything queued, one kind at a time, crossing off what the account confirms. */
  private async push(): Promise<void> {
    const pending = await this.store.pending();
    if (pending.length === 0) return;
    const deviceId = await this.store.deviceId();
    const byKind = new Map<OutboxKind, OutboxEntry[]>();
    for (const entry of pending) {
      const list = byKind.get(entry.kind) ?? [];
      list.push(entry);
      byKind.set(entry.kind, list);
    }

    for (const kind of ORDER) {
      for (const batch of chunks(byKind.get(kind) ?? [])) {
        await this.send(kind, batch, deviceId);
        await this.store.acknowledge(batch);
      }
    }
  }

  /** Read the newest contents of what the entries name, and send them. */
  private async send(kind: OutboxKind, entries: readonly OutboxEntry[], deviceId: string): Promise<void> {
    // Something queued and since cleared has nothing to send; it is simply crossed off.
    const found = async <T>(read: (ref: string) => Promise<T | undefined>): Promise<T[]> => {
      const rows = await Promise.all(entries.map((entry) => read(entry.ref)));
      return rows.filter((row): row is Awaited<T> & {} => row !== undefined) as T[];
    };
    switch (kind) {
      case 'progress': {
        const rows = await found<ProgressRecord>((ref) => this.store.progress(ref));
        if (rows.length > 0) await this.remote.pushProgress(rows);
        return;
      }
      case 'session': {
        const rows = await found((ref) => this.store.session(ref));
        if (rows.length > 0) await this.remote.pushSessions(rows);
        return;
      }
      case 'key': {
        const rows = await found((ref) => this.store.keyCount(ref));
        if (rows.length > 0) await this.remote.pushKeyCounts(deviceId, rows);
        return;
      }
      case 'word': {
        const rows = await found((ref) => this.store.wordCount(ref));
        if (rows.length > 0) await this.remote.pushWordCounts(deviceId, rows);
        return;
      }
      case 'settings': {
        const updatedAt = (await this.store.settingsChangedAt()) ?? this.now();
        await this.remote.pushSettings({ data: this.settings.read(), updatedAt, deviceId });
        return;
      }
    }
  }
}

/** Whether the reader already has this very save waiting as a question. */
function sameAhead(local: ProgressRecord | undefined, remote: ProgressRecord): boolean {
  const ahead = local?.ahead;
  return ahead !== undefined && ahead.deviceId === remote.deviceId && ahead.updatedAt === remote.updatedAt;
}
