import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it, vi } from 'vitest';
import type { Position } from '../book/types';
import { saveTag, type ProgressRecord } from './types';
import { USER_DB_NAME, UserStore, type NewSession } from './userStore';

const at = (chapter: number, paragraph: number, char: number): Position => ({ chapter, paragraph, char });
const book = (id = 'book-1') => ({ id, fingerprint: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' });

async function openStore() {
  return UserStore.open(new IDBFactory());
}

function session(id = 's1', overrides: Partial<NewSession> = {}): NewSession {
  return {
    id,
    bookId: 'book-1',
    startedAt: 1000,
    endedAt: 61_000,
    activeMs: 50_000,
    words: 120,
    wpm: 40,
    accuracy: 0.95,
    ...overrides,
  };
}

/** A place on another device, as the account would hand it down. */
function remoteRecord(overrides: Partial<ProgressRecord> = {}): ProgressRecord {
  return {
    bookId: 'book-1',
    fingerprint: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    position: at(3, 0, 0),
    updatedAt: 2000,
    deviceId: 'other-device',
    ...overrides,
  };
}

describe('saveProgress', () => {
  it('stores the position, fingerprint, time and device', async () => {
    const store = await openStore();
    const saved = await store.saveProgress(book(), at(1, 2, 3), 5000);

    expect(saved).toEqual({
      bookId: 'book-1',
      fingerprint: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      position: at(1, 2, 3),
      updatedAt: 5000,
      deviceId: await store.deviceId(),
    });
    expect(await store.progress('book-1')).toEqual(saved);
  });

  it('queues one outbox entry for the book', async () => {
    const store = await openStore();
    await store.saveProgress(book(), at(0, 0, 1), 100);

    const pending = await store.pending();
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ id: 'progress:book-1', kind: 'progress', ref: 'book-1' });
  });

  it('leaves one outbox entry with a higher seq after ten saves of the same book', async () => {
    const store = await openStore();
    await store.saveProgress(book(), at(0, 0, 1), 100);
    const first = (await store.pending())[0]!;

    for (let i = 2; i <= 10; i += 1) await store.saveProgress(book(), at(0, 0, i), 100 + i);

    const pending = await store.pending();
    expect(pending).toHaveLength(1);
    expect(pending[0]!.seq).toBeGreaterThan(first.seq);
    expect((await store.progress('book-1'))!.position).toEqual(at(0, 0, 10));
  });

  it('queues separate entries for different books', async () => {
    const store = await openStore();
    await store.saveProgress(book('a'), at(0, 0, 1), 100);
    await store.saveProgress(book('b'), at(0, 0, 1), 100);

    expect((await store.pending()).map((entry) => entry.id).sort()).toEqual(['progress:a', 'progress:b']);
  });

  it('never lets updatedAt go backwards when the clock is set back', async () => {
    const store = await openStore();
    await store.saveProgress(book(), at(0, 0, 1), 9000);
    const later = await store.saveProgress(book(), at(0, 0, 2), 4000);

    expect(later.updatedAt).toBe(9000);
    expect((await store.progress('book-1'))!.updatedAt).toBe(9000);
  });

  it('keeps an unanswered ahead question on an ordinary save', async () => {
    const store = await openStore();
    await store.saveProgress(book(), at(1, 0, 0), 1000);
    await store.reconcileProgress(remoteRecord(), () => 'ask');

    const saved = await store.saveProgress(book(), at(1, 0, 5), 1500);

    expect(saved.ahead).toEqual({ position: at(3, 0, 0), updatedAt: 2000, deviceId: 'other-device' });
    expect((await store.progress('book-1'))!.ahead).toBeDefined();
  });

  it('keeps a declined mark on an ordinary save', async () => {
    const store = await openStore();
    await store.saveProgress(book(), at(1, 0, 0), 1000);
    await store.reconcileProgress(remoteRecord(), () => 'ask');
    await store.answerAhead('book-1', false, 3000);

    const saved = await store.saveProgress(book(), at(1, 0, 9), 4000);

    expect(saved.declined).toBe('other-device@2000');
  });

  it('returns undefined for a book never saved', async () => {
    const store = await openStore();
    expect(await store.progress('nope')).toBeUndefined();
  });
});

