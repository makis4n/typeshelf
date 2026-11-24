import { describe, expect, it } from 'vitest';
import { TypingEngine, type EngineOptions, type KeyRecord } from './engine';
import { buildPassage } from './text';

const TEXT = ['ab cd ef gh', 'ij kl'];
const make = (options: EngineOptions = {}) => new TypingEngine(buildPassage(TEXT), options);
function typeAll(engine: TypingEngine, text: string, from = 0, gap = 100): number {
  let at = from;
  for (const char of text) engine.type(char, (at += gap));
  return at;
}

describe('startWord: the starting point', () => {
  it('puts the caret at the start of that word', () => {
    expect(make({ startWord: 3 }).caret()).toEqual({ word: 3, char: 0 });
  });

  it('clamps out-of-range values', () => {
    expect(make({ startWord: 99 }).caret().word).toBe(5);
    expect(make({ startWord: -4 }).caret().word).toBe(0);
    expect(make({ startWord: Number.NaN }).caret().word).toBe(0);
    expect(make({ startWord: 2.7 }).caret().word).toBe(2);
  });

  it('copes with an empty passage', () => {
    const engine = new TypingEngine(buildPassage([]), { startWord: 3 });
    expect(engine.caret().word).toBe(0);
    expect(engine.finished).toBe(true);
  });
});

describe('startWord: how earlier words look', () => {
  it('shows them as typed correctly, not skipped or flawed', () => {
    const engine = make({ startWord: 2 });
    for (const i of [0, 1]) {
      expect(engine.wordView(i)).toEqual({ states: ['ok', 'ok'], extras: [], flawed: false });
    }
    expect(engine.wordView(2).states).toEqual(['pending', 'pending']);
  });
});

describe('startWord: speed, accuracy and progress', () => {
  it('starts with nothing earned and progress at the matching fraction', () => {
    const keys: KeyRecord[] = [];
    const engine = make({ startWord: 3, onKey: (key) => keys.push(key) });
    const stats = engine.stats();
    expect(stats.correctChars).toBe(0);
    expect(stats.wpm).toBe(0);
    expect(stats.accuracy).toBe(1);
    expect(stats.keysCorrect + stats.keysWrong).toBe(0);
    expect(stats.wordsDone).toBe(3);
    expect(stats.wordsTotal).toBe(6);
    expect(keys).toHaveLength(0);
  });

  it('credits only what is typed after the start', () => {
    const keys: KeyRecord[] = [];
    const engine = make({ startWord: 3, onKey: (key) => keys.push(key) });
    typeAll(engine, 'gh '); // keys at 100, 200, 300 ms; the clock starts at the first
    const stats = engine.stats();
    expect(stats.correctChars).toBe(3);
    expect(stats.keysCorrect).toBe(3);
    expect(stats.accuracy).toBe(1);
    expect(stats.activeMs).toBe(200);
    expect(stats.wordsDone).toBe(4);
    expect(keys).toHaveLength(3);
  });

  it('keeps the clock waiting for the first key', () => {
    const engine = make({ startWord: 2 });
    expect(engine.stats(5000).activeMs).toBe(0);
  });

  it('can finish the passage', () => {
    const engine = make({ startWord: 5 });
    typeAll(engine, 'kl');
    expect(engine.finished).toBe(true);
    expect(engine.stats().wordsDone).toBe(6);
  });
});

describe('startWord: going back', () => {
  it('backspace cannot step into the pre-typed words, even in freedom mode', () => {
    for (const freedomMode of [false, true]) {
      const engine = make({ startWord: 2, freedomMode });
      expect(engine.backspace(100).kind).toBe('none');
      expect(engine.deleteWord(200).kind).toBe('none');
      expect(engine.caret()).toEqual({ word: 2, char: 0 });
    }
  });

  it('words typed after the start follow the usual rules', () => {
    const engine = make({ startWord: 2 });
    typeAll(engine, 'ex '); // "ef" typed wrong, left behind
    expect(engine.backspace(1000).kind).toBe('retreated');
    expect(engine.caret()).toEqual({ word: 2, char: 2 });
    expect(engine.backspace(1100).kind).toBe('erased');
    typeAll(engine, 'f ', 1100);
    expect(engine.backspace(2000).kind).toBe('none'); // correct, so locked
  });
});

describe('startWord: default behaviour', () => {
  it('0 and undefined behave exactly as before', () => {
    for (const options of [{}, { startWord: 0 }]) {
      const engine = make(options);
      expect(engine.caret()).toEqual({ word: 0, char: 0 });
      expect(engine.wordView(0).states).toEqual(['pending', 'pending']);
      typeAll(engine, 'ab ');
      expect(engine.stats().correctChars).toBe(3);
      expect(engine.backspace(1000).kind).toBe('none');
    }
  });
});
