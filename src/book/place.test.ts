import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it, vi } from 'vitest';
import { buildPassage } from '../engine/text';
import { UserStore } from '../store/userStore';
import { openingPlace, placeAfterChapter, PlaceKeeper, samePlace, type PlaceStore } from './place';
import type { Position } from './types';

const at = (chapter: number, paragraph: number, char: number): Position => ({ chapter, paragraph, char });
const book = { id: 'book-1', fingerprint: 'a'.repeat(64) };

describe('samePlace', () => {
  it('is true for the same chapter, paragraph and character', () => {
    expect(samePlace(at(1, 2, 3), at(1, 2, 3))).toBe(true);
  });

  it.each([
    ['chapter', at(2, 2, 3)],
    ['paragraph', at(1, 3, 3)],
    ['character', at(1, 2, 4)],
  ])('is false when the %s differs', (_name, other) => {
    expect(samePlace(at(1, 2, 3), other)).toBe(false);
  });
});

describe('placeAfterChapter', () => {
  const passage = buildPassage(['One two.', 'Three four']);

  it('is the start of the next chapter when there is one', () => {
    expect(placeAfterChapter(3, passage, 0)).toEqual(at(1, 0, 0));
    expect(placeAfterChapter(3, passage, 1)).toEqual(at(2, 0, 0));
  });

  it('is the very end of the last chapter when there is no next one', () => {
    // "Three four" starts at char 0 of paragraph 1; "four" starts at 6 and is 4 long.
    expect(placeAfterChapter(1, passage, 0)).toEqual(at(0, 1, 10));
  });

  it('measures the end of the last chapter from its own index', () => {
    expect(placeAfterChapter(3, passage, 2)).toEqual(at(2, 1, 10));
  });

  it('is the start of an empty last chapter', () => {
    expect(placeAfterChapter(1, buildPassage([]), 0)).toEqual(at(0, 0, 0));
  });
});