describe('device id and owner', () => {
  it('makes the device id once and returns the same one every time', async () => {
    const store = await openStore();
    expect(await store.deviceId()).toBe(await store.deviceId());
    expect(await store.deviceId()).not.toBe('');
  });

  it('keeps the device id after a reload', async () => {
    const factory = new IDBFactory();
    const first = await UserStore.open(factory);
    const id = await first.deviceId();
    first.close();

    const second = await UserStore.open(factory);
    expect(await second.deviceId()).toBe(id);
  });

  it('gives different stores different device ids', async () => {
    expect(await (await openStore()).deviceId()).not.toBe(await (await openStore()).deviceId());
  });

  it('keeps saved data after a reload', async () => {
    const factory = new IDBFactory();
    const first = await UserStore.open(factory);
    await first.saveProgress(book(), at(1, 2, 3), 100);
    await first.addSession(session());
    await first.addCounts({ keys: [{ key: 'a', hits: 2 }], words: [{ word: 'the', hits: 1 }] });
    first.close();

    const second = await UserStore.open(factory);
    expect((await second.progress('book-1'))!.position).toEqual(at(1, 2, 3));
    expect(await second.session('s1')).toBeDefined();
    expect((await second.keyCount('a'))!.hits).toBe(2);
    expect((await second.wordCount('the'))!.hits).toBe(1);
    expect(await second.pendingCount()).toBe(4);
  });

  it('uses the database name typeshelf-user', async () => {
    const factory = new IDBFactory();
    await UserStore.open(factory);
    const names = (await factory.databases()).map((db) => db.name);
    expect(names).toEqual([USER_DB_NAME]);
    expect(USER_DB_NAME).toBe('typeshelf-user');
  });

  it('has no owner by default', async () => {
    const store = await openStore();
    expect(await store.owner()).toBeNull();
  });

  it('remembers the owner that was set, also after a reload', async () => {
    const factory = new IDBFactory();
    const first = await UserStore.open(factory);
    await first.setOwner('user-1');
    expect(await first.owner()).toBe('user-1');
    first.close();

    expect(await (await UserStore.open(factory)).owner()).toBe('user-1');
  });

  it('forgets the owner when it is set to null', async () => {
    const store = await openStore();
    await store.setOwner('user-1');
    await store.setOwner(null);
    expect(await store.owner()).toBeNull();
  });
});

describe('addSession', () => {
  it('stores the session with this device id', async () => {
    const store = await openStore();
    const saved = await store.addSession(session('s1'));

    expect(saved.deviceId).toBe(await store.deviceId());
    expect(await store.session('s1')).toEqual({ ...session('s1'), deviceId: await store.deviceId() });
  });

  it('queues the session', async () => {
    const store = await openStore();
    await store.addSession(session('s1'));

    const pending = await store.pending();
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ id: 'session:s1', kind: 'session', ref: 's1' });
  });

  it('lists every session added', async () => {
    const store = await openStore();
    await store.addSession(session('s1'));
    await store.addSession(session('s2'));
    expect((await store.sessions()).map((s) => s.id).sort()).toEqual(['s1', 's2']);
  });
});

