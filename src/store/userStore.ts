/**
 * The local store: one IndexedDB database, `typeshelf-user`, that the app
 * always writes to first. Typing never waits on the network; whatever is
 * written here is also noted in an outbox, which the sync sends to the
 * account when there is one.
 *
 * Guests use it in exactly the same way. Their outbox simply waits, and is
 * sent on the day they sign in.
 *
 * The live contents belong to one owner at a time: a guest, or one account.
 * When an account's time on this browser ends, what it had not managed to
 * send is moved to a side shelf (`parked`) that only that account can ever
 * collect, and the live store starts again empty. That is what keeps one
 * person's typing out of the next person's account.
 *
 * Several tabs share this database. Nothing about it is cached in a tab:
 * the device id and the owner are read inside the same transaction as the
 * write that uses them.
 *
 * (Books themselves live in a separate database owned by the import code.)
 */

import type { Book, Position } from '../book/types';
import {
  FINGERPRINT,
  MAX_BOOK_ID_LENGTH,
  MAX_KEY_LENGTH,
  MAX_WORD_LENGTH,
  saveTag,
  type AheadPlace,
  type KeyCount,
  type OutboxEntry,
  type OutboxKind,
  type Parked,
  type ProgressRecord,
  type SessionRecord,
  type WordCount,
} from './types';

export const USER_DB_NAME = 'typeshelf-user';
const VERSION = 2;

const PROGRESS = 'progress';
const SESSIONS = 'sessions';
const KEYS = 'keyStats';
const WORDS = 'wordStats';
const OUTBOX = 'outbox';
const META = 'meta';
const PARKED = 'parked';
/** The live stores: everything that belongs to the current owner. */
const LIVE = [PROGRESS, SESSIONS, KEYS, WORDS, OUTBOX, META];
/** An offset smaller than this is a correct clock seen through network delay, not a clock that is off. */
const CLOCK_WOBBLE_MS = 5000;

/** Key presses to add to the counts for one key. */
export interface KeyDelta {
  key: string;
  hits?: number;
  misses?: number;
  /** Time spent on the correct presses being added. */
  ms?: number;
}

/** Attempts to add to the counts for one word. */
export interface WordDelta {
  word: string;
  hits?: number;
  misses?: number;
}

/** A session as the typing view reports it; the store adds the device. */
export type NewSession = Omit<SessionRecord, 'deviceId'>;

type Verdict = 'keep-local' | 'take-remote' | 'ask';

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function finished(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('The local save was aborted.'));
  });
}

