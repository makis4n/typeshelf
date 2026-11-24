import { IDBFactory } from 'fake-indexeddb';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Book } from '../book/types';
import { BOOKS_DB_NAME, openBookStore } from './books';

const FP_A = 'a'.repeat(64);
const FP_B = 'b'.repeat(64);

const makeBook = (fingerprint: string, overrides: Partial<Book> = {}): Book => ({
  id: `import:${fingerprint}`,
  title: 'A Test Book',
  author: 'Ada Example',
  language: 'en',
  source: 'text',
  fingerprint,
  chapters: [
    { title: 'One', paragraphs: ['First paragraph.', 'Second paragraph.'] },
    { title: 'Two', paragraphs: ['Third paragraph.'] },
  ],
  ...overrides,
});

afterEach(() => {
  vi.useRealTimers();
});

describe('openBookStore', () => {
  it('saves a book and gets back all of it', async () => {
    const store = openBookStore(new IDBFactory());
    const book = makeBook(FP_A);
    await store.save(book);
    expect(await store.get(book.id)).toEqual(book);
  });

  it('returns a summary from save', async () => {
    const store = openBookStore(new IDBFactory());
    const summary = await store.save(makeBook(FP_A));
    expect(summary).toEqual({
      id: `import:${FP_A}`,
      title: 'A Test Book',
      author: 'Ada Example',
      language: 'en',
      source: 'text',
      fingerprint: FP_A,
      chapters: 2,
      addedAt: expect.any(Number),
    });
  });

  it('gives undefined for an unknown id', async () => {
    const store = openBookStore(new IDBFactory());
    expect(await store.get('import:nothing')).toBeUndefined();
  });

  it('lists summaries with a chapter count and no text', async () => {
    const store = openBookStore(new IDBFactory());
    await store.save(makeBook(FP_A));
    const [summary] = await store.list();
    expect(summary).toBeDefined();
    expect(summary!.chapters).toBe(2);
    expect(JSON.stringify(summary)).not.toContain('paragraph');
    expect(summary).not.toHaveProperty('paragraphs');
  });

  it('lists books in the order they were added', async () => {
    // Only the clock is faked: fake-indexeddb needs real timers.
    vi.useFakeTimers({ toFake: ['Date'] });
    const store = openBookStore(new IDBFactory());
    vi.setSystemTime(1_000);
    await store.save(makeBook(FP_B, { title: 'Zed, added first' }));
    vi.setSystemTime(2_000);
    await store.save(makeBook(FP_A, { title: 'Aardvark, added second' }));
    expect((await store.list()).map((summary) => summary.title)).toEqual(['Zed, added first', 'Aardvark, added second']);
  });

  it('lists nothing for an empty store', async () => {
    expect(await openBookStore(new IDBFactory()).list()).toEqual([]);
  });

  it('keeps one entry and the original addedAt when the same id is saved twice', async () => {
    // Only the clock is faked: fake-indexeddb needs real timers.
    vi.useFakeTimers({ toFake: ['Date'] });
    const store = openBookStore(new IDBFactory());
    vi.setSystemTime(1_000);
    const first = await store.save(makeBook(FP_A));
    vi.setSystemTime(5_000);
    const second = await store.save(makeBook(FP_A, { title: 'Renamed' }));

    expect(first.addedAt).toBe(1_000);
    expect(second.addedAt).toBe(1_000);
    const list = await store.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ title: 'Renamed', addedAt: 1_000 });
    expect((await store.get(`import:${FP_A}`))?.title).toBe('Renamed');
  });

  it('removes a deleted book from both get and list', async () => {
    const store = openBookStore(new IDBFactory());
    await store.save(makeBook(FP_A));
    await store.save(makeBook(FP_B));
    await store.delete(`import:${FP_A}`);
    expect(await store.get(`import:${FP_A}`)).toBeUndefined();
    expect((await store.list()).map((summary) => summary.id)).toEqual([`import:${FP_B}`]);
    expect(await store.findByFingerprint(FP_A)).toBeUndefined();
  });

  it('does not fail when deleting an id that is not there', async () => {
    const store = openBookStore(new IDBFactory());
    await expect(store.delete('import:nothing')).resolves.toBeUndefined();
  });

  it('finds a book by its fingerprint', async () => {
    const store = openBookStore(new IDBFactory());
    await store.save(makeBook(FP_A));
    await store.save(makeBook(FP_B, { title: 'Other' }));
    expect(await store.findByFingerprint(FP_B)).toMatchObject({ id: `import:${FP_B}`, title: 'Other' });
  });

  it('matches a fingerprint in any case', async () => {
    const store = openBookStore(new IDBFactory());
    await store.save(makeBook(FP_A));
    expect(await store.findByFingerprint(FP_A.toUpperCase())).toMatchObject({ id: `import:${FP_A}` });
  });

  it('gives undefined when no book has the fingerprint', async () => {
    const store = openBookStore(new IDBFactory());
    await store.save(makeBook(FP_A));
    expect(await store.findByFingerprint(FP_B)).toBeUndefined();
  });

  it('keeps its data after close and reopening with the same factory', async () => {
    const factory = new IDBFactory();
    const first = openBookStore(factory);
    const book = makeBook(FP_A);
    await first.save(book);
    first.close();

    const second = openBookStore(factory);
    expect(await second.get(book.id)).toEqual(book);
    expect(await second.list()).toHaveLength(1);
    expect(await second.findByFingerprint(FP_A)).toBeDefined();
  });

  it('reopens by itself when used after close', async () => {
    const store = openBookStore(new IDBFactory());
    await store.save(makeBook(FP_A));
    store.close();
    expect(await store.list()).toHaveLength(1);
  });

  it('keeps separate factories separate', async () => {
    const one = openBookStore(new IDBFactory());
    const two = openBookStore(new IDBFactory());
    await one.save(makeBook(FP_A));
    expect(await two.list()).toEqual([]);
  });

  it('uses a database named typeshelf-books', async () => {
    const factory = new IDBFactory();
    const store = openBookStore(factory);
    await store.save(makeBook(FP_A));
    expect(BOOKS_DB_NAME).toBe('typeshelf-books');
    expect((await factory.databases()).map((database) => database.name)).toEqual(['typeshelf-books']);
  });
});
