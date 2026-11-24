import { describe, expect, it } from 'vitest';
import { TypingEngine } from './engine';
import { buildPassage } from './text';
import { autoPauseMs, DEFAULT_SETTINGS } from '../settings';

const make = () => new TypingEngine(buildPassage(['ab cd ef gh']));

describe('pause', () => {
  it('without a pause, the clock keeps running through a long gap', () => {
    const engine = make();
    engine.type('a', 0);
    expect(engine.stats(30_000).activeMs).toBe(30_000);
    engine.type('b', 60_000);
    expect(engine.stats().activeMs).toBe(60_000);
  });

  it('pause() rewinds to the last key: idle time before the pause is not counted', () => {
    const engine = make();
    engine.type('a', 0);
    engine.type('b', 100);
    expect(engine.stats(9000).activeMs).toBe(9000); // ticking while idle
    engine.pause();
    expect(engine.stats(10_000).activeMs).toBe(100); // rewound and stopped
    expect(engine.stats(50_000).activeMs).toBe(100);
  });

  it('pause(at) keeps the time up to that moment and stops there', () => {
    const engine = make();
    engine.type('a', 0);
    engine.type('b', 100);
    engine.pause(2500);
    expect(engine.stats(50_000).activeMs).toBe(2500);
  });

  it('the next key restarts the clock without counting the paused stretch', () => {
    const engine = make();
    engine.type('a', 0);
    engine.type('b', 100);
    engine.pause();
    engine.type(' ', 60_000);
    expect(engine.stats().activeMs).toBe(100);
    engine.type('c', 60_100);
    expect(engine.stats().activeMs).toBe(200);
    expect(engine.stats(60_600).activeMs).toBe(700);
  });

  it('keeps the same typing credit across a break', () => {
    const straight = make();
    const broken = make();
    let at = 0;
    for (const char of 'ab cd') straight.type(char, (at += 100));
    at = 0;
    for (const char of 'ab ') broken.type(char, (at += 100));
    broken.pause();
    at += 600_000;
    for (const char of 'cd') broken.type(char, (at += 100));
    // The first key after the pause starts a fresh gap, so one 100 ms gap is missing.
    expect(broken.stats().activeMs).toBe(straight.stats().activeMs - 100);
    expect(broken.stats().correctChars).toBe(straight.stats().correctChars);
    expect(broken.stats().recentWpm).toBeGreaterThan(0);
  });

  it('reports a gap of 0 to onKey for the first key after a pause', () => {
    const gaps: number[] = [];
    const engine = new TypingEngine(buildPassage(['ab']), { onKey: (key) => gaps.push(key.gapMs) });
    engine.type('a', 0);
    engine.pause();
    engine.type('b', 9000);
    expect(gaps).toEqual([0, 0]);
  });

  it('is harmless before any key and when called twice', () => {
    const engine = make();
    engine.pause();
    engine.pause(300);
    engine.type('a', 500);
    expect(engine.stats(500).activeMs).toBe(0);
  });
});

describe('auto pause setting', () => {
  it('defaults to 10 seconds', () => {
    expect(DEFAULT_SETTINGS.autoPause).toBe('10');
  });

  it('converts each choice to milliseconds, with off as 0', () => {
    expect(autoPauseMs('off')).toBe(0);
    expect(autoPauseMs('5')).toBe(5000);
    expect(autoPauseMs('10')).toBe(10_000);
    expect(autoPauseMs('30')).toBe(30_000);
  });
});
