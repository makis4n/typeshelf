/**
 * Scenarios found by review: each one used to lose data, leak it to another
 * account, or stall the queue. They share one browser (one local store)
 * between several sign-ins, or one account between several tabs.
 */

import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import type { Position } from '../book/types';
import type { NewSession } from '../store/userStore';
import { UserStore } from '../store/userStore';
import { FakeRemote } from './fakeRemote';
import { Sync } from './sync';

const at = (chapter: number, paragraph = 0, char = 0): Position => ({ chapter, paragraph, char });
const book = (id: string) => ({ id, fingerprint: 'a'.repeat(64) });
const BOOK = book('book-1');

const session = (id: string, overrides: Partial<NewSession> = {}): NewSession => ({
  id,
  bookId: BOOK.id,
  startedAt: 1000,
  endedAt: 2000,
  activeMs: 900,
  words: 12,
  wpm: 48,
  accuracy: 0.95,
  ...overrides,
});

/** A sign-in on a browser: a sync for one account over the browser's store. Timers never fire by themselves. */
function signIn(store: UserStore, remote: FakeRemote, userId: string, clock = { time: 1000 }) {
  const page = { settings: { caretStyle: 'line' } as unknown };
  const sync = new Sync({
    store,
    remote,
    userId,
    settings: { read: () => page.settings, apply: (data) => (page.settings = data) },
    now: () => clock.time,
    timers: { set: () => 0, clear: () => {} },
  });
  return { sync, page, clock };
}

describe('two accounts, one browser', () => {
  it("never sends one account's typing to the next account, even if the first never got through (F2)", async () => {
    const store = await UserStore.open(new IDBFactory());
    const accountA = new FakeRemote();
    const accountB = new FakeRemote();

    // A signs in on a bad connection: nothing gets through, but A types.
    accountA.offline = true;
    const a = signIn(store, accountA, 'user-a');
    await a.sync.start();
    await store.saveProgress(BOOK, at(4), 100);
    await store.addSession(session('s-a'));
    await store.addCounts({ keys: [{ key: 'e', hits: 9 }], words: [{ word: 'truth', misses: 1 }] });
    await a.sync.flushNow();
    a.sync.stop();

    // B signs in on the same browser.
    const b = signIn(store, accountB, 'user-b');
    await b.sync.start();
    await b.sync.flushNow();
    expect(accountB.progress.size).toBe(0);
    expect(accountB.sessions.size).toBe(0);
    expect(accountB.totalForKey('e').hits).toBe(0);
    expect(accountB.totalForWord('truth').misses).toBe(0);
    expect(await store.progress(BOOK.id)).toBeUndefined();
    b.sync.stop();

    // A's typing was not thrown away: it goes up when A is back, with a connection.
    accountA.offline = false;
    const again = signIn(store, accountA, 'user-a');
    await again.sync.start();
    expect(accountA.progress.get(BOOK.id)?.position).toEqual(at(4));
    expect(accountA.sessions.has('s-a')).toBe(true);
    expect(accountA.totalForKey('e').hits).toBe(9);
    expect(accountA.totalForWord('truth').misses).toBe(1);
    // And still nothing of it in B's account.
    expect(accountB.progress.size).toBe(0);
  });

  it('a sync that was stopped mid-round cannot claim the browser back for its account (F2)', async () => {
    const store = await UserStore.open(new IDBFactory());
    const accountA = new FakeRemote();
    const accountB = new FakeRemote();
    accountA.progress.set(BOOK.id, { bookId: BOOK.id, fingerprint: BOOK.fingerprint, position: at(7), updatedAt: 50, deviceId: 'a-phone' });

    // A's first round is held in flight while A signs out and B signs in.
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const pull = accountA.pullProgress.bind(accountA);
    accountA.pullProgress = async () => {
      const rows = await pull();
      await held;
      return rows;
    };
    const a = signIn(store, accountA, 'user-a');
    const starting = a.sync.start();
    await new Promise((resolve) => setTimeout(resolve, 0));
    a.sync.stop();

    const b = signIn(store, accountB, 'user-b');
    await b.sync.start();
    release();
    await starting;

    expect(await store.owner()).toBe('user-b');
    // A's place did not land in the store B is now using.
    expect(await store.progress(BOOK.id)).toBeUndefined();
    await store.saveProgress(book('book-2'), at(1), 200);
    await b.sync.flushNow();
    expect([...accountB.progress.keys()]).toEqual(['book-2']);
  });

  it('keeps a guest’s typing for the account that signs in, after another account’s session ended badly (F8)', async () => {
    const store = await UserStore.open(new IDBFactory());
    const accountX = new FakeRemote();
    const accountY = new FakeRemote();

    // X is signed in and has one change that could not be sent when the session ends.
    const x = signIn(store, accountX, 'user-x');
    await x.sync.start();
    accountX.offline = true;
    await store.saveProgress(BOOK, at(3), 100);
    await x.sync.flushNow();
    x.sync.stop();
    // The session is over (expired, or signed out offline): the page says so.
    await store.endAccountSession({ caretStyle: 'line' });

    // Someone types as a guest, then signs in as Y.
    const guestBook = book('book-guest');
    await store.saveProgress(guestBook, at(2, 5, 9), 200);
    await store.addCounts({ keys: [{ key: 'q', hits: 3 }] });
    const y = signIn(store, accountY, 'user-y');
    await y.sync.start();

    // The guest's typing is Y's now, and is still on the browser.
    expect(accountY.progress.get(guestBook.id)?.position).toEqual(at(2, 5, 9));
    expect(accountY.totalForKey('q').hits).toBe(3);
    expect((await store.progress(guestBook.id))?.position).toEqual(at(2, 5, 9));
    // X's unsent change did not reach Y.
    expect(accountY.progress.has(BOOK.id)).toBe(false);
    y.sync.stop();

    // X's unsent change was kept, and goes up when X is back. The guest's typing does not go to X.
    accountX.offline = false;
    const back = signIn(store, accountX, 'user-x');
    await back.sync.start();
    expect(accountX.progress.get(BOOK.id)?.position).toEqual(at(3));
    expect(accountX.progress.has(guestBook.id)).toBe(false);
    expect(accountX.totalForKey('q').hits).toBe(0);
  });

  it('forgets a finished session with nothing unsent, leaving a clean guest', async () => {
    const store = await UserStore.open(new IDBFactory());
    const account = new FakeRemote();
    const x = signIn(store, account, 'user-x');
    await x.sync.start();
    await store.saveProgress(BOOK, at(3), 100);
    await x.sync.flushNow();
    const device = await store.deviceId();
    x.sync.stop();
    await store.endAccountSession({});

    expect(await store.owner()).toBeNull();
    expect(await store.allProgress()).toEqual([]);
    expect(await store.deviceId()).not.toBe(device);
    expect(await store.parkedFor('user-x')).toEqual([]);
  });

  it('leaves a guest’s own typing alone when there was no account session to end', async () => {
    const store = await UserStore.open(new IDBFactory());
    await store.saveProgress(BOOK, at(3), 100);
    await store.endAccountSession({});
    expect((await store.progress(BOOK.id))?.position).toEqual(at(3));
    expect(await store.pendingCount()).toBe(1);
  });
});

