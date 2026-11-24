/**
 * The local store: one IndexedDB database, `typeshelf-user`, that the app
 * always writes to first. Typing never waits on the network; whatever is
 * written here is also noted in an outbox, which the sync sends to the
 * account when there is one.
 *
 * Guests use it in exactly the same way. Their outbox simply waits, and is
 * sent on the day they sign in.
 *
 * (Books themselves live in a separate database owned by the import code.)
 */

import type { Book, Position } from '../book/types';
import {
  MAX_KEY_LENGTH,
  MAX_WORD_LENGTH,
  type AheadPlace,
  type KeyCount,
  type OutboxEntry,
  type OutboxKind,
  type ProgressRecord,
  type SessionRecord,
  type WordCount,
} from './types';

export const USER_DB_NAME = 'typeshelf-user';
const VERSION = 1;

const PROGRESS = 'progress';
const SESSIONS = 'sessions';
const KEYS = 'keyStats';
const WORDS = 'wordStats';
const OUTBOX = 'outbox';
const META = 'meta';
const ALL = [PROGRESS, SESSIONS, KEYS, WORDS, OUTBOX, META];

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

function newId(): string {
  return crypto.randomUUID();
}

export class UserStore {
  private readonly listeners = new Set<() => void>();
  private device: string | undefined;

  private constructor(private readonly db: IDBDatabase) {}

