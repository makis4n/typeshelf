import { expect, test, type Page } from '@playwright/test';
import { strToU8 } from 'fflate';

const importDialog = (page: Page) => page.locator('dialog.import');

/** Puts a file in the modal's file picker, as choosing it in the system dialog would. */
async function pick(page: Page, name: string, bytes: Uint8Array, type: string): Promise<void> {
  await importDialog(page)
    .locator('input[type=file]')
    .evaluate(
      (input: HTMLInputElement, file) => {
        const transfer = new DataTransfer();
        transfer.items.add(new File([new Uint8Array(file.bytes)], file.name, { type: file.type }));
        input.files = transfer.files;
        input.dispatchEvent(new Event('change', { bubbles: true }));
      },
      { name, type, bytes: Array.from(bytes) },
    );
}

async function openImport(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Import', exact: true }).click();
  await expect(importDialog(page)).toHaveAttribute('open', '');
}

/** One option button of one row in the settings modal. */
const setting = (page: Page, group: string, option: string) =>
  page.getByRole('group', { name: group }).getByRole('button', { name: option, exact: true });

async function openSettings(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
}

/** Close settings and wait until the keyboard is back on the text. */
async function closeSettings(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Close settings' }).click();
  await expect(page.locator('.ts')).toHaveClass(/ts-focused/);
}

async function chooseSpelling(page: Page, option: 'As printed' | 'British' | 'American'): Promise<void> {
  await openSettings(page);
  await setting(page, 'Spelling', option).click();
  await closeSettings(page);
}

/** Two chapters; the first has two paragraphs and a word the spelling table converts. */
const BOOK = [
  'Chapter 1',
  'The colour of the sea was grey. Nobody spoke at all.',
  'A gull cried over the wall.',
  'Chapter 2',
  'It came back at noon.',
].join('\n\n');

/** The same first chapter alone, so finishing it ends the book. */
const SHORT_BOOK = 'The colour of the sea was grey.\n\nA gull cried.';

async function importText(page: Page, name: string, text: string): Promise<void> {
  await openImport(page);
  await pick(page, name, strToU8(text), 'text/plain');
  await expect(page.locator('.book h1')).toHaveText(name.replace(/\.txt$/, ''));
  // Opening the book closes the dialog and hands the keyboard to the text.
  await expect(importDialog(page)).not.toHaveAttribute('open', '');
  await expect(page.locator('.ts')).toHaveClass(/ts-focused/);
}

interface Place {
  chapter: number;
  paragraph: number;
  char: number;
}

/** The place saved on this device for the first book that has one, read straight from IndexedDB. */
async function storedPlace(page: Page): Promise<Place | undefined> {
  return page.evaluate(
    () =>
      new Promise<Place | undefined>((resolve) => {
        const opening = indexedDB.open('typeshelf-user');
        opening.onerror = () => resolve(undefined);
        opening.onsuccess = () => {
          const db = opening.result;
          if (!db.objectStoreNames.contains('progress')) {
            db.close();
            resolve(undefined);
            return;
          }
          const request = db.transaction('progress').objectStore('progress').getAll();
          request.onerror = () => {
            db.close();
            resolve(undefined);
          };
          request.onsuccess = () => {
            db.close();
            resolve((request.result[0] as { position: Place } | undefined)?.position);
          };
        };
      }),
  );
}

/** Saves are asynchronous, so wait for the place to land before reloading. */
async function waitForPlace(page: Page, place: Place): Promise<void> {
  await expect.poll(() => storedPlace(page)).toEqual(place);
}

/** Reload and wait for the book to be back on the page. */
async function reload(page: Page, title: string): Promise<void> {
  await page.reload();
  await expect(page.locator('.book h1')).toHaveText(title);
  await expect(page.locator('.ts')).toHaveClass(/ts-focused/);
}

const letters = (text: string) => text.replace(/\s+/g, '').length;
const typed = (page: Page) => page.locator('.c.ok');

test('a reload reopens the book at the word the reader was on, with earlier words shown as typed', async ({ page }) => {
  await page.goto('/');
  await importText(page, 'tale.txt', BOOK);

  await page.keyboard.type('The colour of ');
  // The start of "the", the fourth word.
  await waitForPlace(page, { chapter: 0, paragraph: 0, char: 'The colour of '.length });
  await reload(page, 'tale');

  await expect(typed(page)).toHaveCount(letters('The colour of'));
  await expect(page.locator('.c.bad, .c.extra, .c.miss, .w.flawed')).toHaveCount(0);

  // Typing carries on from the saved word.
  await page.keyboard.type('the sea ');
  await expect(typed(page)).toHaveCount(letters('The colour of the sea'));
  await expect(page.locator('.c.bad, .c.extra, .c.miss, .w.flawed')).toHaveCount(0);
});

