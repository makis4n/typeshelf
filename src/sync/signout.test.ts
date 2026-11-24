import { IDBFactory } from 'fake-indexeddb';
import { expect, it, vi } from 'vitest';
import { PlaceKeeper } from '../book/place';
import type { Position } from '../book/types';
import { UserStore } from '../store/userStore';
import { FakeRemote } from './fakeRemote';
import { Sync } from './sync';

const at = (chapter: number, paragraph: number, char: number): Position => ({ chapter, paragraph, char });
const BOOK = { id: 'book-x', fingerprint: 'a'.repeat(64) };
const settings = { read: () => ({}), apply: () => {} };

it('a place typed after sign-out by a keeper still on the page never reaches the next account', async () => {
  const store = await UserStore.open(new IDBFactory());
  const remoteA = new FakeRemote();
  const remoteB = new FakeRemote();
  const earlier = at(2, 0, 0);
  // B has its own, earlier place in the same book.
  remoteB.progress.set(BOOK.id, {
    bookId: BOOK.id,
    fingerprint: BOOK.fingerprint,
    position: earlier,
    updatedAt: Date.now() - 10_000_000,
    deviceId: 'b-laptop',
  });

  const syncA = new Sync({ store, remote: remoteA, userId: 'A', settings });
  await syncA.start();
  const onLost = vi.fn();
  const keeper = new PlaceKeeper(async () => store, BOOK, onLost);
  keeper.save(at(7, 3, 40));
  await keeper.settled();
  await syncA.flushNow();
  expect(remoteA.progress.get(BOOK.id)?.position.chapter).toBe(7);

  // A signs out, but the book stays on the page with its keeper.
  syncA.stop();
  expect(await store.endAccountSession({})).toBe(true);

  keeper.save(at(7, 3, 46));
  await keeper.settled();
  expect(onLost).toHaveBeenCalledTimes(1);
  expect(await store.progress(BOOK.id)).toBeUndefined();
  expect(await store.pending()).toEqual([]);

  // The next person signs in as B.
  const syncB = new Sync({ store, remote: remoteB, userId: 'B', settings });
  await syncB.start();
  await syncB.flushNow();

  expect(remoteB.progress.get(BOOK.id)?.position).toEqual(earlier);
  expect((await store.progress(BOOK.id))?.position).toEqual(earlier);
});