describe('addCounts', () => {
  it('adds hits, misses and time across calls', async () => {
    const store = await openStore();
    await store.addCounts({ keys: [{ key: 'a', hits: 3, misses: 1, ms: 300 }] });
    await store.addCounts({ keys: [{ key: 'a', hits: 2, misses: 4, ms: 150 }] });

    expect(await store.keyCount('a')).toEqual({ key: 'a', hits: 5, misses: 5, totalMs: 450 });
  });

  it('adds word hits and misses across calls', async () => {
    const store = await openStore();
    await store.addCounts({ words: [{ word: 'the', hits: 2, misses: 1 }] });
    await store.addCounts({ words: [{ word: 'the', hits: 1 }] });

    expect(await store.wordCount('the')).toEqual({ word: 'the', hits: 3, misses: 1 });
  });

  it('counts a pair of characters as one key', async () => {
    const store = await openStore();
    await store.addCounts({ keys: [{ key: 'th', hits: 1 }] });
    expect((await store.keyCount('th'))!.hits).toBe(1);
  });

  it('queues one entry per key and per word, however often they are counted', async () => {
    const store = await openStore();
    await store.addCounts({ keys: [{ key: 'a', hits: 1 }, { key: 'b', hits: 1 }], words: [{ word: 'the', hits: 1 }] });
    await store.addCounts({ keys: [{ key: 'a', hits: 1 }], words: [{ word: 'the', hits: 1 }] });

    expect((await store.pending()).map((entry) => entry.id).sort()).toEqual(['key:a', 'key:b', 'word:the']);
  });

  it('ignores keys longer than 8 characters but accepts exactly 8', async () => {
    const store = await openStore();
    await store.addCounts({ keys: [{ key: '123456789', hits: 1 }, { key: '12345678', hits: 1 }] });

    expect(await store.keyCount('123456789')).toBeUndefined();
    expect(await store.keyCount('12345678')).toBeDefined();
    expect((await store.pending()).map((entry) => entry.id)).toEqual(['key:12345678']);
  });

  it('ignores words longer than 64 characters but accepts exactly 64', async () => {
    const store = await openStore();
    await store.addCounts({ words: [{ word: 'w'.repeat(65), hits: 1 }, { word: 'w'.repeat(64), hits: 1 }] });

    expect(await store.wordCount('w'.repeat(65))).toBeUndefined();
    expect(await store.wordCount('w'.repeat(64))).toBeDefined();
  });

  it('ignores empty keys and words', async () => {
    const store = await openStore();
    await store.addCounts({ keys: [{ key: '', hits: 1 }], words: [{ word: '', hits: 1 }] });

    expect(await store.keyCounts()).toEqual([]);
    expect(await store.wordCounts()).toEqual([]);
    expect(await store.pendingCount()).toBe(0);
  });

  it('treats negative numbers as zero', async () => {
    const store = await openStore();
    await store.addCounts({
      keys: [{ key: 'a', hits: -5, misses: -1, ms: -100 }],
      words: [{ word: 'the', hits: -2, misses: -3 }],
    });

    expect(await store.keyCount('a')).toEqual({ key: 'a', hits: 0, misses: 0, totalMs: 0 });
    expect(await store.wordCount('the')).toEqual({ word: 'the', hits: 0, misses: 0 });
  });

  it('does not take away from earlier totals when given negative numbers', async () => {
    const store = await openStore();
    await store.addCounts({ keys: [{ key: 'a', hits: 4, misses: 2, ms: 200 }] });
    await store.addCounts({ keys: [{ key: 'a', hits: -4, misses: -2, ms: -200 }] });

    expect(await store.keyCount('a')).toEqual({ key: 'a', hits: 4, misses: 2, totalMs: 200 });
  });

  it('treats missing numbers as zero', async () => {
    const store = await openStore();
    await store.addCounts({ keys: [{ key: 'a' }] });
    expect(await store.keyCount('a')).toEqual({ key: 'a', hits: 0, misses: 0, totalMs: 0 });
  });

  it('rounds fractional milliseconds', async () => {
    const store = await openStore();
    await store.addCounts({ keys: [{ key: 'a', ms: 10.6 }] });
    expect((await store.keyCount('a'))!.totalMs).toBe(11);
  });

  it('does nothing and tells nobody when nothing valid was given', async () => {
    const store = await openStore();
    const heard = vi.fn();
    store.onChange(heard);

    await store.addCounts({});
    await store.addCounts({ keys: [{ key: 'toolongkey', hits: 1 }] });

    expect(heard).not.toHaveBeenCalled();
    expect(await store.pendingCount()).toBe(0);
  });

  it('keeps only totals: no order of key presses is stored', async () => {
    const factory = new IDBFactory();
    const store = await UserStore.open(factory);
    await store.addCounts({ keys: [{ key: 'a', hits: 1, misses: 1, ms: 5 }], words: [{ word: 'the', hits: 1 }] });
    await store.addCounts({ keys: [{ key: 'b', hits: 1 }] });

    for (const row of await store.keyCounts()) {
      expect(Object.keys(row).sort()).toEqual(['hits', 'key', 'misses', 'totalMs']);
    }
    for (const row of await store.wordCounts()) {
      expect(Object.keys(row).sort()).toEqual(['hits', 'misses', 'word']);
    }

    // The only places typed data can sit are the two count stores (and `parked`, which holds
    // unsent copies of those same totals for an account that has left).
    const raw = await new Promise<IDBDatabase>((resolve, reject) => {
      const opening = factory.open(USER_DB_NAME);
      opening.onsuccess = () => resolve(opening.result);
      opening.onerror = () => reject(opening.error);
    });
    expect([...raw.objectStoreNames].sort()).toEqual([
      'keyStats',
      'meta',
      'outbox',
      'parked',
      'progress',
      'sessions',
      'wordStats',
    ]);
    raw.close();
  });
});

