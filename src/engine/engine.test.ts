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

const last = (changes: Change[]): Change => changes[changes.length - 1];
const NONE: Change = { kind: 'none', dirty: [] };

describe('flow mode: typing', () => {
  it('marks correct characters ok with kind typed', () => {
    const engine = make(['abc def']);
    const change = engine.type('a', 0);
    expect(change).toEqual({ kind: 'typed', dirty: [0] });
    expect(engine.wordView(0).states).toEqual(['ok', 'pending', 'pending']);
  });

  it('advances the caret with each correct character', () => {
    const engine = make(['abc def']);
    expect(engine.caret()).toEqual({ word: 0, char: 0 });
    typeText(engine, 'ab');
    expect(engine.caret()).toEqual({ word: 0, char: 2 });
  });

  it('keeps a wrong character on the page as bad and counts a wrong key', () => {
    const engine = make(['abc def']);
    const change = engine.type('x', 0);
    expect(change.kind).toBe('typed');
    expect(engine.wordView(0).states).toEqual(['bad', 'pending', 'pending']);
    expect(engine.caret()).toEqual({ word: 0, char: 1 });
    expect(engine.stats().keysWrong).toBe(1);
    expect(engine.stats().keysCorrect).toBe(0);
  });

  it('keeps extra letters past the end of a word', () => {
    const engine = make(['ab cd']);
    typeText(engine, 'abxy');
    expect(engine.wordView(0).extras).toEqual(['x', 'y']);
    expect(engine.caret()).toEqual({ word: 0, char: 4 });
  });

  it('rejects extra letters beyond maxExtra and counts them as wrong keys', () => {
    const engine = make(['ab cd'], { maxExtra: 2 });
    typeText(engine, 'ab');
    expect(engine.type('x', 300).kind).toBe('typed');
    expect(engine.type('y', 400).kind).toBe('typed');
    const change = engine.type('z', 500);
    expect(change).toEqual({ kind: 'rejected', dirty: [0] });
    expect(engine.wordView(0).extras).toEqual(['x', 'y']);
    expect(engine.stats().keysWrong).toBe(3);
  });

  it('allows eight extra letters by default and rejects the ninth', () => {
    const engine = make(['ab cd']);
    typeText(engine, 'ab');
    const changes = typeText(engine, 'xxxxxxxxx', 1000);
    expect(changes.slice(0, 8).every((c) => c.kind === 'typed')).toBe(true);
    expect(changes[8].kind).toBe('rejected');
  });

  it('ignores an empty string', () => {
    const engine = make(['ab']);
    expect(engine.type('', 0)).toEqual(NONE);
    expect(engine.stats().keysCorrect + engine.stats().keysWrong).toBe(0);
  });

  it('accepts a straight quote for a curly quote in the text', () => {
    const engine = make(['“hi” there']);
    expect(engine.type('"', 0).kind).toBe('typed');
    expect(engine.wordView(0).states[0]).toBe('ok');
    typeText(engine, 'hi', 100);
    engine.type('"', 400);
    expect(engine.wordView(0).states).toEqual(['ok', 'ok', 'ok', 'ok']);
    expect(engine.stats().keysWrong).toBe(0);
  });

  it('accepts the curly quote itself too', () => {
    const engine = make(['“hi” there']);
    engine.type('“', 0);
    expect(engine.wordView(0).states[0]).toBe('ok');
  });

  it('routes a space typed through type to space', () => {
    const engine = make(['ab cd']);
    typeText(engine, 'ab ');
    expect(engine.wordIndex).toBe(1);
  });
});

