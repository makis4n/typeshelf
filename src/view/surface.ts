/**
 * The typing surface: paints a passage, captures key presses, feeds them to
 * the engine and repaints only what changed.
 *
 * It is plain DOM code on purpose. A key press touches one word and the
 * caret, with no framework work in between, which keeps typing smooth.
 *
 * Layout: root > view (clipped window) > scroll (moves up as you type) >
 * caret + paragraphs > words > characters. Only paragraphs near the caret are
 * in the page; ones far above are removed and replaced by padding of the same
 * height, so nothing visible ever shifts.
 */

import type { Change, TypingEngine } from '../engine/engine';
import type { Passage } from '../engine/text';

export interface SurfaceHooks {
  onChange?: (change: Change) => void;
}

/**
 * How the text moves to keep the eyes still.
 * - `off`: the page scrolls up line by line and the caret travels along each line.
 * - `tape`: the text is one long line that slides under a caret fixed in place.
 * - `typewriter`: like `off`, but the line being typed is held in the middle of the window.
 */
export type Motion = 'off' | 'tape' | 'typewriter';

export interface SurfaceOptions {
  motion?: Motion;
  /** In tape mode, slide on every letter or once per word. Default 'letter'. */
  tapeStep?: 'letter' | 'word';
  /** In tape mode, how far across the window the caret is held: 0 is the left edge, 1 the right. Default 1/3. */
  tapeAnchor?: number;
  /** Let the wheel or trackpad scroll the text away from the caret. Default false. */
  scrollable?: boolean;
  /**
   * After scrolling away, whether the key that jumps back to the caret is
   * also typed. Default true; false makes it only jump back.
   */
  typeOnReturn?: boolean;
  /** Clicking a later word jumps to it, skipping the words in between. Default false. */
  clickToJump?: boolean;
  /** Pause after this long with no key press, in ms. 0 turns idle pausing off. Default 0. */
  autoPauseMs?: number;
}

/** Most lines kept visible above the line being typed. */
const MAX_LEAD_LINES = 4;

/** How long the scroll bar stays after the last wheel movement. */
const BAR_LINGER_MS = 900;

/** Keys that are held with others and are not typing by themselves. */
const MODIFIER_KEYS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'Fn']);

const CHAR_CLASS = { pending: 'c', ok: 'c ok', bad: 'c bad', missed: 'c miss', skipped: 'c skip' } as const;

export class TypingSurface {
  private readonly view: HTMLDivElement;
  private readonly scroll: HTMLDivElement;
  private readonly caret: HTMLDivElement;
  private readonly capture: HTMLInputElement;
  /** Scroll position marker, shown only while scrolling by hand. */
  private readonly bar: HTMLDivElement;
  private readonly thumb: HTMLDivElement;
  private barTimer: ReturnType<typeof setTimeout> | undefined;
  /** Set while the scroll bar is being dragged. */
  private drag: { startY: number; startShown: number } | null = null;

  private readonly wordEls = new Map<number, HTMLElement>();
  private readonly paraEls = new Map<number, HTMLElement>();
  /** Paragraphs in the page are [firstPara, nextPara). */
  private firstPara = 0;
  private nextPara = 0;
  private activePara = -1;

  /** Height of removed paragraphs, kept as padding above the first one in the page. */
  private spacer = 0;
  /** How far up the text sits to keep the caret in place, in px. */
  private offset = 0;
  /** How far up the text is actually drawn right now. */
  private shown = 0;
  /** Where the reader has scrolled to by hand, or null when following the caret. */
  private manual: number | null = null;
  private scrollable: boolean;
  private readonly motion: Motion;
  private readonly tapeStep: 'letter' | 'word';
  private readonly tapeAnchor: number;
  /** Tape mode: width of removed paragraphs, kept as padding before the first one in the page. */
  private spacerX = 0;
  /** Tape mode: how far along the line the fixed point is, in px. */
  private tapeAt = 0;
  private viewWidth = 0;
  private autoPauseMs: number;
  private clickToJump = false;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  /** Why typing is paused: no key for a while, or the page lost the keyboard. */
  private pausedBy: 'idle' | 'blur' | null = null;
  /** See `SurfaceOptions.typeOnReturn`. Can be changed at any time. */
  typeOnReturn: boolean;
  private lineHeight = 0;
  private viewHeight = 0;
  private leadLines = 1;
  private fontSize = 16;