test('a place in a later paragraph is restored there', async ({ page }) => {
  await page.goto('/');
  await importText(page, 'tale.txt', BOOK);

  await page.keyboard.type('The colour of the sea was grey. Nobody spoke at all. A gull ');
  await waitForPlace(page, { chapter: 0, paragraph: 1, char: 'A gull '.length });
  await reload(page, 'tale');

  await expect(typed(page)).toHaveCount(letters('The colour of the sea was grey. Nobody spoke at all. A gull'));
  await page.keyboard.type('cried ');
  await expect(typed(page)).toHaveCount(letters('The colour of the sea was grey. Nobody spoke at all. A gull cried'));
});

test('stepping back to an earlier word saves that word as the place', async ({ page }) => {
  await page.goto('/');
  await importText(page, 'tale.txt', BOOK);

  // Backspace only steps back into a word that has a mistake in it.
  await page.keyboard.type('The colxur ');
  await waitForPlace(page, { chapter: 0, paragraph: 0, char: 'The colour '.length });
  await page.keyboard.press('Backspace'); // back into "colour"
  await waitForPlace(page, { chapter: 0, paragraph: 0, char: 'The '.length });
});

test('the sample opens when no book was open last', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.book h1')).toHaveText('Pride and Prejudice');
  await reload(page, 'Pride and Prejudice');
  await expect(typed(page)).toHaveCount(0);
});

test('the sample opens when the last book is no longer stored on the device', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => localStorage.setItem('typeshelf:reading', 'a-book-that-is-gone'));
  await page.reload();
  await expect(page.locator('.book h1')).toHaveText('Pride and Prejudice');
  await expect(page.locator('.ts')).toHaveClass(/ts-focused/);
  await page.keyboard.type('It ');
  await expect(typed(page)).toHaveCount('It'.length);
});

test('a place saved with American spelling opens on the same word with spelling as printed', async ({ page }) => {
  await page.goto('/');
  await importText(page, 'tale.txt', BOOK);
  await chooseSpelling(page, 'American');
  await expect(page.locator('.ts-para').first()).toContainText('color');

  await page.keyboard.type('The color of ');
  // Measured against the text as printed: "colour" has one more letter than "color".
  await waitForPlace(page, { chapter: 0, paragraph: 0, char: 'The colour of '.length });

  // Switch the stored setting back to as printed and reload, so the book opens from the saved place alone.
  await page.evaluate(() => {
    const settings = JSON.parse(localStorage.getItem('typeshelf:settings') ?? '{}');
    localStorage.setItem('typeshelf:settings', JSON.stringify({ ...settings, spelling: 'original' }));
  });
  await reload(page, 'tale');
  await expect(page.locator('.ts-para').first()).toContainText('colour');

  await expect(typed(page)).toHaveCount(letters('The colour of'));
  await page.keyboard.type('the sea ');
  await expect(typed(page)).toHaveCount(letters('The colour of the sea'));
  await expect(page.locator('.c.bad, .c.extra, .c.miss, .w.flawed')).toHaveCount(0);
});

test('a place saved with spelling as printed opens on the same word with American spelling', async ({ page }) => {
  await page.goto('/');
  await importText(page, 'tale.txt', BOOK);

  await page.keyboard.type('The colour of ');
  await waitForPlace(page, { chapter: 0, paragraph: 0, char: 'The colour of '.length });
  await page.evaluate(() => {
    const settings = JSON.parse(localStorage.getItem('typeshelf:settings') ?? '{}');
    localStorage.setItem('typeshelf:settings', JSON.stringify({ ...settings, spelling: 'american' }));
  });
  await reload(page, 'tale');
  await expect(page.locator('.ts-para').first()).toContainText('color');
  await expect(page.locator('.ts-para').first()).not.toContainText('colour');

  await expect(typed(page)).toHaveCount(letters('The color of'));
  await page.keyboard.type('the sea ');
  await expect(typed(page)).toHaveCount(letters('The color of the sea'));
});

test('restart goes back to the first word but the old place stands until a word is completed', async ({ page }) => {
  await page.goto('/');
  await importText(page, 'tale.txt', BOOK);

  await page.keyboard.type('The colour of ');
  const saved = { chapter: 0, paragraph: 0, char: 'The colour of '.length };
  await waitForPlace(page, saved);

  await page.getByRole('button', { name: 'Restart' }).click();
  await expect(typed(page)).toHaveCount(0);
  // Give a wrongly made save time to land; the poll above cannot tell "not yet" from "never".
  await page.waitForTimeout(500);
  expect(await storedPlace(page)).toEqual(saved);

  // Reloading without typing brings the old place back.
  await reload(page, 'tale');
  await expect(typed(page)).toHaveCount(letters('The colour of'));

  // Restart again, and now complete a word: the place follows the new typing.
  await page.getByRole('button', { name: 'Restart' }).click();
  await page.keyboard.type('The ');
  await waitForPlace(page, { chapter: 0, paragraph: 0, char: 'The '.length });
});

