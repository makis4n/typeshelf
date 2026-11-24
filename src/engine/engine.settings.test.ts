import { describe, expect, it } from 'vitest';
import { type Change, type EngineOptions, type KeyRecord, TypingEngine } from './engine';
import { buildPassage } from './text';

function make(paragraphs: string[], options: EngineOptions = {}): TypingEngine {
  return new TypingEngine(buildPassage(paragraphs), options);
}

/** Types a string with a fixed gap between keys; returns the change of every key. */
function typeText(engine: TypingEngine, text: string, start = 0, gap = 100): Change[] {
  return Array.from(text, (ch, i) => engine.type(ch, start + i * gap));
}

const NONE: Change = { kind: 'none', dirty: [] };

function recorded(paragraphs: string[], options: EngineOptions = {}) {
  const keys: KeyRecord[] = [];
  const engine = make(paragraphs, { ...options, onKey: (k) => keys.push(k) });
  return { engine, keys };
}

describe('word mode: typing', () => {
  it('keeps a wrong letter on the page as bad, unlike strict mode', () => {
    const engine = make(['abc de'], { mode: 'word' });
    expect(engine.type('x', 0)).toEqual({ kind: 'typed', dirty: [0] });
    expect(engine.wordView(0).states).toEqual(['bad', 'pending', 'pending']);
    expect(engine.caret()).toEqual({ word: 0, char: 1 });
  });

  it('counts a wrong letter as a wrong key', () => {
    const engine = make(['abc de'], { mode: 'word' });
    engine.type('x', 0);
    expect(engine.stats().keysWrong).toBe(1);
    expect(engine.stats().keysCorrect).toBe(0);
  });

  it('keeps extra letters past the end of the word', () => {
    const engine = make(['ab cd'], { mode: 'word' });
    typeText(engine, 'abx');
    expect(engine.wordView(0).extras).toEqual(['x']);
  });
});

describe('word mode: space', () => {
  it('rejects space while the word has a wrong letter, counts a wrong key and keeps the caret', () => {
    const engine = make(['abc de'], { mode: 'word' });
    typeText(engine, 'axc');
    const before = engine.stats().keysWrong;
    expect(engine.space(300)).toEqual({ kind: 'rejected', dirty: [0] });
    expect(engine.stats().keysWrong).toBe(before + 1);
    expect(engine.caret()).toEqual({ word: 0, char: 3 });
    expect(engine.wordIndex).toBe(0);
  });

  it('rejects space while the word is unfinished', () => {
    const engine = make(['abc de'], { mode: 'word' });
    typeText(engine, 'ab');
    expect(engine.space(200)).toEqual({ kind: 'rejected', dirty: [0] });
    expect(engine.stats().keysWrong).toBe(1);
    expect(engine.caret()).toEqual({ word: 0, char: 2 });
  });

  it('rejects space while the word has extra letters', () => {
    const engine = make(['ab cd'], { mode: 'word' });
    typeText(engine, 'abx');
    expect(engine.space(300).kind).toBe('rejected');
    expect(engine.stats().keysWrong).toBe(2);
    expect(engine.caret()).toEqual({ word: 0, char: 3 });
  });

  it('reports a rejected space as a miss of the due glyph', () => {
    const { engine, keys } = recorded(['abc de'], { mode: 'word' });
    typeText(engine, 'ab ');
    expect(keys[2]).toEqual({ expected: 'c', typed: ' ', correct: false, gapMs: 100 });
  });

  it('reports a rejected space after extra letters as expected space, not correct', () => {
    const { engine, keys } = recorded(['ab cd'], { mode: 'word' });
    typeText(engine, 'abx ');
    expect(keys[3]).toEqual({ expected: ' ', typed: ' ', correct: false, gapMs: 100 });
  });

  it('advances with space after the word is fixed with backspace', () => {
    const engine = make(['abc de'], { mode: 'word' });
    typeText(engine, 'axc');
    expect(engine.space(300).kind).toBe('rejected');
    engine.backspace(400);
    engine.backspace(500);
    typeText(engine, 'bc', 600);
    expect(engine.space(800)).toEqual({ kind: 'advanced', dirty: [0, 1] });
    expect(engine.wordIndex).toBe(1);
  });

  it('counts the accepted space as a correct key', () => {
    const engine = make(['ab cd'], { mode: 'word' });
    typeText(engine, 'ab');
    engine.space(200);
    expect(engine.stats().keysCorrect).toBe(3);
    expect(engine.stats().keysWrong).toBe(0);
  });

  it('advances after extra letters are removed', () => {
    const engine = make(['ab cd'], { mode: 'word' });
    typeText(engine, 'abx');
    engine.backspace(300);
    expect(engine.space(400).kind).toBe('advanced');
  });

  it('ignores space on an untouched word without counting it', () => {
    const engine = make(['ab cd'], { mode: 'word' });
    expect(engine.space(0)).toEqual(NONE);
    expect(engine.stats().keysCorrect).toBe(0);
    expect(engine.stats().keysWrong).toBe(0);
  });

  it('ignores a double space after a finished word', () => {
    const engine = make(['ab cd'], { mode: 'word' });
    typeText(engine, 'ab ');
    expect(engine.space(500)).toEqual(NONE);
  });
});

