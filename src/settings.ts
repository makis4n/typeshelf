/**
 * The reader's settings: what they are, their defaults, and how they are
 * kept in the browser between visits. (Theme is kept separately, because the
 * page has to apply it before anything else loads.)
 */

import type { Mode } from './engine/engine';
import type { Spelling } from './engine/spelling';

export type StopOnError = 'off' | 'word' | 'letter';
export type CaretStyle = 'off' | 'line' | 'block' | 'underline' | 'box';
/** Seconds with no key press before typing pauses, or off. */
export type AutoPause = 'off' | '5' | '10' | '30';
/** Seconds of typing time the recent speed looks back over. */
export type RecentWindow = '15' | '30' | '60' | '120' | '300';
/** The smallest unit the time metric shows. */
export type TimeUnit = 'seconds' | 'minutes';
/** How the text moves to keep the eyes still. */
export type TextMotion = 'off' | 'tape' | 'typewriter';
export type TapeStep = 'letter' | 'word';
/** Where across the window the tape holds the caret. */
export type TapeMargin = 'left' | 'third' | 'centre';
export type CaretSpeed = 'off' | 'slow' | 'medium' | 'fast';

export interface Settings {
  /** Whether a mistake blocks progress: never, until the word is right, or on every letter. */
  stopOnError: StopOnError;
  /** A space pressed before a word is started counts as a mistake instead of being ignored. */
  strictSpace: boolean;
  /** Backspace can step back into any previous word, even one typed correctly. */
  freedomMode: boolean;
  /** Finishing a paragraph moves to the next one without pressing space or Enter. */
  autoParagraph: boolean;
  autoPause: AutoPause;
  /** Clicking a later word jumps to it, skipping the words in between. */
  clickToJump: boolean;
  spelling: Spelling;
  /** How quickly the caret glides between letters; off makes it jump. */
  smoothCaret: CaretSpeed;
  caretStyle: CaretStyle;
  /** The wheel or trackpad can scroll the text away from the caret; typing brings it back. */
  scrollText: boolean;
  /** After scrolling away, the key that jumps back to the caret is also typed. */
  typeOnReturn: boolean;
  textMotion: TextMotion;
  /** In tape mode, slide on every letter or once per word. */
  tapeStep: TapeStep;
  tapeMargin: TapeMargin;
  recentWindow: RecentWindow;
  timeUnit: TimeUnit;
}

export const DEFAULT_SETTINGS: Settings = {
  stopOnError: 'off',
  strictSpace: false,
  freedomMode: false,
  autoParagraph: false,
  autoPause: '10',
  clickToJump: false,
  spelling: 'original',
  smoothCaret: 'medium',
  caretStyle: 'line',
  scrollText: false,
  typeOnReturn: true,
  textMotion: 'off',
  tapeStep: 'letter',
  tapeMargin: 'third',
  recentWindow: '60',
  timeUnit: 'seconds',
};

const ALLOWED: { [K in keyof Settings]: readonly Settings[K][] } = {
  stopOnError: ['off', 'word', 'letter'],
  strictSpace: [false, true],
  freedomMode: [false, true],
  autoParagraph: [false, true],
  autoPause: ['off', '5', '10', '30'],
  clickToJump: [false, true],
  spelling: ['original', 'british', 'american'],
  smoothCaret: ['off', 'slow', 'medium', 'fast'],
  caretStyle: ['off', 'line', 'block', 'underline', 'box'],
  scrollText: [false, true],
  typeOnReturn: [false, true],
  textMotion: ['off', 'tape', 'typewriter'],
  tapeStep: ['letter', 'word'],
  tapeMargin: ['left', 'third', 'centre'],
  recentWindow: ['15', '30', '60', '120', '300'],
  timeUnit: ['seconds', 'minutes'],
};

const KEY = 'typeshelf:settings';

/**
 * The tape margin as a share of the window width. Left is a little in from
 * the edge, so the last letters typed are still readable.
 */
export function tapeAnchor(choice: TapeMargin): number {
  return { left: 0.14, third: 1 / 3, centre: 0.5 }[choice];
}

/** The recent-speed window as milliseconds. */
export function recentWindowMs(choice: RecentWindow): number {
  return Number(choice) * 1000;
}

