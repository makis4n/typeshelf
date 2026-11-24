import { createSignal, For, onCleanup, onMount, Show } from 'solid-js';
import type { Book } from './book/types';
import { TypingEngine, type Stats } from './engine/engine';
import { convertSpelling } from './engine/spelling';
import { buildPassage, type Passage } from './engine/text';
import { ImportDialog } from './import/ImportDialog';
import { sample } from './sample/pride-and-prejudice';
import {
  autoPauseMs,
  formatTime,
  loadSettings,
  modeFor,
  recentWindowLabel,
  recentWindowMs,
  tapeAnchor,
  saveSetting,
  wholePercent,
  type Settings,
} from './settings';
import { TypingSurface } from './view/surface';

type Theme = 'light' | 'dark';

const THEME_KEY = 'typeshelf:theme';
/** How often the numbers under the text refresh while typing. */
const STATS_REFRESH_MS = 250;
/** Speed is hidden until there is enough typing time for it to mean something. */
const MIN_MS_FOR_SPEED = 2000;

function currentTheme(): Theme {
  const chosen = document.documentElement.dataset.theme;
  if (chosen === 'light' || chosen === 'dark') return chosen;
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/** One row of the settings modal: a title, a note, and a set of options to pick from. */
function Choice<T extends string>(props: {
  id: string;
  title: string;
  note: string;
  value: T;
  options: readonly { value: T; label: string }[];
  onPick: (value: T) => void;
  /** Shown indented under the setting above, which it depends on. */
  nested?: boolean;
  /** Greyed out and unclickable, because the setting it depends on is off. */
  disabled?: boolean;
}) {
  return (
    <div class="setting" classList={{ nested: props.nested, unavailable: props.disabled }}>
      <div>
        <h4 id={`setting-${props.id}`}>{props.title}</h4>
        <p>{props.note}</p>
      </div>
      <div class="seg" role="group" aria-labelledby={`setting-${props.id}`}>
        <For each={props.options}>
          {(option) => (
            <button
              type="button"
              classList={{ on: props.value === option.value }}
              aria-pressed={props.value === option.value}
              disabled={props.disabled}
              onClick={() => props.onPick(option.value)}
            >
              {option.label}
            </button>
          )}
        </For>
      </div>
    </div>
  );
}

const ON_OFF = [
  { value: 'off', label: 'Off' },
  { value: 'on', label: 'On' },
] as const;

export function App() {
  const [settings, setSettings] = createSignal<Settings>(loadSettings());
  const [theme, setTheme] = createSignal<Theme>(currentTheme());

  // What is on the page: the bundled sample, or the first chapter of an imported book.
  const [reading, setReading] = createSignal<typeof sample>(sample);
  const [importing, setImporting] = createSignal(false);

  const passageFor = (current: Settings): Passage =>
    buildPassage(reading().paragraphs.map((paragraph) => convertSpelling(paragraph, current.spelling)));

  const [stats, setStats] = createSignal<Stats>(new TypingEngine(passageFor(settings())).stats());

  let host!: HTMLDivElement;
  let dialog!: HTMLDialogElement;
  let engine: TypingEngine | undefined;
  let surface: TypingSurface | undefined;

  // The numbers are refreshed by a steady timer, never by a key press, so
  // typing does not wait on them and the clock ticks between keys.
  const publish = () => {
    // Passing the time makes the clock tick between key presses.
    if (engine) setStats(engine.stats(performance.now()));
  };

  let passage: Passage | undefined;

  /** Build the typing view for the current engine. Used at the start and when the layout changes. */
  const mount = () => {
    if (!engine || !passage) return;
    surface?.destroy();
    const current = settings();
    surface = new TypingSurface(
      host,
      engine,
      passage,
      {
        onChange: (change) => {
          if (change.kind === 'finished') publish();
        },
      },
      {
        motion: current.textMotion,
        tapeStep: current.tapeStep,
        tapeAnchor: tapeAnchor(current.tapeMargin),
        scrollable: current.scrollText,
        typeOnReturn: current.typeOnReturn,
        clickToJump: current.clickToJump,
        autoPauseMs: autoPauseMs(current.autoPause),
      },
    );
  };

  const start = () => {
    const current = settings();
    passage = passageFor(current);
    engine = new TypingEngine(passage, {
      mode: modeFor(current.stopOnError),
      strictSpace: current.strictSpace,
      freedomMode: current.freedomMode,
      autoParagraph: current.autoParagraph,
      recentWindowMs: recentWindowMs(current.recentWindow),
    });
    mount();
    publish();
    surface?.focus();
  };

  onMount(() => {
    start();
    const timer = setInterval(publish, STATS_REFRESH_MS);
    onCleanup(() => {
      clearInterval(timer);
      surface?.destroy();
    });
  });

  const change = <K extends keyof Settings>(name: K, value: Settings[K]) => {
    // Picking the option that is already chosen changes nothing; in particular
    // it must not restart the chapter.
    if (settings()[name] === value) return;
    const next = { ...settings(), [name]: value };
    setSettings(next);
    saveSetting(name, value);

    if (name === 'spelling') {
      // The words themselves change, so the chapter starts over.
      start();
    } else if (engine) {
      engine.mode = modeFor(next.stopOnError);
      engine.strictSpace = next.strictSpace;
      engine.freedomMode = next.freedomMode;
      engine.autoParagraph = next.autoParagraph;
      engine.recentWindowMs = recentWindowMs(next.recentWindow);
      publish();
    }
    // A different layout rebuilds the view around the same typing session, so nothing typed is lost.
    if (name === 'textMotion' || name === 'tapeStep' || name === 'tapeMargin') mount();
    if (name === 'scrollText') surface?.setScrollable(next.scrollText);
    if (surface) surface.typeOnReturn = next.typeOnReturn;
    if (name === 'clickToJump') surface?.setClickToJump(next.clickToJump);
    if (name === 'autoPause') surface?.setAutoPause(autoPauseMs(next.autoPause));
    // Caret settings reach the page through attributes on the surface element.
    surface?.relayout();
  };

  const chooseTheme = (next: Theme) => {
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {
      // Private windows can refuse storage; the choice then lasts for this visit only.
    }
    setTheme(next);
  };

  const openSettings = () => dialog.showModal();
  // Closing hands the keyboard straight back to the text. The button and the
  // outside click do it at once; Escape arrives through the dialog's own
  // close event a moment later.
  const giveBackKeyboard = () => surface?.focus();
  const closeSettings = () => {
    dialog.close();
    giveBackKeyboard();
  };
  const closeImport = () => {
    setImporting(false);
    giveBackKeyboard();
  };
  /** Type the first chapter of an imported book. Choosing chapters and resuming come with the library. */
  const openBook = (book: Book) => {
    const first = book.chapters[0];
    if (!first) return;
    const chapter = first.title === book.title ? '' : first.title;
    setReading({ title: book.title, author: book.author, chapter, paragraphs: first.paragraphs });
    setImporting(false);
    start();
  };
  const onDialogClick = (event: MouseEvent) => {
    // A click on the dimmed area outside the panel lands on the dialog itself.
    if (event.target === dialog) closeSettings();
  };

  const percent = () => {
    const { wordsDone, wordsTotal } = stats();
    return wordsTotal > 0 ? wholePercent(wordsDone, wordsTotal) : 0;
  };
  const shown = (wpm: number) => (stats().activeMs >= MIN_MS_FOR_SPEED ? String(Math.round(wpm)) : '–');
  const accuracy = () => {
    const { keysCorrect, keysWrong } = stats();
    const keys = keysCorrect + keysWrong;
    return keys > 0 ? wholePercent(keysCorrect, keys) : 100;
  };

  const stopNote = () =>
    ({
      off: 'Mistakes stay on the page and you keep going.',
      word: 'Mistakes show, but space is refused until the word is right.',
      letter: 'A wrong key is refused until you press the right one.',
    })[settings().stopOnError];

  return (
    <div class="page">
      <header class="top">
        <span class="mark">typeshelf</span>
        <nav class="controls" aria-label="Page actions">
          <button type="button" onClick={start}>
            Restart
          </button>
          <button type="button" onClick={() => setImporting(true)}>
            Import
          </button>
          <button type="button" class="icon" aria-label="Settings" title="Settings" onClick={openSettings}>
            {/* Gear outline from the Lucide icon set (ISC licence). */}
            <svg
              viewBox="0 0 24 24"
              width="18"
              height="18"
              fill="none"
              stroke="currentColor"
              stroke-width="1.75"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
              <circle cx="12" cy="12" r="3" />
            </svg>
          </button>
        </nav>
      </header>

      <main class="stage">
        <div class="book">
          <h1>{reading().title}</h1>
          <p>{[reading().author, reading().chapter].filter(Boolean).join(' · ')}</p>
        </div>

        <div
          class="track"
          role="progressbar"
          aria-label="Chapter progress"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent()}
        >
          <div class="fill" style={{ width: `${percent()}%` }} />
        </div>

        <div
          ref={host}
          class="surface"
          data-caret={settings().caretStyle}
          data-smooth={settings().smoothCaret}
          data-auto-paragraph={settings().autoParagraph ? 'on' : 'off'}
        />

        <dl class="meter">
          <div>
            <dt>{recentWindowLabel(settings().recentWindow)}</dt>
            <dd data-stat="recent-speed">
              {shown(stats().recentWpm)} <small>wpm</small>
            </dd>
          </div>
          <div>
            <dt>Average</dt>
            <dd data-stat="average-speed">
              {shown(stats().wpm)} <small>wpm</small>
            </dd>
          </div>
          <div>
            <dt>Accuracy</dt>
            <dd data-stat="accuracy">
              {accuracy()}
              <small>%</small>
            </dd>
          </div>
          <div>
            <dt>Time</dt>
            <dd data-stat="time">{formatTime(stats().activeMs, settings().timeUnit)}</dd>
          </div>
          <div>
            <dt>Chapter</dt>
            <dd data-stat="progress">
              {percent()}
              <small>%</small>
            </dd>
          </div>
        </dl>

        <Show when={stats().finished}>
          <section class="done" aria-live="polite">
            <h2>Chapter complete.</h2>
            <button type="button" onClick={start}>
              Type it again
            </button>
          </section>
        </Show>
      </main>

      <dialog
        ref={dialog}
        class="settings"
        aria-labelledby="settings-title"
        on:close={giveBackKeyboard}
        onClick={onDialogClick}
      >
        <div class="panel">
          <header>
            <h2 id="settings-title">Settings</h2>
            <button type="button" class="icon" aria-label="Close settings" onClick={closeSettings}>
              <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
                <path
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.8"
                  stroke-linecap="round"
                  d="M6 6l12 12M18 6 6 18"
                />
              </svg>
            </button>
          </header>

          <section class="group" aria-labelledby="group-rules">
            <h3 id="group-rules">Rules</h3>
            <Choice
              id="stop"
              title="Stop on error"
              note={stopNote()}
              value={settings().stopOnError}
              options={[
                { value: 'off', label: 'Off' },
                { value: 'word', label: 'Word' },
                { value: 'letter', label: 'Letter' },
              ]}
              onPick={(value) => change('stopOnError', value)}
            />
            <Choice
              id="strict-space"
              title="Strict space"
              note="A space pressed before a word is started counts as a mistake instead of being ignored."
              value={settings().strictSpace ? 'on' : 'off'}
              options={ON_OFF}
              onPick={(value) => change('strictSpace', value === 'on')}
            />
            <Choice
              id="freedom"
              title="Freedom mode"
              note="Backspace can step back into any earlier word, even one you typed correctly."
              value={settings().freedomMode ? 'on' : 'off'}
              options={ON_OFF}
              onPick={(value) => change('freedomMode', value === 'on')}
            />
            <Choice
              id="auto-paragraph"
              title="Auto next paragraph"
              note="Finishing the last word of a paragraph moves you to the next one. No space or Enter needed."
              value={settings().autoParagraph ? 'on' : 'off'}
              options={ON_OFF}
              onPick={(value) => change('autoParagraph', value === 'on')}
            />
            <Choice
              id="auto-pause"
              title="Auto pause"
              note="Pause after this long with no typing. Paused time never counts towards your speed."
              value={settings().autoPause}
              options={[
                { value: 'off', label: 'Off' },
                { value: '5', label: '5 s' },
                { value: '10', label: '10 s' },
                { value: '30', label: '30 s' },
              ]}
              onPick={(value) => change('autoPause', value)}
            />
            <Choice
              id="click-to-jump"
              title="Click to jump"
              note="Click a word further on to jump to it. The words in between are skipped, not counted."
              value={settings().clickToJump ? 'on' : 'off'}
              options={ON_OFF}
              onPick={(value) => change('clickToJump', value === 'on')}
            />
          </section>
          <section class="group" aria-labelledby="group-text">
            <h3 id="group-text">Text</h3>
            <Choice
              id="spelling"
              title="Spelling"
              note="Convert common words to British or American spelling. Restarts the chapter."
              value={settings().spelling}
              options={[
                { value: 'original', label: 'As printed' },
                { value: 'british', label: 'British' },
                { value: 'american', label: 'American' },
              ]}
              onPick={(value) => change('spelling', value)}
            />
            <Choice
              id="text-motion"
              title="Moving text"
              note="Tape slides one line under a fixed caret. Typewriter holds your line in the middle of the window."
              value={settings().textMotion}
              options={[
                { value: 'off', label: 'Off' },
                { value: 'tape', label: 'Tape' },
                { value: 'typewriter', label: 'Typewriter' },
              ]}
              onPick={(value) => change('textMotion', value)}
            />
            <Choice
              id="tape-step"
              title="Tape step"
              note="Slide the tape on every letter, or once per word."
              nested
              disabled={settings().textMotion !== 'tape'}
              value={settings().tapeStep}
              options={[
                { value: 'letter', label: 'Letter' },
                { value: 'word', label: 'Word' },
              ]}
              onPick={(value) => change('tapeStep', value)}
            />
            <Choice
              id="tape-margin"
              title="Tape margin"
              note="Where the caret is held. Further left shows more of the text still to come."
              nested
              disabled={settings().textMotion !== 'tape'}
              value={settings().tapeMargin}
              options={[
                { value: 'left', label: 'Left' },
                { value: 'third', label: 'Third' },
                { value: 'centre', label: 'Centre' },
              ]}
              onPick={(value) => change('tapeMargin', value)}
            />
            <Choice
              id="scroll-text"
              title="Scroll text"
              note="Scroll with the wheel or trackpad. Any key jumps back to the caret."
              value={settings().scrollText ? 'on' : 'off'}
              options={ON_OFF}
              onPick={(value) => change('scrollText', value === 'on')}
            />
            <Choice
              id="type-on-return"
              title="Type on jump back"
              nested
              disabled={!settings().scrollText}
              note="After scrolling, the key that jumps back to the caret is also typed. Off only jumps back."
              value={settings().typeOnReturn ? 'on' : 'off'}
              options={ON_OFF}
              onPick={(value) => change('typeOnReturn', value === 'on')}
            />
          </section>
          <section class="group" aria-labelledby="group-caret">
            <h3 id="group-caret">Caret</h3>
            <Choice
              id="smooth-caret"
              title="Smooth caret"
              note="How quickly the caret glides between letters. Off makes it jump."
              value={settings().smoothCaret}
              options={[
                { value: 'off', label: 'Off' },
                { value: 'slow', label: 'Slow' },
                { value: 'medium', label: 'Medium' },
                { value: 'fast', label: 'Fast' },
              ]}
              onPick={(value) => change('smoothCaret', value)}
            />
            <Choice
              id="caret-style"
              title="Caret style"
              note="The shape that marks where you are. Off hides it."
              value={settings().caretStyle}
              options={[
                { value: 'off', label: 'Off' },
                { value: 'line', label: 'Line' },
                { value: 'block', label: 'Block' },
                { value: 'underline', label: 'Underline' },
                { value: 'box', label: 'Box' },
              ]}
              onPick={(value) => change('caretStyle', value)}
            />
          </section>
          <section class="group" aria-labelledby="group-metrics">
            <h3 id="group-metrics">Metrics</h3>
            <Choice
              id="recent-window"
              title="Recent speed window"
              note="How much of your latest typing the recent speed number looks back over."
              value={settings().recentWindow}
              options={[
                { value: '15', label: '15 s' },
                { value: '30', label: '30 s' },
                { value: '60', label: '1 min' },
                { value: '120', label: '2 min' },
                { value: '300', label: '5 min' },
              ]}
              onPick={(value) => change('recentWindow', value)}
            />
            <Choice
              id="time-unit"
              title="Smallest time unit"
              note="Show typing time down to the second, or in whole minutes only."
              value={settings().timeUnit}
              options={[
                { value: 'seconds', label: 'Seconds' },
                { value: 'minutes', label: 'Minutes' },
              ]}
              onPick={(value) => change('timeUnit', value)}
            />
          </section>
          <section class="group" aria-labelledby="group-appearance">
            <h3 id="group-appearance">Appearance</h3>
            <Choice
              id="theme"
              title="Theme"
              note="Paper is light, Night is dark."
              value={theme()}
              options={[
                { value: 'light', label: 'Paper' },
                { value: 'dark', label: 'Night' },
              ]}
              onPick={chooseTheme}
            />
          </section>
        </div>
      </dialog>

      <ImportDialog
        open={importing()}
        onRequestOpen={() => setImporting(true)}
        onClose={closeImport}
        onBook={openBook}
      />
    </div>
  );
}