describe('outbox', () => {
  it('lists pending entries with the oldest change first', async () => {
    const store = await openStore();
    await store.saveProgress(book('a'), at(0, 0, 1), 100);
    await store.addSession(session('s1'));
    await store.addCounts({ keys: [{ key: 'k', hits: 1 }] });
    await store.markSettingsChanged(200);

    const pending = await store.pending();
    expect(pending.map((entry) => entry.id)).toEqual(['progress:a', 'session:s1', 'key:k', 'settings:']);
    expect(pending.map((entry) => entry.seq)).toEqual([...pending.map((entry) => entry.seq)].sort((x, y) => x - y));
  });

  it('moves a book to the end of the list when it changes again', async () => {
    const store = await openStore();
    await store.saveProgress(book('a'), at(0, 0, 1), 100);
    await store.saveProgress(book('b'), at(0, 0, 1), 100);
    await store.saveProgress(book('a'), at(0, 0, 2), 100);

    expect((await store.pending()).map((entry) => entry.id)).toEqual(['progress:b', 'progress:a']);
  });

  it('removes entries once they are acknowledged', async () => {
    const store = await openStore();
    await store.saveProgress(book('a'), at(0, 0, 1), 100);
    await store.addSession(session('s1'));

    await store.acknowledge(await store.pending());

    expect(await store.pending()).toEqual([]);
    expect(await store.pendingCount()).toBe(0);
  });

  it('removes only the entries it was given', async () => {
    const store = await openStore();
    await store.saveProgress(book('a'), at(0, 0, 1), 100);
    await store.saveProgress(book('b'), at(0, 0, 1), 100);
    const [first] = await store.pending();

    await store.acknowledge([first!]);

    expect((await store.pending()).map((entry) => entry.id)).toEqual(['progress:b']);
  });

  it('keeps an entry that changed again after it was read', async () => {
    const store = await openStore();
    await store.saveProgress(book(), at(0, 0, 1), 100);
    const oldCopy = await store.pending();
    await store.saveProgress(book(), at(0, 0, 2), 200);

    await store.acknowledge(oldCopy);

    const pending = await store.pending();
    expect(pending).toHaveLength(1);
    expect(pending[0]!.seq).toBeGreaterThan(oldCopy[0]!.seq);
  });

  it('removes the entry when the newest copy is acknowledged', async () => {
    const store = await openStore();
    await store.saveProgress(book(), at(0, 0, 1), 100);
    await store.saveProgress(book(), at(0, 0, 2), 200);

    await store.acknowledge(await store.pending());

    expect(await store.pending()).toEqual([]);
  });

  it('accepts an empty acknowledgement and an entry that is already gone', async () => {
    const store = await openStore();
    await store.saveProgress(book(), at(0, 0, 1), 100);
    const copy = await store.pending();
    await store.acknowledge(copy);

    await expect(store.acknowledge([])).resolves.toBeUndefined();
    await expect(store.acknowledge(copy)).resolves.toBeUndefined();
  });
});