/** The label of the recent-speed metric for each window. */
export function recentWindowLabel(choice: RecentWindow): string {
  return { '15': 'Last 15 s', '30': 'Last 30 s', '60': 'Last minute', '120': 'Last 2 min', '300': 'Last 5 min' }[choice];
}

/**
 * Typing time as text. With seconds: 0:05, 12:40, 1:02:03. With minutes as
 * the smallest unit: 0 min, 12 min, 1 h 02 min (always rounded down).
 */
export function formatTime(ms: number, unit: TimeUnit): string {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const two = (value: number) => String(value).padStart(2, '0');
  if (unit === 'minutes') return hours > 0 ? `${hours} h ${two(minutes)} min` : `${minutes} min`;
  return hours > 0 ? `${hours}:${two(minutes)}:${two(seconds)}` : `${minutes}:${two(seconds)}`;
}

/** The auto pause choice as milliseconds; 0 means off. */
export function autoPauseMs(choice: AutoPause): number {
  return choice === 'off' ? 0 : Number(choice) * 1000;
}

/** The engine's name for each stop-on-error choice. */
export function modeFor(stop: StopOnError): Mode {
  return stop === 'off' ? 'flow' : stop === 'word' ? 'word' : 'strict';
}

/** Check a settings object from anywhere (this browser, the account): the default stands in for anything missing or invalid. */
export function parseSettings(saved: unknown): Settings {
  const settings: Settings = { ...DEFAULT_SETTINGS };
  if (typeof saved !== 'object' || saved === null) return settings;
  const record = { ...(saved as Record<string, unknown>) };
  // Smooth caret used to be a plain on/off switch.
  if (record.smoothCaret === true) record.smoothCaret = 'medium';
  if (record.smoothCaret === false) record.smoothCaret = 'off';
  for (const name of Object.keys(ALLOWED) as (keyof Settings)[]) {
    const value = record[name];
    if ((ALLOWED[name] as readonly unknown[]).includes(value)) {
      (settings as unknown as Record<string, unknown>)[name] = value;
    }
  }
  return settings;
}

/** Whether the browser refused the last attempt to save the settings. */
let saveRefused = false;

/**
 * The saved settings, or null when there are none to read: a first visit,
 * or a browser (a private window, say) that refuses to keep anything.
 */
export function storedSettings(): Settings | null {
  // An older copy may still be readable when new ones cannot be written. It is not the reader's settings any more.
  if (saveRefused) return null;
  try {
    const raw = localStorage.getItem(KEY);
    return raw === null ? null : parseSettings(JSON.parse(raw));
  } catch {
    return null;
  }
}

/** Read saved settings, falling back to the default for anything missing or invalid. */
export function loadSettings(): Settings {
  try {
    return parseSettings(JSON.parse(localStorage.getItem(KEY) ?? '{}'));
  } catch {
    // Unreadable or blocked storage: use the defaults.
    return { ...DEFAULT_SETTINGS };
  }
}

const savedListeners = new Set<(settings: Settings) => void>();

/** Be told whenever settings are saved, so account sync can send them. Returns the way to stop. */
export function onSettingsSaved(listener: (settings: Settings) => void): () => void {
  savedListeners.add(listener);
  return () => savedListeners.delete(listener);
}

/**
 * A share as a whole percent, rounded down (so 99.6% never shows as 100%).
 * Multiplying before dividing keeps exact shares exact: 29 of 100 is 29,
 * where (29 / 100) * 100 falls just short and would round down to 28.
 */
export function wholePercent(part: number, total: number): number {
  return Math.floor((part * 100) / total);
}

/**
 * Save one changed setting on top of what is stored now, not on top of this
 * tab's copy, so two open tabs do not undo each other's choices.
 */
export function saveSetting<K extends keyof Settings>(name: K, value: Settings[K]): void {
  saveSettings({ ...loadSettings(), [name]: value });
}

export function saveSettings(settings: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
    saveRefused = false;
  } catch {
    saveRefused = true;
    // Private windows can refuse storage; the choice then lasts for this visit only.
  }
  for (const listener of savedListeners) listener(settings);
}