describe('taking the browser over', () => {
  it('does not wait for the network, so a sign-out is never queued behind a slow first round', async () => {
    const store = await UserStore.open(new IDBFactory());
    const account = new FakeRemote();
    let release!: () => void;
    const slow = new Promise<void>((resolve) => (release = resolve));
    const pull = account.pullProgress.bind(account);
    account.pullProgress = async () => {
      await slow;
      return pull();
    };
    const { sync } = signIn(store, account, 'user-x');

    const { firstRound } = await sync.begin();
    // Already the account's, with the first round still out.
    expect(await store.owner()).toBe('user-x');
    expect(await store.joinedAs()).toBeNull();
    release();
    await firstRound;
    expect(await store.joinedAs()).toBe('user-x');
  });
});

describe('one account, two tabs', () => {
  it('both tabs use the new device id after one of them starts the browser over (F6)', async () => {
    const browser = new IDBFactory();
    const tabA = await UserStore.open(browser);
    const tabB = await UserStore.open(browser);
    const before = await tabB.deviceId();
    expect(await tabA.deviceId()).toBe(before);

    await tabA.clear();
    const after = await tabA.deviceId();
    expect(after).not.toBe(before);
    expect(await tabB.deviceId()).toBe(after);
    expect((await tabB.saveProgress(BOOK, at(1), 100)).deviceId).toBe(after);
    expect((await tabB.addSession(session('s1'))).deviceId).toBe(after);
  });

  it('a tab that slept through a sign-out and sign-in does not overwrite the account’s count totals (F6)', async () => {
    const browser = new IDBFactory();
    const account = new FakeRemote();
    const tabA = await UserStore.open(browser);
    const tabB = await UserStore.open(browser);

    const a = signIn(tabA, account, 'user-x');
    await a.sync.start();
    const b = signIn(tabB, account, 'user-x');
    await b.sync.start();
    await tabA.addCounts({ keys: [{ key: 'e', hits: 100 }] });
    await a.sync.flushNow();
    expect(account.totalForKey('e').hits).toBe(100);

    // Tab A signs out cleanly and in again; tab B just sits there with its sync running.
    a.sync.stop();
    await tabA.endAccountSession({});
    const a2 = signIn(tabA, account, 'user-x');
    await a2.sync.start();
    await tabB.addCounts({ keys: [{ key: 'e', hits: 3 }] });
    await b.sync.flushNow();
    await a2.sync.flushNow();

    // 100 from before the sign-out plus 3 after: nothing overwritten, nothing counted twice.
    expect(account.totalForKey('e').hits).toBe(103);
  });
});

