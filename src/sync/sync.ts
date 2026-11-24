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
 * - A row the account refuses for what it is (not for the connection) is
 *   set aside, so one bad row cannot hold everything else back for ever.
 * - The first time an account meets this browser, the guest's progress is
 *   merged into it (see `pull`).
 * - One account's unsent changes never reach another account: when a
 *   different account takes over the browser they are moved to a side
 *   shelf, and sent when their own account is back (`sendParked`).
 * - If another device is further on in a book, the place is not moved. It
 *   is kept as a question for the reader: `aheadFor` and `answerAhead`.
 */

import type { Position } from '../book/types';
import type { AheadPlace, OutboxEntry, OutboxKind, Parked } from '../store/types';
import type { UserStore } from '../store/userStore';
import { resolveProgress } from './conflict';
import { RejectedError, type Remote } from './remote';

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
/** An answer that took longer than this says too little about what time it is right now. */
const MAX_CLOCK_ROUND_TRIP_MS = 10_000;
/** Rows per request, so one huge backlog is not one huge request. */
const CHUNK = 200;
/** The order kinds are sent in: the reader's place matters most. */
const ORDER: readonly OutboxKind[] = ['progress', 'settings', 'session', 'key', 'word'];

/** The round cannot go on: the sync was stopped, or the store now belongs to someone else. Not a failure. */
class Interrupted extends Error {}

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
  /** Whether a clock was handed in (tests); otherwise the store's own best estimate of the time is used. */
  private readonly ownClock: boolean;
  private readonly timers: Timers;

  private state: SyncState = 'synced';
  private readonly stateListeners = new Set<(state: SyncState) => void>();
  private readonly aheadListeners = new Set<(bookId: string) => void>();

  /** Queue entries the account refused for what they are. They stay on this device but are not sent again. */
  readonly setAside: OutboxEntry[] = [];

  private started = false;
  private stopped = false;
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
    this.ownClock = options.now !== undefined;
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
    await (await this.begin()).firstRound;
  }

  /**
   * The first half of `start`: take the store over for this account, and
   * set the first round going without waiting for it. For callers that
   * must not be held up by a slow connection. (The round is handed back
   * inside an object, because a promise returned bare would be waited for.)
   */
  async begin(): Promise<{ firstRound: Promise<void> }> {
    if (this.started) return { firstRound: Promise.resolve() };
    this.started = true;
    const previous = await this.store.owner();
    // Another account's leftovers are never merged into this one. What it
    // had not sent is put aside for it, and the store starts again empty.
    if (previous !== null && previous !== this.userId) await this.store.endAccountSession(this.settings.read());
    // From this moment whatever is typed here is this account's, whether or
    // not the first round gets through.
    await this.store.setOwner(this.userId);
    this.unsubscribe = this.store.onChange(() => this.schedule());
    return { firstRound: this.refresh() };
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
    await this.store.markSettingsChanged(await this.accountNow(), this.userId);
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
    const record = await this.store.answerAhead(bookId, continueFromThere, await this.accountNow());
    void this.flushNow();
    return record?.position;
  }

  // ---- sending and fetching -------------------------------------------------

  /**
   * Bring the account's copy down, then send what is queued. Call it when a
   * book is opened and when the tab comes back into view.
   */
  refresh(): Promise<void> {
    return this.exclusive(() => this.round(true));
  }

  /** Send what is queued now, without waiting for the next batch. */
  flushNow(): Promise<void> {
    return this.exclusive(() => this.round(false));
  }

  private async round(pullFirst: boolean): Promise<void> {
    await this.mine();
    // Nothing may be sent before this browser has been merged into the account.
    const joined = (await this.store.joinedAs()) === this.userId;
    const pulling = pullFirst || !joined;
    const sending =
      (await this.store.sendable()).length > 0 || (await this.store.parkedFor(this.userId)).length > 0;
    // A round with nothing to fetch and nothing to send does not call the account at all.
    if (!pulling && !sending) return;
    // Before anything is weighed or sent: save times only compare if they are in the same time.
    await this.measureClock();
    await this.sendParked();
    if (pulling) await this.pull(joined);
    await this.push();
  }

  /** Now, in the account's time: this device's clock, corrected by what was last measured. */
  private accountNow(): Promise<number> {
    return this.ownClock ? this.store.accountTime(this.now()) : this.store.accountTime();
  }

  /**
   * Ask the account what time it is and remember how far this device's
   * clock is from it. Best effort: offline, or with an account database
   * that cannot say, the last measurement stands.
   */
  private async measureClock(): Promise<void> {
    try {
      const asked = this.now();
      const account = await this.remote.serverTime();
      const answered = this.now();
      if (answered - asked > MAX_CLOCK_ROUND_TRIP_MS) return;
      // The account read its clock somewhere between the question and the answer.
      await this.store.setClockOffset(Math.round(account - (asked + answered) / 2), answered);
    } catch {
      // Nothing learned this time.
    }
  }

  /** Go no further if the sync was stopped or the store has changed hands (another tab signed out, or in as someone else). */
  private async mine(): Promise<void> {
    if (this.stopped || (await this.store.owner()) !== this.userId) throw new Interrupted();
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
      } catch (error) {
        // Offline, signed out or server trouble: everything is still queued.
        if (!(error instanceof Interrupted)) this.failures += 1;
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
    const mine = (await this.store.owner()) === this.userId;
    // A place held back for an unanswered question is not "waiting": only the reader can release it.
    const waiting = mine && (await this.store.sendable()).length > 0;
    const joined = (await this.store.joinedAs()) === this.userId;
    if (this.failures > 0) {
      this.setState('failed');
      this.schedule();
    } else if (waiting || (mine && !joined)) {
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
   * Send what this account left unsent on an earlier visit to this browser
   * (see `UserStore.endAccountSession`). It goes straight to the account
   * and is never mixed into the live store, with one exception: a place
   * with an unanswered "continue from there?" is put back, so the reader is
   * still asked.
   */
  private async sendParked(): Promise<void> {
    for (const parked of await this.store.parkedFor(this.userId)) {
      const left: Parked = { ...parked };
      const drop = () => {};
      for (const record of parked.held) await this.store.restoreHeld(record, this.userId);
      left.held = [];
      await this.store.updateParked(left);

      await this.deliver(parked.progress, (rows) => this.remote.pushProgress(rows), drop);
      left.progress = [];
      await this.store.updateParked(left);
      await this.deliver(parked.sessions, (rows) => this.remote.pushSessions(rows), drop);
      left.sessions = [];
      await this.store.updateParked(left);
      await this.deliver(parked.keys, (rows) => this.remote.pushKeyCounts(parked.deviceId, rows), drop);
      left.keys = [];
      await this.store.updateParked(left);
      await this.deliver(parked.words, (rows) => this.remote.pushWordCounts(parked.deviceId, rows), drop);
      left.words = [];
      await this.store.updateParked(left);
      if (parked.settings) {
        const { data, updatedAt } = parked.settings;
        await this.deliver([parked.settings], () => this.remote.pushSettings({ data, updatedAt, deviceId: parked.deviceId }), drop);
        delete left.settings;
        await this.store.updateParked(left);
      }
    }
  }

  /**
   * Send rows in batches. If the account refuses a batch for what is in it,
   * the rows are sent one by one, so only the row at fault is left out
   * (`refused` is told about it) and its neighbours still get through. Any
   * other failure (the connection, the server) is passed on, to be retried.
   */
  private async deliver<T>(
    rows: readonly T[],
    send: (rows: T[]) => Promise<unknown>,
    refused: (row: T) => void,
    sent: (rows: T[]) => Promise<void> = async () => {},
  ): Promise<void> {
    for (const batch of chunks(rows)) {
      try {
        await send(batch);
        await sent(batch);
      } catch (error) {
        if (!(error instanceof RejectedError)) throw error;
        if (batch.length === 1) {
          console.warn('typeshelf: the account refused a row; it stays on this device only', error.message);
          refused(batch[0]!);
          await sent(batch);
          continue;
        }
        for (const row of batch) {
          try {
            await send([row]);
          } catch (single) {
            if (!(single instanceof RejectedError)) throw single;
            console.warn('typeshelf: the account refused a row; it stays on this device only', single.message);
            refused(row);
          }
          await sent([row]);
        }
      }
    }
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
  private async pull(joined: boolean): Promise<void> {
    const deviceId = await this.store.deviceId();
    const [rows, remoteSettings] = await Promise.all([this.remote.pullProgress(), this.remote.pullSettings()]);
    // The answer may have been a long time coming.
    await this.mine();

    for (const remote of rows) {
      const verdict = await this.store.reconcileProgress(
        remote,
        (local) => {
          const decided = resolveProgress(local, remote, deviceId);
          // The same question is not raised twice.
          if (decided === 'ask' && sameAhead(local?.ahead, remote)) return 'keep-local';
          return decided;
        },
        this.userId,
      );
      if (verdict === 'ask') for (const listener of this.aheadListeners) listener(remote.bookId);
    }

    const localAt = await this.store.settingsChangedAt();
    if (remoteSettings === null) {
      // The account has none: this device's become the account's.
      if (!joined || localAt !== undefined) {
        await this.store.markSettingsChanged(localAt ?? (await this.accountNow()), this.userId);
      }
    } else if (!joined || localAt === undefined || remoteSettings.updatedAt > localAt) {
      await this.mine();
      this.applyingSettings = true;
      try {
        this.settings.apply(remoteSettings.data);
      } finally {
        this.applyingSettings = false;
      }
      await this.store.adoptSettings(remoteSettings.updatedAt, this.userId);
    }

    await this.store.markJoined(this.userId);
  }

  /** Send everything that may be sent, one kind at a time, crossing off what the account confirms. */
  private async push(): Promise<void> {
    const pending = await this.store.sendable();
    if (pending.length === 0) return;
    const byKind = new Map<OutboxKind, OutboxEntry[]>();
    for (const entry of pending) {
      const list = byKind.get(entry.kind) ?? [];
      list.push(entry);
      byKind.set(entry.kind, list);
    }
    for (const kind of ORDER) await this.pushKind(kind, byKind.get(kind) ?? []);
  }

  /** Read the newest contents of what the entries name, and send them. */
  private async pushKind(kind: OutboxKind, entries: readonly OutboxEntry[]): Promise<void> {
    if (entries.length === 0) return;
    const store = this.store;
    const userId = this.userId;

    /** Pair each entry with its row. Something queued and since cleared has no row: it is simply crossed off. */
    const load = async <T>(read: (ref: string) => Promise<T | undefined>) => {
      const pairs: { entry: OutboxEntry; row: T }[] = [];
      const gone: OutboxEntry[] = [];
      for (const entry of entries) {
        const row = await read(entry.ref);
        if (row === undefined) gone.push(entry);
        else pairs.push({ entry, row });
      }
      const deviceId = await store.deviceId();
      // Read last: if the store is still this account's now, so was everything just read from it.
      await this.mine();
      await store.acknowledge(gone, userId);
      return { pairs, deviceId };
    };
    type Pair<T> = { entry: OutboxEntry; row: T };
    const rowsOf = <T>(pairs: Pair<T>[]) => pairs.map((pair) => pair.row);
    const refused = <T>(pair: Pair<T>) => void this.setAside.push(pair.entry);
    const crossOff = <T>(pairs: Pair<T>[]) => store.acknowledge(pairs.map((pair) => pair.entry), userId);

    switch (kind) {
      case 'progress': {
        const { pairs } = await load((ref) => store.progress(ref));
        await this.deliver(
          pairs,
          async (batch) => {
            const stored = await this.remote.pushProgress(rowsOf(batch));
            // The account may have stored a save under its own time (this device's clock runs fast).
            for (const stamp of stored) {
              const sentAt = batch.find((pair) => pair.row.bookId === stamp.bookId)?.row.updatedAt;
              if (sentAt !== undefined && sentAt !== stamp.updatedAt) {
                await store.restampProgress(stamp.bookId, sentAt, stamp.updatedAt, userId);
              }
            }
          },
          refused,
          crossOff,
        );
        return;
      }
      case 'session': {
        const { pairs } = await load((ref) => store.session(ref));
        await this.deliver(pairs, (batch) => this.remote.pushSessions(rowsOf(batch)), refused, crossOff);
        return;
      }
      case 'key': {
        const { pairs, deviceId } = await load((ref) => store.keyCount(ref));
        await this.deliver(pairs, (batch) => this.remote.pushKeyCounts(deviceId, rowsOf(batch)), refused, crossOff);
        return;
      }
      case 'word': {
        const { pairs, deviceId } = await load((ref) => store.wordCount(ref));
        await this.deliver(pairs, (batch) => this.remote.pushWordCounts(deviceId, rowsOf(batch)), refused, crossOff);
        return;
      }
      case 'settings': {
        const deviceId = await store.deviceId();
        const updatedAt = (await store.settingsChangedAt()) ?? (await this.accountNow());
        const data = this.settings.read();
        await this.mine();
        const pairs = entries.map((entry) => ({ entry, row: data }));
        await this.deliver(
          pairs,
          async () => {
            const storedAt = await this.remote.pushSettings({ data, updatedAt, deviceId });
            if (storedAt !== undefined && storedAt !== updatedAt) await store.restampSettings(updatedAt, storedAt, userId);
          },
          refused,
          crossOff,
        );
        return;
      }
    }
  }
}

/** Whether the reader already has this very save waiting as a question. */
function sameAhead(ahead: AheadPlace | undefined, remote: { deviceId: string; updatedAt: number }): boolean {
  return ahead !== undefined && ahead.deviceId === remote.deviceId && ahead.updatedAt === remote.updatedAt;
}
