import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it, vi } from 'vitest';
import type { Position } from '../book/types';
import type { ProgressRecord } from '../store/types';
import { UserStore } from '../store/userStore';
import { FakeRemote } from './fakeRemote';
import { DEFAULT_INTERVAL_MS, Sync, type SettingsPort, type SyncState, type Timers } from './sync';

const at = (chapter: number, paragraph: number, char: number): Position => ({ chapter, paragraph, char });
const BOOK = { id: 'book-1', fingerprint: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' };
const USER = 'user-1';

/** Timers that never run by themselves: the test looks at what was asked for and fires it by hand. */
class ManualTimers implements Timers {
  scheduled: { handle: number; run: () => void; ms: number }[] = [];
  cleared: number[] = [];
  private next = 1;

  set(run: () => void, ms: number): unknown {
    const handle = this.next++;
    this.scheduled.push({ handle, run, ms });
    return handle;
  }

  clear(handle: unknown): void {
    this.cleared.push(handle as number);
    this.scheduled = this.scheduled.filter((timer) => timer.handle !== handle);
  }

  get delays(): number[] {
    return this.scheduled.map((timer) => timer.ms);
  }

  /** Run the oldest waiting timer. */
  fire(): void {
    const timer = this.scheduled.shift();
    if (!timer) throw new Error('no timer is waiting');
    timer.run();
  }
}

/** The settings as the page keeps them: a value, and a note of every time the account's copy was applied. */
class FakeSettings implements SettingsPort {
  applied: unknown[] = [];
  onApply: (() => void) | undefined;

  constructor(public value: unknown = { theme: 'light' }) {}

  read(): unknown {
    return this.value;
  }

  apply(data: unknown): void {
    this.value = data;
    this.applied.push(data);
    this.onApply?.();
  }
}

interface DeviceOptions {
  userId?: string;
  intervalMs?: number;
  time?: number;
  settings?: unknown;
}

/** One device: its own local store, clock, timers and settings, syncing to the shared account. */
async function openDevice(remote: FakeRemote, options: DeviceOptions = {}) {
  const store = await UserStore.open(new IDBFactory());
  const timers = new ManualTimers();
  const clock = { time: options.time ?? 1000 };
  const settings = new FakeSettings(options.settings);
  const sync = new Sync({
    store,
    remote,
    userId: options.userId ?? USER,
    settings,
    intervalMs: options.intervalMs,
    now: () => clock.time,
    timers,
  });
  return { store, timers, clock, settings, sync };
}

/** A place saved on some other device, put straight into the account. */
function putRemote(remote: FakeRemote, position: Position, updatedAt: number, deviceId = 'other-device'): void {
  const row: ProgressRecord = { bookId: BOOK.id, fingerprint: BOOK.fingerprint, position, updatedAt, deviceId };
  remote.progress.set(BOOK.id, row);
}

function stateLog(sync: Sync): SyncState[] {
  const seen: SyncState[] = [];
  sync.onState((state) => seen.push(state));
  return seen;
}

const waitForState = (sync: Sync, state: SyncState) => vi.waitFor(() => expect(sync.current()).toBe(state));

describe('two devices', () => {
  it('shows progress made on one device on a second device after it starts', async () => {
    const remote = new FakeRemote();
    const a = await openDevice(remote);
    await a.store.saveProgress(BOOK, at(2, 3, 4), 100);
    await a.sync.start();

    const b = await openDevice(remote);
    await b.sync.start();

    const onB = await b.store.progress(BOOK.id);
    expect(onB!.position).toEqual(at(2, 3, 4));
    expect(onB!.deviceId).toBe(await a.store.deviceId());
    expect(await b.sync.aheadFor(BOOK.id)).toBeUndefined();
  });

  it('does not queue the place it just took from the account', async () => {
    const remote = new FakeRemote();
    const a = await openDevice(remote);
    await a.store.saveProgress(BOOK, at(2, 3, 4), 100);
    await a.sync.start();

    const b = await openDevice(remote);
    await b.sync.start();

    expect((await b.store.pending()).filter((entry) => entry.kind === 'progress')).toEqual([]);
    expect(remote.sent('pushProgress')).toHaveLength(1);
  });

  it('moves silently when the account place is newer but further back', async () => {
    const remote = new FakeRemote();
    putRemote(remote, at(1, 0, 0), 300);
    const device = await openDevice(remote);
    await device.store.saveProgress(BOOK, at(2, 0, 0), 100);
    const listener = vi.fn();
    device.sync.onAhead(listener);

    await device.sync.start();

    expect((await device.store.progress(BOOK.id))!.position).toEqual(at(1, 0, 0));
    expect(await device.sync.aheadFor(BOOK.id)).toBeUndefined();
    expect(listener).not.toHaveBeenCalled();
  });

  it('keeps its own place and gives it to the account when it is newer and further on', async () => {
    const remote = new FakeRemote();
    putRemote(remote, at(1, 0, 0), 100);
    const device = await openDevice(remote);
    await device.store.saveProgress(BOOK, at(2, 0, 0), 300);

    await device.sync.start();

    expect((await device.store.progress(BOOK.id))!.position).toEqual(at(2, 0, 0));
    expect(remote.progress.get(BOOK.id)!.position).toEqual(at(2, 0, 0));
    expect(remote.progress.get(BOOK.id)!.updatedAt).toBe(300);
  });

  it('does not let an older save pushed late overwrite a newer one on the account', async () => {
    const remote = new FakeRemote();
    const a = await openDevice(remote);
    const b = await openDevice(remote);
    await a.store.saveProgress(BOOK, at(3, 0, 0), 200);
    await b.store.saveProgress(BOOK, at(1, 0, 0), 100);

    await a.sync.start();
    await b.sync.start();

    const account = remote.progress.get(BOOK.id)!;
    expect(account.updatedAt).toBe(200);
    expect(account.position).toEqual(at(3, 0, 0));
    expect(account.deviceId).toBe(await a.store.deviceId());
    // B is behind, so it is asked rather than moved.
    expect((await b.sync.aheadFor(BOOK.id))!.there.position).toEqual(at(3, 0, 0));
    expect((await b.store.progress(BOOK.id))!.position).toEqual(at(1, 0, 0));
  });

  it('moves the device that was further on but older back to the newer place on the account', async () => {
    const remote = new FakeRemote();
    const a = await openDevice(remote);
    const b = await openDevice(remote);
    await a.store.saveProgress(BOOK, at(1, 0, 0), 200);
    await b.store.saveProgress(BOOK, at(3, 0, 0), 100);

    await a.sync.start();
    await b.sync.start();

    expect(remote.progress.get(BOOK.id)!.position).toEqual(at(1, 0, 0));
    expect((await b.store.progress(BOOK.id))!.position).toEqual(at(1, 0, 0));
  });

  it('gives a device the newer save of another device when it refreshes', async () => {
    const remote = new FakeRemote();
    const a = await openDevice(remote);
    const b = await openDevice(remote);
    await a.sync.start();
    await b.sync.start();

    await a.store.saveProgress(BOOK, at(1, 0, 0), 500);
    await a.sync.flushNow();
    await b.sync.refresh();

    expect((await b.store.progress(BOOK.id))!.position).toEqual(at(1, 0, 0));
  });

  it('adds key and word counts from both devices on the account without overwriting each other', async () => {
    const remote = new FakeRemote();
    const a = await openDevice(remote);
    const b = await openDevice(remote);
    await a.store.addCounts({ keys: [{ key: 'a', hits: 3, misses: 1, ms: 300 }], words: [{ word: 'the', hits: 2 }] });
    await b.store.addCounts({ keys: [{ key: 'a', hits: 4, misses: 2, ms: 400 }], words: [{ word: 'the', hits: 5, misses: 1 }] });

    await a.sync.start();
    await b.sync.start();

    expect(remote.totalForKey('a')).toEqual({ hits: 7, misses: 3, totalMs: 700 });
    expect(remote.totalForWord('the')).toEqual({ hits: 7, misses: 1 });
  });
});

describe('guest merge', () => {
  it('sends everything typed before signing in and makes the user the owner', async () => {
    const remote = new FakeRemote();
    const guest = await openDevice(remote);
    await guest.store.saveProgress(BOOK, at(1, 2, 3), 100);
    await guest.store.addSession({
      id: 's1',
      bookId: BOOK.id,
      startedAt: 0,
      endedAt: 1000,
      activeMs: 900,
      words: 10,
      wpm: 30,
      accuracy: 0.9,
    });
    await guest.store.addCounts({ keys: [{ key: 'a', hits: 3, misses: 1, ms: 250 }], words: [{ word: 'the', hits: 2, misses: 1 }] });
    expect(await guest.store.owner()).toBeNull();

    await guest.sync.start();

    const deviceId = await guest.store.deviceId();
    expect(remote.progress.get(BOOK.id)!.position).toEqual(at(1, 2, 3));
    expect(remote.sessions.get('s1')).toMatchObject({ bookId: BOOK.id, deviceId });
    expect(remote.keyRow(deviceId, 'a')).toEqual({ key: 'a', hits: 3, misses: 1, totalMs: 250 });
    expect(remote.wordRow(deviceId, 'the')).toEqual({ word: 'the', hits: 2, misses: 1 });
    expect(await guest.store.owner()).toBe(USER);
    expect(await guest.store.pendingCount()).toBe(0);
    expect(guest.sync.current()).toBe('synced');
  });

  it('keeps the local place and asks when the account is further on in the same book', async () => {
    const remote = new FakeRemote();
    putRemote(remote, at(3, 0, 0), 300);
    const guest = await openDevice(remote);
    await guest.store.saveProgress(BOOK, at(1, 0, 0), 200);
    const listener = vi.fn();
    guest.sync.onAhead(listener);

    await guest.sync.start();

    expect((await guest.store.progress(BOOK.id))!.position).toEqual(at(1, 0, 0));
    expect(await guest.sync.aheadFor(BOOK.id)).toEqual({
      bookId: BOOK.id,
      here: at(1, 0, 0),
      there: { position: at(3, 0, 0), updatedAt: 300, deviceId: 'other-device' },
    });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(BOOK.id);
  });

  it('does not raise the same question again when pulling again', async () => {
    const remote = new FakeRemote();
    putRemote(remote, at(3, 0, 0), 300);
    const guest = await openDevice(remote);
    await guest.store.saveProgress(BOOK, at(1, 0, 0), 200);
    const listener = vi.fn();
    guest.sync.onAhead(listener);
    await guest.sync.start();

    await guest.sync.refresh();
    await guest.sync.refresh();

    expect(listener).toHaveBeenCalledTimes(1);
    expect(await guest.sync.aheadFor(BOOK.id)).toBeDefined();
  });

  it('raises a new question when the other device saves again further on', async () => {
    const remote = new FakeRemote();
    putRemote(remote, at(3, 0, 0), 300);
    const guest = await openDevice(remote);
    await guest.store.saveProgress(BOOK, at(1, 0, 0), 200);
    const listener = vi.fn();
    guest.sync.onAhead(listener);
    await guest.sync.start();

    putRemote(remote, at(4, 0, 0), 400);
    await guest.sync.refresh();

    expect(listener).toHaveBeenCalledTimes(2);
    expect((await guest.sync.aheadFor(BOOK.id))!.there.position).toEqual(at(4, 0, 0));
  });

  it('stops telling a listener once it has unsubscribed', async () => {
    const remote = new FakeRemote();
    putRemote(remote, at(3, 0, 0), 300);
    const guest = await openDevice(remote);
    await guest.store.saveProgress(BOOK, at(1, 0, 0), 200);
    const listener = vi.fn();
    guest.sync.onAhead(listener)();

    await guest.sync.start();

    expect(listener).not.toHaveBeenCalled();
  });

  it('answering yes returns the account place and sends it to the account', async () => {
    const remote = new FakeRemote();
    putRemote(remote, at(3, 0, 0), 300);
    const guest = await openDevice(remote, { time: 500 });
    await guest.store.saveProgress(BOOK, at(1, 0, 0), 200);
    await guest.sync.start();

    const place = await guest.sync.answerAhead(BOOK.id, true);
    await guest.sync.flushNow();

    expect(place).toEqual(at(3, 0, 0));
    expect(await guest.sync.aheadFor(BOOK.id)).toBeUndefined();
    const account = remote.progress.get(BOOK.id)!;
    expect(account.position).toEqual(at(3, 0, 0));
    expect(account.deviceId).toBe(await guest.store.deviceId());
    expect(account.updatedAt).toBeGreaterThan(300);
  });

  it('answering no keeps the local place, sends it to the account and is not asked again', async () => {
    const remote = new FakeRemote();
    putRemote(remote, at(3, 0, 0), 300);
    const guest = await openDevice(remote, { time: 500 });
    await guest.store.saveProgress(BOOK, at(1, 0, 0), 200);
    await guest.sync.start();
    const listener = vi.fn();
    guest.sync.onAhead(listener);

    const place = await guest.sync.answerAhead(BOOK.id, false);
    await guest.sync.flushNow();
    await guest.sync.refresh();

    expect(place).toEqual(at(1, 0, 0));
    expect(remote.progress.get(BOOK.id)!.position).toEqual(at(1, 0, 0));
    expect(await guest.sync.aheadFor(BOOK.id)).toBeUndefined();
    expect(listener).not.toHaveBeenCalled();
  });

  it('is not asked again about a declined save even if the account still holds it', async () => {
    const remote = new FakeRemote();
    putRemote(remote, at(3, 0, 0), 300);
    const guest = await openDevice(remote, { time: 100 });
    await guest.store.saveProgress(BOOK, at(1, 0, 0), 200);
    await guest.sync.start();

    await guest.sync.answerAhead(BOOK.id, false);
    // The answer is newer than the account's copy, so it replaces it.
    await guest.sync.flushNow();
    // Put the declined save back, as if the other device had saved it later.
    putRemote(remote, at(3, 0, 0), 300);
    await guest.sync.refresh();

    expect(await guest.sync.aheadFor(BOOK.id)).toBeUndefined();
  });

  it('answering when nothing was asked returns the current place', async () => {
    const remote = new FakeRemote();
    const guest = await openDevice(remote);
    await guest.store.saveProgress(BOOK, at(1, 0, 0), 200);
    await guest.sync.start();

    expect(await guest.sync.answerAhead(BOOK.id, true)).toEqual(at(1, 0, 0));
    expect(await guest.sync.answerAhead('unknown-book', true)).toBeUndefined();
  });
});

describe('settings', () => {
  it('sends the local settings on first start when the account has none', async () => {
    const remote = new FakeRemote();
    const device = await openDevice(remote, { settings: { theme: 'dark' }, time: 700 });

    await device.sync.start();

    expect(remote.settings).toEqual({ data: { theme: 'dark' }, updatedAt: 700, deviceId: await device.store.deviceId() });
    expect(device.settings.applied).toEqual([]);
  });

  it('applies the account settings on first meeting even if the guest changed theirs more recently', async () => {
    const remote = new FakeRemote();
    remote.settings = { data: { theme: 'sepia' }, updatedAt: 100, deviceId: 'other-device' };
    const device = await openDevice(remote, { settings: { theme: 'dark' } });
    await device.store.markSettingsChanged(900);

    await device.sync.start();

    expect(device.settings.applied).toEqual([{ theme: 'sepia' }]);
    expect(device.settings.value).toEqual({ theme: 'sepia' });
    expect(remote.count('pushSettings')).toBe(0);
    expect(remote.settings!.data).toEqual({ theme: 'sepia' });
    expect(await device.store.settingsChangedAt()).toBe(100);
    expect(await device.store.pendingCount()).toBe(0);
  });

  it('applies the account settings on first meeting when the guest never changed theirs', async () => {
    const remote = new FakeRemote();
    remote.settings = { data: { theme: 'sepia' }, updatedAt: 100, deviceId: 'other-device' };
    const device = await openDevice(remote);

    await device.sync.start();

    expect(device.settings.applied).toEqual([{ theme: 'sepia' }]);
  });

  it('sends a local settings change with the new time after joining', async () => {
    const remote = new FakeRemote();
    remote.settings = { data: { theme: 'sepia' }, updatedAt: 100, deviceId: 'other-device' };
    const device = await openDevice(remote);
    await device.sync.start();

    device.clock.time = 2000;
    device.settings.value = { theme: 'night' };
    await device.sync.settingsChanged();
    await device.sync.flushNow();

    expect(remote.settings).toEqual({ data: { theme: 'night' }, updatedAt: 2000, deviceId: await device.store.deviceId() });
  });

  it('applies a remote copy newer than the local change time on refresh', async () => {
    const remote = new FakeRemote();
    const device = await openDevice(remote, { time: 1000 });
    await device.sync.start();
    device.settings.applied.length = 0;

    remote.settings = { data: { theme: 'newer' }, updatedAt: 5000, deviceId: 'other-device' };
    await device.sync.refresh();

    expect(device.settings.applied).toEqual([{ theme: 'newer' }]);
    expect(await device.store.settingsChangedAt()).toBe(5000);
  });

  it('does not apply a remote copy older than the local change time on refresh', async () => {
    const remote = new FakeRemote();
    const device = await openDevice(remote, { time: 3000 });
    await device.sync.start();
    await device.sync.settingsChanged();
    await device.sync.flushNow();

    remote.settings = { data: { theme: 'older' }, updatedAt: 2000, deviceId: 'other-device' };
    await device.sync.refresh();

    expect(device.settings.applied).toEqual([]);
  });

  it('does not queue a settings push when applying the account copy changes settings re-entrantly', async () => {
    const remote = new FakeRemote();
    remote.settings = { data: { theme: 'sepia' }, updatedAt: 100, deviceId: 'other-device' };
    const device = await openDevice(remote);
    device.settings.onApply = () => void device.sync.settingsChanged();

    await device.sync.start();
    await device.sync.refresh();

    expect(remote.count('pushSettings')).toBe(0);
    expect(await device.store.pendingCount()).toBe(0);
    expect(device.timers.scheduled).toEqual([]);
    expect(device.sync.current()).toBe('synced');
    expect(await device.store.settingsChangedAt()).toBe(100);
  });

  it('does queue a push for a change the reader makes outside of applying', async () => {
    const remote = new FakeRemote();
    const device = await openDevice(remote);
    await device.sync.start();
    expect(await device.store.pendingCount()).toBe(0);

    await device.sync.settingsChanged();

    expect((await device.store.pending()).map((entry) => entry.id)).toEqual(['settings:']);
  });
});

describe('a different account on the same browser', () => {
  it('sends none of the earlier account data and empties the store', async () => {
    const remoteB = new FakeRemote();
    const device = await openDevice(remoteB, { userId: 'user-b' });
    const oldDeviceId = await device.store.deviceId();
    await device.store.setOwner('user-a');
    await device.store.saveProgress(BOOK, at(4, 0, 0), 100);
    await device.store.addSession({
      id: 's1',
      bookId: BOOK.id,
      startedAt: 0,
      endedAt: 10,
      activeMs: 10,
      words: 1,
      wpm: 1,
      accuracy: 1,
    });
    await device.store.addCounts({ keys: [{ key: 'a', hits: 1 }], words: [{ word: 'the', hits: 1 }] });

    await device.sync.start();

    expect(remoteB.progress.size).toBe(0);
    expect(remoteB.sessions.size).toBe(0);
    expect(remoteB.totalForKey('a')).toEqual({ hits: 0, misses: 0, totalMs: 0 });
    expect(remoteB.totalForWord('the')).toEqual({ hits: 0, misses: 0 });
    expect(remoteB.count('pushProgress')).toBe(0);
    expect(remoteB.count('pushSessions')).toBe(0);
    expect(await device.store.allProgress()).toEqual([]);
    expect(await device.store.sessions()).toEqual([]);
    expect(await device.store.keyCounts()).toEqual([]);
    expect(await device.store.wordCounts()).toEqual([]);
    expect(await device.store.owner()).toBe('user-b');
    expect(await device.store.deviceId()).not.toBe(oldDeviceId);
  });

  it('takes the new account place instead of the earlier account place', async () => {
    const remoteB = new FakeRemote();
    putRemote(remoteB, at(1, 0, 0), 50);
    const device = await openDevice(remoteB, { userId: 'user-b' });
    await device.store.setOwner('user-a');
    await device.store.saveProgress(BOOK, at(9, 0, 0), 9000);

    await device.sync.start();

    expect((await device.store.progress(BOOK.id))!.position).toEqual(at(1, 0, 0));
    expect(remoteB.progress.get(BOOK.id)!.position).toEqual(at(1, 0, 0));
  });
});

describe('the same account restarting', () => {
  it('sends the changes that were queued', async () => {
    const remote = new FakeRemote();
    const device = await openDevice(remote);
    await device.store.setOwner(USER);
    await device.store.markJoined(USER);
    await device.store.saveProgress(BOOK, at(2, 0, 0), 100);
    await device.store.addCounts({ words: [{ word: 'the', hits: 1 }] });

    await device.sync.start();

    expect(remote.progress.get(BOOK.id)!.position).toEqual(at(2, 0, 0));
    expect(remote.totalForWord('the').hits).toBe(1);
    expect(await device.store.pendingCount()).toBe(0);
  });

  it('keeps its own newer settings instead of taking the account copy', async () => {
    const remote = new FakeRemote();
    remote.settings = { data: { theme: 'account' }, updatedAt: 1000, deviceId: 'other-device' };
    const device = await openDevice(remote, { settings: { theme: 'mine' } });
    await device.store.setOwner(USER);
    await device.store.markJoined(USER);
    await device.store.markSettingsChanged(5000);

    await device.sync.start();

    expect(device.settings.applied).toEqual([]);
    expect(remote.settings).toEqual({ data: { theme: 'mine' }, updatedAt: 5000, deviceId: await device.store.deviceId() });
  });

  it('takes the account settings when they are newer than its own', async () => {
    const remote = new FakeRemote();
    remote.settings = { data: { theme: 'account' }, updatedAt: 9000, deviceId: 'other-device' };
    const device = await openDevice(remote, { settings: { theme: 'mine' } });
    await device.store.setOwner(USER);
    await device.store.markJoined(USER);
    await device.store.markSettingsChanged(5000);

    await device.sync.start();

    expect(device.settings.applied).toEqual([{ theme: 'account' }]);
    expect(remote.settings!.data).toEqual({ theme: 'account' });
  });
});

describe('offline', () => {
  it('resolves start, fails, loses nothing and schedules a retry', async () => {
    const remote = new FakeRemote();
    remote.offline = true;
    const device = await openDevice(remote, { intervalMs: 1000 });
    await device.store.saveProgress(BOOK, at(1, 0, 0), 100);
    await device.store.addCounts({ keys: [{ key: 'a', hits: 1 }] });
    const before = await device.store.pending();

    await expect(device.sync.start()).resolves.toBeUndefined();

    expect(device.sync.current()).toBe('failed');
    expect(await device.store.pending()).toEqual(before);
    expect(device.timers.delays).toHaveLength(1);
  });

  it('sends nothing while the first pull has never succeeded, but the browser is already the account’s', async () => {
    const remote = new FakeRemote();
    remote.offline = true;
    const device = await openDevice(remote);
    await device.store.saveProgress(BOOK, at(1, 0, 0), 100);

    await device.sync.start();

    // Whatever is typed from now on is this account's, so it can never be merged into another one.
    expect(await device.store.owner()).toBe(USER);
    expect(await device.store.joinedAs()).toBeNull();
    for (const method of ['pushProgress', 'pushSessions', 'pushKeyCounts', 'pushWordCounts', 'pushSettings'] as const) {
      expect(remote.count(method)).toBe(0);
    }
  });

  it('retries after intervalMs times two the first time, then with growing delays up to five minutes', async () => {
    const remote = new FakeRemote();
    remote.offline = true;
    const device = await openDevice(remote, { intervalMs: 12_000 });
    await device.sync.start();
    const delays = [device.timers.delays[0]];

    for (let round = 0; round < 5; round += 1) {
      const pulls = remote.count('pullProgress');
      device.timers.fire();
      await vi.waitFor(() => {
        expect(remote.count('pullProgress')).toBe(pulls + 1);
        expect(device.timers.scheduled).toHaveLength(1);
      });
      delays.push(device.timers.delays[0]);
    }

    expect(delays).toEqual([24_000, 48_000, 96_000, 192_000, 300_000, 300_000]);
  });

  it('sends everything and becomes synced when the remote comes back and the retry fires', async () => {
    const remote = new FakeRemote();
    remote.offline = true;
    const device = await openDevice(remote, { intervalMs: 1000 });
    await device.store.saveProgress(BOOK, at(1, 0, 0), 100);
    await device.store.addSession({
      id: 's1',
      bookId: BOOK.id,
      startedAt: 0,
      endedAt: 10,
      activeMs: 10,
      words: 1,
      wpm: 1,
      accuracy: 1,
    });
    await device.store.addCounts({ keys: [{ key: 'a', hits: 2 }], words: [{ word: 'the', hits: 1 }] });
    await device.sync.start();
    expect(device.sync.current()).toBe('failed');

    remote.offline = false;
    device.timers.fire();
    await waitForState(device.sync, 'synced');

    const deviceId = await device.store.deviceId();
    expect(remote.progress.get(BOOK.id)!.position).toEqual(at(1, 0, 0));
    expect(remote.sessions.has('s1')).toBe(true);
    expect(remote.keyRow(deviceId, 'a')!.hits).toBe(2);
    expect(remote.wordRow(deviceId, 'the')!.hits).toBe(1);
    expect(await device.store.owner()).toBe(USER);
    expect(await device.store.pendingCount()).toBe(0);
  });

  it('goes back to the normal gap after a success', async () => {
    const remote = new FakeRemote();
    remote.offline = true;
    const device = await openDevice(remote, { intervalMs: 1000 });
    await device.sync.start();
    remote.offline = false;
    device.timers.fire();
    await waitForState(device.sync, 'synced');

    await device.store.saveProgress(BOOK, at(1, 0, 0), 100);

    expect(device.timers.delays).toEqual([1000]);
  });

  it('keeps queued changes when a push fails after the pull worked', async () => {
    const remote = new FakeRemote();
    const device = await openDevice(remote, { intervalMs: 1000 });
    await device.sync.start();
    await device.store.saveProgress(BOOK, at(1, 0, 0), 100);

    remote.offline = true;
    await device.sync.flushNow();

    expect(device.sync.current()).toBe('failed');
    expect((await device.store.pending()).map((entry) => entry.id)).toEqual(['progress:book-1']);
  });
});

describe('batching', () => {
  it('schedules exactly one timer with the default interval after several local saves', async () => {
    const remote = new FakeRemote();
    const device = await openDevice(remote);
    await device.sync.start();

    await device.store.saveProgress(BOOK, at(0, 0, 1), 100);
    await device.store.saveProgress(BOOK, at(0, 0, 2), 101);
    await device.store.saveProgress({ id: 'book-2', fingerprint: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }, at(0, 0, 1), 102);

    expect(DEFAULT_INTERVAL_MS).toBe(12_000);
    expect(device.timers.delays).toEqual([12_000]);
  });

  it('uses the configured interval', async () => {
    const remote = new FakeRemote();
    const device = await openDevice(remote, { intervalMs: 3000 });
    await device.sync.start();

    await device.store.saveProgress(BOOK, at(0, 0, 1), 100);

    expect(device.timers.delays).toEqual([3000]);
  });

  it('sends one batch when the timer fires', async () => {
    const remote = new FakeRemote();
    const device = await openDevice(remote);
    await device.sync.start();
    const pushesBefore = remote.count('pushProgress');
    for (let i = 1; i <= 5; i += 1) await device.store.saveProgress(BOOK, at(0, 0, i), 100 + i);
    await device.store.saveProgress({ id: 'book-2', fingerprint: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }, at(0, 0, 1), 200);

    device.timers.fire();
    await vi.waitFor(async () => expect(await device.store.pendingCount()).toBe(0));

    expect(remote.count('pushProgress')).toBe(pushesBefore + 1);
    const batch = remote.sent('pushProgress').at(-1) as ProgressRecord[];
    expect(batch.map((row) => row.bookId).sort()).toEqual(['book-1', 'book-2']);
    expect(batch.find((row) => row.bookId === 'book-1')!.position).toEqual(at(0, 0, 5));
    expect(await device.store.pendingCount()).toBe(0);
  });

  it('goes to waiting after a local change and to synced after the flush', async () => {
    const remote = new FakeRemote();
    const device = await openDevice(remote);
    await device.sync.start();
    expect(device.sync.current()).toBe('synced');

    await device.store.saveProgress(BOOK, at(0, 0, 1), 100);
    expect(device.sync.current()).toBe('waiting');

    await device.sync.flushNow();
    expect(device.sync.current()).toBe('synced');
  });

  it('tells state listeners about each change and not about repeats', async () => {
    const remote = new FakeRemote();
    const device = await openDevice(remote);
    await device.sync.start();
    const seen = stateLog(device.sync);

    await device.store.saveProgress(BOOK, at(0, 0, 1), 100);
    await device.store.saveProgress(BOOK, at(0, 0, 2), 101);
    await device.sync.flushNow();

    expect(seen).toEqual(['waiting', 'syncing', 'synced']);
  });

  it('stops telling a state listener once it has unsubscribed', async () => {
    const remote = new FakeRemote();
    const device = await openDevice(remote);
    await device.sync.start();
    const listener = vi.fn();
    device.sync.onState(listener)();

    await device.store.saveProgress(BOOK, at(0, 0, 1), 100);

    expect(listener).not.toHaveBeenCalled();
  });

  it('sends immediately on flushNow and cancels the pending timer', async () => {
    const remote = new FakeRemote();
    const device = await openDevice(remote);
    await device.sync.start();
    await device.store.saveProgress(BOOK, at(0, 0, 1), 100);
    expect(device.timers.scheduled).toHaveLength(1);

    await device.sync.flushNow();

    expect(remote.progress.get(BOOK.id)!.position).toEqual(at(0, 0, 1));
    expect(device.timers.scheduled).toEqual([]);
    expect(device.timers.cleared.length).toBeGreaterThan(0);
  });

  it('does not call the account when there is nothing queued', async () => {
    const remote = new FakeRemote();
    const device = await openDevice(remote);
    await device.sync.start();
    const before = remote.calls.length;

    await device.sync.flushNow();

    expect(remote.calls.length).toBe(before);
  });

  it('does not push when pulling a first time fails during a flush', async () => {
    const remote = new FakeRemote();
    remote.offline = true;
    const device = await openDevice(remote);
    await device.store.setOwner(USER);
    await device.store.saveProgress(BOOK, at(0, 0, 1), 100);

    await device.sync.flushNow();

    expect(remote.count('pushProgress')).toBe(0);
    expect(remote.count('pullProgress')).toBe(1);
  });
});

describe('a change made while sending', () => {
  it('is not lost: the entry stays queued and the next flush sends the newer place', async () => {
    const remote = new FakeRemote();
    const device = await openDevice(remote);
    await device.sync.start();
    await device.store.saveProgress(BOOK, at(0, 0, 1), 100);

    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let entered = false;
    remote.onPushProgress = async () => {
      entered = true;
      await gate;
    };

    const flushing = device.sync.flushNow();
    await vi.waitFor(() => expect(entered).toBe(true));
    await device.store.saveProgress(BOOK, at(0, 0, 2), 200);
    remote.onPushProgress = undefined;
    release();
    await flushing;

    expect(remote.progress.get(BOOK.id)!.position).toEqual(at(0, 0, 1));
    expect((await device.store.pending()).map((entry) => entry.id)).toEqual(['progress:book-1']);

    await device.sync.flushNow();

    expect(remote.progress.get(BOOK.id)!.position).toEqual(at(0, 0, 2));
    expect(await device.store.pendingCount()).toBe(0);
  });

  it('books another batch for the change made during the send', async () => {
    const remote = new FakeRemote();
    const device = await openDevice(remote);
    await device.sync.start();
    await device.store.saveProgress(BOOK, at(0, 0, 1), 100);

    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let entered = false;
    remote.onPushProgress = async () => {
      entered = true;
      await gate;
    };
    const flushing = device.sync.flushNow();
    await vi.waitFor(() => expect(entered).toBe(true));
    await device.store.saveProgress(BOOK, at(0, 0, 2), 200);
    remote.onPushProgress = undefined;
    release();
    await flushing;

    expect(device.sync.current()).toBe('waiting');
    expect(device.timers.scheduled).toHaveLength(1);
  });
});

describe('large backlogs', () => {
  it('sends more than 200 queued word counts in several requests of at most 200 rows', async () => {
    const remote = new FakeRemote();
    const device = await openDevice(remote);
    const words = Array.from({ length: 450 }, (_, i) => ({ word: `word${i}`, hits: 1 }));
    await device.store.addCounts({ words });

    await device.sync.start();

    const sizes = remote.sent('pushWordCounts').map((rows) => rows.length);
    expect(sizes).toEqual([200, 200, 50]);
    const deviceId = await device.store.deviceId();
    expect(remote.wordRow(deviceId, 'word0')).toBeDefined();
    expect(remote.wordRow(deviceId, 'word449')).toBeDefined();
    expect(await device.store.pendingCount()).toBe(0);
  });

  it('sends exactly 200 queued key counts in one request', async () => {
    const remote = new FakeRemote();
    const device = await openDevice(remote);
    await device.store.addCounts({ keys: Array.from({ length: 200 }, (_, i) => ({ key: `k${i}`, hits: 1 })) });

    await device.sync.start();

    expect(remote.sent('pushKeyCounts').map((rows) => rows.length)).toEqual([200]);
  });

  it('keeps the chunks it has not sent when one request fails', async () => {
    const remote = new FakeRemote();
    const device = await openDevice(remote);
    await device.sync.start();
    await device.store.addCounts({ words: Array.from({ length: 450 }, (_, i) => ({ word: `word${i}`, hits: 1 })) });
    const original = remote.pushWordCounts.bind(remote);
    let calls = 0;
    remote.pushWordCounts = async (deviceId, rows) => {
      calls += 1;
      if (calls === 2) throw new Error('server trouble');
      return original(deviceId, rows);
    };

    await device.sync.flushNow();

    expect(device.sync.current()).toBe('failed');
    expect(await device.store.pendingCount()).toBe(250);
  });
});

describe('stop', () => {
  it('stops sending, cancels the pending timer and leaves the outbox intact', async () => {
    const remote = new FakeRemote();
    const device = await openDevice(remote);
    await device.sync.start();
    await device.store.saveProgress(BOOK, at(0, 0, 1), 100);
    expect(device.timers.scheduled).toHaveLength(1);
    const callsBefore = remote.calls.length;

    device.sync.stop();
    await device.sync.flushNow();
    await device.sync.refresh();

    expect(device.timers.scheduled).toEqual([]);
    expect(remote.calls.length).toBe(callsBefore);
    expect((await device.store.pending()).map((entry) => entry.id)).toEqual(['progress:book-1']);
  });

  it('does not schedule anything for changes made after stopping', async () => {
    const remote = new FakeRemote();
    const device = await openDevice(remote);
    await device.sync.start();
    device.sync.stop();

    await device.store.saveProgress(BOOK, at(0, 0, 1), 100);
    await device.store.addCounts({ keys: [{ key: 'a', hits: 1 }] });

    expect(device.timers.scheduled).toEqual([]);
    expect(await device.store.pendingCount()).toBe(2);
  });

  it('can be called before start without trouble', async () => {
    const remote = new FakeRemote();
    const device = await openDevice(remote);
    expect(() => device.sync.stop()).not.toThrow();
  });
});

describe('start', () => {
  it('does its first round only once when called twice', async () => {
    const remote = new FakeRemote();
    const device = await openDevice(remote);

    await device.sync.start();
    const pulls = remote.count('pullProgress');
    await device.sync.start();

    expect(remote.count('pullProgress')).toBe(pulls);
  });

  it('does a pull and then a push on refresh', async () => {
    const remote = new FakeRemote();
    const device = await openDevice(remote);
    await device.sync.start();
    await device.store.saveProgress(BOOK, at(0, 0, 1), 100);
    remote.calls.length = 0;

    await device.sync.refresh();

    expect(remote.calls.map((call) => call.method).filter((m) => m === 'pullProgress' || m === 'pushProgress')).toEqual([
      'pullProgress',
      'pushProgress',
    ]);
  });
});
