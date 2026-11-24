import { createMemo, createSignal, For, onMount, Show } from 'solid-js';
import { forgetLayout, join, keep, loadLayout, saveLayout, shownChapters, type Layout } from '../book/layout';
import { bookProgress, percentOf } from '../book/progress';
import type { Book, Position } from '../book/types';
import { bookStore, userStore } from '../store/shared';
import { Icon } from './icons';
import './library.css';

const count = (words: number) => `${words.toLocaleString('en')} ${words === 1 ? 'word' : 'words'}`;

/**
 * One book's chapters: which are done, where the reader is, and a way into
 * any of them. A "chapter" that looks like a stray page number can be
 * joined to the chapter before it, or kept.
 */
export function BookScreen(props: {
  bookId: string;
  onBack: () => void;
  /** Type this chapter (an index into the chapters as shown). */
  onChapter: (book: Book, chapter: number) => void;
  /** The book was removed from this device. */
  onRemoved: (bookId: string) => void;
  /** The reader joined or kept a chapter, so the chapters are numbered differently now. */
  onLayout: (bookId: string) => void;
}) {
  const [book, setBook] = createSignal<Book | null>(null);
  const [saved, setSaved] = createSignal<Position | undefined>(undefined);
  const [layout, setLayout] = createSignal<Layout>(loadLayout(props.bookId));
  const [missing, setMissing] = createSignal(false);

  onMount(async () => {
    const found = await bookStore()
      .get(props.bookId)
      .catch(() => undefined);
    if (!found) return setMissing(true);
    try {
      setSaved((await (await userStore()).progress(found.id))?.position);
    } catch {
      // Storage refused: the book shows as not started.
    }
    setBook(found);
  });

  const shown = createMemo(() => {
    const current = book();
    return current ? shownChapters(current, layout()) : [];
  });
  const progress = createMemo(() => bookProgress(shown(), book()?.chapters.length ?? 0, saved()));
  const percent = () => percentOf(progress().done, progress().total);

  /** A chapter's own title, or its number when it has none of its own. */
  const nameOf = (index: number) => {
    const title = shown()[index]?.title.trim() ?? '';
    return title === '' || title === book()?.title ? `Chapter ${index + 1}` : title;
  };

  const change = (next: Layout) => {
    setLayout(next);
    saveLayout(props.bookId, next);
    props.onLayout(props.bookId);
  };

  const remove = async () => {
    const current = book();
    if (!current) return;
    if (!window.confirm(`Remove “${current.title}” from this device? Your place in it is kept.`)) return;
    await bookStore().delete(current.id);
    forgetLayout(current.id);
    props.onRemoved(current.id);
  };

  return (
    <main class="shelf">
      <div class="chapters-top">
        <button type="button" class="with-icon" onClick={() => props.onBack()}>
          <Icon name="back" size={14} />
          Library
        </button>
        <Show when={book()}>
          <button
            type="button"
            class="bin"
            aria-label="Remove from device"
            title="Remove from device"
            onClick={() => void remove()}
          >
            <Icon name="trash" size={17} />
          </button>
        </Show>
      </div>

      <Show when={missing()}>
        <p class="shelf-note">This book is no longer on this device.</p>
      </Show>

      <Show when={book()}>
        {(current) => (
          <>
            <div class="chapters-head">
              <div class="chapters-book">
                <h1>{current().title}</h1>
                <p>
                  {[
                    current().author,
                    `${shown().length} ${shown().length === 1 ? 'chapter' : 'chapters'}`,
                    `${percent()}% typed`,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </p>
                <span class="shelf-bar" role="presentation">
                  <span style={{ width: `${percent()}%` }} />
                </span>
              </div>
              <Show when={!progress().finished && shown().length > 0}>
                <button
                  type="button"
                  class="go big"
                  onClick={() => props.onChapter(current(), progress().current)}
                >
                  {progress().started ? 'Continue' : 'Start'} Chapter {progress().current + 1}
                </button>
              </Show>
            </div>

            <h2 class="shelf-heading">Chapters</h2>
            <ol class="shelf-list">
              <For each={shown()}>
                {(chapter, index) => {
                  const done = () => progress().finished || (progress().started && index() < progress().current);
                  const here = () => progress().started && !progress().finished && index() === progress().current;
                  const words = () => progress().words[index()] ?? 0;
                  return (
                    <li class="shelf-row chapter" classList={{ here: here() }} data-chapter={index()}>
                      <Show
                        when={!chapter.flagged}
                        fallback={
                          <>
                            <Icon name="warning" class="mark-warning" />
                            <div class="chapter-name">
                              <span class="shelf-title plain">{nameOf(index())}</span>
                              <span class="chapter-warning">
                                {count(words())}. This may be a page number, not a chapter.
                              </span>
                            </div>
                            <button type="button" onClick={() => change(join(layout(), chapter))}>
                              Merge into {nameOf(index() - 1)}
                            </button>
                            <button type="button" onClick={() => change(keep(layout(), chapter))}>
                              Keep
                            </button>
                          </>
                        }
                      >
                        <Icon
                          name={done() ? 'check' : here() ? 'pencil' : 'circle'}
                          class={done() || here() ? 'mark-done' : 'mark-todo'}
                        />
                        <div class="chapter-name">
                          <span class="shelf-title plain">{nameOf(index())}</span>
                          <Show when={here()}>
                            <span class="shelf-bar short" role="presentation">
                              <span style={{ width: `${percentOf(progress().currentDone, words())}%` }} />
                            </span>
                          </Show>
                        </div>
                        <span class="shelf-about">
                          {here() ? `${percentOf(progress().currentDone, words())}% of ${count(words())}` : count(words())}
                        </span>
                        <Show
                          when={done()}
                          fallback={
                            <button
                              type="button"
                              classList={{ go: here() }}
                              aria-label={`${here() ? 'Continue' : 'Start'} ${nameOf(index())}`}
                              onClick={() => props.onChapter(current(), index())}
                            >
                              {here() ? 'Continue' : 'Start'}
                            </button>
                          }
                        >
                          {/* Says the chapter is done; offers to type it again when pointed at or focused. */}
                          <button
                            type="button"
                            class="completed"
                            aria-label={`Type ${nameOf(index())} again`}
                            onClick={() => props.onChapter(current(), index())}
                          >
                            <span class="rest">Completed</span>
                            <span class="over">Type again</span>
                          </button>
                        </Show>
                      </Show>
                    </li>
                  );
                }}
              </For>
            </ol>
          </>
        )}
      </Show>
    </main>
  );
}