describe('word mode: previous words', () => {
  it('cannot re-enter the previous word with backspace or deleteWord', () => {
    const engine = make(['ab cd'], { mode: 'word' });
    typeText(engine, 'ab ');
    expect(engine.backspace(300)).toEqual(NONE);
    expect(engine.deleteWord(400)).toEqual(NONE);
    expect(engine.wordIndex).toBe(1);
  });

  it('never leaves a word behind with a mistake in it', () => {
    const engine = make(['ab cd ef'], { mode: 'word' });
    typeText(engine, 'ab ');
    typeText(engine, 'cx ', 1000);
    expect(engine.wordIndex).toBe(1);
    expect(engine.wordView(0).flawed).toBe(false);
    expect(engine.wordView(1).flawed).toBe(false);
  });
});

describe('word mode: last word', () => {
  it('finishes on its own when it is typed correctly', () => {
    const engine = make(['ab cd'], { mode: 'word' });
    const changes = typeText(engine, 'ab cd');
    expect(changes[4]).toEqual({ kind: 'finished', dirty: [1] });
    expect(engine.finished).toBe(true);
  });

  it('cannot be finished with space while wrong', () => {
    const engine = make(['ab'], { mode: 'word' });
    typeText(engine, 'ax');
    expect(engine.space(300).kind).toBe('rejected');
    expect(engine.finished).toBe(false);
  });

  it('cannot be finished with Enter while wrong', () => {
    const engine = make(['ab'], { mode: 'word' });
    typeText(engine, 'ax');
    expect(engine.enter(300).kind).toBe('rejected');
    expect(engine.finished).toBe(false);
  });

  it('cannot be finished with space while unfinished', () => {
    const engine = make(['abc'], { mode: 'word' });
    typeText(engine, 'ab');
    expect(engine.space(200).kind).toBe('rejected');
    expect(engine.finished).toBe(false);
  });

  it('finishes once a wrong last word has been corrected', () => {
    const engine = make(['ab'], { mode: 'word' });
    typeText(engine, 'ax');
    engine.backspace(300);
    expect(engine.type('b', 400).kind).toBe('finished');
  });
});

describe('word mode: switching mid-passage', () => {
  it('takes effect on the next key when switched from flow', () => {
    const engine = make(['abc de']);
    typeText(engine, 'ab');
    engine.mode = 'word';
    expect(engine.space(300).kind).toBe('rejected');
    expect(engine.wordIndex).toBe(0);
  });

  it('lets space advance again when switched back to flow', () => {
    const engine = make(['abc de'], { mode: 'word' });
    typeText(engine, 'ab');
    expect(engine.space(200).kind).toBe('rejected');
    engine.mode = 'flow';
    expect(engine.space(300).kind).toBe('advanced');
  });

  it('keeps a wrong letter typed in flow, then refuses space after switching to word', () => {
    const engine = make(['abc de']);
    expect(engine.type('x', 0).kind).toBe('typed');
    engine.mode = 'word';
    expect(engine.type('b', 100).kind).toBe('typed');
    expect(engine.space(200).kind).toBe('rejected');
  });
});

describe('strictSpace: off', () => {
  it('is off by default and ignores space on an untouched word', () => {
    const engine = make(['abc de']);
    expect(engine.strictSpace).toBe(false);
    expect(engine.space(0)).toEqual(NONE);
    expect(engine.stats().keysWrong).toBe(0);
    expect(engine.caret()).toEqual({ word: 0, char: 0 });
  });
});