describe('a row the account will not take', () => {
  it('is refused by the local store before it is ever queued (F7)', async () => {
    const store = await UserStore.open(new IDBFactory());
    await expect(store.addSession(session('s1', { endedAt: 500 }))).rejects.toThrow(RangeError);
    await expect(store.addSession(session('s2', { wpm: Number.NaN }))).rejects.toThrow(RangeError);
    await expect(store.addSession(session('s3', { accuracy: 1.5 }))).rejects.toThrow(RangeError);
    await expect(store.addSession(session('s4', { startedAt: Number.NaN }))).rejects.toThrow(RangeError);
    await expect(store.addSession(session('s5', { activeMs: -1 }))).rejects.toThrow(RangeError);
    await expect(store.saveProgress({ id: 'book', fingerprint: 'not-a-hash' }, at(1))).rejects.toThrow(RangeError);
    await expect(store.saveProgress(BOOK, at(-1))).rejects.toThrow(RangeError);
    await expect(store.saveProgress(BOOK, at(1.5))).rejects.toThrow(RangeError);
    await expect(store.saveProgress(BOOK, at(1), Number.NaN)).rejects.toThrow(RangeError);
    expect(await store.pendingCount()).toBe(0);
    expect(await store.sessions()).toEqual([]);
  });

  it('is set aside by the sync, and everything else still goes out (F7)', async () => {
    const store = await UserStore.open(new IDBFactory());
    const account = new FakeRemote();
    // The account has a rule the device does not know about, and one session breaks it.
    account.refuses = (row) => (row as { id?: string }).id === 's-bad';
    const { sync } = signIn(store, account, 'user-x');
    await sync.start();

    await store.addSession(session('s-good-1'));
    await store.addSession(session('s-bad'));
    await store.addSession(session('s-good-2'));
    await store.addCounts({ keys: [{ key: 'e', hits: 5 }], words: [{ word: 'truth', hits: 1 }] });
    await sync.flushNow();

    expect([...account.sessions.keys()].sort()).toEqual(['s-good-1', 's-good-2']);
    expect(account.totalForKey('e').hits).toBe(5);
    expect(account.totalForWord('truth').hits).toBe(1);
    expect(sync.current()).toBe('synced');
    expect(await store.pendingCount()).toBe(0);
    // Set aside, not deleted: it is still on this device, and the sync can say what it could not send.
    expect(await store.session('s-bad')).toBeDefined();
    expect(sync.setAside.map((entry) => entry.id)).toEqual(['session:s-bad']);

    // It is not tried again round after round.
    const calls = account.count('pushSessions');
    await sync.flushNow();
    expect(account.count('pushSessions')).toBe(calls);
  });

  it('does not set anything aside for a failed connection', async () => {
    const store = await UserStore.open(new IDBFactory());
    const account = new FakeRemote();
    const { sync } = signIn(store, account, 'user-x');
    await sync.start();
    account.offline = true;
    await store.addSession(session('s1'));
    await sync.flushNow();
    expect(sync.setAside).toEqual([]);
    expect(await store.pendingCount()).toBe(1);
  });
});