describe('flow mode: space', () => {
  it('ignores a space on an untouched word without counting it', () => {
    const engine = make(['ab cd']);
    expect(engine.space(0)).toEqual(NONE);
    const stats = engine.stats();
    expect(stats.keysCorrect).toBe(0);
    expect(stats.keysWrong).toBe(0);
    expect(engine.caret()).toEqual({ word: 0, char: 0 });
  });

  it('ignores a double space after a finished word', () => {
    const engine = make(['ab cd']);
    typeText(engine, 'ab ');
    const before = engine.stats();
    expect(engine.space(500)).toEqual(NONE);
    expect(engine.stats().keysCorrect).toBe(before.keysCorrect);
  });

  it('advances mid-word, marks the rest missed and counts a wrong key', () => {
    const engine = make(['abc de']);
    engine.type('a', 0);
    const change = engine.space(100);
    expect(change).toEqual({ kind: 'advanced', dirty: [0, 1] });
    expect(engine.wordIndex).toBe(1);
    const view = engine.wordView(0);
    expect(view.states).toEqual(['ok', 'missed', 'missed']);
    expect(view.flawed).toBe(true);
    const stats = engine.stats();
    expect(stats.keysCorrect).toBe(1);
    expect(stats.keysWrong).toBe(1);
  });

  it('counts a space at the end of a word as a correct key', () => {
    const engine = make(['ab cd']);
    typeText(engine, 'ab');
    const change = engine.space(200);
    expect(change.kind).toBe('advanced');
    expect(engine.stats().keysCorrect).toBe(3);
    expect(engine.stats().keysWrong).toBe(0);
    expect(engine.wordView(0).flawed).toBe(false);
  });

  it('advances past a word that has extra letters, which makes it flawed', () => {
    const engine = make(['ab cd']);
    typeText(engine, 'abx ');
    expect(engine.wordIndex).toBe(1);
    expect(engine.wordView(0).flawed).toBe(true);
  });
});

describe('flow mode: flawed', () => {
  it('is false for the word being typed even with a mistake', () => {
    const engine = make(['abc de']);
    typeText(engine, 'x');
    expect(engine.wordView(0).flawed).toBe(false);
  });

  it('is false for the word being typed even with extra letters', () => {
    const engine = make(['ab cd']);
    typeText(engine, 'abx');
    expect(engine.wordView(0).flawed).toBe(false);
  });

  it('is true once a mistaken word has been left', () => {
    const engine = make(['abc de']);
    typeText(engine, 'xbc ');
    expect(engine.wordView(0).flawed).toBe(true);
  });

  it('is false for words not yet reached', () => {
    const engine = make(['abc de']);
    expect(engine.wordView(1).flawed).toBe(false);
    expect(engine.wordView(1).states).toEqual(['pending', 'pending']);
  });

  it('is false for a left word that was typed correctly', () => {
    const engine = make(['abc de']);
    typeText(engine, 'abc ');
    expect(engine.wordView(0).flawed).toBe(false);
  });
});

describe('flow mode: enter', () => {
  it('is ignored on a word that does not end a paragraph', () => {
    const engine = make(['ab cd', 'ef']);
    typeText(engine, 'ab');
    expect(engine.enter(300)).toEqual(NONE);
    expect(engine.wordIndex).toBe(0);
  });

  it('is ignored when sent through type as a line break', () => {
    const engine = make(['ab cd', 'ef']);
    typeText(engine, 'ab');
    expect(engine.type('\n', 300)).toEqual(NONE);
    expect(engine.wordIndex).toBe(0);
  });

  it('advances on the last word of a paragraph', () => {
    const engine = make(['ab cd', 'ef']);
    typeText(engine, 'ab cd');
    const change = engine.enter(600);
    expect(change).toEqual({ kind: 'advanced', dirty: [1, 2] });
    expect(engine.wordIndex).toBe(2);
  });

  it('advances on the last word of a paragraph when sent through type', () => {
    const engine = make(['ab cd', 'ef']);
    typeText(engine, 'ab cd');
    expect(engine.type('\n', 600).kind).toBe('advanced');
  });

  it('does nothing on an untouched last word of a paragraph', () => {
    const engine = make(['ab cd', 'ef']);
    typeText(engine, 'ab ');
    expect(engine.enter(400)).toEqual(NONE);
    expect(engine.wordIndex).toBe(1);
  });
});

