/**
 * The typing engine: given a passage and a stream of key presses, it tracks
 * what has been typed, judges it, and says which words need repainting.
 *
 * It knows nothing about the DOM, SolidJS, books or accounts. Time is passed
 * in by the caller (any monotonic millisecond clock), so it is fully testable.
 */

import { isAccepted, type Passage, type Word } from './text';

/**
 * What happens on a mistake.
 * - `flow`: mistakes stay on the page in red and you keep going. Space moves
 *   to the next word even if the current one is wrong or unfinished.
 * - `word`: mistakes show while you type, but space is refused until the
 *   whole word is right.
 * - `strict`: a wrong key is refused and nothing moves until the right one.
 */
export type Mode = 'flow' | 'word' | 'strict';

export interface EngineOptions {
  mode?: Mode;
  /** Count a space pressed before a word is started as a mistake instead of ignoring it. Default false. */
  strictSpace?: boolean;
  /** Let backspace step back into any previous word, even a correct one. Default false. */
  freedomMode?: boolean;
  /**
   * Move to the next paragraph as soon as the last word of one is typed
   * correctly, with no space or Enter. Default false.
   */
  autoParagraph?: boolean;
  /** Most extra letters that can be typed past the end of a word. Default 8. */
  maxExtra?: number;
  /** How much typing time the recent speed looks back over. Default 60000 ms. */
  recentWindowMs?: number;
  /** Called for every key press that was judged against the text. */
  onKey?: (key: KeyRecord) => void;
}

/** One judged key press. Feeds the weak-key statistics. */
export interface KeyRecord {
  /** The printed character that was due (' ' for a word gap), or null past the end of a word. */
  expected: string | null;
  typed: string;
  correct: boolean;
  /** Time since the previous key press in ms (0 for the first). */
  gapMs: number;
}

export type ChangeKind =
  | 'none' // nothing happened
  | 'typed' // a character was added to the current word
  | 'rejected' // the key was refused (strict mode, or too many extra letters)
  | 'erased' // characters were removed from the current word
  | 'advanced' // moved on to the next word
  | 'retreated' // went back into the previous word
  | 'finished'; // the last word was completed

export interface Change {
  kind: ChangeKind;
  /** Indexes of words whose appearance may have changed. */
  dirty: readonly number[];
}

/** `skipped` marks a word that was jumped over without being typed. */
export type CharState = 'pending' | 'ok' | 'bad' | 'missed' | 'skipped';

/** Everything needed to paint one word. */
export interface WordView {
  /** One state per character of the word. */
  states: CharState[];
  /** Letters typed past the end of the word. */
  extras: string[];
  /** True when the word was left behind with a mistake in it. */
  flawed: boolean;
}

export interface Stats {
  /** Average speed: correct characters (including word gaps) / 5, per minute of typing time. */
  wpm: number;
  /** The same measure over only the most recent minute of typing time. */
  recentWpm: number;
  /** Share of judged key presses that were correct, 0 to 1. */
  accuracy: number;
  /** Typing time in ms: from the first key on, minus paused time. */
  activeMs: number;
  correctChars: number;
  keysCorrect: number;
  keysWrong: number;
  wordsDone: number;
  wordsTotal: number;
  finished: boolean;
}

const NONE: Change = { kind: 'none', dirty: [] };

/** How much typing time the recent speed looks back over, unless told otherwise. */
const DEFAULT_RECENT_WINDOW_MS = 60_000;

export class TypingEngine {
  readonly words: readonly Word[];
  mode: Mode;
  /** See `EngineOptions.strictSpace`. Can be changed mid-passage. */
  strictSpace: boolean;
  /** See `EngineOptions.freedomMode`. Can be changed mid-passage. */
  freedomMode: boolean;
  /** See `EngineOptions.autoParagraph`. Can be changed mid-passage. */
  autoParagraph: boolean;
  /** See `EngineOptions.recentWindowMs`. Can be changed mid-passage. */
  recentWindowMs: number;
  /** Words before this index can no longer be returned to (they have left the page). */
  floor = 0;