  /** Open (and on first use create) the database. Tests pass their own factory. */
  static async open(factory: IDBFactory = indexedDB): Promise<UserStore> {
    const opening = factory.open(USER_DB_NAME, VERSION);
    opening.onupgradeneeded = () => {
      const db = opening.result;
      db.createObjectStore(PROGRESS, { keyPath: 'bookId' });
      db.createObjectStore(SESSIONS, { keyPath: 'id' });
      db.createObjectStore(KEYS, { keyPath: 'key' });
      db.createObjectStore(WORDS, { keyPath: 'word' });
      db.createObjectStore(OUTBOX, { keyPath: 'id' });
      db.createObjectStore(META);
    };
    const db = await request(opening);
    // Another tab upgrading the database must not be blocked by this one.
    db.onversionchange = () => db.close();
    return new UserStore(db);
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
   * only lets a device tell its own saves from another device's.
   */
  async deviceId(): Promise<string> {
    if (this.device) return this.device;
    const tx = this.db.transaction(META, 'readwrite');
    const store = tx.objectStore(META);
    let id = (await request(store.get('deviceId'))) as string | undefined;
    if (!id) {
      id = newId();
      store.put(id, 'deviceId');
    }
    await finished(tx);
    this.device = id;
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

  private async meta(key: string): Promise<unknown> {
    return request(this.db.transaction(META).objectStore(META).get(key));
  }

  // ---- place in each book ---------------------------------------------------

  /** Save the reader's place and queue it for the account. */
  async saveProgress(
    book: Pick<Book, 'id' | 'fingerprint'>,
    position: Position,
    now: number = Date.now(),
  ): Promise<ProgressRecord> {
    const deviceId = await this.deviceId();
    const tx = this.db.transaction([PROGRESS, OUTBOX, META], 'readwrite');
    const store = tx.objectStore(PROGRESS);
    const before = (await request(store.get(book.id))) as ProgressRecord | undefined;
    const record: ProgressRecord = {
      bookId: book.id,
      fingerprint: book.fingerprint,
      position: { chapter: position.chapter, paragraph: position.paragraph, char: position.char },
      // Never earlier than the save it replaces, even if the clock was set back.
      updatedAt: Math.max(now, before?.updatedAt ?? 0),
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
   * Take a place that came from the account as it is. Nothing is queued, and
   * a waiting local change to the same book is dropped, because the account
   * already has this.
   */
  async adoptProgress(record: ProgressRecord): Promise<void> {
    const tx = this.db.transaction([PROGRESS, OUTBOX], 'readwrite');
    const { ahead: _ahead, declined: _declined, ...clean } = record;
    tx.objectStore(PROGRESS).put(clean);
    tx.objectStore(OUTBOX).delete(`progress:${record.bookId}`);
    await finished(tx);
  }

  /** Remember (or forget) that another device is further on in this book. */
  async setAhead(bookId: string, ahead: AheadPlace | undefined): Promise<void> {
    await this.patchProgress(bookId, (record) => {
      if (ahead) record.ahead = ahead;
      else delete record.ahead;
    });
  }

  /** Remember that the reader said no to another device's save. */
  async setDeclined(bookId: string, declined: string): Promise<void> {
    await this.patchProgress(bookId, (record) => {
      record.declined = declined;
      delete record.ahead;
    });
  }

  private async patchProgress(bookId: string, patch: (record: ProgressRecord) => void): Promise<void> {
    const tx = this.db.transaction(PROGRESS, 'readwrite');
    const store = tx.objectStore(PROGRESS);
    const record = (await request(store.get(bookId))) as ProgressRecord | undefined;
    if (record) {
      patch(record);
      store.put(record);
    }
    await finished(tx);
  }

  // ---- sessions -------------------------------------------------------------

  /** Record a finished sitting and queue it for the account. */
  async addSession(session: NewSession): Promise<SessionRecord> {
    const deviceId = await this.deviceId();
    const record: SessionRecord = { ...session, deviceId };
    const tx = this.db.transaction([SESSIONS, OUTBOX, META], 'readwrite');
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
      count.hits += Math.max(0, item.hits ?? 0);
      count.misses += Math.max(0, item.misses ?? 0);
      count.totalMs += Math.max(0, Math.round(item.ms ?? 0));
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
      count.hits += Math.max(0, item.hits ?? 0);
      count.misses += Math.max(0, item.misses ?? 0);
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

  /** Note that the settings changed on this device and queue them. */
  async markSettingsChanged(now: number = Date.now()): Promise<void> {
    const tx = this.db.transaction([OUTBOX, META], 'readwrite');
    tx.objectStore(META).put(now, 'settingsAt');
    await this.queue(tx, 'settings', '');
    await finished(tx);
    this.changed();
  }

  /** When the settings last changed, or undefined if they never have on this device. */
  async settingsChangedAt(): Promise<number | undefined> {
    return (await this.meta('settingsAt')) as number | undefined;
  }

  /** The settings now match the account's copy from this moment: nothing to send. */
  async adoptSettings(updatedAt: number): Promise<void> {
    const tx = this.db.transaction([OUTBOX, META], 'readwrite');
    tx.objectStore(META).put(updatedAt, 'settingsAt');
    tx.objectStore(OUTBOX).delete('settings:');
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
   * Cross off entries that were sent. An entry that changed again while it
   * was being sent stays, so the newer change goes out next time.
   */
  async acknowledge(sent: readonly OutboxEntry[]): Promise<void> {
    if (sent.length === 0) return;
    const tx = this.db.transaction(OUTBOX, 'readwrite');
    const store = tx.objectStore(OUTBOX);
    for (const entry of sent) {
      const current = (await request(store.get(entry.id))) as OutboxEntry | undefined;
      if (current && current.seq === entry.seq) store.delete(entry.id);
    }
    await finished(tx);
  }

  // ---- starting over --------------------------------------------------------

  /**
   * Forget everything, including the device id. Used when a different
   * account signs in on this browser, and after a clean sign-out.
   *
   * The device id has to change with it: the account keeps per-device count
   * totals, and a device that started again from zero under its old id would
   * overwrite its own earlier totals with smaller ones.
   */
  async clear(): Promise<void> {
    const tx = this.db.transaction(ALL, 'readwrite');
    for (const name of ALL) tx.objectStore(name).clear();
    await finished(tx);
    this.device = undefined;
  }
}