describe('flow mode: backspace', () => {
  it('removes one character', () => {
    const engine = make(['abc de']);
    typeText(engine, 'abx');
    const change = engine.backspace(300);
    expect(change).toEqual({ kind: 'erased', dirty: [0] });
    expect(engine.caret()).toEqual({ word: 0, char: 2 });
    expect(engine.wordView(0).states).toEqual(['ok', 'ok', 'pending']);
  });

  it('does nothing at the very start of the passage', () => {
    const engine = make(['ab cd']);
    expect(engine.backspace(0)).toEqual(NONE);
  });

  it('steps back into a mistaken previous word, caret after its typed text', () => {
    const engine = make(['abc de']);
    typeText(engine, 'ax ');
    const change = engine.backspace(300);
    expect(change).toEqual({ kind: 'retreated', dirty: [0, 1] });
    expect(engine.wordIndex).toBe(0);
    expect(engine.caret()).toEqual({ word: 0, char: 2 });
    expect(engine.wordView(0).states).toEqual(['ok', 'bad', 'pending']);
    expect(engine.wordView(0).flawed).toBe(false);
  });

  it('steps back into a previous word that was left unfinished', () => {
    const engine = make(['abc de']);
    typeText(engine, 'a ');
    expect(engine.backspace(300).kind).toBe('retreated');
    expect(engine.caret()).toEqual({ word: 0, char: 1 });
  });

  it('steps back into a previous word with extra letters', () => {
    const engine = make(['ab cd']);
    typeText(engine, 'abx ');
    expect(engine.backspace(500).kind).toBe('retreated');
    expect(engine.caret()).toEqual({ word: 0, char: 3 });
  });

  it('never re-enters a correct previous word', () => {
    const engine = make(['ab cd']);
    typeText(engine, 'ab ');
    expect(engine.backspace(300)).toEqual(NONE);
    expect(engine.wordIndex).toBe(1);
    expect(engine.caret()).toEqual({ word: 1, char: 0 });
  });

  it('never goes below the floor', () => {
    const engine = make(['abc de']);
    typeText(engine, 'x ');
    engine.floor = 1;
    expect(engine.backspace(300)).toEqual(NONE);
    expect(engine.wordIndex).toBe(1);
  });

  it('can still step back to a mistaken word exactly at the floor', () => {
    const engine = make(['abc de fg']);
    typeText(engine, 'x y ');
    engine.floor = 1;
    expect(engine.backspace(500).kind).toBe('retreated');
    expect(engine.wordIndex).toBe(1);
    expect(engine.backspace(600).kind).toBe('erased');
    expect(engine.backspace(700)).toEqual(NONE);
  });
});

describe('flow mode: deleteWord', () => {
  it('clears the current word', () => {
    const engine = make(['abc de']);
    typeText(engine, 'abx');
    const change = engine.deleteWord(300);
    expect(change).toEqual({ kind: 'erased', dirty: [0] });
    expect(engine.caret()).toEqual({ word: 0, char: 0 });
    expect(engine.wordView(0).states).toEqual(['pending', 'pending', 'pending']);
  });

  it('does nothing on an untouched first word', () => {
    const engine = make(['ab cd']);
    expect(engine.deleteWord(0)).toEqual(NONE);
  });

  it('steps back into a mistaken previous word and clears it', () => {
    const engine = make(['abc de']);
    typeText(engine, 'ax ');
    const change = engine.deleteWord(300);
    expect(change).toEqual({ kind: 'retreated', dirty: [0, 1] });
    expect(engine.wordIndex).toBe(0);
    expect(engine.caret()).toEqual({ word: 0, char: 0 });
    expect(engine.wordView(0).states).toEqual(['pending', 'pending', 'pending']);
  });

  it('does not re-enter a correct previous word', () => {
    const engine = make(['ab cd']);
    typeText(engine, 'ab ');
    expect(engine.deleteWord(300)).toEqual(NONE);
    expect(engine.wordIndex).toBe(1);
  });

  it('never goes below the floor', () => {
    const engine = make(['abc de']);
    typeText(engine, 'x ');
    engine.floor = 1;
    expect(engine.deleteWord(300)).toEqual(NONE);
    expect(engine.wordIndex).toBe(1);
  });
});

