import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/** A fresh copy of the module, so each test starts with no store handed out. */
async function freshUserStore() {
  vi.resetModules();
  return (await import('./shared')).userStore;
}

describe('userStore', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('gives the same store on every call while it is open', async () => {
    const userStore = await freshUserStore();
    const first = await userStore();
    expect(await userStore()).toBe(first);
  });

  it('gives a different, open store once the one it handed out is closed', async () => {
    const userStore = await freshUserStore();
    const first = await userStore();
    first.close();

    const second = await userStore();
    expect(second).not.toBe(first);
    expect(second.closed).toBe(false);
    // The fresh one can be used.
    expect(await second.owner()).toBeNull();
  });
});