describe('reconcileProgress', () => {
  it('replaces the local record with the account copy on take-remote', async () => {
    const store = await openStore();
    await store.saveProgress(book(), at(5, 0, 0), 1000);

    const verdict = await store.reconcileProgress(remoteRecord({ position: at(1, 0, 0), updatedAt: 3000 }), () => 'take-remote');

    expect(verdict).toBe('take-remote');
    expect(await store.progress('book-1')).toEqual(remoteRecord({ position: at(1, 0, 0), updatedAt: 3000 }));
  });

  it('stores a copy without ahead and declined on take-remote', async () => {
    const store = await openStore();
    const dirty = remoteRecord({
      ahead: { position: at(9, 9, 9), updatedAt: 1, deviceId: 'x' },
      declined: 'x@1',
    });

    await store.reconcileProgress(dirty, () => 'take-remote');

    const stored = (await store.progress('book-1'))!;
    expect(stored.ahead).toBeUndefined();
    expect(stored.declined).toBeUndefined();
    expect(Object.keys(stored)).not.toContain('ahead');
    expect(Object.keys(stored)).not.toContain('declined');
  });

  it('takes the account place when there is no local record', async () => {
    const store = await openStore();
    await store.reconcileProgress(remoteRecord(), (local) => (local === undefined ? 'take-remote' : 'keep-local'));
    expect((await store.progress('book-1'))!.position).toEqual(at(3, 0, 0));
  });

  it('hands the local record to the deciding function', async () => {
    const store = await openStore();
    const saved = await store.saveProgress(book(), at(1, 1, 1), 1000);
    const decide = vi.fn(() => 'keep-local' as const);

    await store.reconcileProgress(remoteRecord(), decide);

    expect(decide).toHaveBeenCalledWith(saved);
  });

  it('removes the queued progress entry for that book on take-remote and keeps the others', async () => {
    const store = await openStore();
    await store.saveProgress(book('book-1'), at(5, 0, 0), 1000);
    await store.saveProgress(book('book-2'), at(5, 0, 0), 1000);

    await store.reconcileProgress(remoteRecord(), () => 'take-remote');

    expect((await store.pending()).map((entry) => entry.id)).toEqual(['progress:book-2']);
  });

  it('does not tell change listeners about a take-remote', async () => {
    const store = await openStore();
    await store.saveProgress(book(), at(5, 0, 0), 1000);
    const heard = vi.fn();
    store.onChange(heard);

    await store.reconcileProgress(remoteRecord(), () => 'take-remote');

    expect(heard).not.toHaveBeenCalled();
  });

  it('keeps the local position and records the other place on ask', async () => {
    const store = await openStore();
    await store.saveProgress(book(), at(1, 0, 0), 1000);

    const verdict = await store.reconcileProgress(remoteRecord(), () => 'ask');

    expect(verdict).toBe('ask');
    const stored = (await store.progress('book-1'))!;
    expect(stored.position).toEqual(at(1, 0, 0));
    expect(stored.updatedAt).toBe(1000);
    expect(stored.ahead).toEqual({ position: at(3, 0, 0), updatedAt: 2000, deviceId: 'other-device' });
  });

  it('queues nothing and tells nobody on ask', async () => {
    const store = await openStore();
    await store.saveProgress(book(), at(1, 0, 0), 1000);
    const before = await store.pending();
    const heard = vi.fn();
    store.onChange(heard);

    await store.reconcileProgress(remoteRecord(), () => 'ask');

    expect(await store.pending()).toEqual(before);
    expect(heard).not.toHaveBeenCalled();
  });

  it('stores nothing on ask when there is no local record', async () => {
    const store = await openStore();
    await store.reconcileProgress(remoteRecord(), () => 'ask');
    expect(await store.progress('book-1')).toBeUndefined();
  });

  it('changes nothing on keep-local', async () => {
    const store = await openStore();
    const saved = await store.saveProgress(book(), at(1, 0, 0), 1000);
    const pending = await store.pending();

    const verdict = await store.reconcileProgress(remoteRecord(), () => 'keep-local');

    expect(verdict).toBe('keep-local');
    expect(await store.progress('book-1')).toEqual(saved);
    expect(await store.pending()).toEqual(pending);
  });
});

