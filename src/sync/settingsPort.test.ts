import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadSettings, onSettingsSaved, saveSetting, type Settings } from '../settings';
import { UserStore } from '../store/userStore';
import { FakeRemote } from './fakeRemote';
import { storedSettingsPort } from './settingsPort';
import { Sync } from './sync';

/** A small in-memory stand-in for localStorage, shared by every "tab" in a test. */
beforeEach(() => {
  const data = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    removeItem: (key: string) => void data.delete(key),
  });
});
afterEach(() => vi.unstubAllGlobals());

/**
 * A tab: its own copy of the settings in memory (as the page keeps them),
 * the browser's shared storage underneath, and a sync for the account.
 */
function openTab(store: UserStore, account: FakeRemote, clock: { time: number }) {
  const tab = { shown: loadSettings() };
  const sync = new Sync({
    store,
    remote: account,
    userId: 'user-x',
    settings: storedSettingsPort((next) => (tab.shown = next)),
    now: () => clock.time,
    timers: { set: () => 0, clear: () => {} },
  });
  /** What the page does when the reader picks an option. */
  const pick = async <K extends keyof Settings>(name: K, value: Settings[K]) => {
    tab.shown = { ...tab.shown, [name]: value };
    saveSetting(name, value);
    await sync.settingsChanged();
  };
  return { tab, sync, pick };
}

describe('settings with two tabs open on one account', () => {
  it('a tab that missed a change does not send the old value to the account', async () => {
    const clock = { time: 10_000_000 };
    const store = await UserStore.open(new IDBFactory());
    const account = new FakeRemote();
    const a = openTab(store, account, clock);
    const b = openTab(store, account, clock);
    await a.sync.start();
    await b.sync.start();

    // Tab A changes the caret. Tab B has not heard, and is the one that syncs first.
    clock.time += 1000;
    await a.pick('caretStyle', 'block');
    expect(b.tab.shown.caretStyle).toBe('line');
    await b.sync.refresh();
    await a.sync.flushNow();

    expect((account.settings?.data as Settings).caretStyle).toBe('block');
    expect(loadSettings().caretStyle).toBe('block');
  });

  it('a later change in the other tab keeps the first tab’s choice in the account', async () => {
    const clock = { time: 10_000_000 };
    const store = await UserStore.open(new IDBFactory());
    const account = new FakeRemote();
    const a = openTab(store, account, clock);
    const b = openTab(store, account, clock);
    await a.sync.start();
    await b.sync.start();

    clock.time += 1000;
    await a.pick('caretStyle', 'block');
    await a.sync.flushNow();
    clock.time += 1000;
    await b.pick('smoothCaret', 'fast');
    await b.sync.flushNow();

    // The account holds both choices, exactly as the browser's storage does.
    expect(account.settings?.data).toEqual(loadSettings());
    expect(account.settings?.data).toMatchObject({ caretStyle: 'block', smoothCaret: 'fast' });
  });

  it('settings from the account are stored whole, even where this tab’s own copy already matched', async () => {
    const clock = { time: 10_000_000 };
    const store = await UserStore.open(new IDBFactory());
    const account = new FakeRemote();
    const a = openTab(store, account, clock);
    const b = openTab(store, account, clock);
    await a.sync.start();
    await b.sync.start();
    clock.time += 1000;
    await a.pick('caretStyle', 'block');
    await a.sync.flushNow();

    // Another device sets the caret back to line. Tab B, whose own copy still says line, is the one that pulls.
    clock.time += 1000;
    account.settings = { data: { ...loadSettings(), caretStyle: 'line' }, updatedAt: clock.time, deviceId: 'phone' };
    await b.sync.refresh();
    expect(loadSettings().caretStyle).toBe('line');
    expect(b.tab.shown.caretStyle).toBe('line');
  });

  it('putting the account’s settings into effect is not mistaken for the reader changing them', async () => {
    const clock = { time: 10_000_000 };
    const store = await UserStore.open(new IDBFactory());
    const account = new FakeRemote();
    account.settings = { data: { caretStyle: 'box' }, updatedAt: 5_000_000, deviceId: 'phone' };
    const { sync } = openTab(store, account, clock);
    // As the page wires it: every save of the settings tells the sync.
    const stop = onSettingsSaved(() => void sync.settingsChanged());
    await sync.start();
    stop();

    expect(loadSettings().caretStyle).toBe('box');
    expect(account.count('pushSettings')).toBe(0);
    expect(await store.pendingCount()).toBe(0);
  });
});
