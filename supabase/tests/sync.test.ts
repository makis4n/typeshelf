/**
 * The whole sync path against a real database: the local store, the sync,
 * the Supabase adapter, and the database's own rules, with two "browsers"
 * (two local stores) signed in to one account.
 *
 * Needs the local Supabase stack (`pnpm db:start`); skipped, with the
 * reason printed, without it.
 */

import { IDBFactory } from 'fake-indexeddb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { UserStore } from '../../src/store/userStore';
import { createClient } from '@supabase/supabase-js';
import { RejectedError } from '../../src/sync/remote';
import { supabaseRemote } from '../../src/sync/supabaseRemote';
import { Sync } from '../../src/sync/sync';
import { admin, findStack, makeUser, removeUser, visitor, type Stack, type TestUser } from './stack';

const found = findStack();
const missing = 'missing' in found ? found.missing : undefined;
if (missing) console.warn(`\nSKIPPED sync tests against the database: ${missing}\n`);
const stack = found as Stack;

const BOOK = { id: 'gutenberg:1342', fingerprint: 'b'.repeat(64) };

/** One browser: its own local store, and a sync for the signed-in account. */
async function browser(user: TestUser, settings: Record<string, unknown> = { caretStyle: 'line' }) {
  const store = await UserStore.open(new IDBFactory());
  const page = { settings };
  const sync = new Sync({
    store,
    remote: supabaseRemote(user.client, user.id),
    userId: user.id,
    settings: { read: () => page.settings, apply: (data) => (page.settings = data as Record<string, unknown>) },
    // Batches are sent by hand in these tests.
    timers: { set: () => 0, clear: () => {} },
  });
  return { store, sync, page };
}

