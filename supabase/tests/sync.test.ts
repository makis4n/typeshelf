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
import { supabaseRemote } from '../../src/sync/supabaseRemote';
import { Sync } from '../../src/sync/sync';
import { admin, findStack, makeUser, removeUser, type Stack, type TestUser } from './stack';

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
  });
});