describe('answerAhead', () => {
  /** A device that saved at t=1000 and has been told another device is at chapter 3, saved at t=2000. */
  async function askedStore() {
    const store = await openStore();
    await store.saveProgress(book(), at(1, 0, 0), 1000);
    await store.reconcileProgress(remoteRecord(), () => 'ask');
    await store.acknowledge(await store.pending());
    return store;
  }

  it('moves to the other place on yes', async () => {
    const store = await askedStore();
    const answered = await store.answerAhead('book-1', true, 500);

    expect(answered!.position).toEqual(at(3, 0, 0));
    expect((await store.progress('book-1'))!.position).toEqual(at(3, 0, 0));
  });

  it('clears the question on yes', async () => {
    const store = await askedStore();
    await store.answerAhead('book-1', true, 500);
    expect((await store.progress('book-1'))!.ahead).toBeUndefined();
  });

  it('makes the answer newer than both earlier saves even when the clock is earlier', async () => {
    const store = await askedStore();
    const answered = await store.answerAhead('book-1', true, 500);

    expect(answered!.updatedAt).toBeGreaterThan(1000);
    expect(answered!.updatedAt).toBeGreaterThan(2000);
  });

  it('uses the real time for the answer when it is later than both saves', async () => {
    const store = await askedStore();
    const answered = await store.answerAhead('book-1', true, 9000);
    expect(answered!.updatedAt).toBe(9000);
  });

  it('records the answer as this device save, not the other device', async () => {
    const store = await askedStore();
    const answered = await store.answerAhead('book-1', true, 500);
    expect(answered!.deviceId).toBe(await store.deviceId());
  });

  it('queues the book after yes', async () => {
    const store = await askedStore();
    expect(await store.pendingCount()).toBe(0);

    await store.answerAhead('book-1', true, 500);

    expect((await store.pending()).map((entry) => entry.id)).toEqual(['progress:book-1']);
  });

  it('keeps the place on no', async () => {
    const store = await askedStore();
    const answered = await store.answerAhead('book-1', false, 500);
    expect(answered!.position).toEqual(at(1, 0, 0));
  });

  it('remembers which save was turned down and clears the question on no', async () => {
    const store = await askedStore();
    const answered = await store.answerAhead('book-1', false, 500);

    expect(answered!.declined).toBe(saveTag({ deviceId: 'other-device', updatedAt: 2000 }));
    expect(answered!.ahead).toBeUndefined();
    expect((await store.progress('book-1'))!.ahead).toBeUndefined();
  });

  it('makes the answer newer than both earlier saves on no', async () => {
    const store = await askedStore();
    const answered = await store.answerAhead('book-1', false, 500);
    expect(answered!.updatedAt).toBeGreaterThan(2000);
    expect(answered!.deviceId).toBe(await store.deviceId());
  });

  it('queues the book after no', async () => {
    const store = await askedStore();
    await store.answerAhead('book-1', false, 500);
    expect((await store.pending()).map((entry) => entry.id)).toEqual(['progress:book-1']);
  });

  it('tells change listeners about an answer', async () => {
    const store = await askedStore();
    const heard = vi.fn();
    store.onChange(heard);
    await store.answerAhead('book-1', true, 500);
    expect(heard).toHaveBeenCalledTimes(1);
  });

  it('changes nothing when no question is waiting', async () => {
    const store = await openStore();
    const saved = await store.saveProgress(book(), at(1, 0, 0), 1000);
    await store.acknowledge(await store.pending());
    const heard = vi.fn();
    store.onChange(heard);

    const answered = await store.answerAhead('book-1', true, 9000);

    expect(answered).toEqual(saved);
    expect(await store.progress('book-1')).toEqual(saved);
    expect(await store.pendingCount()).toBe(0);
    expect(heard).not.toHaveBeenCalled();
  });

  it('returns undefined for a book that was never saved', async () => {
    const store = await openStore();
    expect(await store.answerAhead('nope', true, 9000)).toBeUndefined();
    expect(await store.pendingCount()).toBe(0);
  });

  it('does not ask again once answered', async () => {
    const store = await askedStore();
    await store.answerAhead('book-1', false, 500);
    const second = await store.answerAhead('book-1', true, 600);
    expect(second!.position).toEqual(at(1, 0, 0));
  });
});

describe('settings bookkeeping', () => {
  it('has no change time before settings ever changed', async () => {
    const store = await openStore();
    expect(await store.settingsChangedAt()).toBeUndefined();
  });

  it('records when settings changed and queues them', async () => {
    const store = await openStore();
    await store.markSettingsChanged(4000);

    expect(await store.settingsChangedAt()).toBe(4000);
    expect((await store.pending()).map((entry) => entry.id)).toEqual(['settings:']);
  });

  it('queues settings only once however often they change', async () => {
    const store = await openStore();
    await store.markSettingsChanged(4000);
    await store.markSettingsChanged(5000);

    expect(await store.pendingCount()).toBe(1);
    expect(await store.settingsChangedAt()).toBe(5000);
  });

  it('takes the account time and removes the queued settings when adopting', async () => {
    const store = await openStore();
    await store.markSettingsChanged(4000);
    await store.saveProgress(book(), at(0, 0, 1), 100);

    await store.adoptSettings(3000);

    expect(await store.settingsChangedAt()).toBe(3000);
    expect((await store.pending()).map((entry) => entry.id)).toEqual(['progress:book-1']);
  });

  it('does not tell listeners when adopting', async () => {
    const store = await openStore();
    const heard = vi.fn();
    store.onChange(heard);
    await store.adoptSettings(3000);
    expect(heard).not.toHaveBeenCalled();
  });
});

