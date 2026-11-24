/**
 * The access rules, tested against a real database: one account must never
 * read or write another's rows, and a signed-out visitor gets nothing.
 *
 * Needs the local Supabase stack (`pnpm db:start`). Without it the whole
 * file is skipped, with the reason printed, rather than passing on nothing.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { admin, findStack, makeUser, removeUser, visitor, type Stack, type TestUser } from './stack';

const found = findStack();
const missing = 'missing' in found ? found.missing : undefined;
if (missing) console.warn(`\nSKIPPED database access tests: ${missing}\n`);
const stack = found as Stack;

const FINGERPRINT = 'a'.repeat(64);
const BOOK = 'gutenberg:1342';

const TABLES = ['book_progress', 'typing_sessions', 'key_stats', 'word_stats', 'user_settings'] as const;
type Row = Record<string, unknown>;

/** A row of each table, as its owner would write it. */
function rowsFor(userId: string): Record<(typeof TABLES)[number], Row> {
  return {
    book_progress: {
      user_id: userId,
      book_id: BOOK,
      fingerprint: FINGERPRINT,
      chapter: 3,
      paragraph: 4,
      char_offset: 5,
      updated_at: '2026-11-01T10:00:00Z',
      device_id: 'device-a',
    },
    typing_sessions: {
      user_id: userId,
      id: crypto.randomUUID(),
      book_id: BOOK,
      started_at: '2026-11-01T10:00:00Z',
      ended_at: '2026-11-01T10:20:00Z',
      active_ms: 1_100_000,
      words: 900,
      wpm: 49.1,
      accuracy: 0.97,
      device_id: 'device-a',
    },
    key_stats: { user_id: userId, device_id: 'device-a', key: 'e', hits: 100, misses: 4, total_ms: 9000 },
    word_stats: { user_id: userId, device_id: 'device-a', word: 'acknowledged', hits: 3, misses: 2 },
    user_settings: {
      user_id: userId,
      data: { caretStyle: 'block' },
      updated_at: '2026-11-01T10:00:00Z',
      device_id: 'device-a',
    },
  };
}

const VIEWS = ['key_totals', 'word_totals'] as const;

