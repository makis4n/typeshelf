import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, loadSettings, modeFor, saveSettings, type Settings } from './settings';

const KEY = 'typeshelf:settings';

/** A small in-memory stand-in for localStorage. */
function installStorage(initial: Record<string, string> = {}) {
  const data = new Map<string, string>(Object.entries(initial));
  const storage = {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    removeItem: (key: string) => void data.delete(key),
  };
  vi.stubGlobal('localStorage', storage);
  return data;
}

function installThrowingStorage() {
  const fail = () => {
    throw new Error('storage blocked');
  };
  vi.stubGlobal('localStorage', { getItem: fail, setItem: fail, removeItem: fail });
}

const saved = (value: unknown) => installStorage({ [KEY]: JSON.stringify(value) });

beforeEach(() => {
  installStorage();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('modeFor', () => {
  it('maps off to flow', () => {
    expect(modeFor('off')).toBe('flow');
  });

  it('maps word to word', () => {
    expect(modeFor('word')).toBe('word');
  });

  it('maps letter to strict', () => {
    expect(modeFor('letter')).toBe('strict');
  });
});

describe('loadSettings: falls back to the defaults', () => {
  it('when nothing is saved', () => {
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it('when the saved value is not JSON', () => {
    installStorage({ [KEY]: '{not json' });
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it('when the saved value is an empty string', () => {
    installStorage({ [KEY]: '' });
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it('when the saved value is a number', () => {
    installStorage({ [KEY]: '42' });
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it('when the saved value is null', () => {
    installStorage({ [KEY]: 'null' });
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it('when the saved value is a string', () => {
    installStorage({ [KEY]: '"word"' });
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it('when the saved value is an array', () => {
    saved(['word']);
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it('when localStorage throws', () => {
    installThrowingStorage();
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it('when there is no localStorage at all', () => {
    vi.unstubAllGlobals();
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS);
  });
});

describe('loadSettings: saved fields', () => {
  it('uses every valid saved field', () => {
    const custom: Settings = {
      stopOnError: 'letter',
      strictSpace: true,
      freedomMode: true,
      autoParagraph: true,
      autoPause: '30',
      clickToJump: true,
      scrollText: true,
      typeOnReturn: true,
      textMotion: 'tape',
      tapeStep: 'word',
      tapeMargin: 'centre',
      recentWindow: '300',
      timeUnit: 'minutes',
      spelling: 'british',
      smoothCaret: 'fast',
      caretStyle: 'box',
    };
    saved(custom);
    expect(loadSettings()).toEqual(custom);
  });

  it('fills fields missing from the saved value with their defaults', () => {
    saved({ spelling: 'american' });
    expect(loadSettings()).toEqual({ ...DEFAULT_SETTINGS, spelling: 'american' });
  });

  it('falls back to the default for a field of the wrong type and keeps the others', () => {
    saved({ stopOnError: 3, strictSpace: 'yes', smoothCaret: 'slow', caretStyle: 'block' });
    expect(loadSettings()).toEqual({
      ...DEFAULT_SETTINGS,
      smoothCaret: 'slow',
      caretStyle: 'block',
    });
  });

  it('falls back to the default for an unknown option and keeps the others', () => {
    saved({ stopOnError: 'sometimes', spelling: 'canadian', caretStyle: 'underline', strictSpace: true });
    expect(loadSettings()).toEqual({
      ...DEFAULT_SETTINGS,
      caretStyle: 'underline',
      strictSpace: true,
    });
  });

  it('falls back to the default for null and string booleans', () => {
    saved({ smoothCaret: null, strictSpace: 'true' });
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it('ignores unknown extra fields', () => {
    saved({ caretStyle: 'box', fontSize: 20, extra: { a: 1 } });
    const loaded = loadSettings();
    expect(loaded).toEqual({ ...DEFAULT_SETTINGS, caretStyle: 'box' });
    expect(Object.keys(loaded).sort()).toEqual(Object.keys(DEFAULT_SETTINGS).sort());
  });
});

describe('loadSettings: fresh object', () => {
  it('returns a new object each time', () => {
    expect(loadSettings()).not.toBe(loadSettings());
  });

  it('does not let a mutation of the result change DEFAULT_SETTINGS', () => {
    const before = { ...DEFAULT_SETTINGS };
    const loaded = loadSettings();
    loaded.stopOnError = 'letter';
    loaded.smoothCaret = 'off';
    expect(DEFAULT_SETTINGS).toEqual(before);
    expect(loadSettings()).toEqual(before);
  });

  it('does not let a mutation change DEFAULT_SETTINGS when the saved value is unusable', () => {
    installStorage({ [KEY]: 'null' });
    const before = { ...DEFAULT_SETTINGS };
    loadSettings().spelling = 'british';
    expect(DEFAULT_SETTINGS).toEqual(before);
  });
});

describe('saveSettings', () => {
  it('round-trips every field', () => {
    const custom: Settings = {
      stopOnError: 'word',
      strictSpace: true,
      freedomMode: true,
      autoParagraph: true,
      autoPause: '30',
      clickToJump: true,
      scrollText: true,
      typeOnReturn: true,
      textMotion: 'tape',
      tapeStep: 'word',
      tapeMargin: 'centre',
      recentWindow: '300',
      timeUnit: 'minutes',
      spelling: 'american',
      smoothCaret: 'fast',
      caretStyle: 'underline',
    };
    saveSettings(custom);
    expect(loadSettings()).toEqual(custom);
  });

  it('round-trips the defaults', () => {
    saveSettings(DEFAULT_SETTINGS);
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it('writes JSON under the typeshelf:settings key', () => {
    const data = installStorage();
    saveSettings(DEFAULT_SETTINGS);
    expect(JSON.parse(data.get(KEY) ?? 'null')).toEqual(DEFAULT_SETTINGS);
  });

  it('replaces a previously saved value', () => {
    saveSettings({ ...DEFAULT_SETTINGS, caretStyle: 'box' });
    saveSettings({ ...DEFAULT_SETTINGS, caretStyle: 'block' });
    expect(loadSettings().caretStyle).toBe('block');
  });

  it('does not throw when storage throws', () => {
    installThrowingStorage();
    expect(() => saveSettings(DEFAULT_SETTINGS)).not.toThrow();
  });
});