describe('flow mode: finishing', () => {
  it('finishes the last word without a space as soon as it is correct', () => {
    const engine = make(['ab']);
    expect(engine.type('a', 0).kind).toBe('typed');
    const change = engine.type('b', 100);
    expect(change).toEqual({ kind: 'finished', dirty: [0] });
    expect(engine.finished).toBe(true);
  });

  it('finishes after the earlier words once the last word is correct', () => {
    const engine = make(['ab cd']);
    const changes = typeText(engine, 'ab cd');
    expect(changes.map((c) => c.kind)).toEqual(['typed', 'typed', 'advanced', 'typed', 'finished']);
  });

  it('does not finish a wrong last word on its own', () => {
    const engine = make(['ab']);
    typeText(engine, 'ax');
    expect(engine.finished).toBe(false);
  });

  it('finishes a wrong last word with space', () => {
    const engine = make(['ab']);
    typeText(engine, 'ax');
    const change = engine.space(300);
    expect(change).toEqual({ kind: 'finished', dirty: [0] });
    expect(engine.finished).toBe(true);
    expect(engine.wordView(0).flawed).toBe(true);
  });

  it('finishes a wrong last word with Enter', () => {
    const engine = make(['ab']);
    typeText(engine, 'ax');
    expect(engine.enter(300).kind).toBe('finished');
    expect(engine.finished).toBe(true);
  });

  it('finishes an unfinished last word with space and marks the rest missed', () => {
    const engine = make(['abc']);
    typeText(engine, 'a');
    expect(engine.space(100).kind).toBe('finished');
    expect(engine.wordView(0).states).toEqual(['ok', 'missed', 'missed']);
    expect(engine.wordView(0).flawed).toBe(true);
  });

  it('finishes once a wrong last word has been corrected', () => {
    const engine = make(['ab']);
    typeText(engine, 'ax');
    engine.backspace(300);
    expect(engine.type('b', 400).kind).toBe('finished');
  });

  it('does not flag a correct last word as flawed after finishing', () => {
    const engine = make(['ab']);
    typeText(engine, 'ab');
    expect(engine.wordView(0).flawed).toBe(false);
  });

  it('returns none for every input after finishing', () => {
    const engine = make(['ab']);
    typeText(engine, 'ab');
    const before = engine.stats();
    expect(engine.type('c', 1000)).toEqual(NONE);
    expect(engine.type(' ', 1000)).toEqual(NONE);
    expect(engine.type('\n', 1000)).toEqual(NONE);
    expect(engine.space(1000)).toEqual(NONE);
    expect(engine.enter(1000)).toEqual(NONE);
    expect(engine.backspace(1000)).toEqual(NONE);
    expect(engine.deleteWord(1000)).toEqual(NONE);
    expect(engine.stats()).toEqual(before);
  });
});

describe('dirty words', () => {
  it('lists the typed word for typed changes', () => {
    const engine = make(['ab cd']);
    typeText(engine, 'ab ');
    expect(engine.type('c', 400).dirty).toEqual([1]);
  });

  it('lists the left and the new word for advanced changes', () => {
    const engine = make(['ab cd ef']);
    typeText(engine, 'ab ');
    expect(last(typeText(engine, 'cd ', 1000)).dirty).toEqual([1, 2]);
  });

  it('lists the previous and the current word for retreated changes', () => {
    const engine = make(['ab cd ef']);
    typeText(engine, 'ab cx ');
    expect(engine.backspace(1000).dirty).toEqual([1, 2]);
  });

  it('lists the typed word for rejected changes', () => {
    const engine = make(['ab cd'], { mode: 'strict' });
    typeText(engine, 'ab ');
    expect(engine.type('x', 400)).toEqual({ kind: 'rejected', dirty: [1] });
  });
});