describe.skipIf(missing)('access rules', () => {
  let alice: TestUser;
  let bob: TestUser;
  let aliceRows: ReturnType<typeof rowsFor>;

  beforeAll(async () => {
    alice = await makeUser(stack, 'alice');
    bob = await makeUser(stack, 'bob');
    aliceRows = rowsFor(alice.id);
    for (const table of TABLES) {
      const { error } = await alice.client.from(table).insert(aliceRows[table]);
      expect(error, `alice writes her own ${table}`).toBeNull();
    }
  });

  afterAll(async () => {
    await removeUser(stack, alice);
    await removeUser(stack, bob);
  });

  /** How many of alice's rows really exist, looking behind the access rules. */
  const aliceCount = async (table: string) => {
    const { count, error } = await admin(stack)
      .from(table)
      .select('*', { count: 'exact', head: true })
      .eq('user_id', alice.id);
    expect(error).toBeNull();
    return count;
  };

  describe.each(TABLES)('%s', (table) => {
    it('lets the owner read her own row', async () => {
      const { data, error } = await alice.client.from(table).select('*');
      expect(error).toBeNull();
      expect(data).toHaveLength(1);
      expect(data![0].user_id).toBe(alice.id);
    });

    it('shows another account nothing', async () => {
      const all = await bob.client.from(table).select('*');
      expect(all.error).toBeNull();
      expect(all.data).toEqual([]);
      // Asking for her rows by name makes no difference.
      const aimed = await bob.client.from(table).select('*').eq('user_id', alice.id);
      expect(aimed.error).toBeNull();
      expect(aimed.data).toEqual([]);
    });

    it('refuses a signed-out visitor outright', async () => {
      const read = await visitor(stack).from(table).select('*');
      expect(read.data).toBeNull();
      expect(read.error?.code).toBe('42501');
      const write = await visitor(stack).from(table).insert(aliceRows[table]);
      expect(write.error?.code).toBe('42501');
    });

    it("refuses a row written under someone else's id", async () => {
      // Bob tries to plant a fresh row in alice's name.
      const fresh = rowsFor(alice.id);
      const planted = {
        book_progress: { ...fresh.book_progress, book_id: 'gutenberg:11' },
        typing_sessions: fresh.typing_sessions,
        key_stats: { ...fresh.key_stats, key: 'q' },
        word_stats: { ...fresh.word_stats, word: 'planted' },
        user_settings: fresh.user_settings,
      }[table];
      const { error } = await bob.client.from(table).insert(planted);
      expect(error?.code).toBe('42501');
      expect(await aliceCount(table)).toBe(1);
    });

    it("refuses an upsert aimed at someone else's row", async () => {
      const { error } = await bob.client.from(table).upsert({ ...aliceRows[table], device_id: 'bob-was-here' });
      expect(error?.code).toBe('42501');
      const { data } = await admin(stack).from(table).select('device_id').eq('user_id', alice.id).single();
      expect(data?.device_id).toBe('device-a');
    });

    it("cannot change someone else's row", async () => {
      const { data, error } = await bob.client
        .from(table)
        .update({ device_id: 'bob-was-here' })
        .eq('user_id', alice.id)
        .select();
      // Not an error: to bob the row does not exist, so nothing matches.
      expect(error).toBeNull();
      expect(data).toEqual([]);
      const check = await admin(stack).from(table).select('device_id').eq('user_id', alice.id).single();
      expect(check.data?.device_id).toBe('device-a');
    });

    it("cannot delete someone else's row", async () => {
      const { data, error } = await bob.client.from(table).delete().eq('user_id', alice.id).select();
      expect(error).toBeNull();
      expect(data).toEqual([]);
      expect(await aliceCount(table)).toBe(1);
    });

    it('cannot hand a row over to another account', async () => {
      const { error } = await alice.client.from(table).update({ user_id: bob.id }).eq('user_id', alice.id);
      expect(error?.code).toBe('42501');
      expect(await aliceCount(table)).toBe(1);
    });

    it('fills in the owner when the row does not name one', async () => {
      const { user_id: _owner, ...anonymous } = rowsFor(bob.id)[table];
      const written = await bob.client.from(table).insert(anonymous).select();
      expect(written.error).toBeNull();
      expect(written.data![0].user_id).toBe(bob.id);
      const removed = await bob.client.from(table).delete().eq('user_id', bob.id).select();
      expect(removed.error).toBeNull();
      expect(removed.data).toHaveLength(1);
    });
  });

  describe.each(VIEWS)('%s', (view) => {
    it('shows the owner her totals and another account nothing', async () => {
      const own = await alice.client.from(view).select('*');
      expect(own.error).toBeNull();
      expect(own.data).toHaveLength(1);
      const other = await bob.client.from(view).select('*');
      expect(other.error).toBeNull();
      expect(other.data).toEqual([]);
    });

    it('refuses a signed-out visitor', async () => {
      const read = await visitor(stack).from(view).select('*');
      expect(read.error?.code).toBe('42501');
    });
  });

  it('removes every row when the account is deleted', async () => {
    const carol = await makeUser(stack, 'carol');
    const rows = rowsFor(carol.id);
    for (const table of TABLES) {
      expect((await carol.client.from(table).insert(rows[table])).error).toBeNull();
    }
    await removeUser(stack, carol);
    for (const table of TABLES) {
      const { count } = await admin(stack)
        .from(table)
        .select('*', { count: 'exact', head: true })
        .eq('user_id', carol.id);
      expect(count, table).toBe(0);
    }
  });
});