describe('openingPlace', () => {
  it('opens the first chapter from its start when nothing is saved', () => {
    expect(openingPlace(4, undefined)).toEqual({ chapter: 0, place: undefined });
  });

  it('opens at the saved place when it is inside the book', () => {
    expect(openingPlace(4, at(2, 1, 5))).toEqual({ chapter: 2, place: at(2, 1, 5) });
  });

  it('opens at the last chapter when the saved chapter is the last', () => {
    expect(openingPlace(4, at(3, 0, 0))).toEqual({ chapter: 3, place: at(3, 0, 0) });
  });

  it('opens the last chapter from its start when the saved chapter is past the end', () => {
    expect(openingPlace(4, at(4, 1, 5))).toEqual({ chapter: 3, place: undefined });
    expect(openingPlace(4, at(99, 0, 0))).toEqual({ chapter: 3, place: undefined });
  });

  it('opens the first chapter from its start when the saved chapter is negative', () => {
    expect(openingPlace(4, at(-1, 0, 0))).toEqual({ chapter: 0, place: undefined });
  });

  it.each([1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'opens the first chapter from its start when the saved chapter is %s',
    (chapter) => {
      expect(openingPlace(4, at(chapter, 0, 0))).toEqual({ chapter: 0, place: undefined });
    },
  );
});

/** A store whose writes finish only when the test says so. */
function controlledStore(initial?: Position) {
  const writes: { place: Position; done: () => void; fail: (error: Error) => void }[] = [];
  let stored = initial;
  const store: PlaceStore = {
    saveProgress: (_book, place) =>
      new Promise((resolve, reject) => {
        writes.push({
          place,
          done: () => {
            stored = place;
            resolve(undefined);
          },
          fail: reject,
        });
      }),
    progress: async () => (stored ? { position: stored } : undefined),
  };
  return {
    store,
    writes,
    /** Another device's place arriving, as the sync would write it. */
    setStored: (place: Position | undefined) => (stored = place),
  };
}

/** Lets pending promise callbacks run. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('PlaceKeeper', () => {
  it('reads the stored place', async () => {
    const fake = controlledStore(at(1, 0, 4));
    const keeper = new PlaceKeeper(async () => fake.store, book);
    expect(await keeper.read()).toEqual(at(1, 0, 4));
  });

  it('reads nothing when no place is stored', async () => {
    const fake = controlledStore();
    expect(await new PlaceKeeper(async () => fake.store, book).read()).toBeUndefined();
  });

  it('returns from save at once, before the write has finished', async () => {
    const fake = controlledStore();
    const keeper = new PlaceKeeper(async () => fake.store, book);
    expect(keeper.save(at(0, 0, 5))).toBeUndefined();
    await tick();
    expect(fake.writes).toHaveLength(1);
    let settled = false;
    void keeper.settled().then(() => (settled = true));
    await tick();
    expect(settled).toBe(false);
    fake.writes[0]!.done();
    await keeper.settled();
    expect(settled).toBe(true);
  });

  it('passes the book and the place to the store', async () => {
    const saveProgress = vi.fn().mockResolvedValue(undefined);
    const keeper = new PlaceKeeper(async () => ({ saveProgress, progress: async () => undefined }), book);
    keeper.save(at(0, 1, 2));
    await keeper.settled();
    expect(saveProgress).toHaveBeenCalledWith(book, at(0, 1, 2));
  });

  it('runs one write at a time and writes only the newest of the places noted meanwhile', async () => {
    const fake = controlledStore();
    const keeper = new PlaceKeeper(async () => fake.store, book);

    keeper.save(at(0, 0, 1));
    await tick();
    keeper.save(at(0, 0, 2));
    keeper.save(at(0, 0, 3));
    keeper.save(at(0, 0, 4));
    await tick();
    expect(fake.writes.map((w) => w.place)).toEqual([at(0, 0, 1)]);

    fake.writes[0]!.done();
    await tick();
    expect(fake.writes.map((w) => w.place)).toEqual([at(0, 0, 1), at(0, 0, 4)]);

    fake.writes[1]!.done();
    await keeper.settled();
    expect(fake.writes).toHaveLength(2);
  });

  it('writes nothing for the place the store already holds', async () => {
    const fake = controlledStore(at(0, 0, 7));
    const keeper = new PlaceKeeper(async () => fake.store, book);
    await keeper.read();
    keeper.save(at(0, 0, 7));
    await keeper.settled();
    expect(fake.writes).toHaveLength(0);
  });

  it('writes nothing when the same place is saved again after a write', async () => {
    const fake = controlledStore();
    const keeper = new PlaceKeeper(async () => fake.store, book);
    keeper.save(at(0, 0, 1));
    await tick();
    fake.writes[0]!.done();
    await keeper.settled();

    keeper.save(at(0, 0, 1));
    await keeper.settled();
    expect(fake.writes).toHaveLength(1);
  });

  it('writes nothing when places noted during a write end back on the stored one', async () => {
    const fake = controlledStore();
    const keeper = new PlaceKeeper(async () => fake.store, book);
    keeper.save(at(0, 0, 1));
    await tick();
    keeper.save(at(0, 0, 2));
    keeper.save(at(0, 0, 1));
    fake.writes[0]!.done();
    await keeper.settled();
    expect(fake.writes).toHaveLength(1);
  });

  it('never throws to the caller when a write fails, and warns once', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const saveProgress = vi.fn().mockRejectedValue(new Error('disk full'));
    const keeper = new PlaceKeeper(async () => ({ saveProgress, progress: async () => undefined }), book);

    expect(() => keeper.save(at(0, 0, 1))).not.toThrow();
    await expect(keeper.settled()).resolves.toBeUndefined();
    keeper.save(at(0, 0, 2));
    await expect(keeper.settled()).resolves.toBeUndefined();

    expect(saveProgress).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('still attempts later saves after a write has failed', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fake = controlledStore();
    const keeper = new PlaceKeeper(async () => fake.store, book);

    keeper.save(at(0, 0, 1));
    await tick();
    fake.writes[0]!.fail(new Error('boom'));
    await keeper.settled();

    keeper.save(at(0, 0, 2));
    await tick();
    expect(fake.writes.map((w) => w.place)).toEqual([at(0, 0, 1), at(0, 0, 2)]);
    fake.writes[1]!.done();
    await keeper.settled();
    expect(await keeper.read()).toEqual(at(0, 0, 2));
    warn.mockRestore();
  });

  it('does not throw when the store cannot be opened, and tries again next time', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const saveProgress = vi.fn().mockResolvedValue(undefined);
    const open = vi
      .fn<() => Promise<PlaceStore>>()
      .mockRejectedValueOnce(new Error('blocked'))
      .mockResolvedValue({ saveProgress, progress: async () => undefined });
    const keeper = new PlaceKeeper(open, book);

    keeper.save(at(0, 0, 1));
    await keeper.settled();
    expect(saveProgress).not.toHaveBeenCalled();

    keeper.save(at(0, 0, 2));
    await keeper.settled();
    expect(saveProgress).toHaveBeenCalledWith(book, at(0, 0, 2));
    warn.mockRestore();
  });

  it('reads nothing, without throwing, when the store cannot be read', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const keeper = new PlaceKeeper(async () => {
      throw new Error('blocked');
    }, book);
    expect(await keeper.read()).toBeUndefined();
    expect(await keeper.movedElsewhere()).toBeUndefined();
    warn.mockRestore();
  });

  describe('movedElsewhere', () => {
    it('is undefined when the stored place is the one this keeper last read', async () => {
      const fake = controlledStore(at(0, 0, 3));
      const keeper = new PlaceKeeper(async () => fake.store, book);
      await keeper.read();
      expect(await keeper.movedElsewhere()).toBeUndefined();
    });

    it('is undefined when the stored place is the one this keeper wrote', async () => {
      const fake = controlledStore();
      const keeper = new PlaceKeeper(async () => fake.store, book);
      keeper.save(at(0, 0, 9));
      await tick();
      fake.writes[0]!.done();
      await keeper.settled();
      expect(await keeper.movedElsewhere()).toBeUndefined();
    });

    it('returns the stored place when something else changed it', async () => {
      const fake = controlledStore(at(0, 0, 3));
      const keeper = new PlaceKeeper(async () => fake.store, book);
      await keeper.read();
      fake.setStored(at(2, 0, 0));
      expect(await keeper.movedElsewhere()).toEqual(at(2, 0, 0));
    });

    it('reports a move only once', async () => {
      const fake = controlledStore(at(0, 0, 3));
      const keeper = new PlaceKeeper(async () => fake.store, book);
      await keeper.read();
      fake.setStored(at(2, 0, 0));
      await keeper.movedElsewhere();
      expect(await keeper.movedElsewhere()).toBeUndefined();
    });

    it('is undefined while a write of its own is in flight, even if the store holds another place', async () => {
      const fake = controlledStore(at(0, 0, 3));
      const keeper = new PlaceKeeper(async () => fake.store, book);
      await keeper.read();
      keeper.save(at(0, 0, 8));
      await tick();
      fake.setStored(at(2, 0, 0));
      expect(await keeper.movedElsewhere()).toBeUndefined();
      fake.writes[0]!.done();
      await keeper.settled();
    });

    it('is undefined when nothing is stored', async () => {
      const fake = controlledStore();
      const keeper = new PlaceKeeper(async () => fake.store, book);
      expect(await keeper.movedElsewhere()).toBeUndefined();
    });
  });

  describe('when the store changes hands', () => {
    /** A store with an owner the test can change, writing at once. */
    function ownedStore(initial: string | null) {
      const saved: Position[] = [];
      let owner = initial;
      let stored: Position | undefined;
      const store: PlaceStore = {
        saveProgress: async (_book, place) => {
          saved.push(place);
          stored = place;
        },
        progress: async () => (stored ? { position: stored } : undefined),
        owner: async () => owner,
      };
      return { store, saved, setOwner: (next: string | null) => (owner = next), setStored: (p: Position) => (stored = p) };
    }

    it('writes nothing more and says so once when the account signs out', async () => {
      const fake = ownedStore('A');
      const onLost = vi.fn();
      const keeper = new PlaceKeeper(async () => fake.store, book, onLost);
      keeper.save(at(0, 0, 1));
      await keeper.settled();

      fake.setOwner(null);
      keeper.save(at(0, 0, 2));
      await keeper.settled();
      keeper.save(at(0, 0, 3));
      await keeper.settled();

      expect(fake.saved).toEqual([at(0, 0, 1)]);
      expect(onLost).toHaveBeenCalledTimes(1);
    });

    it('writes nothing more and says so once when another account takes the store', async () => {
      const fake = ownedStore('A');
      const onLost = vi.fn();
      const keeper = new PlaceKeeper(async () => fake.store, book, onLost);
      keeper.save(at(0, 0, 1));
      await keeper.settled();

      fake.setOwner('B');
      keeper.save(at(0, 0, 2));
      await keeper.settled();
      keeper.save(at(0, 0, 3));
      await keeper.settled();

      expect(fake.saved).toEqual([at(0, 0, 1)]);
      expect(onLost).toHaveBeenCalledTimes(1);
    });

    it('keeps saving when a guest signs in to an account', async () => {
      const fake = ownedStore(null);
      const onLost = vi.fn();
      const keeper = new PlaceKeeper(async () => fake.store, book, onLost);
      keeper.save(at(0, 0, 1));
      await keeper.settled();

      fake.setOwner('B');
      keeper.save(at(0, 0, 2));
      await keeper.settled();
      keeper.save(at(0, 0, 3));
      await keeper.settled();

      expect(fake.saved).toEqual([at(0, 0, 1), at(0, 0, 2), at(0, 0, 3)]);
      expect(onLost).not.toHaveBeenCalled();
    });

    it('does not write a place noted before the owner changed', async () => {
      const fake = ownedStore('A');
      const onLost = vi.fn();
      const keeper = new PlaceKeeper(async () => fake.store, book, onLost);
      await keeper.read();

      keeper.save(at(0, 0, 5)); // noted, not yet written
      fake.setOwner(null);
      await keeper.settled();

      expect(fake.saved).toEqual([]);
      expect(onLost).toHaveBeenCalledTimes(1);
    });

    it('reads nothing and sees no move after the store has changed hands', async () => {
      const fake = ownedStore('A');
      fake.setStored(at(1, 0, 0));
      const keeper = new PlaceKeeper(async () => fake.store, book, vi.fn());
      expect(await keeper.read()).toEqual(at(1, 0, 0));

      fake.setOwner('B');
      fake.setStored(at(4, 0, 0));
      expect(await keeper.movedElsewhere()).toBeUndefined();
      expect(await keeper.read()).toBeUndefined();
    });

    it('is never lost with a store that has no owner', async () => {
      const onLost = vi.fn();
      const fake = controlledStore();
      const keeper = new PlaceKeeper(async () => fake.store, book, onLost);
      keeper.save(at(0, 0, 1));
      await tick();
      fake.writes[0]!.done();
      await keeper.settled();
      expect(await keeper.read()).toEqual(at(0, 0, 1));
      expect(onLost).not.toHaveBeenCalled();
    });
  });

  describe('with the real user store', () => {
    it('reads back a saved place and queues it for the account', async () => {
      const store = await UserStore.open(new IDBFactory());
      const keeper = new PlaceKeeper(async () => store, book);

      keeper.save(at(1, 2, 3));
      await keeper.settled();

      expect((await store.progress(book.id))?.position).toEqual(at(1, 2, 3));
      expect(await new PlaceKeeper(async () => store, book).read()).toEqual(at(1, 2, 3));
      const pending = await store.pending();
      expect(pending).toHaveLength(1);
      expect(pending[0]).toMatchObject({ id: 'progress:book-1', kind: 'progress', ref: 'book-1' });
    });

    it('leaves one queued entry after several places are saved in a row', async () => {
      const store = await UserStore.open(new IDBFactory());
      const keeper = new PlaceKeeper(async () => store, book);
      for (let char = 1; char <= 5; char += 1) {
        keeper.save(at(0, 0, char));
        await keeper.settled();
      }
      expect((await store.progress(book.id))?.position).toEqual(at(0, 0, 5));
      expect(await store.pending()).toHaveLength(1);
    });

    it('notices a place written to the store by something else', async () => {
      const store = await UserStore.open(new IDBFactory());
      const keeper = new PlaceKeeper(async () => store, book);
      keeper.save(at(0, 0, 1));
      await keeper.settled();

      await store.saveProgress(book, at(4, 0, 0));
      expect(await keeper.movedElsewhere()).toEqual(at(4, 0, 0));
    });
  });
});