/** A whole number of things, never negative: anything else counts as none. */
function tally(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

const wholeNumber = (value: unknown) => typeof value === 'number' && Number.isInteger(value) && value >= 0;
const amount = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0;

/**
 * Refuse a record the account's database would refuse. It is far better to
 * fail here, where the mistake was made, than to queue something that can
 * never be sent.
 */
function must(ok: boolean, what: string): void {
  if (!ok) throw new RangeError(`typeshelf: ${what}`);
}

export interface StoreOptions {
  /**
   * A stopwatch that only runs forward, in milliseconds, whatever happens
   * to the device's clock. The browser's `performance.now()` unless a test
   * supplies its own.
   */
  monotonic?: () => number;
}

export class UserStore {
  private readonly listeners = new Set<() => void>();
  /** What the account's time was at one reading of the stopwatch. Lives only as long as the page. */
  private anchor: { accountTime: number; at: number } | undefined;

  private constructor(
    private readonly db: IDBDatabase,
    private readonly monotonic: (() => number) | undefined,
  ) {}

  /** Open (and on first use create) the database. Tests pass their own factory. */
  static async open(factory: IDBFactory = indexedDB, options: StoreOptions = {}): Promise<UserStore> {
    const opening = factory.open(USER_DB_NAME, VERSION);
    opening.onupgradeneeded = () => {
      const db = opening.result;
      const add = (name: string, options?: IDBObjectStoreParameters) => {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, options);
      };
      add(PROGRESS, { keyPath: 'bookId' });
      add(SESSIONS, { keyPath: 'id' });
      add(KEYS, { keyPath: 'key' });
      add(WORDS, { keyPath: 'word' });
      add(OUTBOX, { keyPath: 'id' });
      add(META);
      add(PARKED, { keyPath: 'id', autoIncrement: true });
    };
    const db = await request(opening);
    // Another tab upgrading the database must not be blocked by this one.
    db.onversionchange = () => db.close();
    const stopwatch = options.monotonic ?? (typeof performance === 'undefined' ? undefined : () => performance.now());
    return new UserStore(db, stopwatch);
  }

  close(): void {
    this.db.close();
  }

  /** Be told after every local change that needs sending. Returns the way to stop. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private changed(): void {
    for (const listener of this.listeners) listener();
  }

  // ---- who and where --------------------------------------------------------

  /**
   * This browser's id, made up on first use. It is not tied to a person: it
   * only lets a device tell its own saves from another device's. It changes
   * whenever the store starts over (`clear`), in every tab at once.
   */
  async deviceId(): Promise<string> {
    const tx = this.db.transaction(META, 'readwrite');
    const id = await this.deviceIn(tx);
    await finished(tx);
    return id;
  }

  /** The device id, read (or made) inside a transaction that includes the meta store. */
  private async deviceIn(tx: IDBTransaction): Promise<string> {
    const meta = tx.objectStore(META);
    let id = (await request(meta.get('deviceId'))) as string | undefined;
    if (!id) {
      id = crypto.randomUUID();
      meta.put(id, 'deviceId');
    }
    return id;
  }

  /** The account this store's contents belong to, or null while they are a guest's. */
  async owner(): Promise<string | null> {
    return ((await this.meta('owner')) as string | undefined) ?? null;
  }

  async setOwner(userId: string | null): Promise<void> {
    const tx = this.db.transaction(META, 'readwrite');
    if (userId === null) tx.objectStore(META).delete('owner');
    else tx.objectStore(META).put(userId, 'owner');
    await finished(tx);
  }

  /**
   * Whether the store still belongs to `as`, checked inside the caller's
   * transaction (which must include the meta store). A sync passes its
   * account on every write, so one that is out of date (the account signed
   * out in another tab, or another account signed in) cannot touch what is
   * no longer its own. With no `as`, anyone may write.
   */
  private async ownedBy(tx: IDBTransaction, as: string | undefined): Promise<boolean> {
    if (as === undefined) return true;
    return (await request(tx.objectStore(META).get('owner'))) === as;
  }

  /** The account whose copy has been brought down and merged into this store at least once, or null. */
  async joinedAs(): Promise<string | null> {
    return ((await this.meta('joined')) as string | undefined) ?? null;
  }

  /** Note that the account's copy has been merged in. Does nothing if the store is not that account's. */
  async markJoined(userId: string): Promise<void> {
    const tx = this.db.transaction(META, 'readwrite');
    if (await this.ownedBy(tx, userId)) tx.objectStore(META).put(userId, 'joined');
    await finished(tx);
  }

  // ---- the device's clock ---------------------------------------------------

  // "Most recent save wins" only works if devices agree on the time. They do
  // not always: a clock can be an hour off. So saves are stamped in the
  // account's time: the device's clock plus an offset the sync measures
  // whenever it talks to the account. The offset is kept here so it also
  // holds while offline. It describes the device, not an account, and
  // outlives sign-outs.
  //
  // The offset alone is only right until the clock is changed again. So for
  // as long as the page stays open there is a second opinion: the account's
  // time at the last measurement plus what a stopwatch says has passed
  // since. A stopwatch does not jump when the clock is set. It can only fall
  // behind, because in many browsers it stops while the computer sleeps.
  // The time used is therefore the later of the two:
  //
  // - clock set back: the stopwatch is ahead of the clock, and right;
  // - computer slept: the clock is ahead of the stopwatch, and right;
  // - clock set forward: the clock is ahead, and wrong. From inside the page
  //   this looks exactly like sleep, so the clock is believed. The stamp is
  //   late, and the account pulls a stamp that is too far ahead back to its
  //   own time when the save is sent.
  //
  // After a reload there is no stopwatch reading to go by, and the clock
  // plus the last known offset is all there is.

  /** Milliseconds to add to this device's clock to get the account's time. 0 until measured. */
  async clockOffset(): Promise<number> {
    return ((await this.meta('clockOffset')) as number | undefined) ?? 0;
  }

  /**
   * The account's time now. Given a reading of this device's clock, that
   * reading corrected by the offset; given nothing, the best estimate there
   * is (see above).
   */
  async accountTime(deviceNow?: number): Promise<number> {
    const offset = await this.clockOffset();
    if (deviceNow !== undefined) return deviceNow + offset;
    return Math.max(Date.now() + offset, this.sinceAnchor() ?? -Infinity);
  }

  /** The account's time by the stopwatch, if a measurement was made since the page opened. */
  private sinceAnchor(): number | undefined {
    if (!this.anchor || !this.monotonic) return undefined;
    return Math.round(this.anchor.accountTime + (this.monotonic() - this.anchor.at));
  }

  private async offsetIn(tx: IDBTransaction): Promise<number> {
    return ((await request(tx.objectStore(META).get('clockOffset'))) as number | undefined) ?? 0;
  }

  /** The account's time now, for stamping a save inside a transaction that includes the meta store. */
  private async stampIn(tx: IDBTransaction): Promise<number> {
    return Math.max(Date.now() + (await this.offsetIn(tx)), this.sinceAnchor() ?? -Infinity);
  }

  /**
   * Record a fresh measurement of the offset.
   *
   * The very first measurement on a browser also corrects the saves still
   * waiting to be sent: they were stamped by a clock nobody had checked (a
   * guest who has never been in touch with an account), so if it turns out
   * to be off, they are off by the same amount. Saves the account already
   * has are left alone: it stored its own time for those.
   *
   * Later measurements never move a save. If the offset has changed, the
   * clock itself was changed at some point, and nothing says whether that
   * was before or after a waiting save was stamped. A save stamped with a
   * measured offset was right when it was made, so it is left as it is.
   *
   * @param deviceNow what this device's clock read when the measurement was made
   */
  async setClockOffset(offset: number, deviceNow: number = Date.now()): Promise<void> {
    if (!Number.isFinite(offset)) return;
    // Read now, used only once the measurement is stored: a save already under way must be
    // stamped the old way and then corrected with the others, not stamped the new way and corrected too.
    const anchor = this.monotonic ? { accountTime: deviceNow + offset, at: this.monotonic() } : undefined;
    const tx = this.db.transaction([META, OUTBOX, PROGRESS], 'readwrite');
    const meta = tx.objectStore(META);
    const measuredBefore = (await request(meta.get('clockOffset'))) !== undefined;
    const shift = offset;
    meta.put(offset, 'clockOffset');
    if (!measuredBefore && Math.abs(shift) > CLOCK_WOBBLE_MS) {
      const places = tx.objectStore(PROGRESS);
      for (const entry of (await request(tx.objectStore(OUTBOX).getAll())) as OutboxEntry[]) {
        if (entry.kind === 'progress') {
          const record = (await request(places.get(entry.ref))) as ProgressRecord | undefined;
          if (record) places.put({ ...record, updatedAt: record.updatedAt + shift });
        } else if (entry.kind === 'settings') {
          const at = (await request(meta.get('settingsAt'))) as number | undefined;
          if (at !== undefined) meta.put(at + shift, 'settingsAt');
        }
      }
    }
    await finished(tx);
    this.anchor = anchor;
  }

  private async meta(key: string): Promise<unknown> {
    return request(this.db.transaction(META).objectStore(META).get(key));
  }

  // ---- place in each book ---------------------------------------------------

  /**
   * Save the reader's place and queue it for the account.
   *
   * @param now the save time, in the account's time. Leave it out to use this device's clock, corrected.
   */
  async saveProgress(
    book: Pick<Book, 'id' | 'fingerprint'>,
    position: Position,
    now?: number,
  ): Promise<ProgressRecord> {
    must(typeof book.id === 'string' && book.id.length >= 1 && book.id.length <= MAX_BOOK_ID_LENGTH, 'a book id of 1 to 200 characters is needed');
    must(FINGERPRINT.test(book.fingerprint), 'a book fingerprint is 64 lowercase hex characters');
    must(
      wholeNumber(position.chapter) && wholeNumber(position.paragraph) && wholeNumber(position.char),
      'a position is made of whole numbers, none below zero',
    );
    must(now === undefined || Number.isFinite(now), 'a save needs a real time');

    const tx = this.db.transaction([PROGRESS, OUTBOX, META], 'readwrite');
    const deviceId = await this.deviceIn(tx);
    const stamp = now ?? (await this.stampIn(tx));
    const store = tx.objectStore(PROGRESS);
    const before = (await request(store.get(book.id))) as ProgressRecord | undefined;
    const record: ProgressRecord = {
      bookId: book.id,
      fingerprint: book.fingerprint,
      position: { chapter: position.chapter, paragraph: position.paragraph, char: position.char },
      // Never earlier than the save it replaces, even if the clock was set back.
      updatedAt: Math.max(stamp, before?.updatedAt ?? 0),
      deviceId,
    };
    // An unanswered "continue from there?" survives ordinary saves.
    if (before?.ahead) record.ahead = before.ahead;
    if (before?.declined) record.declined = before.declined;
    store.put(record);
    await this.queue(tx, 'progress', book.id);
    await finished(tx);
    this.changed();
    return record;
  }

  async progress(bookId: string): Promise<ProgressRecord | undefined> {
    return request(this.db.transaction(PROGRESS).objectStore(PROGRESS).get(bookId));
  }

  async allProgress(): Promise<ProgressRecord[]> {
    return request(this.db.transaction(PROGRESS).objectStore(PROGRESS).getAll());
  }

  /**
   * Weigh the account's copy of a place against this device's, and act on
   * the verdict in the same breath, so a save made at that very moment
   * cannot slip in between the look and the write.
   *
   * - `take-remote`: this device moves to the account's place. Nothing is
   *   queued, and a waiting local change to the book is dropped, because the
   *   account's copy has just won.
   * - `ask`: this device stays where it is and remembers the other place,
   *   so the reader can be asked when the book is opened. Until they have
   *   answered, this device's place is not sent (see `sendable`).
   * - `keep-local`: nothing changes.
   *
   * @param as the account doing the weighing; nothing happens if the store is no longer its own
   */
  async reconcileProgress(
    remote: ProgressRecord,
    decide: (local: ProgressRecord | undefined) => Verdict,
    as?: string,
  ): Promise<Verdict> {
    const tx = this.db.transaction([PROGRESS, OUTBOX, META], 'readwrite');
    if (!(await this.ownedBy(tx, as))) {
      await finished(tx);
      return 'keep-local';
    }
    const store = tx.objectStore(PROGRESS);
    const local = (await request(store.get(remote.bookId))) as ProgressRecord | undefined;
    const verdict = decide(local);
    if (verdict === 'take-remote') {
      const { ahead: _ahead, declined: _declined, ...clean } = remote;
      store.put(clean);
      tx.objectStore(OUTBOX).delete(`progress:${remote.bookId}`);
    } else if (verdict === 'ask' && local) {
      const ahead: AheadPlace = {
        position: remote.position,
        updatedAt: remote.updatedAt,
        deviceId: remote.deviceId,
      };
      store.put({ ...local, ahead });
    }
    await finished(tx);
    return verdict;
  }

  /**
   * Record the reader's answer to "continue from there?".
   *
   * Either way the result is saved as a brand new save and queued, so the
   * choice the reader just made is the most recent one everywhere.
   * Yes moves this device to the other place. No keeps this place and
   * remembers which save was turned down, so it is not asked about again.
   */
  async answerAhead(bookId: string, accept: boolean, now?: number): Promise<ProgressRecord | undefined> {
    const tx = this.db.transaction([PROGRESS, OUTBOX, META], 'readwrite');
    const deviceId = await this.deviceIn(tx);
    const stamp = now ?? (await this.stampIn(tx));
    const store = tx.objectStore(PROGRESS);
    const before = (await request(store.get(bookId))) as ProgressRecord | undefined;
    if (!before?.ahead) {
      await finished(tx);
      return before;
    }
    const { ahead, declined: _declined, ...rest } = before;
    const record: ProgressRecord = {
      ...rest,
      position: accept ? ahead.position : before.position,
      // Strictly later than both saves it settles, even on a slow clock.
      updatedAt: Math.max(stamp, before.updatedAt + 1, ahead.updatedAt + 1),
      deviceId,
    };
    if (!accept) record.declined = saveTag(ahead);
    store.put(record);
    await this.queue(tx, 'progress', bookId);
    await finished(tx);
    this.changed();
    return record;
  }

  /**
   * The account stored this save under a different time than the device
   * stamped it with (the device's clock runs fast, and the account pulled
   * the stamp back to its own clock). Take the account's time, so that
   * later saves from other devices are seen as later. Skipped if the place
   * has been saved again since.
   */
  async restampProgress(bookId: string, sentAt: number, storedAt: number, as?: string): Promise<void> {
    const tx = this.db.transaction([PROGRESS, META], 'readwrite');
    const store = tx.objectStore(PROGRESS);
    const record = (await request(store.get(bookId))) as ProgressRecord | undefined;
    if (record && record.updatedAt === sentAt && (await this.ownedBy(tx, as))) {
      store.put({ ...record, updatedAt: storedAt });
    }
    await finished(tx);
  }

  // ---- sessions -------------------------------------------------------------

  /** Record a finished sitting and queue it for the account. */
  async addSession(session: NewSession): Promise<SessionRecord> {
    must(typeof session.id === 'string' && session.id.length >= 1, 'a session needs an id');
    must(
      typeof session.bookId === 'string' && session.bookId.length >= 1 && session.bookId.length <= MAX_BOOK_ID_LENGTH,
      'a session needs a book id of 1 to 200 characters',
    );
    must(Number.isFinite(session.startedAt) && Number.isFinite(session.endedAt), 'a session needs real start and end times');
    must(session.endedAt >= session.startedAt, 'a session cannot end before it starts');
    must(amount(session.activeMs) && amount(session.words), 'typing time and words cannot be negative');
    must(amount(session.wpm), 'speed is a number, not below zero');
    must(amount(session.accuracy) && session.accuracy <= 1, 'accuracy is between 0 and 1');

    const tx = this.db.transaction([SESSIONS, OUTBOX, META], 'readwrite');
    const record: SessionRecord = { ...session, deviceId: await this.deviceIn(tx) };
    tx.objectStore(SESSIONS).put(record);
    await this.queue(tx, 'session', record.id);
    await finished(tx);
    this.changed();
    return record;
  }

  async session(id: string): Promise<SessionRecord | undefined> {
    return request(this.db.transaction(SESSIONS).objectStore(SESSIONS).get(id));
  }

  async sessions(): Promise<SessionRecord[]> {
    return request(this.db.transaction(SESSIONS).objectStore(SESSIONS).getAll());
  }

  // ---- weak-key counts ------------------------------------------------------

  /**
   * Add key presses and word attempts to this device's running totals.
   * Only totals are kept: what was typed, and in what order, is not.
   */
  async addCounts(delta: { keys?: readonly KeyDelta[]; words?: readonly WordDelta[] }): Promise<void> {
    const keys = (delta.keys ?? []).filter((item) => item.key.length >= 1 && item.key.length <= MAX_KEY_LENGTH);
    const words = (delta.words ?? []).filter((item) => item.word.length >= 1 && item.word.length <= MAX_WORD_LENGTH);
    if (keys.length === 0 && words.length === 0) return;

    const tx = this.db.transaction([KEYS, WORDS, OUTBOX, META], 'readwrite');
    const keyStore = tx.objectStore(KEYS);
    for (const item of keys) {
      const count = ((await request(keyStore.get(item.key))) as KeyCount | undefined) ?? {
        key: item.key,
        hits: 0,
        misses: 0,
        totalMs: 0,
      };
      count.hits += tally(item.hits);
      count.misses += tally(item.misses);
      count.totalMs += tally(item.ms);
      keyStore.put(count);
      await this.queue(tx, 'key', item.key);
    }
    const wordStore = tx.objectStore(WORDS);
    for (const item of words) {
      const count = ((await request(wordStore.get(item.word))) as WordCount | undefined) ?? {
        word: item.word,
        hits: 0,
        misses: 0,
      };
      count.hits += tally(item.hits);
      count.misses += tally(item.misses);
      wordStore.put(count);
      await this.queue(tx, 'word', item.word);
    }
    await finished(tx);
    this.changed();
  }

  async keyCount(key: string): Promise<KeyCount | undefined> {
    return request(this.db.transaction(KEYS).objectStore(KEYS).get(key));
  }

  async keyCounts(): Promise<KeyCount[]> {
    return request(this.db.transaction(KEYS).objectStore(KEYS).getAll());
  }

  async wordCount(word: string): Promise<WordCount | undefined> {
    return request(this.db.transaction(WORDS).objectStore(WORDS).get(word));
  }

  async wordCounts(): Promise<WordCount[]> {
    return request(this.db.transaction(WORDS).objectStore(WORDS).getAll());
  }

  // ---- settings -------------------------------------------------------------

  // The settings themselves stay in localStorage, where the page can read
  // them before anything else loads. The store only keeps when they last
  // changed, and queues them for the account.

  /**
   * Note that the settings changed on this device and queue them.
   *
   * @param as the account noting it; nothing happens if the store is no longer its own
   */
  async markSettingsChanged(now?: number, as?: string): Promise<void> {
    const tx = this.db.transaction([OUTBOX, META], 'readwrite');
    const mine = await this.ownedBy(tx, as);
    if (mine) {
      tx.objectStore(META).put(now ?? (await this.stampIn(tx)), 'settingsAt');
      await this.queue(tx, 'settings', '');
    }
    await finished(tx);
    if (mine) this.changed();
  }

  /** When the settings last changed, or undefined if they never have on this device. */
  async settingsChangedAt(): Promise<number | undefined> {
    return (await this.meta('settingsAt')) as number | undefined;
  }

  /** The settings now match the account's copy from this moment: nothing to send. */
  async adoptSettings(updatedAt: number, as?: string): Promise<void> {
    const tx = this.db.transaction([OUTBOX, META], 'readwrite');
    if (await this.ownedBy(tx, as)) {
      tx.objectStore(META).put(updatedAt, 'settingsAt');
      tx.objectStore(OUTBOX).delete('settings:');
    }
    await finished(tx);
  }

  /** As `restampProgress`, for the settings: take the time the account stored them under. */
  async restampSettings(sentAt: number, storedAt: number, as?: string): Promise<void> {
    const tx = this.db.transaction(META, 'readwrite');
    const meta = tx.objectStore(META);
    if ((await request(meta.get('settingsAt'))) === sentAt && (await this.ownedBy(tx, as))) {
      meta.put(storedAt, 'settingsAt');
    }
    await finished(tx);
  }

  // ---- outbox ---------------------------------------------------------------

  private async queue(tx: IDBTransaction, kind: OutboxKind, ref: string): Promise<void> {
    const meta = tx.objectStore(META);
    const seq = (((await request(meta.get('seq'))) as number | undefined) ?? 0) + 1;
    meta.put(seq, 'seq');
    const entry: OutboxEntry = { id: `${kind}:${ref}`, kind, ref, seq };
    tx.objectStore(OUTBOX).put(entry);
  }

  /** Everything waiting to be sent, oldest change first. */
  async pending(): Promise<OutboxEntry[]> {
    const entries = (await request(this.db.transaction(OUTBOX).objectStore(OUTBOX).getAll())) as OutboxEntry[];
    return entries.sort((a, b) => a.seq - b.seq);
  }

  async pendingCount(): Promise<number> {
    return request(this.db.transaction(OUTBOX).objectStore(OUTBOX).count());
  }

  /**
   * What may be sent right now, oldest change first: everything waiting,
   * except a place with an unanswered "continue from there?". Sending that
   * place could overwrite the further-on one in the account before the
   * reader has chosen between them.
   */
  async sendable(): Promise<OutboxEntry[]> {
    const tx = this.db.transaction([OUTBOX, PROGRESS]);
    const entries = (await request(tx.objectStore(OUTBOX).getAll())) as OutboxEntry[];
    const places = tx.objectStore(PROGRESS);
    const free: OutboxEntry[] = [];
    for (const entry of entries) {
      if (entry.kind === 'progress') {
        const record = (await request(places.get(entry.ref))) as ProgressRecord | undefined;
        if (record?.ahead) continue;
      }
      free.push(entry);
    }
    return free.sort((a, b) => a.seq - b.seq);
  }

  /**
   * Cross off entries that were sent. An entry that changed again while it
   * was being sent stays, so the newer change goes out next time.
   *
   * @param as the account that sent them; nothing happens if the store is no longer its own
   */
  async acknowledge(sent: readonly OutboxEntry[], as?: string): Promise<void> {
    if (sent.length === 0) return;
    const tx = this.db.transaction([OUTBOX, META], 'readwrite');
    if (await this.ownedBy(tx, as)) {
      const store = tx.objectStore(OUTBOX);
      for (const entry of sent) {
        const current = (await request(store.get(entry.id))) as OutboxEntry | undefined;
        if (current && current.seq === entry.seq) store.delete(entry.id);
      }
    }
    await finished(tx);
  }

  // ---- an account's time here ending ----------------------------------------

  /**
   * Call when an account stops being signed in on this browser, however
   * that happened: a sign-out, an expired session, or another account
   * signing in.
   *
   * What the account had not managed to send is moved to the side shelf,
   * where only that account can collect it (`parkedFor`). Then the live
   * store is emptied, device id included, so whoever types next starts as a
   * clean guest and nothing of the account's can be merged into someone
   * else's.
   *
   * Does nothing when the store is a guest's: there is no account to end.
   *
   * @param settingsData the settings as they are now, kept in case they were waiting to be sent
   * @returns whether there was an account session to end
   */
  async endAccountSession(settingsData: unknown): Promise<boolean> {
    const tx = this.db.transaction([...LIVE, PARKED], 'readwrite');
    const meta = tx.objectStore(META);
    const userId = (await request(meta.get('owner'))) as string | undefined;
    if (userId === undefined) {
      await finished(tx);
      return false;
    }

    const entries = (await request(tx.objectStore(OUTBOX).getAll())) as OutboxEntry[];
    const places = (await request(tx.objectStore(PROGRESS).getAll())) as ProgressRecord[];
    const parked: Parked = {
      userId,
      deviceId: await this.deviceIn(tx),
      progress: [],
      // An open question is kept whether or not the place was waiting to be sent.
      held: places.filter((record) => record.ahead),
      sessions: [],
      keys: [],
      words: [],
    };
    for (const entry of entries) {
      if (entry.kind === 'progress') {
        const record = places.find((place) => place.bookId === entry.ref);
        if (record && !record.ahead) parked.progress.push(record);
      } else if (entry.kind === 'session') {
        const record = (await request(tx.objectStore(SESSIONS).get(entry.ref))) as SessionRecord | undefined;
        if (record) parked.sessions.push(record);
      } else if (entry.kind === 'key') {
        const record = (await request(tx.objectStore(KEYS).get(entry.ref))) as KeyCount | undefined;
        if (record) parked.keys.push(record);
      } else if (entry.kind === 'word') {
        const record = (await request(tx.objectStore(WORDS).get(entry.ref))) as WordCount | undefined;
        if (record) parked.words.push(record);
      } else {
        const updatedAt = (await request(meta.get('settingsAt'))) as number | undefined;
        if (updatedAt !== undefined) parked.settings = { data: settingsData, updatedAt };
      }
    }
    const anything =
      parked.progress.length + parked.held.length + parked.sessions.length + parked.keys.length + parked.words.length >
        0 || parked.settings !== undefined;
    if (anything) tx.objectStore(PARKED).add(parked);
    await this.empty(tx);
    await finished(tx);
    return true;
  }

  /** What this account left unsent on earlier visits to this browser. */
  async parkedFor(userId: string): Promise<Parked[]> {
    const all = (await request(this.db.transaction(PARKED).objectStore(PARKED).getAll())) as Parked[];
    return all.filter((parked) => parked.userId === userId);
  }

  /** Replace a parked bundle with what is left of it, or remove it when nothing is. */
  async updateParked(parked: Parked): Promise<void> {
    const tx = this.db.transaction(PARKED, 'readwrite');
    const left =
      parked.progress.length + parked.held.length + parked.sessions.length + parked.keys.length + parked.words.length >
        0 || parked.settings !== undefined;
    if (left) tx.objectStore(PARKED).put(parked);
    else if (parked.id !== undefined) tx.objectStore(PARKED).delete(parked.id);
    await finished(tx);
  }

  /**
   * Put a place with an unanswered "continue from there?" back into the
   * live store, so the reader is still asked. If the store has a place for
   * the book already (typed since), that one stands and this one is dropped.
   *
   * @param as the account it belongs to; nothing happens if the store is not its own
   */
  async restoreHeld(record: ProgressRecord, as: string): Promise<void> {
    const tx = this.db.transaction([PROGRESS, OUTBOX, META], 'readwrite');
    if (await this.ownedBy(tx, as)) {
      const store = tx.objectStore(PROGRESS);
      if ((await request(store.get(record.bookId))) === undefined) {
        store.put({ ...record, deviceId: await this.deviceIn(tx) });
        await this.queue(tx, 'progress', record.bookId);
      }
    }
    await finished(tx);
  }

  // ---- starting over --------------------------------------------------------

  /**
   * Forget everything in the live store, including the device id and
   * whatever was waiting to be sent. Prefer `endAccountSession`, which
   * keeps what an account had not sent.
   *
   * The device id has to change with it: the account keeps per-device count
   * totals, and a device that started again from zero under its old id would
   * overwrite its own earlier totals with smaller ones.
   */
  async clear(): Promise<void> {
    const tx = this.db.transaction(LIVE, 'readwrite');
    await this.empty(tx);
    await finished(tx);
  }

  /** Empty the live stores. What is known about the device's clock is kept: it is not anyone's data. */
  private async empty(tx: IDBTransaction): Promise<void> {
    const offset = (await request(tx.objectStore(META).get('clockOffset'))) as number | undefined;
    for (const name of LIVE) tx.objectStore(name).clear();
    if (offset !== undefined) tx.objectStore(META).put(offset, 'clockOffset');
  }
}