describe('strict mode', () => {
  it('rejects a wrong key, adds nothing and counts a wrong key', () => {
    const engine = make(['abc de'], { mode: 'strict' });
    const change = engine.type('x', 0);
    expect(change).toEqual({ kind: 'rejected', dirty: [0] });
    expect(engine.caret()).toEqual({ word: 0, char: 0 });
    expect(engine.wordView(0).states).toEqual(['pending', 'pending', 'pending']);
    expect(engine.stats().keysWrong).toBe(1);
  });

  it('accepts the right key after a rejected one', () => {
    const engine = make(['abc de'], { mode: 'strict' });
    engine.type('x', 0);
    expect(engine.type('a', 100).kind).toBe('typed');
    expect(engine.caret()).toEqual({ word: 0, char: 1 });
    expect(engine.stats().keysWrong).toBe(1);
    expect(engine.stats().keysCorrect).toBe(1);
  });

  it('rejects a letter past the end of a word', () => {
    const engine = make(['ab cd'], { mode: 'strict' });
    typeText(engine, 'ab');
    expect(engine.type('x', 300).kind).toBe('rejected');
    expect(engine.wordView(0).extras).toEqual([]);
  });

  it('rejects space before the word is complete', () => {
    const engine = make(['abc de'], { mode: 'strict' });
    engine.type('a', 0);
    const change = engine.space(100);
    expect(change).toEqual({ kind: 'rejected', dirty: [0] });
    expect(engine.wordIndex).toBe(0);
    expect(engine.stats().keysWrong).toBe(1);
  });

  it('still ignores space on an untouched word without counting it', () => {
    const engine = make(['abc de'], { mode: 'strict' });
    expect(engine.space(0)).toEqual(NONE);
    expect(engine.stats().keysWrong).toBe(0);
    expect(engine.stats().keysCorrect).toBe(0);
  });

  it('advances on space once the word is complete', () => {
    const engine = make(['ab cd'], { mode: 'strict' });
    typeText(engine, 'ab');
    expect(engine.space(300).kind).toBe('advanced');
  });

  it('cannot re-enter previous words', () => {
    const engine = make(['ab cd'], { mode: 'strict' });
    typeText(engine, 'ab ');
    expect(engine.backspace(300)).toEqual(NONE);
    expect(engine.deleteWord(300)).toEqual(NONE);
    expect(engine.wordIndex).toBe(1);
  });

  it('still lets backspace remove a correct character of the current word', () => {
    const engine = make(['abc de'], { mode: 'strict' });
    typeText(engine, 'ab');
    expect(engine.backspace(300).kind).toBe('erased');
    expect(engine.caret()).toEqual({ word: 0, char: 1 });
  });

  it('finishes the passage when the last word is typed correctly', () => {
    const engine = make(['ab'], { mode: 'strict' });
    expect(last(typeText(engine, 'ab')).kind).toBe('finished');
  });

  it('exposes mode as a public property', () => {
    expect(make(['ab']).mode).toBe('flow');
    expect(make(['ab'], { mode: 'strict' }).mode).toBe('strict');
  });

  it('can be switched to strict mid-passage', () => {
    const engine = make(['abc de']);
    expect(engine.type('x', 0).kind).toBe('typed');
    engine.mode = 'strict';
    expect(engine.type('x', 100).kind).toBe('rejected');
  });

  it('can be switched back to flow mid-passage', () => {
    const engine = make(['abc de'], { mode: 'strict' });
    expect(engine.type('x', 0).kind).toBe('rejected');
    engine.mode = 'flow';
    expect(engine.type('x', 100).kind).toBe('typed');
  });
});

describe('stats: wpm', () => {
  it('counts correct characters over five per minute, with the gap after a correct word', () => {
    // "ab cd" at 100 ms gaps: 4 keys + space = 500 ms between first and last key = 400 ms.
    // Credit: "ab" 2 + 1 gap, "cd" 2 (last word, no gap) = 5 correct chars.
    // wpm = (5 / 5) / (400 / 60000) = 150.
    const engine = make(['ab cd']);
    typeText(engine, 'ab cd');
    const stats = engine.stats();
    expect(stats.activeMs).toBe(400);
    expect(stats.correctChars).toBe(5);
    expect(stats.wpm).toBeCloseTo(150, 6);
  });

  it('gives no gap credit to a word with a mistake', () => {
    // "ab cd": "ax" (1 correct, no gap), space, "cd" (2) = 3 chars in 400 ms.
    const engine = make(['ab cd']);
    typeText(engine, 'ax cd');
    const stats = engine.stats();
    expect(stats.correctChars).toBe(3);
    expect(stats.wpm).toBeCloseTo(3 / 5 / (400 / 60000), 6);
  });

  it('counts the characters of the word being typed', () => {
    const engine = make(['abc de']);
    typeText(engine, 'ab');
    expect(engine.stats().correctChars).toBe(2);
  });

  it('is 0 before any time has passed', () => {
    const engine = make(['ab']);
    expect(engine.stats().wpm).toBe(0);
    engine.type('a', 500);
    expect(engine.stats().wpm).toBe(0);
  });
});

describe('stats: accuracy', () => {
  it('is 1 before any key', () => {
    expect(make(['ab']).stats().accuracy).toBe(1);
  });

  it('is correct keys over all judged keys', () => {
    const engine = make(['abcd']);
    typeText(engine, 'axcd');
    const stats = engine.stats();
    expect(stats.keysCorrect).toBe(3);
    expect(stats.keysWrong).toBe(1);
    expect(stats.accuracy).toBe(0.75);
  });

  it('does not count backspace or ignored keys', () => {
    const engine = make(['abc de']);
    engine.space(0);
    engine.type('a', 100);
    engine.backspace(200);
    expect(engine.stats().keysCorrect).toBe(1);
    expect(engine.stats().keysWrong).toBe(0);
    expect(engine.stats().accuracy).toBe(1);
  });
});