  private readonly typed: string[][];
  /** Correct characters credited to each word when it was left. */
  private readonly credit: number[];
  /** Words that were jumped over untouched. They are not mistakes. */
  private readonly skipped: boolean[];
  private readonly maxExtra: number;
  private readonly onKey?: (key: KeyRecord) => void;

  private index = 0;
  private done: boolean;
  private settled = 0;
  private keysCorrect = 0;
  private keysWrong = 0;
  private activeMs = 0;
  private lastAt: number | null = null;
  /**
   * Typing time and correct characters as they stood at each key press,
   * oldest first, trimmed to the recent window. Feeds the recent speed.
   */
  private readonly samples: { ms: number; chars: number }[] = [];

  constructor(passage: Passage, options: EngineOptions = {}) {
    this.words = passage.words;
    this.mode = options.mode ?? 'flow';
    this.strictSpace = options.strictSpace ?? false;
    this.freedomMode = options.freedomMode ?? false;
    this.autoParagraph = options.autoParagraph ?? false;
    this.recentWindowMs = options.recentWindowMs ?? DEFAULT_RECENT_WINDOW_MS;
    this.maxExtra = options.maxExtra ?? 8;
    this.onKey = options.onKey;
    this.typed = this.words.map(() => []);
    this.credit = this.words.map(() => 0);
    this.skipped = this.words.map(() => false);
    this.done = this.words.length === 0;
  }

  /** Index of the word being typed. */
  get wordIndex(): number {
    return this.index;
  }

  get finished(): boolean {
    return this.done;
  }

  /** Where the caret sits: a word and how many characters of it are typed. */
  caret(): { word: number; char: number } {
    return { word: this.index, char: this.typed[this.index]?.length ?? 0 };
  }

  /**
   * Stop the typing clock until the next key press.
   *
   * With no argument the clock rewinds to the last key press, so the idle
   * time that led to the pause is not counted. With a time, the clock keeps
   * what ran up to that moment and stops there. Once the passage is finished
   * the clock has already stopped at the last key, so nothing more is added.
   */
  pause(at?: number): void {
    if (at !== undefined && this.lastAt !== null && !this.done) {
      this.activeMs += Math.max(0, at - this.lastAt);
    }
    this.lastAt = null;
  }

  /** Feed one typed character. A space or line break is routed to `space` / `enter`. */
  type(char: string, at: number): Change {
    if (char === ' ') return this.space(at);
    if (char === '\n') return this.enter(at);
    if (this.done || char.length === 0) return NONE;
    return this.insert(char, at);
  }

  /** Judge one character against the current word and add it if allowed. */
  private insert(char: string, at: number): Change {
    const gap = this.tick(at);
    const i = this.index;
    const word = this.words[i];
    const typed = this.typed[i];
    const due = word.chars[typed.length];
    const correct = due !== undefined && isAccepted(due, char);
    this.judge(correct, due?.glyph ?? null, char, gap);

    const full = typed.length >= word.chars.length + this.maxExtra;
    if (!correct && (this.mode === 'strict' || full)) return { kind: 'rejected', dirty: [i] };

    typed.push(char);

    // The last word finishes the passage as soon as it is right; no space needed.
    if (i === this.words.length - 1 && this.isCorrect(i)) {
      this.settle(i);
      this.done = true;
      return { kind: 'finished', dirty: [i] };
    }
    // With auto paragraph, a finished paragraph hands over to the next one by itself.
    if (this.autoParagraph && word.endsPara && this.isCorrect(i)) {
      this.settle(i, false);
      this.index = i + 1;
      return { kind: 'advanced', dirty: [i, i + 1] };
    }
    return { kind: 'typed', dirty: [i] };
  }

