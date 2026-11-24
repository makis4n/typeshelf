import { describe, expect, it } from 'vitest';
import { TypingEngine } from './engine';
import { buildPassage } from './text';

/** A long run of the word "ab", so there is always more to type. */
function engineFor(words: number): TypingEngine {
  return new TypingEngine(buildPassage([Array(words).fill('ab').join(' ')]));
}

/** Types "ab " over and over with a fixed gap, returning the time of the last key. */
function typeWords(engine: TypingEngine, count: number, gapMs: number, from: number): number {
  let at = from;
  for (let i = 0; i < count; i++) {
    for (const char of 'ab ') {
      at += gapMs;
      engine.type(char, at);
    }
  }
  return at;
}

describe('recent speed', () => {
  it('is 0 before anything is typed', () => {
    expect(engineFor(10).stats().recentWpm).toBe(0);
  });

  it('matches the average while the session is shorter than a minute', () => {
    const engine = engineFor(100);
    typeWords(engine, 20, 100, 0);
    const stats = engine.stats();
    expect(stats.activeMs).toBeLessThan(60_000);
    expect(stats.recentWpm).toBeCloseTo(stats.wpm, 6);
  });

  it('follows the last minute, not the whole session', () => {
    const engine = engineFor(2000);
    // Two slow minutes: one key a second is 12 wpm.
    let at = typeWords(engine, 40, 1000, 0);
    expect(engine.stats().recentWpm).toBeCloseTo(12, 0);

    // Then a fast minute: ten keys a second is 120 wpm.
    at = typeWords(engine, 200, 100, at);
    const stats = engine.stats();
    expect(stats.recentWpm).toBeCloseTo(120, 0);
    expect(stats.wpm).toBeLessThan(60);
    expect(at).toBeGreaterThan(0);
  });

  it('never goes below 0 when correct letters are erased', () => {
    const engine = engineFor(10);
    engine.type('a', 0);
    engine.type('b', 100);
    engine.backspace(200);
    engine.backspace(300);
    expect(engine.stats().recentWpm).toBe(0);
  });
});