describe('stats: typing clock', () => {
  it('counts the whole gap between two keys, however long', () => {
    const engine = make(['abc']);
    engine.type('a', 0);
    engine.type('b', 60_000);
    expect(engine.stats().activeMs).toBe(60_000);
  });

  it('adds up every gap', () => {
    const engine = make(['abcd']);
    engine.type('a', 0);
    engine.type('b', 1000);
    engine.type('c', 1300);
    expect(engine.stats().activeMs).toBe(1300);
  });

  it('starts at the first key, not before it', () => {
    const engine = make(['abc']);
    expect(engine.stats(50_000).activeMs).toBe(0);
    engine.type('a', 50_000);
    expect(engine.stats(50_000).activeMs).toBe(0);
  });

  it('runs between keys when given the current time', () => {
    const engine = make(['abc']);
    engine.type('a', 0);
    engine.type('b', 400);
    expect(engine.stats().activeMs).toBe(400); // as of the last key
    expect(engine.stats(1650).activeMs).toBe(1650); // live
    expect(engine.stats(1650).wpm).toBeLessThan(engine.stats().wpm);
  });

  it('never runs backwards if given a time before the last key', () => {
    const engine = make(['abc']);
    engine.type('a', 0);
    engine.type('b', 400);
    expect(engine.stats(100).activeMs).toBe(400);
  });

  it('stops for good when the passage is finished', () => {
    const engine = make(['ab']);
    engine.type('a', 0);
    engine.type('b', 300);
    expect(engine.stats().finished).toBe(true);
    expect(engine.stats(99_000).activeMs).toBe(300);
  });
});

describe('stats: stepping back', () => {
  it('removes the credit of a word that is stepped back into and cleared', () => {
    const engine = make(['abc de']);
    typeText(engine, 'ab ');
    expect(engine.stats().correctChars).toBe(2);
    engine.deleteWord(500);
    expect(engine.stats().correctChars).toBe(0);
  });

  it('does not count a word twice after stepping back into it', () => {
    const engine = make(['abc de']);
    typeText(engine, 'ab ');
    engine.backspace(500);
    expect(engine.stats().correctChars).toBe(2);
  });

  it('credits the word again, with the gap, when it is re-finished', () => {
    const engine = make(['abc de']);
    typeText(engine, 'ab ');
    engine.backspace(500);
    typeText(engine, 'c ', 600);
    // "abc" fully correct: 3 chars plus 1 gap
    expect(engine.stats().correctChars).toBe(4);
    typeText(engine, 'de', 1000);
    expect(engine.stats().correctChars).toBe(6);
  });

  it('credits only the correct characters when re-finished with a mistake', () => {
    const engine = make(['ab cd']);
    typeText(engine, 'ax ');
    engine.backspace(500);
    engine.backspace(600);
    typeText(engine, 'y ', 700);
    expect(engine.stats().correctChars).toBe(1);
  });
});

describe('stats: progress', () => {
  it('reports wordsDone, wordsTotal and finished along the way', () => {
    const engine = make(['ab cd ef']);
    expect(engine.stats()).toMatchObject({ wordsDone: 0, wordsTotal: 3, finished: false });
    typeText(engine, 'ab ');
    expect(engine.stats()).toMatchObject({ wordsDone: 1, wordsTotal: 3, finished: false });
    typeText(engine, 'cd ', 1000);
    expect(engine.stats()).toMatchObject({ wordsDone: 2, wordsTotal: 3, finished: false });
    typeText(engine, 'ef', 2000);
    expect(engine.stats()).toMatchObject({ wordsDone: 3, wordsTotal: 3, finished: true });
  });

  it('counts words across paragraphs', () => {
    expect(make(['a b', 'c']).stats().wordsTotal).toBe(3);
  });

  it('lowers wordsDone when stepping back into a word', () => {
    const engine = make(['abc de']);
    typeText(engine, 'a ');
    expect(engine.stats().wordsDone).toBe(1);
    engine.backspace(500);
    expect(engine.stats().wordsDone).toBe(0);
  });

  it('counts the correct characters of the last word once the passage is finished', () => {
    const engine = make(['ab']);
    typeText(engine, 'ab');
    expect(engine.stats().correctChars).toBe(2);
  });
});