  private readonly listeners = new AbortController();
  private readonly resizeObserver: ResizeObserver;

  constructor(
    private readonly root: HTMLElement,
    private readonly engine: TypingEngine,
    private readonly passage: Passage,
    private readonly hooks: SurfaceHooks = {},
    options: SurfaceOptions = {},
  ) {
    this.motion = options.motion ?? 'off';
    this.tapeStep = options.tapeStep ?? 'letter';
    this.tapeAnchor = Math.min(1, Math.max(0, options.tapeAnchor ?? 1 / 3));
    // A single sliding line has nothing to scroll up or down.
    this.scrollable = (options.scrollable ?? false) && this.motion !== 'tape';
    this.autoPauseMs = options.autoPauseMs ?? 0;
    this.typeOnReturn = options.typeOnReturn ?? true;
    this.setClickToJump(options.clickToJump ?? false);
    root.classList.add('ts');
    root.classList.toggle('ts-tape', this.motion === 'tape');
    root.replaceChildren();

    this.view = el('div', 'ts-view');
    this.scroll = el('div', 'ts-scroll');
    this.caret = el('div', 'ts-caret');
    this.scroll.append(this.caret);
    this.view.append(this.scroll);

    this.capture = el('input', 'ts-capture');
    this.capture.type = 'text';
    this.capture.autocomplete = 'off';
    this.capture.autocapitalize = 'off';
    this.capture.spellcheck = false;
    this.capture.setAttribute('autocorrect', 'off');
    this.capture.setAttribute('aria-label', 'Type the text shown on the page');

    const hint = el('div', 'ts-hint');
    hint.textContent = 'Paused. Press any key to keep typing.';

    this.bar = el('div', 'ts-bar');
    this.thumb = el('div', 'ts-thumb');
    this.bar.append(this.thumb);
    this.bar.setAttribute('aria-hidden', 'true');

    root.append(this.view, this.capture, hint, this.bar);

    const { signal } = this.listeners;
    this.capture.addEventListener('keydown', this.onKeyDown, { signal });
    this.capture.addEventListener('beforeinput', this.onBeforeInput, { signal });
    this.capture.addEventListener('compositionend', this.onCompositionEnd, { signal });
    this.capture.addEventListener('input', this.onInput, { signal });
    this.capture.addEventListener('focus', this.onFocus, { signal });
    this.capture.addEventListener('blur', this.onBlur, { signal });
    // Until the field has the keyboard, the page is paused.
    this.pause('blur');
    root.addEventListener('pointerdown', this.onPointerDown, { signal });
    root.addEventListener('click', this.onClick, { signal });
    root.addEventListener('wheel', this.onWheel, { signal, passive: false });
    this.bar.addEventListener('pointerenter', this.onBarEnter, { signal });
    this.bar.addEventListener('pointerdown', this.onBarDown, { signal });
    this.bar.addEventListener('pointermove', this.onBarMove, { signal });
    this.bar.addEventListener('pointerup', this.onBarUp, { signal });
    this.bar.addEventListener('pointercancel', this.onBarUp, { signal });
    root.classList.toggle('ts-scrollable', this.scrollable);
    window.addEventListener('keydown', this.onWindowKeyDown, { signal });

    this.measure();
    this.fill();
    // The engine may already be part-way through (the layout was switched
    // mid-chapter), so show what has been typed.
    for (const index of this.wordEls.keys()) {
      if (index <= this.engine.wordIndex) this.paintWord(index);
    }
    this.still(() => this.placeCaret());

    this.resizeObserver = new ResizeObserver(() => this.relayout());
    this.resizeObserver.observe(this.view);
    // Letter widths change when the book font arrives, so place the caret again.
    void document.fonts?.ready.then(() => {
      if (!signal.aborted) this.relayout();
    });
  }

