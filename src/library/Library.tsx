import { createSignal, For, onMount, Show } from 'solid-js';
import { loadLayout, shownChapters } from '../book/layout';
import { bookProgress, percentOf } from '../book/progress';
import type { Book, Position } from '../book/types';
import { sample } from '../sample/pride-and-prejudice';
import { bookStore, userStore } from '../store/shared';
import { Icon } from './icons';
import './library.css';

/** One line of the library. */
interface Entry {
  /** The book's id, or null for the bundled sample. */
  id: string | null;
  title: string;
  author: string;
  /** How many chapters the book shows on this device. */
  chapters: number;
  /** Index of the chapter the reader is in. */
  current: number;
  /** Share of the book's words behind the reader, 0 to 100. */
  percent: number;
  state: 'reading' | 'new' | 'finished';
  /** When the place was last saved, for putting the latest book first. */
  savedAt: number;
}

const SAMPLE: Entry = {
  id: null,
  title: sample.title,
  author: sample.author,
  chapters: 1,
  current: 0,
  percent: 0,
  state: 'new',
  savedAt: 0,
};

/**
 * The library: every book on this device with the reader's place in it.
 * The name and author open the book's chapters; the button goes straight
 * to typing from the saved place.
 */
export function Library(props: {
  /** Type this book from the saved place. */
  onType: (book: Book) => void;
  /** Show this book's chapters. */
  onOpen: (bookId: string) => void;
  /** Type the bundled sample. */
  onSample: () => void;
}) {
  const [entries, setEntries] = createSignal<Entry[] | null>(null);

  const load = async () => {
    const books = await bookStore()
      .list()
      .catch(() => []);
    const places = new Map<string, { position: Position; updatedAt: number }>();
    // The user store is only opened when there is a book it could know about.
    if (books.length > 0) {
      try {
        for (const record of await (await userStore()).allProgress()) places.set(record.bookId, record);
      } catch {
        // Storage refused: every book shows as not started.
      }
    }
    const found = await Promise.all(
      books.map(async (summary): Promise<Entry> => {
        const layout = loadLayout(summary.id);
        const fresh: Entry = {
          id: summary.id,
          title: summary.title,
          author: summary.author,
          chapters: Math.max(1, summary.chapters - layout.joined.filter((index) => index < summary.chapters).length),
          current: 0,
          percent: 0,
          state: 'new',
          savedAt: 0,
        };
        const saved = places.get(summary.id);
        if (!saved) return fresh;
        // How far along needs the text itself, so only books that have a place are read.
        const book = await bookStore()
          .get(summary.id)
          .catch(() => undefined);
        if (!book) return fresh;
        const shown = shownChapters(book, layout);
        const progress = bookProgress(shown, book.chapters.length, saved.position);
        return {
          ...fresh,
          chapters: Math.max(1, shown.length),
          current: progress.current,
          percent: percentOf(progress.done, progress.total),
          state: progress.finished ? 'finished' : 'reading',
          savedAt: saved.updatedAt,
        };
      }),
    );
    setEntries(found);
  };
  onMount(() => void load());

  const inState = (state: Entry['state']) =>
    (entries() ?? []).filter((entry) => entry.state === state).sort((a, b) => b.savedAt - a.savedAt);

  const type = async (entry: Entry) => {
    if (entry.id === null) return props.onSample();
    // A finished book has nowhere to carry on from; its chapters are the way back in.
    if (entry.state === 'finished') return props.onOpen(entry.id);
    const book = await bookStore()
      .get(entry.id)
      .catch(() => undefined);
    if (book) props.onType(book);
    else void load();
  };

  const Line = (line: { entry: Entry; action: string }) => {
    const about = () =>
      [line.entry.author, `Chapter ${line.entry.current + 1} of ${line.entry.chapters}`].filter(Boolean).join(' · ');
    const body = (
      <>
        <span class="shelf-title">{line.entry.title}</span>
        <span class="shelf-about">{about()}</span>
        <span class="shelf-bar" role="presentation">
          <span style={{ width: `${line.entry.percent}%` }} />
        </span>
      </>
    );
    return (
      <li class="shelf-row" data-book={line.entry.id ?? 'sample'}>
        <Show when={line.entry.id} fallback={<div class="shelf-book">{body}</div>}>
          {(id) => (
            <button
              type="button"
              class="shelf-book"
              aria-label={`${line.entry.title}: chapters`}
              onClick={() => props.onOpen(id())}
            >
              {body}
            </button>
          )}
        </Show>
        <span class="shelf-percent">{line.entry.percent}%</span>
        <button
          type="button"
          classList={{ go: line.entry.state === 'reading' }}
          aria-label={`${line.action} ${line.entry.title}`}
          onClick={() => void type(line.entry)}
        >
          {line.action}
        </button>
      </li>
    );
  };

  const Section = (section: { title: string; entries: Entry[]; action: string }) => (
    <Show when={section.entries.length > 0}>
      <section aria-label={section.title}>
        <h2 class="shelf-heading">{section.title}</h2>
        <ul class="shelf-list">
          <For each={section.entries}>{(entry) => <Line entry={entry} action={section.action} />}</For>
        </ul>
      </section>
    </Show>
  );

  return (
    <main class="shelf">
      <label class="shelf-search">
        <Icon name="search" />
        {/* Waiting for the book service: there is nothing to search yet. */}
        <input type="search" placeholder="Search for e-books..." aria-label="Search for e-books" disabled />
      </label>
      <Show when={entries() !== null}>
        <Section title="Reading now" entries={inState('reading')} action="Continue" />
        <Section title="Not started" entries={[...inState('new'), SAMPLE]} action="Start" />
        <Section title="Finished" entries={inState('finished')} action="Open" />
      </Show>
    </main>
  );
}
