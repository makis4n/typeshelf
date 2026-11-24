/**
 * Keeps a reader's place in a book: which place to save as they type, where
 * to start when a book is opened, and the saving itself.
 *
 * Places are always measured against the text as printed, never against a
 * spelling-converted copy. Conversion swaps words one for one, so the word
 * index is the same in both, and a place saved under one spelling setting
 * opens on the same word under another, on this device or any other.
 */

import type { Passage } from '../engine/text';
import { positionAtWordStart } from './position';
import type { Book, Position } from './types';

export function samePlace(a: Position, b: Position): boolean {
  return a.chapter === b.chapter && a.paragraph === b.paragraph && a.char === b.char;
}

/**
 * The place to save when a chapter has been typed to its end: the start of
 * the next chapter, or the very end of the book's last one.
 *
 * @param chapters How many chapters the book has.
 * @param passage The finished chapter, as printed.
 * @param chapter Index of the finished chapter.
 */
export function placeAfterChapter(chapters: number, passage: Passage, chapter: number): Position {
  if (chapter + 1 < chapters) return { chapter: chapter + 1, paragraph: 0, char: 0 };
  const last = passage.words.length - 1;
  if (last < 0) return { chapter, paragraph: 0, char: 0 };
  const start = positionAtWordStart(passage, chapter, last);
  return { ...start, char: start.char + passage.words[last].chars.length };
}

/**
 * Where to open a book for a saved place.
 *
 * A place can point outside the book: it may come from another device, or
 * from before the book was cleaned differently. A chapter past the end opens
 * the last chapter from its start, and anything that is not a whole number
 * opens the book from the beginning.
 *
 * @returns The chapter to show, and the place within it (undefined for the chapter's start).
 */
export function openingPlace(
  chapters: number,
  saved: Position | undefined,
): { chapter: number; place: Position | undefined } {
  if (!saved || !Number.isInteger(saved.chapter) || saved.chapter < 0) return { chapter: 0, place: undefined };
  if (saved.chapter >= chapters) return { chapter: Math.max(0, chapters - 1), place: undefined };
  return { chapter: saved.chapter, place: saved };
}

/** The part of the local store the keeper needs. */
export interface PlaceStore {
  saveProgress(book: Pick<Book, 'id' | 'fingerprint'>, position: Position): Promise<unknown>;
  progress(bookId: string): Promise<{ position: Position } | undefined>;
  /** The account the store's contents belong to, or null for a guest's. A store without owners leaves it out. */
  owner?(): Promise<string | null>;
}

/**
 * Saves the place in one book, and reads it back.
 *
 * `save` never makes typing wait: it notes the place and returns. One write
 * runs at a time; places noted while it runs replace each other, so only the
 * newest is written next. A browser that refuses storage is not an error to
 * the reader: the book is typed as before, its place just is not kept.
 *
 * A keeper belongs to whoever owned the store when it first looked. If the
 * store has since passed from that account to anyone else (a sign-out, or
 * another account signing in, in this tab or another), the place on the
 * page is the earlier account's, so the keeper writes nothing more and says
 * so through `onLost`. A guest's store becoming an account's is not a loss:
 * that is the guest signing in, and their place goes with them.
 */
export class PlaceKeeper {
  /** The newest place not yet written. */
  private wanted: Position | undefined;
  /** The place the store holds, as far as this page knows. */
  private known: Position | undefined;
  private writing: Promise<void> | undefined;
  private warned = false;
  /** Who owned the store when this keeper first looked. Undefined until then. */
  private owner: string | null | undefined;
  private lost = false;

  /**
   * @param open Gives the store. Called for every read and write, so a store that could not be opened is tried again.
   */
  constructor(
    private readonly open: () => Promise<PlaceStore>,
    readonly book: Pick<Book, 'id' | 'fingerprint'>,
    /** Called once, when the store turns out to belong to someone else now. */
    private readonly onLost: () => void = () => undefined,
  ) {}

  /** Whether the store still belongs to whoever this keeper started with. Notes the owner on first use. */
  private async mine(store: PlaceStore): Promise<boolean> {
    if (this.lost) return false;
    if (!store.owner) return true;
    const now = await store.owner();
    if (this.owner === undefined || this.owner === null) {
      this.owner = now;
      return true;
    }
    if (now === this.owner) return true;
    this.lost = true;
    this.wanted = undefined;
    this.onLost();
    return false;
  }

  /** The saved place, or undefined when there is none or storage cannot be read. */
  async read(): Promise<Position | undefined> {
    try {
      const store = await this.open();
      if (!(await this.mine(store))) return undefined;
      const record = await store.progress(this.book.id);
      this.known = record?.position;
      return this.known;
    } catch (error) {
      this.warn(error);
      return undefined;
    }
  }

  /** Note a place to be saved. Returns at once. */
  save(place: Position): void {
    if (this.lost) return;
    this.wanted = place;
    this.writing ??= this.drain();
  }

  /** Resolves once everything noted so far has been written, or given up on. */
  settled(): Promise<void> {
    return this.writing ?? Promise.resolve();
  }

  /**
   * The stored place, if something other than this page has moved it since
   * this page last read or wrote it (the sync taking the account's copy).
   * Undefined when it has not moved, and while a save of this page's own is
   * still on its way.
   */
  async movedElsewhere(): Promise<Position | undefined> {
    if (this.writing || this.lost) return undefined;
    try {
      const store = await this.open();
      if (!(await this.mine(store))) return undefined;
      const record = await store.progress(this.book.id);
      // A save noted while reading is newer than what was just read.
      if (this.writing || !record) return undefined;
      if (this.known && samePlace(record.position, this.known)) return undefined;
      this.known = record.position;
      return record.position;
    } catch (error) {
      this.warn(error);
      return undefined;
    }
  }

  private async drain(): Promise<void> {
    // Not before `save` has recorded this run in `writing`, or the last line here would be undone by it.
    await Promise.resolve();
    try {
      while (this.wanted) {
        const next = this.wanted;
        this.wanted = undefined;
        if (this.known && samePlace(next, this.known)) continue;
        const store = await this.open();
        if (!(await this.mine(store))) return;
        await store.saveProgress(this.book, next);
        this.known = next;
      }
    } catch (error) {
      this.wanted = undefined;
      this.warn(error);
    } finally {
      this.writing = undefined;
    }
  }

  private warn(error: unknown): void {
    if (this.warned) return;
    this.warned = true;
    console.warn('typeshelf: the place in this book could not be kept', error);
  }
}