describe('clear', () => {
  it('wipes progress, sessions, counts, settings time, owner and outbox', async () => {
    const store = await openStore();
    await store.setOwner('user-1');
    await store.saveProgress(book(), at(1, 1, 1), 100);
    await store.addSession(session());
    await store.addCounts({ keys: [{ key: 'a', hits: 1 }], words: [{ word: 'the', hits: 1 }] });
    await store.markSettingsChanged(200);

    await store.clear();

    expect(await store.allProgress()).toEqual([]);
    expect(await store.sessions()).toEqual([]);
    expect(await store.keyCounts()).toEqual([]);
    expect(await store.wordCounts()).toEqual([]);
    expect(await store.pending()).toEqual([]);
    expect(await store.owner()).toBeNull();
    expect(await store.settingsChangedAt()).toBeUndefined();
  });

  it('gives a new device id', async () => {
    const store = await openStore();
    const before = await store.deviceId();
    await store.clear();
    expect(await store.deviceId()).not.toBe(before);
  });

  it('keeps the new device id after a reload', async () => {
    const factory = new IDBFactory();
    const first = await UserStore.open(factory);
    await first.deviceId();
    await first.clear();
    const fresh = await first.deviceId();
    first.close();

    expect(await (await UserStore.open(factory)).deviceId()).toBe(fresh);
  });

  it('starts the outbox order again', async () => {
    const store = await openStore();
    await store.saveProgress(book(), at(0, 0, 1), 100);
    await store.clear();
    await store.saveProgress(book(), at(0, 0, 1), 100);
    expect(await store.pendingCount()).toBe(1);
  });
});

describe('onChange', () => {
  it('fires on local writes that queue something', async () => {
    const store = await openStore();
    const heard = vi.fn();
    store.onChange(heard);

    await store.saveProgress(book(), at(0, 0, 1), 100);
    await store.addSession(session());
    await store.addCounts({ keys: [{ key: 'a', hits: 1 }] });
    await store.markSettingsChanged(100);

    expect(heard).toHaveBeenCalledTimes(4);
  });

  it('stops firing after the returned function is called', async () => {
    const store = await openStore();
    const heard = vi.fn();
    const stop = store.onChange(heard);

    await store.saveProgress(book(), at(0, 0, 1), 100);
    stop();
    await store.saveProgress(book(), at(0, 0, 2), 200);

    expect(heard).toHaveBeenCalledTimes(1);
  });

  it('tells every listener', async () => {
    const store = await openStore();
    const one = vi.fn();
    const two = vi.fn();
    store.onChange(one);
    store.onChange(two);

    await store.saveProgress(book(), at(0, 0, 1), 100);

    expect(one).toHaveBeenCalledTimes(1);
    expect(two).toHaveBeenCalledTimes(1);
  });
});

describe('onSessionEnded', () => {
  it('fires once, after the store is emptied, when an account session ends', async () => {
    const store = await openStore();
    await store.setOwner('user-1');
    await store.saveProgress(book(), at(0, 0, 1), 100);
    const seen: (Position | undefined)[] = [];
    const heard = vi.fn(() => void store.progress('book-1').then((p) => seen.push(p?.position)));
    store.onSessionEnded(heard);

    expect(await store.endAccountSession({})).toBe(true);

    expect(heard).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(seen).toEqual([undefined]));
  });

  it('does not fire for a guest store, where there is no session to end', async () => {
    const store = await openStore();
    const heard = vi.fn();
    store.onSessionEnded(heard);

    expect(await store.endAccountSession({})).toBe(false);

    expect(heard).not.toHaveBeenCalled();
  });

  it('does not fire after the returned function is called', async () => {
    const store = await openStore();
    await store.setOwner('user-1');
    const heard = vi.fn();
    const stop = store.onSessionEnded(heard);
    stop();

    await store.endAccountSession({});

    expect(heard).not.toHaveBeenCalled();
  });
});

describe('closed', () => {
  it('is false while the connection is open', async () => {
    expect((await openStore()).closed).toBe(false);
  });

  it('is true after close', async () => {
    const store = await openStore();
    store.close();
    expect(store.closed).toBe(true);
  });

  it('is true after another connection opens the database at a higher version', async () => {
    const factory = new IDBFactory();
    const store = await UserStore.open(factory);
    await new Promise<void>((resolve, reject) => {
      const request = factory.open(USER_DB_NAME, 99);
      request.onsuccess = () => {
        request.result.close();
        resolve();
      };
      request.onerror = () => reject(request.error);
    });
    expect(store.closed).toBe(true);
  });
});