  focus(): void {
    this.capture.focus({ preventScroll: true });
  }

  /** Turn jumping to a clicked word on or off. */
  setClickToJump(on: boolean): void {
    this.clickToJump = on;
    this.root.classList.toggle('ts-jump', on);
  }

  /** Change how long without a key press pauses typing. 0 turns idle pausing off. */
  setAutoPause(ms: number): void {
    this.autoPauseMs = ms;
    if (this.pausedBy === 'idle' && ms === 0) this.resume();
    if (this.idleTimer !== undefined) this.armIdle();
  }

  /**
   * Turn hand scrolling on or off. Turning it on puts back any paragraphs
   * that were removed above, so the whole chapter can be reached.
   */
  setScrollable(on: boolean): void {
    on = on && this.motion !== 'tape';
    this.scrollable = on;
    this.root.classList.toggle('ts-scrollable', on);
    if (on) this.restoreAbove();
    else this.follow();
    this.still(() => this.placeCaret());
  }

  /** Re-measure after a resize or font load and put the caret back without animating. */
  relayout(): void {
    this.measure();
    this.fill();
    this.still(() => this.placeCaret());
  }

  destroy(): void {
    this.listeners.abort();
    this.resizeObserver.disconnect();
    clearTimeout(this.idleTimer);
    clearTimeout(this.barTimer);
    this.root.replaceChildren();
    this.root.classList.remove('ts', 'ts-focused', 'ts-still', 'ts-scrolled', 'ts-paused', 'ts-bar-on', 'ts-at-end', 'ts-scrollable', 'ts-dragging', 'ts-jump', 'ts-tape');
  }

  // ---- input ---------------------------------------------------------------

  private readonly onFocus = (): void => {
    this.root.classList.add('ts-focused');
    // Coming back to the page ends a pause caused by leaving it. An idle
    // pause waits for a key.
    if (this.pausedBy === 'blur') this.resume();
  };

  private readonly onBlur = (): void => {
    this.root.classList.remove('ts-focused');
    this.pause('blur');
  };

  private pause(reason: 'idle' | 'blur'): void {
    clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
    this.pausedBy = reason;
    this.root.classList.add('ts-paused');
    // Idling rewinds the clock to the last key press, so the wait that led
    // here is not counted. Leaving the page stops the clock where it is.
    if (reason === 'idle') this.engine.pause();
    else this.engine.pause(performance.now());
  }

  private resume(): void {
    this.pausedBy = null;
    this.root.classList.remove('ts-paused');
  }

  /** A key was pressed: end any pause and start counting idle time again. */
  private wake(): void {
    if (this.pausedBy !== null) this.resume();
    this.armIdle();
  }