test('restarting a book says that a reload undoes it, until the next key press', async ({ page }, testInfo) => {
  await page.goto('/');
  await importText(page, 'tale.txt', BOOK);
  const note = page.locator('.restart-note');
  await expect(note).not.toHaveClass(/shown/);

  // Nothing typed yet, so there is nothing to undo and nothing to say.
  await page.getByRole('button', { name: 'Restart' }).click();
  await expect(note).not.toHaveClass(/shown/);

  await page.keyboard.type('The colour of ');
  await page.getByRole('button', { name: 'Restart' }).click();
  await expect(note).toHaveClass(/shown/);
  await expect(note).toHaveText('Didn’t mean to restart? Reload the page to go back to your place.');
  await expect(note).toHaveCSS('opacity', '1');
  await page.screenshot({ path: testInfo.outputPath('restart-note.png') });

  // It looks like the "Paused" note, and sits where that one does.
  const paused = page.locator('.ts-hint');
  for (const property of ['border-radius', 'background-color', 'color', 'font-size', 'top', 'left']) {
    expect(await note.evaluate((el, name) => getComputedStyle(el).getPropertyValue(name), property)).toBe(
      await paused.evaluate((el, name) => getComputedStyle(el).getPropertyValue(name), property),
    );
  }

  await page.keyboard.type('T');
  await expect(note).not.toHaveClass(/shown/);
});

test('restarting the sample says nothing about reloading', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.ts-para').first()).toBeVisible();
  await page.locator('.ts').click();
  await page.keyboard.type('It is ');
  await page.getByRole('button', { name: 'Restart' }).click();
  await expect(page.locator('.c.ok')).toHaveCount(0);
  await expect(page.locator('.restart-note')).not.toHaveClass(/shown/);
});

test('finishing a chapter offers the next one, and a reload opens it at its start', async ({ page }) => {
  await page.goto('/');
  await importText(page, 'tale.txt', BOOK);

  await page.keyboard.type('The colour of the sea was grey. Nobody spoke at all. A gull cried over the wall.');
  await expect(page.getByRole('heading', { name: 'Chapter complete.' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Next chapter' })).toBeVisible();
  await waitForPlace(page, { chapter: 1, paragraph: 0, char: 0 });

  await reload(page, 'tale');
  await expect(page.locator('.book p')).toContainText('Chapter 2');
  await expect(typed(page)).toHaveCount(0);
  await page.keyboard.type('It came ');
  await expect(typed(page)).toHaveCount(letters('It came'));
});

test('the next chapter button opens the next chapter', async ({ page }) => {
  await page.goto('/');
  await importText(page, 'tale.txt', BOOK);

  await page.keyboard.type('The colour of the sea was grey. Nobody spoke at all. A gull cried over the wall.');
  await page.getByRole('button', { name: 'Next chapter' }).click();

  await expect(page.locator('.book p')).toContainText('Chapter 2');
  await expect(page.getByRole('heading', { name: 'Chapter complete.' })).toHaveCount(0);
  await expect(page.locator('.ts')).toHaveClass(/ts-focused/);
  await page.keyboard.type('It came back at noon.');
  await expect(page.getByRole('heading', { name: 'Book complete.' })).toBeVisible();
});

test('finishing the last chapter says the book is complete, with no next chapter, and a reload reopens its end', async ({
  page,
}) => {
  await page.goto('/');
  await importText(page, 'tale.txt', SHORT_BOOK);

  await page.keyboard.type('The colour of the sea was grey. A gull cried.');
  await expect(page.getByRole('heading', { name: 'Book complete.' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Next chapter' })).toHaveCount(0);
  // The very end: past the last letter of the last paragraph.
  await waitForPlace(page, { chapter: 0, paragraph: 1, char: 'A gull cried.'.length });

  await reload(page, 'tale');
  await expect(typed(page)).toHaveCount(letters('The colour of the sea was grey. A gull cried.') - 'cried.'.length);
});

test('changing spelling in a book keeps the reader on the same word', async ({ page }) => {
  await page.goto('/');
  await importText(page, 'tale.txt', BOOK);

  await page.keyboard.type('The colour of ');
  await expect(typed(page)).toHaveCount(letters('The colour of'));

  await chooseSpelling(page, 'American');
  await expect(page.locator('.ts-para').first()).toContainText('color');
  // Words before the caret are shown as typed, in the new spelling.
  await expect(typed(page)).toHaveCount(letters('The color of'));
  await page.keyboard.type('the sea ');
  await expect(typed(page)).toHaveCount(letters('The color of the sea'));
});

test('changing spelling in a book does not move the saved place', async ({ page }) => {
  await page.goto('/');
  await importText(page, 'tale.txt', BOOK);

  await page.keyboard.type('The colour of ');
  const saved = { chapter: 0, paragraph: 0, char: 'The colour of '.length };
  await waitForPlace(page, saved);

  await chooseSpelling(page, 'American');
  await page.waitForTimeout(300);
  expect(await storedPlace(page)).toEqual(saved);
});

test('typing the sample keeps no place', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.ts')).toHaveClass(/ts-focused/);
  await page.keyboard.type('It is a truth ');
  await expect(typed(page)).toHaveCount(letters('It is a truth'));
  await page.waitForTimeout(300);
  expect(await storedPlace(page)).toBeUndefined();
  expect(await page.evaluate(() => localStorage.getItem('typeshelf:reading'))).toBeNull();
});
