import { describe, expect, it } from 'vitest';
import { TypingEngine } from './engine/engine';
import { buildPassage } from './engine/text';
import { DEFAULT_SETTINGS, formatTime, recentWindowLabel, recentWindowMs, wholePercent } from './settings';

describe('time format', () => {
  it('shows seconds as m:ss, and h:mm:ss past an hour', () => {
    expect(formatTime(0, 'seconds')).toBe('0:00');
    expect(formatTime(5_900, 'seconds')).toBe('0:05');
    expect(formatTime(760_000, 'seconds')).toBe('12:40');
    expect(formatTime(3_723_000, 'seconds')).toBe('1:02:03');
  });

  it('shows whole minutes rounded down, and hours past an hour', () => {
    expect(formatTime(0, 'minutes')).toBe('0 min');
    expect(formatTime(59_999, 'minutes')).toBe('0 min');
    expect(formatTime(60_000, 'minutes')).toBe('1 min');
    expect(formatTime(760_000, 'minutes')).toBe('12 min');
    expect(formatTime(3_723_000, 'minutes')).toBe('1 h 02 min');
  });
});

describe('whole percent', () => {
  it('keeps exact shares exact', () => {
    // (n / 100) * 100 falls just short for these and would round down a step.
    expect(wholePercent(29, 100)).toBe(29);
    expect(wholePercent(57, 100)).toBe(57);
    expect(wholePercent(58, 100)).toBe(58);
    for (let n = 0; n <= 100; n++) expect(wholePercent(n, 100)).toBe(n);
  });

  it('rounds down, so nearly all is not shown as all', () => {
    expect(wholePercent(999, 1000)).toBe(99);
    expect(wholePercent(1, 3)).toBe(33);
    expect(wholePercent(3, 3)).toBe(100);
  });
});

describe('recent window setting', () => {
  it('defaults to one minute and seconds', () => {
    expect(DEFAULT_SETTINGS.recentWindow).toBe('60');
    expect(DEFAULT_SETTINGS.timeUnit).toBe('seconds');
  });

  it('gives milliseconds and a label for every choice', () => {
    expect(recentWindowMs('15')).toBe(15_000);
    expect(recentWindowMs('300')).toBe(300_000);
    expect(['15', '30', '60', '120', '300'].map((c) => recentWindowLabel(c as '15'))).toEqual([
      'Last 15 s',
      'Last 30 s',
      'Last minute',
      'Last 2 min',
      'Last 5 min',
    ]);
  });
});

describe('recent speed window in the engine', () => {
  const words = Array(3000).fill('ab').join(' ');
  /** One slow minute (12 wpm) then twenty fast seconds (120 wpm). */
  function session(recentWindowMs?: number): TypingEngine {
    const engine = new TypingEngine(buildPassage([words]), { recentWindowMs });
    let at = 0;
    const run = (keys: number, gap: number) => {
      for (let i = 0; i < keys; i++) engine.type('ab '[i % 3], (at += gap));
    };
    run(60, 1000);
    run(201, 100);
    return engine;
  }

  it('a 15 second window sees only the fast stretch', () => {
    expect(session(15_000).stats().recentWpm).toBeCloseTo(120, -1); // within a few wpm
  });

  it('a 5 minute window covers the whole session, so it equals the average', () => {
    const stats = session(300_000).stats();
    expect(stats.recentWpm).toBeCloseTo(stats.wpm, 6);
  });

  it('the default window is one minute', () => {
    const byDefault = session().stats().recentWpm;
    expect(byDefault).toBeCloseTo(session(60_000).stats().recentWpm, 6);
    expect(byDefault).toBeLessThan(120);
    expect(byDefault).toBeGreaterThan(12);
  });

  it('lengthening the window mid-session takes effect at once', () => {
    const engine = session(15_000);
    engine.recentWindowMs = 300_000;
    const stats = engine.stats();
    // The whole session fits in five minutes, so it equals the average.
    expect(stats.recentWpm).toBeCloseTo(stats.wpm, 6);
    expect(stats.recentWpm).toBeCloseTo(session(300_000).stats().recentWpm, 6);
  });

  it('shortening the window mid-session takes effect at once', () => {
    const engine = session(300_000);
    engine.recentWindowMs = 15_000;
    expect(engine.stats().recentWpm).toBeCloseTo(120, -1); // within a few wpm
  });
});