  /** The space bar: leave the current word and start the next. */
  space(at: number): Change {
    if (this.done) return NONE;
    const i = this.index;
    const typed = this.typed[i];
    // A space before anything is typed is ignored, so a double space costs
    // nothing. With strict space it is a mistake like any other wrong key.
    if (typed.length === 0) {
      // Right after an automatic paragraph change, a space or Enter pressed
      // out of habit is never a mistake.
      const habit = this.autoParagraph && i > 0 && this.words[i - 1].endsPara;
      return this.strictSpace && !habit ? this.insert(' ', at) : NONE;
    }

    const gap = this.tick(at);
    const due = this.words[i].chars[typed.length];
    const atEnd = due === undefined; // the end of the word has been reached
    const refused = (this.mode === 'strict' && !atEnd) || (this.mode === 'word' && !this.isCorrect(i));
    this.judge(atEnd && !refused, due?.glyph ?? ' ', ' ', gap);
    if (refused) return { kind: 'rejected', dirty: [i] };

    this.settle(i);
    if (i === this.words.length - 1) {
      this.done = true;
      return { kind: 'finished', dirty: [i] };
    }
    this.index = i + 1;
    return { kind: 'advanced', dirty: [i, i + 1] };
  }

  /** The Enter key: works like space at the end of a paragraph, ignored elsewhere. */
  enter(at: number): Change {
    if (this.done) return NONE;
    return this.words[this.index].endsPara ? this.space(at) : NONE;
  }

  /** Remove one character, or step back into the previous word if it has a mistake. */
  backspace(at: number): Change {
    if (this.done) return NONE;
    const i = this.index;
    const typed = this.typed[i];
    if (typed.length > 0) {
      this.tick(at);
      typed.pop();
      return { kind: 'erased', dirty: [i] };
    }
    if (!this.canReturnTo(i - 1)) return NONE;
    this.tick(at);
    this.unsettle(i - 1);
    this.skipped[i - 1] = false;
    this.index = i - 1;
    return { kind: 'retreated', dirty: [i - 1, i] };
  }

  /** Clear the current word, or step back into a mistaken previous word and clear that. */
  deleteWord(at: number): Change {
    if (this.done) return NONE;
    const i = this.index;
    if (this.typed[i].length > 0) {
      this.tick(at);
      this.typed[i].length = 0;
      return { kind: 'erased', dirty: [i] };
    }
    if (!this.canReturnTo(i - 1)) return NONE;
    this.tick(at);
    this.unsettle(i - 1);
    this.skipped[i - 1] = false;
    this.index = i - 1;
    this.typed[i - 1].length = 0;
    return { kind: 'retreated', dirty: [i - 1, i] };
  }

  /**
   * Jump forward to a later word, skipping everything in between.
   *
   * Skipped words earn nothing and cost nothing: no key was pressed for
   * them, so accuracy is untouched and they add no correct characters. The
   * word that was under way keeps the credit for the letters typed so far.
   * The clock is not touched, since a jump is not a key press.
   */
  jumpTo(target: number): Change {
    if (this.done || !Number.isInteger(target)) return NONE;
    const from = this.index;
    if (target <= from || target >= this.words.length) return NONE;

    const dirty: number[] = [];
    for (let i = from; i < target; i++) {
      this.settle(i, false);
      if (this.typed[i].length === 0) this.skipped[i] = true;
      dirty.push(i);
    }
    dirty.push(target);
    this.index = target;
    return { kind: 'advanced', dirty };
  }

  wordView(i: number): WordView {
    const chars = this.words[i].chars;
    const typed = this.typed[i];
    const left = i < this.index || this.done;
    if (left && this.skipped[i]) {
      return { states: new Array<CharState>(chars.length).fill('skipped'), extras: [], flawed: false };
    }

    const states = new Array<CharState>(chars.length);
    let mistakes = typed.length > chars.length;
    for (let k = 0; k < chars.length; k++) {
      if (k < typed.length) {
        const ok = isAccepted(chars[k], typed[k]);
        states[k] = ok ? 'ok' : 'bad';
        if (!ok) mistakes = true;
      } else if (left) {
        states[k] = 'missed';
        mistakes = true;
      } else {
        states[k] = 'pending';
      }
    }
    return { states, extras: typed.slice(chars.length), flawed: left && mistakes };
  }

