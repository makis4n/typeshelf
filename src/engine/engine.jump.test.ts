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

describe('jumpTo: moving', () => {
  it('moves the caret to the start of a later word and reports every word in between', () => {
    const engine = make();
    const change = engine.jumpTo(3);
    expect(change).toEqual({ kind: 'advanced', dirty: [0, 1, 2, 3] });
    expect(engine.caret()).toEqual({ word: 3, char: 0 });
  });

  it('does nothing for the current word, an earlier word, or a word that does not exist', () => {
    const engine = make();
    typeAll(engine, 'ab cd ');
    for (const target of [2, 1, 0, -1, 6, 99, 2.5, Number.NaN]) {
      expect(engine.jumpTo(target).kind).toBe('none');
    }
    expect(engine.caret()).toEqual({ word: 2, char: 0 });
  });

  it('does nothing once the passage is finished', () => {
    const engine = new TypingEngine(buildPassage(['ab cd']));
    typeAll(engine, 'ab cd');
    expect(engine.finished).toBe(true);
    expect(engine.jumpTo(1).kind).toBe('none');
  });

  it('works across paragraphs and in every stop-on-error mode', () => {
    for (const mode of ['flow', 'word', 'strict'] as const) {
      const engine = make({ mode });
      expect(engine.jumpTo(5).kind).toBe('advanced');
      expect(engine.caret()).toEqual({ word: 5, char: 0 });
    }
  });

  it('typing carries on normally from the new place, and can finish the passage', () => {
    const engine = make();
    engine.jumpTo(5);
    typeAll(engine, 'kl');
    expect(engine.finished).toBe(true);
    expect(engine.stats().wordsDone).toBe(6);
  });
});

describe('jumpTo: how skipped words look', () => {
  it('shows untouched words as skipped, not as mistakes', () => {
    const engine = make();
    engine.jumpTo(2);
    expect(engine.wordView(0)).toEqual({ states: ['skipped', 'skipped'], extras: [], flawed: false });
    expect(engine.wordView(1).states).toEqual(['skipped', 'skipped']);
    expect(engine.wordView(2).states).toEqual(['pending', 'pending']);
  });

  it('keeps a half-typed word as it was, with its missing letters marked', () => {
    const engine = make();
    typeAll(engine, 'a');
    engine.jumpTo(2);
    expect(engine.wordView(0)).toEqual({ states: ['ok', 'missed'], extras: [], flawed: true });
    expect(engine.wordView(1).states).toEqual(['skipped', 'skipped']);
  });
});

describe('jumpTo: speed, accuracy and time', () => {
  it('gives no correct characters for skipped words', () => {
    const engine = make();
    engine.jumpTo(3);
    expect(engine.stats().correctChars).toBe(0);
    typeAll(engine, 'gh ');
    expect(engine.stats().correctChars).toBe(3); // "gh" and its space, nothing for the three skipped words
  });

  it('keeps the credit already earned, and gives none for the gap after a half-typed word', () => {
    const engine = make();
    typeAll(engine, 'ab c');
    expect(engine.stats().correctChars).toBe(4);
    engine.jumpTo(3);
    expect(engine.stats().correctChars).toBe(4);
  });

  it('does not change speed at the moment of the jump', () => {
    const engine = make();
    const at = typeAll(engine, 'ab c');
    const before = engine.stats(at);
    engine.jumpTo(3);
    const after = engine.stats(at);
    expect(after.wpm).toBe(before.wpm);
    expect(after.recentWpm).toBe(before.recentWpm);
    expect(after.activeMs).toBe(before.activeMs);
  });

  it('never lets a jump raise speed: skipping ahead earns the same as not typing', () => {
    const jumped = make();
    const typed = make();
    let at = typeAll(jumped, 'ab ');
    typeAll(typed, 'ab ');
    jumped.jumpTo(3);
    at = typeAll(jumped, 'gh', at);
    typeAll(typed, 'cd', 300);
    // Same keys pressed in the same time, so the same speed, though one of them is further on.
    expect(jumped.stats().wpm).toBe(typed.stats().wpm);
    expect(jumped.stats().correctChars).toBe(typed.stats().correctChars);
    expect(at).toBe(500);
  });

  it('does not touch accuracy or report any key', () => {
    const keys: KeyRecord[] = [];
    const engine = make({ onKey: (key) => keys.push(key) });
    typeAll(engine, 'ab ');
    engine.jumpTo(4);
    expect(keys).toHaveLength(3);
    expect(engine.stats().accuracy).toBe(1);
    expect(engine.stats().keysCorrect).toBe(3);
    expect(engine.stats().keysWrong).toBe(0);
  });

  it('leaves the clock running: the time until the next key still counts', () => {
    const engine = make();
    typeAll(engine, 'ab'); // keys at 100 and 200 ms; the clock starts at the first
    engine.jumpTo(3);
    expect(engine.stats(1200).activeMs).toBe(1100);
    engine.type('g', 2000);
    expect(engine.stats().activeMs).toBe(1900);
  });

  it('a jump while paused stays paused until the next key', () => {
    const engine = make();
    typeAll(engine, 'ab');
    engine.pause();
    engine.jumpTo(3);
    expect(engine.stats(90_000).activeMs).toBe(100);
    engine.type('g', 90_000);
    expect(engine.stats(90_500).activeMs).toBe(600);
  });

  it('counts chapter progress by position, so a jump moves it forward', () => {
    const engine = make();
    engine.jumpTo(3);
    expect(engine.stats().wordsDone).toBe(3);
    expect(engine.stats().wordsTotal).toBe(6);
  });
});

describe('jumpTo: going back afterwards', () => {
  it('backspace steps back through skipped words one at a time and un-skips them', () => {
    const engine = make();
    typeAll(engine, 'ab ');
    engine.jumpTo(3);
    expect(engine.backspace(1000).kind).toBe('retreated');
    expect(engine.caret()).toEqual({ word: 2, char: 0 });
    expect(engine.wordView(2).states).toEqual(['pending', 'pending']);
    expect(engine.backspace(1100).kind).toBe('retreated');
    expect(engine.caret()).toEqual({ word: 1, char: 0 });
    // "ab" was typed correctly, so it stays locked.
    expect(engine.backspace(1200).kind).toBe('none');
    expect(engine.stats().correctChars).toBe(3);
  });

  it('a word that was skipped and then typed is credited once', () => {
    const engine = make();
    engine.jumpTo(1);
    engine.backspace(100);
    typeAll(engine, 'ab cd ', 100);
    expect(engine.stats().correctChars).toBe(6);
    expect(engine.wordView(0).states).toEqual(['ok', 'ok']);
    expect(engine.wordView(0).flawed).toBe(false);
  });
});