describe.skipIf(missing)('sync against the database', () => {
  let user: TestUser;
  let other: TestUser;

  beforeAll(async () => {
    user = await makeUser(stack, 'sync');
    other = await makeUser(stack, 'sync-other');
  });

  afterAll(async () => {
    await removeUser(stack, user);
    await removeUser(stack, other);
  });

  it('carries a guest’s typing into the account, and on to a second browser', async () => {
    // A guest types before having an account.
    const one = await browser(user, { caretStyle: 'block' });
    await one.store.saveProgress(BOOK, { chapter: 2, paragraph: 7, char: 31 });
    await one.store.addSession({
      id: crypto.randomUUID(),
      bookId: BOOK.id,
      startedAt: Date.now() - 600_000,
      endedAt: Date.now(),
      activeMs: 540_000,
      words: 450,
      wpm: 50,
      accuracy: 0.96,
    });
    await one.store.addCounts({
      keys: [{ key: 'e', hits: 40, misses: 2, ms: 3600 }],
      words: [{ word: 'acknowledged', hits: 1, misses: 1 }],
    });

    // They sign in: everything goes up.
    await one.sync.start();
    expect(one.sync.current()).toBe('synced');
    expect(await one.store.pendingCount()).toBe(0);

    const db = admin(stack);
    const progress = await db.from('book_progress').select('*').eq('user_id', user.id).single();
    expect(progress.data).toMatchObject({ book_id: BOOK.id, chapter: 2, paragraph: 7, char_offset: 31 });
    expect((await db.from('typing_sessions').select('wpm').eq('user_id', user.id)).data).toEqual([{ wpm: 50 }]);
    expect((await db.from('key_totals').select('key, hits, misses, total_ms').eq('user_id', user.id)).data).toEqual([
      { key: 'e', hits: 40, misses: 2, total_ms: 3600 },
    ]);
    expect((await db.from('word_totals').select('word, misses').eq('user_id', user.id)).data).toEqual([
      { word: 'acknowledged', misses: 1 },
    ]);
    expect((await db.from('user_settings').select('data').eq('user_id', user.id).single()).data?.data).toEqual({
      caretStyle: 'block',
    });

    // A second browser signs in to the same account: same place, same settings.
    const two = await browser(user);
    await two.sync.start();
    expect((await two.store.progress(BOOK.id))?.position).toEqual({ chapter: 2, paragraph: 7, char: 31 });
    expect(two.page.settings).toEqual({ caretStyle: 'block' });

    // Sending everything again changes nothing: no doubled sessions or counts.
    await one.store.addCounts({ keys: [{ key: 'e', hits: 10 }] });
    await one.sync.flushNow();
    await one.sync.flushNow();
    expect((await db.from('typing_sessions').select('id').eq('user_id', user.id)).data).toHaveLength(1);
    expect((await db.from('key_totals').select('hits').eq('user_id', user.id).single()).data).toEqual({ hits: 50 });

    // Counts from the second browser add to the first's.
    await two.store.addCounts({ keys: [{ key: 'e', hits: 5, misses: 1 }] });
    await two.sync.flushNow();
    expect((await db.from('key_totals').select('hits, misses').eq('user_id', user.id).single()).data).toEqual({
      hits: 55,
      misses: 3,
    });
  });

  it('asks before jumping to a place further on, and the answer holds everywhere', async () => {
    const book = { id: 'gutenberg:11', fingerprint: 'c'.repeat(64) };
    const phone = await browser(user);
    await phone.sync.start();
    const laptop = await browser(user);
    await laptop.sync.start();

    await laptop.store.saveProgress(book, { chapter: 1, paragraph: 0, char: 0 });
    await laptop.sync.flushNow();
    await phone.sync.refresh();
    await phone.store.saveProgress(book, { chapter: 6, paragraph: 3, char: 12 });
    await phone.sync.flushNow();

    // The laptop opens the book: it stays put and has a question for the reader.
    await laptop.sync.refresh();
    expect((await laptop.store.progress(book.id))?.position.chapter).toBe(1);
    const question = await laptop.sync.aheadFor(book.id);
    expect(question?.here.chapter).toBe(1);
    expect(question?.there.position).toEqual({ chapter: 6, paragraph: 3, char: 12 });

    // "No, stay here": the laptop's place becomes the account's, and it is not asked again.
    expect(await laptop.sync.answerAhead(book.id, false)).toEqual({ chapter: 1, paragraph: 0, char: 0 });
    await laptop.sync.flushNow();
    const row = await admin(stack).from('book_progress').select('chapter').eq('user_id', user.id).eq('book_id', book.id);
    expect(row.data).toEqual([{ chapter: 1 }]);
    await laptop.sync.refresh();
    expect(await laptop.sync.aheadFor(book.id)).toBeUndefined();

    // The phone, further on, is now the one that gets asked nothing: the newer save is behind it,
    // so by "most recent wins" it moves back to where the reader chose to be.
    await phone.sync.refresh();
    expect((await phone.store.progress(book.id))?.position.chapter).toBe(1);
  });

  it('sets aside a row the database refuses, and still sends the rest', async () => {
    const mine = await browser(user);
    await mine.sync.start();
    const good = crypto.randomUUID();
    const session = { bookId: BOOK.id, startedAt: Date.now() - 1000, endedAt: Date.now(), activeMs: 900, words: 10, wpm: 40, accuracy: 0.9 };
    // The local store cannot know every rule: this id is not one the database accepts.
    await mine.store.addSession({ ...session, id: 'not-a-uuid' });
    await mine.store.addSession({ ...session, id: good });
    await mine.store.addCounts({ keys: [{ key: 'z', hits: 7 }] });
    await mine.sync.flushNow();

    expect(mine.sync.current()).toBe('synced');
    expect(mine.sync.setAside.map((entry) => entry.ref)).toEqual(['not-a-uuid']);
    const db = admin(stack);
    expect((await db.from('typing_sessions').select('id').eq('user_id', user.id).eq('id', good)).data).toHaveLength(1);
    expect((await db.from('key_totals').select('hits').eq('user_id', user.id).eq('key', 'z').single()).data).toEqual({ hits: 7 });
  });

  it('tells the adapter apart: refused rows are a RejectedError, a dead connection is not', async () => {
    const remote = supabaseRemote(user.client, user.id);
    const bad = { id: crypto.randomUUID(), bookId: BOOK.id, startedAt: 2000, endedAt: 1000, activeMs: 1, words: 1, wpm: 1, accuracy: 1, deviceId: 'd' };
    await expect(remote.pushSessions([bad])).rejects.toBeInstanceOf(RejectedError);
    await expect(remote.pushSessions([{ ...bad, endedAt: 3000, wpm: Number.NaN }])).rejects.toBeInstanceOf(RejectedError);
    await expect(remote.pushSessions([{ ...bad, startedAt: Number.NaN }])).rejects.toBeInstanceOf(RejectedError);

    const nowhere = supabaseRemote(createClient('http://127.0.0.1:9', 'key', { auth: { persistSession: false } }), user.id);
    const failure = await nowhere.pullProgress().then(() => undefined, (error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(RejectedError);
  });

  it('reports the save time the database stored, which a fast clock does not get to choose', async () => {
    const remote = supabaseRemote(user.client, user.id);
    const place = { bookId: 'gutenberg:98', fingerprint: 'e'.repeat(64), position: { chapter: 1, paragraph: 0, char: 0 }, deviceId: 'fast-laptop' };
    const anHourAhead = Date.now() + 3_600_000;
    const [stored] = await remote.pushProgress([{ ...place, updatedAt: anHourAhead }]);
    expect(stored?.bookId).toBe(place.bookId);
    expect(Math.abs(stored!.updatedAt - Date.now())).toBeLessThan(60_000);
    // An older save is not kept, and is not reported as kept.
    expect(await remote.pushProgress([{ ...place, updatedAt: stored!.updatedAt - 10_000 }])).toEqual([]);

    // End to end: the fast device takes the corrected time, so a later save elsewhere is seen as later.
    const fast = await browser(user);
    await fast.sync.start();
    const book = { id: 'gutenberg:99', fingerprint: 'f'.repeat(64) };
    await fast.store.saveProgress(book, { chapter: 5, paragraph: 0, char: 0 }, anHourAhead);
    await fast.sync.flushNow();
    expect(Math.abs((await fast.store.progress(book.id))!.updatedAt - Date.now())).toBeLessThan(60_000);
    await remote.pushProgress([{ bookId: book.id, fingerprint: book.fingerprint, position: { chapter: 2, paragraph: 0, char: 0 }, updatedAt: Date.now() + 5000, deviceId: 'phone' }]);
    await fast.sync.refresh();
    expect((await fast.store.progress(book.id))?.position.chapter).toBe(2);
  });

  it('tells a signed-in device the time, and nobody else', async () => {
    const time = await supabaseRemote(user.client, user.id).serverTime();
    expect(Math.abs(time - Date.now())).toBeLessThan(60_000);
    const asVisitor = await visitor(stack).rpc('server_time');
    expect(asVisitor.error?.code).toBe('42501');
  });

  it('a device an hour fast, saving offline, ends where a correctly set device would', async () => {
    const book = { id: 'gutenberg:2701', fingerprint: '9'.repeat(64) };
    const HOUR = 3_600_000;
    const fastClock = () => Date.now() + HOUR;
    const store = await UserStore.open(new IDBFactory());
    const sync = new Sync({
      store,
      remote: supabaseRemote(user.client, user.id),
      userId: user.id,
      settings: { read: () => ({}), apply: () => {} },
      now: fastClock,
      timers: { set: () => 0, clear: () => {} },
    });
    await sync.start();
    // The first contact measured the clock.
    expect(Math.abs((await store.clockOffset()) + HOUR)).toBeLessThan(5000);

    // "Offline": the device saves chapter 5 and does not send it. Then the phone saves chapter 2.
    await store.saveProgress(book, { chapter: 5, paragraph: 0, char: 0 }, await store.accountTime(fastClock()));
    await new Promise((resolve) => setTimeout(resolve, 50));
    await supabaseRemote(user.client, user.id).pushProgress([
      { bookId: book.id, fingerprint: book.fingerprint, position: { chapter: 2, paragraph: 0, char: 0 }, updatedAt: Date.now(), deviceId: 'phone' },
    ]);

    await sync.refresh();
    expect((await store.progress(book.id))?.position.chapter).toBe(2);
    const row = await admin(stack).from('book_progress').select('chapter, device_id').eq('user_id', user.id).eq('book_id', book.id);
    expect(row.data).toEqual([{ chapter: 2, device_id: 'phone' }]);
  });

  it('keeps a different account on the same browser apart', async () => {
    const shared = new IDBFactory();
    const first = await UserStore.open(shared);
    await first.setOwner(user.id);
    await first.saveProgress({ id: 'gutenberg:84', fingerprint: 'd'.repeat(64) }, { chapter: 9, paragraph: 9, char: 9 });

    const sync = new Sync({
      store: first,
      remote: supabaseRemote(other.client, other.id),
      userId: other.id,
      settings: { read: () => ({}), apply: () => {} },
      timers: { set: () => 0, clear: () => {} },
    });
    await sync.start();

    const leaked = await admin(stack).from('book_progress').select('book_id').eq('user_id', other.id);
    expect(leaked.data).toEqual([]);
    expect(await first.allProgress()).toEqual([]);

    // The first account's unsent place was put aside, and reaches that account when it is back.
    sync.stop();
    const back = new Sync({
      store: first,
      remote: supabaseRemote(user.client, user.id),
      userId: user.id,
      settings: { read: () => ({}), apply: () => {} },
      timers: { set: () => 0, clear: () => {} },
    });
    await back.start();
    const kept = await admin(stack).from('book_progress').select('chapter').eq('user_id', user.id).eq('book_id', 'gutenberg:84');
    expect(kept.data).toEqual([{ chapter: 9 }]);
    expect((await admin(stack).from('book_progress').select('book_id').eq('user_id', other.id)).data).toEqual([]);
  });
});