  /**
   * The numbers so far. Pass the current time to include the time since the
   * last key press, so the clock runs like a real timer between keys.
   */
  stats(now?: number): Stats {
    const running = now !== undefined && this.lastAt !== null && !this.done;
    const activeMs = this.activeMs + (running ? Math.max(0, now - this.lastAt!) : 0);
    const current = this.done ? 0 : this.correctCount(this.index);
    const correctChars = this.settled + current;
    const keys = this.keysCorrect + this.keysWrong;
    const minutes = activeMs / 60_000;
    // Use the latest sample at or before the start of the window. (After the
    // window is shortened, older samples can linger until the next key.)
    const windowStart = activeMs - this.recentWindowMs;
    let k = 0;
    while (k + 1 < this.samples.length && this.samples[k + 1].ms <= windowStart) k++;
    const oldest = this.samples[k];
    const recentMinutes = oldest === undefined ? 0 : (activeMs - oldest.ms) / 60_000;
    return {
      wpm: minutes > 0 ? correctChars / 5 / minutes : 0,
      recentWpm: recentMinutes > 0 ? Math.max(0, correctChars - oldest.chars) / 5 / recentMinutes : 0,
      accuracy: keys > 0 ? this.keysCorrect / keys : 1,
      activeMs,
      correctChars,
      keysCorrect: this.keysCorrect,
      keysWrong: this.keysWrong,
      wordsDone: this.done ? this.words.length : this.index,
      wordsTotal: this.words.length,
      finished: this.done,
    };
  }

  /**
   * Only a previous word with a mistake can be re-entered; correct words are
   * locked. Freedom mode lifts the lock. Words that have left the page are
   * out of reach either way.
   */
  private canReturnTo(i: number): boolean {
    return i >= 0 && i >= this.floor && (this.freedomMode || !this.isCorrect(i));
  }

  private isCorrect(i: number): boolean {
    const chars = this.words[i].chars;
    return this.typed[i].length === chars.length && this.correctCount(i) === chars.length;
  }

  private correctCount(i: number): number {
    const chars = this.words[i]?.chars;
    if (chars === undefined) return 0;
    const typed = this.typed[i];
    const n = Math.min(chars.length, typed.length);
    let count = 0;
    for (let k = 0; k < n; k++) if (isAccepted(chars[k], typed[k])) count++;
    return count;
  }

  /**
   * Credit a word's correct characters, plus the gap after it when the whole
   * word is right and a key was pressed for that gap.
   */
  private settle(i: number, gapTyped = true): void {
    const gap = gapTyped && this.isCorrect(i) && i < this.words.length - 1 ? 1 : 0;
    this.credit[i] = this.correctCount(i) + gap;
    this.settled += this.credit[i];
  }

  private unsettle(i: number): void {
    this.settled -= this.credit[i];
    this.credit[i] = 0;
  }

  private judge(correct: boolean, expected: string | null, typed: string, gapMs: number): void {
    if (correct) this.keysCorrect++;
    else this.keysWrong++;
    this.onKey?.({ expected, typed, correct, gapMs });
  }

  /** Advance the typing clock and return the gap since the previous key press. */
  private tick(at: number): number {
    const gap = this.lastAt === null ? 0 : Math.max(0, at - this.lastAt);
    this.lastAt = at;
    this.activeMs += gap;

    // Record the state just before this key takes effect, then drop samples
    // older than the window, keeping one at or before its start.
    this.samples.push({ ms: this.activeMs, chars: this.settled + this.correctCount(this.index) });
    const start = this.activeMs - this.recentWindowMs;
    while (this.samples.length > 1 && this.samples[1].ms <= start) this.samples.shift();
    return gap;
  }
}
