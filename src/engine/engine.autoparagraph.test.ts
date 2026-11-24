import { describe, expect, it } from 'vitest';
import { TypingEngine, type EngineOptions } from './engine';
import { buildPassage } from './text';

const make = (options: EngineOptions = {}) =>
  new TypingEngine(buildPassage(['ab cd', 'ef', 'gh']), { autoParagraph: true, ...options });

function typeAll(engine: TypingEngine, text: string, from = 0) {
  let at = from;
  let last = engine.type('', at);
  for (const char of text) last = engine.type(char, (at += 100));
  return { at, last };
}

describe('auto paragraph', () => {
  it('is off by default: the paragraph end waits for space or Enter', () => {
    const engine = new TypingEngine(buildPassage(['ab cd', 'ef']));
    const { last } = typeAll(engine, 'ab cd');
    expect(last.kind).toBe('typed');
    expect(engine.caret()).toEqual({ word: 1, char: 2 });
  });

  it('moves to the next paragraph when the last word is typed correctly', () => {
    const engine = make();
    const { last } = typeAll(engine, 'ab cd');
    expect(last).toEqual({ kind: 'advanced', dirty: [1, 2] });
    expect(engine.caret()).toEqual({ word: 2, char: 0 });
    expect(engine.wordView(1).flawed).toBe(false);
  });

  it('does not advance mid-paragraph', () => {
    const engine = make();
    const { last } = typeAll(engine, 'ab');
    expect(last.kind).toBe('typed');
    expect(engine.caret()).toEqual({ word: 0, char: 2 });
  });

  it('waits when the last word is wrong, and space still moves on', () => {
    const engine = make();
    const { at, last } = typeAll(engine, 'ab cx');
    expect(last.kind).toBe('typed');
    expect(engine.caret()).toEqual({ word: 1, char: 2 });
    expect(engine.space(at + 100).kind).toBe('advanced');
  });

  it('advances once a wrong last word is fixed', () => {
    const engine = make();
    const { at } = typeAll(engine, 'ab cx');
    engine.backspace(at + 100);
    expect(engine.type('d', at + 200).kind).toBe('advanced');
  });

  it('handles one-word paragraphs in a row and still finishes the passage', () => {
    const engine = make();
    const { last } = typeAll(engine, 'ab cdefgh');
    expect(last.kind).toBe('finished');
    expect(engine.stats().wordsDone).toBe(4);
    expect(engine.stats().accuracy).toBe(1);
  });

  it('gives no credit for a gap that was never typed', () => {
    const engine = make();
    typeAll(engine, 'ab cd');
    // "ab" + its space + "cd", and nothing for the paragraph break.
    expect(engine.stats().correctChars).toBe(5);
  });

  it('ignores a space or Enter pressed out of habit after the change, even with strict space', () => {
    const engine = make({ strictSpace: true });
    const { at } = typeAll(engine, 'ab cd');
    expect(engine.space(at + 100).kind).toBe('none');
    expect(engine.enter(at + 200).kind).toBe('none');
    expect(engine.stats().keysWrong).toBe(0);
    expect(engine.caret()).toEqual({ word: 2, char: 0 });
  });

  it('strict space still applies inside a paragraph', () => {
    const engine = make({ strictSpace: true });
    const { at } = typeAll(engine, 'ab ');
    expect(engine.space(at + 100).kind).toBe('typed');
    expect(engine.stats().keysWrong).toBe(1);
  });

  it('works in strict and word modes', () => {
    for (const mode of ['strict', 'word'] as const) {
      const engine = make({ mode });
      expect(typeAll(engine, 'ab cd').last.kind).toBe('advanced');
    }
  });

  it('can be switched on mid-passage', () => {
    const engine = make({ autoParagraph: false });
    const { at } = typeAll(engine, 'ab cd ');
    engine.autoParagraph = true;
    expect(typeAll(engine, 'ef', at).last.kind).toBe('advanced');
  });
});