describe('another device is further on, and this device has a newer save waiting', () => {
  /** The account is at chapter 10 (saved at t=100 by a phone); this browser has a newer, unsent save at chapter 1. */
  async function setup() {
    const store = await UserStore.open(new IDBFactory());
    const account = new FakeRemote();
    account.progress.set(BOOK.id, {
      bookId: BOOK.id,
      fingerprint: BOOK.fingerprint,
      position: at(10),
      updatedAt: 100,
      deviceId: 'phone',
    });
    await store.saveProgress(BOOK, at(1), 500);
    const signedIn = signIn(store, account, 'user-x', { time: 1000 });
    await signedIn.sync.start();
    return { store, account, ...signedIn };
  }

  it('does not overwrite the further-on place before the reader has answered (F11)', async () => {
    const { store, account, sync } = await setup();
    expect((await sync.aheadFor(BOOK.id))?.there.position).toEqual(at(10));
    expect(account.progress.get(BOOK.id)).toMatchObject({ position: at(10), deviceId: 'phone' });

    // Not on later rounds either, and not when the reader types on without answering.
    await store.saveProgress(BOOK, at(1, 0, 20), 600);
    await sync.flushNow();
    await sync.refresh();
    expect(account.progress.get(BOOK.id)).toMatchObject({ position: at(10), deviceId: 'phone' });
    expect((await store.progress(BOOK.id))?.position).toEqual(at(1, 0, 20));
    // The held save does not keep the sync busy.
    expect(sync.current()).toBe('synced');
  });

  it('still sends everything else while the question is open', async () => {
    const { store, account, sync } = await setup();
    await store.saveProgress(book('book-2'), at(2), 700);
    await store.addCounts({ keys: [{ key: 'e', hits: 5 }] });
    await sync.flushNow();
    expect(account.progress.get('book-2')?.position).toEqual(at(2));
    expect(account.totalForKey('e').hits).toBe(5);
    expect(account.progress.get(BOOK.id)?.position).toEqual(at(10));
  });

  it('sends the answer either way once it is given', async () => {
    const stay = await setup();
    await stay.sync.answerAhead(BOOK.id, false);
    await stay.sync.flushNow();
    expect(stay.account.progress.get(BOOK.id)?.position).toEqual(at(1));

    const go = await setup();
    expect(await go.sync.answerAhead(BOOK.id, true)).toEqual(at(10));
    await go.sync.flushNow();
    expect(go.account.progress.get(BOOK.id)).toMatchObject({ position: at(10), deviceId: await go.store.deviceId() });
  });

  it('keeps the question through a sign-out and back in', async () => {
    const { store, account, sync } = await setup();
    sync.stop();
    await store.endAccountSession({});
    expect(await store.progress(BOOK.id)).toBeUndefined();

    const back = signIn(store, account, 'user-x');
    await back.sync.start();
    // The account still has the further-on place, this browser still has its own, and the question is still open.
    expect(account.progress.get(BOOK.id)?.position).toEqual(at(10));
    expect((await store.progress(BOOK.id))?.position).toEqual(at(1));
    expect((await back.sync.aheadFor(BOOK.id))?.there.position).toEqual(at(10));
  });
});

describe('a device whose clock runs fast', () => {
  const HOUR = 3_600_000;

  it('does not ignore newer saves from other devices (F9)', async () => {
    const real = { time: 10_000_000 };
    const account = new FakeRemote(() => real.time);

    // This device thinks it is an hour later than it is.
    const fast = { time: real.time + HOUR };
    const store = await UserStore.open(new IDBFactory());
    const { sync } = signIn(store, account, 'user-x', fast);
    await sync.start();
    await store.saveProgress(BOOK, at(5), fast.time);
    await sync.flushNow();
    // The account pulled the stamp back to its own time; so does the device.
    expect(account.progress.get(BOOK.id)?.updatedAt).toBe(real.time);
    expect((await store.progress(BOOK.id))?.updatedAt).toBe(real.time);

    // A minute later a correctly set device saves a place further back. Most recent wins.
    real.time += 60_000;
    account.progress.set(BOOK.id, { bookId: BOOK.id, fingerprint: BOOK.fingerprint, position: at(2), updatedAt: real.time, deviceId: 'phone' });
    await sync.refresh();
    expect((await store.progress(BOOK.id))?.position).toEqual(at(2));
  });

  it('does not ignore newer settings from other devices (F9)', async () => {
    const real = { time: 10_000_000 };
    const account = new FakeRemote(() => real.time);
    const fast = { time: real.time + HOUR };
    const store = await UserStore.open(new IDBFactory());
    const { sync, page } = signIn(store, account, 'user-x', fast);
    await sync.start();
    page.settings = { caretStyle: 'block' };
    await sync.settingsChanged();
    await sync.flushNow();
    expect(account.settings?.updatedAt).toBe(real.time);

    real.time += 60_000;
    account.settings = { data: { caretStyle: 'underline' }, updatedAt: real.time, deviceId: 'phone' };
    await sync.refresh();
    expect(page.settings).toEqual({ caretStyle: 'underline' });
  });
});