  private armIdle(): void {
    clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
    if (this.autoPauseMs <= 0 || this.engine.finished) return;
    this.idleTimer = setTimeout(() => this.pause('idle'), this.autoPauseMs);
  }

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (event.isComposing) return;
    if (!MODIFIER_KEYS.has(event.key)) this.wake();
    if (event.key === 'Backspace') {
      event.preventDefault();
      if (this.returnToCaret()) return;
      const wholeWord = event.altKey || event.ctrlKey || event.metaKey;
      this.apply(wholeWord ? this.engine.deleteWord(event.timeStamp) : this.engine.backspace(event.timeStamp));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      if (this.returnToCaret()) return;
      this.apply(this.engine.enter(event.timeStamp));
    }
  };

  private readonly onBeforeInput = (event: InputEvent): void => {
    // While an input method or dead key is composing, let it finish; the
    // result arrives in `compositionend`.
    if (event.isComposing || event.inputType.startsWith('insertComposition')) return;
    event.preventDefault();
    this.wake();
    if (this.returnToCaret()) return;

    switch (event.inputType) {
      case 'insertText':
        this.typeText(event.data ?? '', event.timeStamp);
        break;
      case 'insertLineBreak':
      case 'insertParagraph':
        this.apply(this.engine.enter(event.timeStamp));
        break;
      // Reached on touch keyboards, where `keydown` does not name the key.
      case 'deleteContentBackward':
        this.apply(this.engine.backspace(event.timeStamp));
        break;
      case 'deleteWordBackward':
      case 'deleteSoftLineBackward':
      case 'deleteHardLineBackward':
        this.apply(this.engine.deleteWord(event.timeStamp));
        break;
      // Paste, drop, undo and the rest are ignored: the text must be typed.
    }
  };

  private readonly onCompositionEnd = (event: CompositionEvent): void => {
    this.wake();
    if (!this.returnToCaret()) this.typeText(event.data, event.timeStamp);
    this.capture.value = '';
  };

  private readonly onInput = (event: Event): void => {
    // Nothing should ever stay in the field; composition is the one exception.
    if (!(event as InputEvent).isComposing) this.capture.value = '';
  };

  /** With click to jump on, a click on a later word moves the caret there. */
  private readonly onClick = (event: MouseEvent): void => {
    if (!this.clickToJump || !(event.target instanceof Element)) return;
    const wordEl = event.target.closest<HTMLElement>('.w');
    if (wordEl === null || wordEl.dataset.word === undefined) return;
    const change = this.engine.jumpTo(Number(wordEl.dataset.word));
    if (change.kind === 'none') return;
    this.wake();
    this.apply(change);
  };

  private readonly onPointerDown = (event: PointerEvent): void => {
    event.preventDefault();
    this.focus();
  };

  /** Typing anywhere on the page resumes typing, so focus is never a trap. */
  private readonly onWindowKeyDown = (event: KeyboardEvent): void => {
    if (event.metaKey || event.ctrlKey || event.altKey || event.key.length !== 1) return;
    const active = document.activeElement;
    if (active !== null && active !== document.body) return;
    // An open dialog (settings) owns the keyboard.
    if (document.querySelector('dialog[open]') !== null) return;
    // Focusing during keydown routes this same key press into the field.
    this.focus();
  };

  /** Scroll the text by hand. The next key press brings the caret back into view and is not typed. */
  private readonly onWheel = (event: WheelEvent): void => {
    if (!this.scrollable || event.ctrlKey) return; // ctrl + wheel is pinch zoom
    event.preventDefault();

    const pixels = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? event.deltaY * this.lineHeight : event.deltaY;
    this.scrollByHand((this.manual ?? this.offset) + pixels);
  };

  /** Move the text to a hand-chosen place, kept between the first and last line. */
  private scrollByHand(wanted: number): void {
    this.manual = Math.max(0, wanted);
    this.fill(); // bring in paragraphs further down before measuring the end
    this.manual = Math.min(this.manual, this.scrollEnd());

    // Wheel and drag already move in small steps, so follow them without easing.
    this.scroll.style.transition = 'none';
    this.setShown(this.manual);
    this.showBar();
  }

  /**
   * The furthest the text may move up. Once the whole chapter is on the page
   * that puts its last line at the bottom of the window, so there is never
   * empty space under the end of a chapter.
   */
  private scrollEnd(): number {
    const height = this.scroll.offsetHeight;
    const allShown = this.nextPara >= this.passage.paraStart.length;
    return Math.max(0, allShown ? height - this.viewHeight : height - this.lineHeight * 2);
  }

  // ---- scroll bar ------------------------------------------------------------

  private readonly onBarEnter = (): void => {
    if (this.scrollable && this.drag === null) this.showBar();
  };

  /** Grab the bar, or click the track to jump there and keep dragging. */
  private readonly onBarDown = (event: PointerEvent): void => {
    if (!this.scrollable || event.button !== 0) return;
    event.preventDefault();
    // Dragging needs the true height, so bring in the rest of the chapter.
    while (this.nextPara < this.passage.paraStart.length) this.appendPara(this.nextPara++);
    this.showBar();

    const range = this.viewHeight - this.thumb.offsetHeight;
    if (event.target !== this.thumb && range > 0) {
      const top = event.clientY - this.bar.getBoundingClientRect().top - this.thumb.offsetHeight / 2;
      this.scrollByHand(Math.min(1, Math.max(0, top / range)) * this.scrollEnd());
    }

    this.drag = { startY: event.clientY, startShown: this.manual ?? this.shown };
    this.bar.setPointerCapture(event.pointerId);
    this.root.classList.add('ts-dragging');
    this.showBar();
  };

  private readonly onBarMove = (event: PointerEvent): void => {
    if (this.drag === null) return;
    const range = this.viewHeight - this.thumb.offsetHeight;
    if (range <= 0) return;
    const moved = (event.clientY - this.drag.startY) / range;
    this.scrollByHand(this.drag.startShown + moved * this.scrollEnd());
  };

  private readonly onBarUp = (event: PointerEvent): void => {
    if (this.drag === null) return;
    this.drag = null;
    this.bar.releasePointerCapture(event.pointerId);
    this.root.classList.remove('ts-dragging');
    this.showBar(); // start the fade-out timer
  };

  /**
   * Show the scroll bar for a moment. Its size and place come from how much
   * of the chapter is visible and how far down the view is.
   */
  private showBar(): void {
    const end = this.scrollEnd();
    // Paragraphs further down are only added as they are needed, so the full
    // height is estimated from the part that is on the page.
    const { words, paraStart } = this.passage;
    const shownWords = paraStart[this.nextPara] ?? words.length;
    const scale = shownWords > 0 ? words.length / shownWords : 1;
    const total = Math.max(this.viewHeight, this.scroll.offsetHeight * scale);
    const last = Math.max(1, end * scale);

    const track = this.viewHeight;
    const size = Math.max(28, (this.viewHeight / total) * track);
    const place = Math.min(1, this.shown / last) * (track - size);
    this.thumb.style.height = `${size}px`;
    this.thumb.style.transform = `translate3d(0, ${place}px, 0)`;

    this.root.classList.add('ts-bar-on');
    clearTimeout(this.barTimer);
    // While it is being dragged the bar stays; otherwise it fades after a moment.
    if (this.drag === null) {
      this.barTimer = setTimeout(() => this.root.classList.remove('ts-bar-on'), BAR_LINGER_MS);
    }
  }

  /**
   * If the text has been scrolled away by hand, glide back to the caret.
   * Reports true when the key that triggered it should be dropped, which is
   * the case unless `typeOnReturn` is on.
   */
  private returnToCaret(): boolean {
    if (this.manual === null) return false;
    this.follow();
    this.setShown(this.offset);
    return !this.typeOnReturn;
  }

  /** Stop hand scrolling and let the text follow the caret again. */
  private follow(): void {
    if (this.manual === null) return;
    this.manual = null;
    clearTimeout(this.barTimer);
    this.root.classList.remove('ts-bar-on');
    void this.scroll.offsetHeight; // commit the hand-scrolled position first, so the return glides
    this.scroll.style.transition = '';
  }

  private setShown(value: number): void {
    if (value === this.shown) return;
    this.shown = value;
    this.scroll.style.transform = `translate3d(0, ${-value}px, 0)`;
    // The top edge only fades once text has scrolled under it, so the
    // first line of a chapter is never dimmed.
    this.root.classList.toggle('ts-scrolled', value > 0);
    this.markEnd();
  }

  /** At the end of the chapter the bottom edge stops fading, so the last lines are clear. */
  private markEnd(): void {
    const allShown = this.nextPara >= this.passage.paraStart.length;
    this.root.classList.toggle('ts-at-end', allShown && this.shown >= this.scrollEnd() - 1);
  }

  private typeText(text: string, at: number): void {
    for (const char of text) this.apply(this.engine.type(char, at));
  }

  // ---- painting ------------------------------------------------------------

  private apply(change: Change): void {
    if (change.kind === 'none') return;
    this.follow();
    for (const index of change.dirty) this.paintWord(index);
    if (change.kind === 'rejected') this.flashDue();
    this.fill();
    this.placeCaret();
    this.hooks.onChange?.(change);
  }

  private paintWord(index: number): void {
    const wordEl = this.wordEls.get(index);
    if (wordEl === undefined) return;
    const view = this.engine.wordView(index);
    const spans = wordEl.children;
    const length = view.states.length;

    for (let k = 0; k < length; k++) {
      const cls = CHAR_CLASS[view.states[k]];
      if (spans[k].className !== cls) spans[k].className = cls;
    }
    while (spans.length > length + view.extras.length) wordEl.lastElementChild!.remove();
    for (let k = 0; k < view.extras.length; k++) {
      let span = spans[length + k];
      if (span === undefined) {
        span = el('span', 'c extra');
        wordEl.append(span);
      }
      if (span.textContent !== view.extras[k]) span.textContent = view.extras[k];
    }
    wordEl.classList.toggle('flawed', view.flawed);
  }

  /** Strict mode: show which character refused the key. */
  private flashDue(): void {
    const { word, char } = this.engine.caret();
    const target = this.wordEls.get(word)?.children[char] ?? this.caret;
    target.classList.remove('nope');
    void (target as HTMLElement).offsetWidth; // restart the animation
    target.classList.add('nope');
  }

  private placeCaret(): void {
    const { word, char } = this.engine.caret();
    const wordEl = this.wordEls.get(word);
    if (wordEl === undefined) return;

    const base = this.scroll.getBoundingClientRect();
    const wordRect = wordEl.getBoundingClientRect();
    const spans = wordEl.children;
    // The caret covers the character that is due. Past the end of a word
    // there is none, so it takes the width of a space.
    const due = char < spans.length ? spans[char].getBoundingClientRect() : null;
    const x = due !== null ? due.left : spans[spans.length - 1].getBoundingClientRect().right;
    this.caret.style.width = `${due !== null ? due.width : this.fontSize * 0.28}px`;

    // Both rects move together while the text scrolls, so the difference is stable.
    const lineTop = wordRect.top - base.top;
    this.caret.style.transform = `translate3d(${x - base.left}px, ${lineTop}px, 0)`;

    if (this.motion === 'tape') {
      // Slide the line so the caret (or the start of its word) sits at a fixed
      // point, and hold the line at the usual height.
      this.tapeAt = this.tapeStep === 'word' ? wordRect.left - base.left : x - base.left;
      const across = Math.round(this.viewWidth * this.tapeAnchor - this.tapeAt);
      const down = Math.round(this.leadLines * this.lineHeight - lineTop);
      this.scroll.style.transform = `translate3d(${across}px, ${down}px, 0)`;
      return;
    }

    // Follow the caret, but never past the end of the chapter: the last line
    // stops at the bottom of the window instead of leaving empty space under it.
    const wanted = Math.max(0, Math.round(lineTop - this.leadLines * this.lineHeight));
    const allShown = this.nextPara >= this.passage.paraStart.length;
    const target = allShown ? Math.min(wanted, this.scrollEnd()) : wanted;
    this.offset = target;
    if (this.manual === null) this.setShown(target);
    this.markEnd();
  }

  /** Run `work` with transitions off, for jumps that must not animate. */
  private still(work: () => void): void {
    this.root.classList.add('ts-still');
    work();
    void this.root.offsetHeight; // commit the styles before transitions return
    this.root.classList.remove('ts-still');
  }

  // ---- windowing -----------------------------------------------------------

  private measure(): void {
    this.lineHeight = parseFloat(getComputedStyle(this.scroll).lineHeight) || 1;
    this.fontSize = parseFloat(getComputedStyle(this.scroll).fontSize) || 16;
    this.viewHeight = this.view.clientHeight;
    this.viewWidth = this.view.clientWidth;
    const lines = Math.floor(this.viewHeight / this.lineHeight);
    // Typewriter holds the line being typed in the middle of the window.
    // Otherwise it sits about a third of the way down, whatever the height.
    this.leadLines =
      this.motion === 'typewriter'
        ? Math.max(0, Math.floor((lines - 1) / 2))
        : Math.max(1, Math.min(MAX_LEAD_LINES, Math.floor(lines / 3)));
  }

  /** Keep enough paragraphs below the caret, and drop ones far above it. */
  private fill(): void {
    const total = this.passage.paraStart.length;
    if (total === 0) return;
    const active = this.engine.words[Math.min(this.engine.wordIndex, this.engine.words.length - 1)].para;

    while (
      this.nextPara < total &&
      (this.nextPara <= active + 1 ||
        (this.motion === 'tape'
          ? this.scroll.scrollWidth < this.tapeAt + this.viewWidth * 2.5
          : this.scroll.offsetHeight < Math.max(this.offset, this.manual ?? 0) + this.viewHeight * 2.5))
    ) {
      this.appendPara(this.nextPara++);
    }

    if (active === this.activePara) return;
    this.paraEls.get(this.activePara)?.classList.remove('now');
    this.paraEls.get(active)?.classList.add('now');
    this.activePara = active;
    this.trim(active);
  }

  private appendPara(para: number, before: Node | null = null): void {
    const { words, paraStart } = this.passage;
    const paraEl = el('p', 'ts-para');
    if (para === 0) paraEl.classList.add('first');

    const end = paraStart[para + 1] ?? words.length;
    for (let i = paraStart[para]; i < end; i++) {
      const wordEl = el('span', 'w');
      for (const char of words[i].chars) {
        const span = el('span', 'c');
        span.textContent = char.glyph;
        wordEl.append(span);
      }
      wordEl.dataset.word = String(i);
      this.wordEls.set(i, wordEl);
      paraEl.append(wordEl);
      if (i < end - 1) paraEl.append(' ');
    }

    this.paraEls.set(para, paraEl);
    this.scroll.insertBefore(paraEl, before);
  }

  /**
   * Remove paragraphs that are more than a full window above the visible
   * text. Their height moves into the padding, so nothing else moves.
   */
  private trim(active: number): void {
    // With hand scrolling on, everything stays so it can be scrolled back to.
    if (this.scrollable) return;
    if (this.motion === 'tape') {
      this.trimTape(active);
      return;
    }
    const limit = this.offset - this.viewHeight;
    let removed = false;

    while (this.firstPara < active - 1) {
      const paraEl = this.paraEls.get(this.firstPara)!;
      const height = paraEl.offsetHeight;
      if (paraEl.offsetTop + height >= limit) break;

      const end = this.passage.paraStart[this.firstPara + 1];
      for (let i = this.passage.paraStart[this.firstPara]; i < end; i++) this.wordEls.delete(i);
      paraEl.remove();
      this.paraEls.delete(this.firstPara);
      this.spacer += height;
      this.firstPara++;
      removed = true;
    }

    if (removed) {
      this.scroll.style.paddingTop = `${this.spacer}px`;
      // Words that have left the page can no longer be returned to.
      this.engine.floor = this.passage.paraStart[this.firstPara];
    }
  }

  /** Tape mode: remove paragraphs that have slid well off the left, keeping their width as padding. */
  private trimTape(active: number): void {
    const limit = this.tapeAt - this.viewWidth * 1.5;
    let removed = false;

    while (this.firstPara < active - 1) {
      const paraEl = this.paraEls.get(this.firstPara)!;
      const next = this.paraEls.get(this.firstPara + 1)!;
      if (next.offsetLeft >= limit) break;

      const end = this.passage.paraStart[this.firstPara + 1];
      for (let i = this.passage.paraStart[this.firstPara]; i < end; i++) this.wordEls.delete(i);
      this.spacerX += next.offsetLeft - paraEl.offsetLeft;
      paraEl.remove();
      this.paraEls.delete(this.firstPara);
      this.firstPara++;
      removed = true;
    }

    if (removed) {
      this.scroll.style.paddingLeft = `${this.spacerX}px`;
      this.engine.floor = this.passage.paraStart[this.firstPara];
    }
  }

  /** Put back every paragraph that was removed above, with what was typed in them. */
  private restoreAbove(): void {
    if (this.firstPara === 0) return;
    const first = this.paraEls.get(this.firstPara) ?? null;
    const end = this.passage.paraStart[this.firstPara];
    for (let para = 0; para < this.firstPara; para++) this.appendPara(para, first);
    for (let i = 0; i < end; i++) this.paintWord(i);
    this.firstPara = 0;
    this.spacer = 0;
    this.scroll.style.paddingTop = '0px';
    this.engine.floor = 0;
  }
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  return node;
}
