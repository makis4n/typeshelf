import { afterEach, describe, expect, it, vi } from 'vitest';
import { TypingEngine } from './engine/engine';
import { buildPassage } from './engine/text';
import { DEFAULT_SETTINGS, loadSettings } from './settings';

function withSaved(value: unknown): void {
  const text = JSON.stringify(value);
  vi.stubGlobal('localStorage', { getItem: () => text, setItem: () => {} });
}

afterEach(() => vi.unstubAllGlobals());

describe('settings added later', () => {
  it('defaults: freedom mode off, medium caret speed, line caret', () => {
    expect(DEFAULT_SETTINGS.freedomMode).toBe(false);
    expect(DEFAULT_SETTINGS.smoothCaret).toBe('medium');
    expect(DEFAULT_SETTINGS.caretStyle).toBe('line');
  });

  it('loads freedom mode, every caret speed, and a hidden caret', () => {
    for (const smoothCaret of ['off', 'slow', 'medium', 'fast']) {
      withSaved({ freedomMode: true, smoothCaret, caretStyle: 'off' });
      expect(loadSettings()).toMatchObject({ freedomMode: true, smoothCaret, caretStyle: 'off' });
    }
  });

  it('reads the old on/off smooth caret as medium or off', () => {
    withSaved({ smoothCaret: true });
    expect(loadSettings().smoothCaret).toBe('medium');
    withSaved({ smoothCaret: false });
    expect(loadSettings().smoothCaret).toBe('off');
  });

  it('rejects an unknown caret speed', () => {
    withSaved({ smoothCaret: 'warp' });
    expect(loadSettings().smoothCaret).toBe('medium');
  });
});

describe('freedom mode', () => {
  const passage = () => buildPassage(['ab cd ef']);
  const typeAll = (engine: TypingEngine, text: string) => {
    let at = 0;
    for (const char of text) engine.type(char, (at += 100));
    return at;
  };

  it('is off by default: a correct word cannot be re-entered', () => {
    const engine = new TypingEngine(passage());
    const at = typeAll(engine, 'ab ');
    expect(engine.backspace(at + 100).kind).toBe('none');
    expect(engine.caret()).toEqual({ word: 1, char: 0 });
  });

  it('lets backspace step back into a correct word, with the caret after its text', () => {
    const engine = new TypingEngine(passage(), { freedomMode: true });
    const at = typeAll(engine, 'ab ');
    const change = engine.backspace(at + 100);
    expect(change.kind).toBe('retreated');
    expect(change.dirty).toEqual([0, 1]);
    expect(engine.caret()).toEqual({ word: 0, char: 2 });
  });

  it('lets deleteWord clear a correct previous word', () => {
    const engine = new TypingEngine(passage(), { freedomMode: true });
    const at = typeAll(engine, 'ab ');
    expect(engine.deleteWord(at + 100).kind).toBe('retreated');
    expect(engine.caret()).toEqual({ word: 0, char: 0 });
    expect(engine.stats().correctChars).toBe(0);
  });

  it('can walk back through several correct words and does not double count them', () => {
    const engine = new TypingEngine(passage(), { freedomMode: true });
    let at = typeAll(engine, 'ab cd ');
    expect(engine.stats().correctChars).toBe(6);
    // Into "cd", erase its two letters, into "ab", erase the "b".
    for (let i = 0; i < 5; i++) engine.backspace((at += 100));
    expect(engine.caret()).toEqual({ word: 0, char: 1 });
    expect(engine.stats().correctChars).toBe(1);
  });

  it('still stops at the floor', () => {
    const engine = new TypingEngine(passage(), { freedomMode: true });
    const at = typeAll(engine, 'ab ');
    engine.floor = 1;
    expect(engine.backspace(at + 100).kind).toBe('none');
  });

  it('works in strict and word modes, where earlier words are always correct', () => {
    for (const mode of ['strict', 'word'] as const) {
      const engine = new TypingEngine(passage(), { mode, freedomMode: true });
      const at = typeAll(engine, 'ab ');
      expect(engine.backspace(at + 100).kind).toBe('retreated');
    }
  });

  it('can be switched mid-passage', () => {
    const engine = new TypingEngine(passage());
    const at = typeAll(engine, 'ab ');
    expect(engine.backspace(at + 100).kind).toBe('none');
    engine.freedomMode = true;
    expect(engine.backspace(at + 200).kind).toBe('retreated');
  });
});