describe.skipIf(missing)('saving rules in the database', () => {
  let dana: TestUser;

  beforeAll(async () => {
    dana = await makeUser(stack, 'dana');
  });

  afterAll(async () => {
    await removeUser(stack, dana);
  });

  const place = (chapter: number, updatedAt: string, device: string) => ({
    user_id: dana.id,
    book_id: BOOK,
    fingerprint: FINGERPRINT,
    chapter,
    paragraph: 0,
    char_offset: 0,
    updated_at: updatedAt,
    device_id: device,
  });

  const saved = async () => {
    const { data, error } = await dana.client.from('book_progress').select('*').eq('book_id', BOOK).single();
    expect(error).toBeNull();
    return data!;
  };

  it('keeps the most recent save, whichever arrives last', async () => {
    expect((await dana.client.from('book_progress').upsert(place(5, '2026-11-02T12:00:00Z', 'laptop'))).error).toBeNull();

    // A phone that was offline sends an older save afterwards: dropped, without an error.
    const late = await dana.client.from('book_progress').upsert(place(2, '2026-11-02T09:00:00Z', 'phone'));
    expect(late.error).toBeNull();
    expect(await saved()).toMatchObject({ chapter: 5, device_id: 'laptop' });

    // A newer save wins, even though it is further back in the book.
    expect((await dana.client.from('book_progress').upsert(place(1, '2026-11-02T13:00:00Z', 'phone'))).error).toBeNull();
    expect(await saved()).toMatchObject({ chapter: 1, device_id: 'phone' });
  });

  it('pulls a save time from the future back to now', async () => {
    const { error } = await dana.client.from('book_progress').upsert(place(9, '2099-01-01T00:00:00Z', 'time-traveller'));
    expect(error).toBeNull();
    const row = await saved();
    expect(row.chapter).toBe(9);
    expect(Math.abs(new Date(row.updated_at).getTime() - Date.now())).toBeLessThan(60_000);
  });

  it('applies the same rule to settings', async () => {
    const settings = (caretStyle: string, updatedAt: string) => ({
      user_id: dana.id,
      data: { caretStyle },
      updated_at: updatedAt,
      device_id: 'laptop',
    });
    expect((await dana.client.from('user_settings').upsert(settings('block', '2026-11-02T12:00:00Z'))).error).toBeNull();
    expect((await dana.client.from('user_settings').upsert(settings('line', '2026-11-02T08:00:00Z'))).error).toBeNull();
    const { data } = await dana.client.from('user_settings').select('data').single();
    expect(data?.data).toEqual({ caretStyle: 'block' });
  });

  it('takes the same session twice without complaint or a second row', async () => {
    const session = rowsFor(dana.id).typing_sessions;
    for (let attempt = 0; attempt < 2; attempt++) {
      const { error } = await dana.client
        .from('typing_sessions')
        .upsert(session, { onConflict: 'user_id,id', ignoreDuplicates: true });
      expect(error).toBeNull();
    }
    const { data } = await dana.client.from('typing_sessions').select('id');
    expect(data).toHaveLength(1);
  });

  it('adds up weak-key counts across devices', async () => {
    const count = (device: string, hits: number, misses: number) => ({
      user_id: dana.id,
      device_id: device,
      key: 'e',
      hits,
      misses,
      total_ms: hits * 90,
    });
    const send = (row: ReturnType<typeof count>) => dana.client.from('key_stats').upsert(row);
    expect((await send(count('laptop', 100, 4))).error).toBeNull();
    expect((await send(count('phone', 20, 6))).error).toBeNull();
    // The laptop sends its running total again, grown: it replaces, it does not add.
    expect((await send(count('laptop', 110, 5))).error).toBeNull();
    expect((await send(count('laptop', 110, 5))).error).toBeNull();

    const { data, error } = await dana.client.from('key_totals').select('*').eq('key', 'e').single();
    expect(error).toBeNull();
    expect(data).toMatchObject({ hits: 130, misses: 11, total_ms: 11_700 });
  });

  it('refuses rows that are not what they claim to be', async () => {
    const badPrint = await dana.client
      .from('book_progress')
      .upsert({ ...place(1, '2026-11-03T00:00:00Z', 'laptop'), book_id: 'import:x', fingerprint: 'not-a-hash' });
    expect(badPrint.error?.code).toBe('23514');
    const badAccuracy = await dana.client
      .from('typing_sessions')
      .insert({ ...rowsFor(dana.id).typing_sessions, accuracy: 1.5 });
    expect(badAccuracy.error?.code).toBe('23514');
  });
});
