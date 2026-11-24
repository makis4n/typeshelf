import { createEffect, createSignal, For, onCleanup, onMount, Show } from 'solid-js';
import type { Book } from '../book/types';
import type { BookSummary } from '../store/books';
import { bookStore as store } from '../store/shared';
import {
  ACCEPTED_FILES,
  ImportError,
  importErrorMessage,
  importFile,
  MAX_FILE_BYTES,
  NOT_SAVED_NOTICE,
} from './index';
import { parseInBackground } from './background';
import './import.css';

const carriesFiles = (event: DragEvent) => event.dataTransfer?.types.includes('Files') ?? false;

/**
 * The import modal: pick or drop an EPUB, text or Markdown file, and open
 * books already imported on this device. A file dropped anywhere on the page
 * opens the modal and is imported.
 *
 * This is the entry point until the library screen exists.
 */
export function ImportDialog(props: {
  open: boolean;
  /** A file was dropped on the page while the modal was closed. */
  onRequestOpen: () => void;
  onClose: () => void;
  /** A book was imported, or picked from the list, and should be typed. */
  onBook: (book: Book) => void;
}) {
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal('');
  const [over, setOver] = createSignal(false);
  const [books, setBooks] = createSignal<BookSummary[]>([]);

  let dialog!: HTMLDialogElement;
  /** Set while a book is handed over that the modal still has something to say about. */
  let stayOpen = false;
  let input!: HTMLInputElement;

  const refresh = async () => {
    try {
      setBooks(await store().list());
    } catch {
      // Storage can be unavailable (some private windows). Importing still works; it says the book was not saved.
      setBooks([]);
    }
  };

  createEffect(() => {
    if (props.open && !dialog.open) {
      setError('');
      void refresh();
      dialog.showModal();
    } else if (!props.open && dialog.open && !stayOpen) {
      dialog.close();
    }
  });

  const take = async (file: File | undefined) => {
    if (!file || busy()) return;
    setBusy(true);
    setError('');
    try {
      // Checked before reading, so an enormous file is never loaded into memory.
      if (file.size > MAX_FILE_BYTES) throw new ImportError('too-large', 'file');
      const bytes = new Uint8Array(await file.arrayBuffer());
      const { book, stored } = await importFile(store(), { name: file.name, bytes }, parseInBackground);
      // A book that could not be kept is put on the page all the same, and the modal stays to say so.
      stayOpen = !stored;
      props.onBook(book);
      if (stayOpen) {
        props.onRequestOpen();
        setError(NOT_SAVED_NOTICE);
        stayOpen = false;
      }
    } catch (failure) {
      if (!(failure instanceof ImportError)) console.error(failure);
      setError(importErrorMessage(failure));
    } finally {
      stayOpen = false;
      setBusy(false);
      input.value = ''; // so picking the same file again is noticed
    }
  };

  const openStored = async (id: string) => {
    const book = await store().get(id);
    if (book) props.onBook(book);
    else void refresh();
  };

  const remove = async (id: string) => {
    await store().delete(id);
    await refresh();
  };

  onMount(() => {
    // Without these, a file dropped on the page makes the browser leave it to show the file.
    const onDragOver = (event: DragEvent) => {
      if (!carriesFiles(event)) return;
      event.preventDefault();
      setOver(true);
    };
    const onDragEnd = () => setOver(false);
    const onDrop = (event: DragEvent) => {
      if (!carriesFiles(event)) return;
      event.preventDefault();
      setOver(false);
      if (!props.open) props.onRequestOpen();
      void take(event.dataTransfer?.files[0]);
    };
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('dragleave', onDragEnd);
    window.addEventListener('drop', onDrop);
    onCleanup(() => {
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('dragleave', onDragEnd);
      window.removeEventListener('drop', onDrop);
    });
  });

  return (
    <dialog
      ref={dialog}
      class="settings import"
      aria-labelledby="import-title"
      on:close={() => props.onClose()}
      onClick={(event) => {
        // A click on the dimmed area outside the panel lands on the dialog itself.
        if (event.target === dialog) props.onClose();
      }}
    >
      <div class="panel">
        <header>
          <h2 id="import-title">Import a book</h2>
          <button type="button" class="icon" aria-label="Close import" onClick={() => props.onClose()}>
            <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
              <path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" d="M6 6l12 12M18 6 6 18" />
            </svg>
          </button>
        </header>

        <div class="dropzone" classList={{ over: over() }} data-import-drop>
          <p>Drop an EPUB, text or Markdown file here.</p>
          <button type="button" disabled={busy()} onClick={() => input.click()}>
            {busy() ? 'Reading…' : 'Choose a file'}
          </button>
          <input
            ref={input}
            type="file"
            accept={ACCEPTED_FILES}
            aria-label="Book file"
            hidden
            onChange={() => void take(input.files?.[0])}
          />
          <p class="fine">The book stays on this device. It is never uploaded.</p>
        </div>

        <Show when={error()}>
          <p class="import-error" role="alert">
            {error()}
          </p>
        </Show>

        <Show when={books().length > 0}>
          <section class="group" aria-labelledby="import-shelf">
            <h3 id="import-shelf">On this device</h3>
            <ul class="shelf">
              <For each={books()}>
                {(book) => (
                  <li class="setting">
                    <div>
                      <h4>{book.title}</h4>
                      <p>
                        {[book.author, `${book.chapters} ${book.chapters === 1 ? 'chapter' : 'chapters'}`]
                          .filter(Boolean)
                          .join(' · ')}
                      </p>
                    </div>
                    <div class="seg">
                      <button type="button" aria-label={`Type ${book.title}`} onClick={() => void openStored(book.id)}>
                        Type
                      </button>
                      <button type="button" aria-label={`Remove ${book.title}`} onClick={() => void remove(book.id)}>
                        Remove
                      </button>
                    </div>
                  </li>
                )}
              </For>
            </ul>
          </section>
        </Show>
      </div>
    </dialog>
  );
}