describe('onKey', () => {
  function recorded(paragraphs: string[], options: EngineOptions = {}) {
    const keys: KeyRecord[] = [];
    const engine = make(paragraphs, { ...options, onKey: (k) => keys.push(k) });
    return { engine, keys };
  }

  it('reports expected glyph, typed character, correct flag and gap', () => {
    const { engine, keys } = recorded(['ab cd']);
    engine.type('a', 1000);
    engine.type('x', 1250);
    expect(keys).toEqual([
      { expected: 'a', typed: 'a', correct: true, gapMs: 0 },
      { expected: 'b', typed: 'x', correct: false, gapMs: 250 },
    ]);
  });

  it('reports gapMs of 0 for the first key whatever the clock says', () => {
    const { engine, keys } = recorded(['ab']);
    engine.type('a', 987_654);
    expect(keys[0].gapMs).toBe(0);
  });

  it('reports the uncapped gap', () => {
    const { engine, keys } = recorded(['abc']);
    engine.type('a', 0);
    engine.type('b', 9000);
    expect(keys[1].gapMs).toBe(9000);
  });

  it('reports the printed glyph as expected for a curly quote typed straight', () => {
    const { engine, keys } = recorded(['“ab']);
    engine.type('"', 0);
    expect(keys[0]).toEqual({ expected: '“', typed: '"', correct: true, gapMs: 0 });
  });

  it('reports expected null for an extra letter', () => {
    const { engine, keys } = recorded(['ab cd']);
    typeText(engine, 'abz');
    expect(keys[2]).toMatchObject({ expected: null, typed: 'z', correct: false });
  });

  it('reports a space at the end of a word as expected space and correct', () => {
    const { engine, keys } = recorded(['ab cd']);
    typeText(engine, 'ab ');
    expect(keys[2]).toEqual({ expected: ' ', typed: ' ', correct: true, gapMs: 100 });
  });

  it('reports a mid-word space as a miss of the due glyph', () => {
    const { engine, keys } = recorded(['abc de']);
    typeText(engine, 'a ');
    expect(keys[1]).toEqual({ expected: 'b', typed: ' ', correct: false, gapMs: 100 });
  });

  it('reports a rejected key in strict mode', () => {
    const { engine, keys } = recorded(['ab'], { mode: 'strict' });
    engine.type('x', 0);
    expect(keys).toEqual([{ expected: 'a', typed: 'x', correct: false, gapMs: 0 }]);
  });

  it('does not report ignored keys or edits', () => {
    const { engine, keys } = recorded(['abc de']);
    engine.space(0);
    engine.enter(10);
    engine.backspace(20);
    engine.deleteWord(30);
    expect(keys).toEqual([]);
  });

  it('does not report keys after finishing', () => {
    const { engine, keys } = recorded(['ab']);
    typeText(engine, 'ab');
    engine.type('c', 500);
    expect(keys).toHaveLength(2);
  });

  it('measures the gap from the previous edit, including backspace', () => {
    const { engine, keys } = recorded(['abc']);
    engine.type('a', 0);
    engine.backspace(400);
    engine.type('a', 500);
    expect(keys[1].gapMs).toBe(100);
  });
});

describe('empty passage', () => {
  it('is finished from the start', () => {
    const engine = new TypingEngine(buildPassage([]));
    expect(engine.finished).toBe(true);
    expect(engine.stats()).toMatchObject({
      finished: true,
      wordsDone: 0,
      wordsTotal: 0,
      wpm: 0,
      accuracy: 1,
    });
  });

  it('puts the caret at the start', () => {
    expect(new TypingEngine(buildPassage([])).caret()).toEqual({ word: 0, char: 0 });
  });

  it('treats a passage of only blank paragraphs as empty', () => {
    const engine = new TypingEngine(buildPassage(['', '  ']));
    expect(engine.finished).toBe(true);
  });

  it('returns none for every input', () => {
    const engine = new TypingEngine(buildPassage([]));
    expect(engine.type('a', 0)).toEqual(NONE);
    expect(engine.type(' ', 0)).toEqual(NONE);
    expect(engine.type('\n', 0)).toEqual(NONE);
    expect(engine.space(0)).toEqual(NONE);
    expect(engine.enter(0)).toEqual(NONE);
    expect(engine.backspace(0)).toEqual(NONE);
    expect(engine.deleteWord(0)).toEqual(NONE);
  });
});