describe('strictSpace: flow mode', () => {
  it('exposes the option as a property', () => {
    expect(make(['ab'], { strictSpace: true }).strictSpace).toBe(true);
  });

  it('types the space into an untouched word as a wrong character', () => {
    const engine = make(['abc de'], { strictSpace: true });
    expect(engine.space(0)).toEqual({ kind: 'typed', dirty: [0] });
    expect(engine.caret()).toEqual({ word: 0, char: 1 });
    expect(engine.wordView(0).states).toEqual(['bad', 'pending', 'pending']);
    expect(engine.wordIndex).toBe(0);
  });

  it('counts the space as a wrong key', () => {
    const engine = make(['abc de'], { strictSpace: true });
    engine.space(0);
    expect(engine.stats().keysWrong).toBe(1);
    expect(engine.stats().keysCorrect).toBe(0);
  });

  it('reports the first glyph as expected and the space as typed and wrong', () => {
    const { engine, keys } = recorded(['abc de'], { strictSpace: true });
    engine.space(0);
    expect(keys).toEqual([{ expected: 'a', typed: ' ', correct: false, gapMs: 0 }]);
  });

  it('is also reached when a space is sent through type', () => {
    const engine = make(['abc de'], { strictSpace: true });
    expect(engine.type(' ', 0).kind).toBe('typed');
  });

  it('removes the space again with backspace', () => {
    const engine = make(['abc de'], { strictSpace: true });
    engine.space(0);
    expect(engine.backspace(100)).toEqual({ kind: 'erased', dirty: [0] });
    expect(engine.caret()).toEqual({ word: 0, char: 0 });
    expect(engine.wordView(0).states).toEqual(['pending', 'pending', 'pending']);
  });

  it('counts a double space after a finished word as a mistake in the next word', () => {
    const engine = make(['ab cd'], { strictSpace: true });
    typeText(engine, 'ab ');
    expect(engine.space(500).kind).toBe('typed');
    expect(engine.wordIndex).toBe(1);
    expect(engine.stats().keysWrong).toBe(1);
  });
});

describe('strictSpace: strict mode', () => {
  it('rejects space on an untouched word and adds nothing', () => {
    const engine = make(['abc de'], { mode: 'strict', strictSpace: true });
    expect(engine.space(0)).toEqual({ kind: 'rejected', dirty: [0] });
    expect(engine.caret()).toEqual({ word: 0, char: 0 });
    expect(engine.wordView(0).states).toEqual(['pending', 'pending', 'pending']);
  });

  it('counts the rejected space as a wrong key', () => {
    const engine = make(['abc de'], { mode: 'strict', strictSpace: true });
    engine.space(0);
    expect(engine.stats().keysWrong).toBe(1);
  });
});

describe('strictSpace: word mode', () => {
  it('keeps the space as a mistake on an untouched word', () => {
    const engine = make(['abc de'], { mode: 'word', strictSpace: true });
    expect(engine.space(0)).toEqual({ kind: 'typed', dirty: [0] });
    expect(engine.wordView(0).states).toEqual(['bad', 'pending', 'pending']);
    expect(engine.stats().keysWrong).toBe(1);
  });

  it('rejects a following space', () => {
    const engine = make(['abc de'], { mode: 'word', strictSpace: true });
    engine.space(0);
    expect(engine.space(100).kind).toBe('rejected');
    expect(engine.caret()).toEqual({ word: 0, char: 1 });
    expect(engine.stats().keysWrong).toBe(2);
  });
});

describe('strictSpace: only an untouched word', () => {
  it('behaves exactly as with the option off after a typed letter', () => {
    const run = (strictSpace: boolean) => {
      const { engine, keys } = recorded(['abc de'], { strictSpace });
      engine.type('a', 0);
      const change = engine.space(100);
      return { change, keys, stats: engine.stats(), view: engine.wordView(0) };
    };
    expect(run(true)).toEqual(run(false));
  });

  it('still advances with a plain space after a finished word', () => {
    const engine = make(['ab cd'], { strictSpace: true });
    typeText(engine, 'ab');
    expect(engine.space(200).kind).toBe('advanced');
    expect(engine.stats().keysWrong).toBe(0);
  });
});

describe('strictSpace: switching mid-passage', () => {
  it('takes effect on the next space when turned on', () => {
    const engine = make(['abc de']);
    expect(engine.space(0)).toEqual(NONE);
    engine.strictSpace = true;
    expect(engine.space(100).kind).toBe('typed');
  });

  it('takes effect on the next space when turned off', () => {
    const engine = make(['abc de'], { strictSpace: true });
    engine.strictSpace = false;
    expect(engine.space(0)).toEqual(NONE);
    expect(engine.stats().keysWrong).toBe(0);
  });
});
