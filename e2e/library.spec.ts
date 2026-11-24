import { expect, test, type Locator, type Page } from '@playwright/test';
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

/** Imports a Markdown file and waits until its first chapter is on the page, ready to type. */
async function importMarkdown(page: Page, name: string, text: string): Promise<void> {
  await openImport(page);
  await pick(page, name, strToU8(text), 'text/markdown');
  await expect(page.locator('.book h1')).toHaveText(name.replace(/\.md$/, ''));
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

/** Saves are asynchronous, so wait for the place to land before reading it elsewhere. */
async function waitForPlace(page: Page, place: Place): Promise<void> {
  await expect.poll(() => storedPlace(page)).toEqual(place);
}

const letters = (text: string) => text.replace(/\s+/g, '').length;
const typed = (page: Page) => page.locator('.c.ok');

/** Three chapters of 17, 10 and 10 words (37 in all). */
const STORY = [
  '# The Start',
  'The colour of the sea was grey. Nobody spoke at all.',
  'A gull cried over the wall.',
  '# The Middle',
  'It came back at noon. The boats went out again.',
  '# The End',
  'Night fell on the harbour and the lamps were lit.',
].join('\n\n');

const FIRST_CHAPTER = 'The colour of the sea was grey. Nobody spoke at all. A gull cried over the wall.';

/** Chapter two is a page number that the importer took for a heading. */
const PAGES = [
  '# The Start',
  'The colour of the sea was grey. Nobody spoke at all.',
  'A gull cried over the wall.',
  '# 117',
  'Mind the gap.',
  '# The Next',
  'It came back at noon.',
].join('\n\n');

/** One chapter, so finishing it finishes the book. */
const SHORT = 'The colour of the sea was grey.\n\nA gull cried.';

const rowOf = (within: Page | Locator, title: string) =>
  within.locator('li.shelf-row[data-book]').filter({ hasText: title });
const section = (page: Page, name: string) => page.getByRole('region', { name, exact: true });
const chapterRow = (page: Page, index: number) => page.locator(`li.shelf-row.chapter[data-chapter="${index}"]`);

async function openLibrary(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Library', exact: true }).click();
  await expect(page.locator('main.shelf')).toBeVisible();
}

/** From the typing screen to a book's chapters. */
async function openChapters(page: Page, title: string): Promise<void> {
  await openLibrary(page);
  await page.getByRole('button', { name: `${title}: chapters` }).click();
  await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible();
}

/** Types the whole first chapter of STORY and moves on to the second, which is typed `count` letters in. */
async function intoSecondChapter(page: Page, text: string): Promise<void> {
  await page.keyboard.type(FIRST_CHAPTER);
  await page.getByRole('button', { name: 'Next chapter' }).click();
  await expect(page.locator('.book p')).toHaveText('The Middle');
  await page.keyboard.type(text);
  await waitForPlace(page, { chapter: 1, paragraph: 0, char: text.length });
}

test('the library lists an imported book as not started, with the sample last', async ({ page }) => {
  await page.goto('/');
  await importMarkdown(page, 'story.md', STORY);
  await openLibrary(page);

  const notStarted = section(page, 'Not started');
  const story = rowOf(notStarted, 'story');
  await expect(story.locator('.shelf-about')).toHaveText('Chapter 1 of 3');
  await expect(story.locator('.shelf-percent')).toHaveText('0%');
  await expect(story.locator('button', { hasText: /^Start$/ })).toBeVisible();
  await expect(notStarted.locator('li.shelf-row').last()).toHaveAttribute('data-book', 'sample');
  await expect(notStarted.locator('li.shelf-row')).toHaveCount(2);
  await expect(section(page, 'Reading now')).toHaveCount(0);
  await expect(section(page, 'Finished')).toHaveCount(0);
});

test('a book moves to reading now once words are typed, with its chapter and a percentage', async ({ page }) => {
  await page.goto('/');
  await importMarkdown(page, 'story.md', STORY);
  await intoSecondChapter(page, 'It came ');
  await openLibrary(page);

  const story = rowOf(section(page, 'Reading now'), 'story');
  await expect(story.locator('.shelf-about')).toHaveText('Chapter 2 of 3');
  // 17 words of the first chapter and 2 of the second, out of 37.
  await expect(story.locator('.shelf-percent')).toHaveText('51%');
  await expect(story.locator('button', { hasText: /^Continue$/ })).toBeVisible();
  await expect(section(page, 'Not started').locator('li.shelf-row')).toHaveCount(1);
});

test('the search box is disabled and says what it will search', async ({ page }) => {
  await page.goto('/');
  await openLibrary(page);
  const search = page.getByPlaceholder('Search for e-books...');
  await expect(search).toBeVisible();
  await expect(search).toBeDisabled();
});

test('continue in the library returns to typing at the saved word', async ({ page }) => {
  await page.goto('/');
  await importMarkdown(page, 'story.md', STORY);
  await page.keyboard.type('The colour of ');
  await waitForPlace(page, { chapter: 0, paragraph: 0, char: 'The colour of '.length });
  await openLibrary(page);

  await rowOf(section(page, 'Reading now'), 'story').locator('button', { hasText: /^Continue$/ }).click();
  await expect(page.locator('.book h1')).toHaveText('story');
  await expect(page.locator('main.shelf')).toHaveCount(0);
  await expect(typed(page)).toHaveCount(letters('The colour of'));
  await expect(page.locator('.ts')).toHaveClass(/ts-focused/);

  await page.keyboard.type('the sea ');
  await expect(typed(page)).toHaveCount(letters('The colour of the sea'));
});

test('the wordmark returns to typing with what was typed still shown, and the clock did not run meanwhile', async ({
  page,
}) => {
  await page.goto('/');
  await importMarkdown(page, 'story.md', STORY);
  await page.keyboard.type('The colour of the sea was grey. ', { delay: 90 });
  const done = letters('The colour of the sea was grey.');
  await expect(typed(page)).toHaveCount(done);
  // The time shows from two seconds of typing.
  const time = page.locator('[data-stat="time"]');
  await expect(time).toHaveText(/^0:0[2-9]$/);

  await openLibrary(page);
  await expect(typed(page)).toHaveCount(0);
  // Let the page publish the paused clock, then wait and look again.
  await page.waitForTimeout(500);
  const before = await time.textContent();
  await page.waitForTimeout(2500);
  expect(await time.textContent()).toBe(before);

  await page.locator('button.mark').click();
  await expect(page.locator('main.shelf')).toHaveCount(0);
  await expect(typed(page)).toHaveCount(done);
  await page.waitForTimeout(500);
  expect(await time.textContent()).toBe(before);
  await expect(page.locator('.ts')).toHaveClass(/ts-focused/);
});

test('the wordmark goes back to typing from a book\'s chapters too', async ({ page }) => {
  await page.goto('/');
  await importMarkdown(page, 'story.md', STORY);
  await page.keyboard.type('The colour of ');
  await openChapters(page, 'story');

  await page.locator('button.mark').click();
  await expect(page.locator('main.shelf')).toHaveCount(0);
  await expect(typed(page)).toHaveCount(letters('The colour of'));
});

test('the chapter screen marks chapters as completed, in progress and not started', async ({ page }) => {
  await page.goto('/');
  await importMarkdown(page, 'story.md', STORY);
  await intoSecondChapter(page, 'It came back ');
  await openChapters(page, 'story');

  await expect(page.getByRole('heading', { level: 1 })).toHaveText('story');
  // 17 words and 3 of 10, out of 37.
  await expect(page.locator('.chapters-book p')).toHaveText('3 chapters · 54% typed');
  await expect(page.getByRole('button', { name: 'Continue Chapter 2', exact: true })).toBeVisible();

  await expect(chapterRow(page, 0).locator('button.completed .rest')).toHaveText('Completed');
  await expect(chapterRow(page, 0)).not.toHaveClass(/here/);

  await expect(chapterRow(page, 1)).toHaveClass(/here/);
  await expect(chapterRow(page, 1).locator('.shelf-about')).toHaveText('30% of 10 words');
  await expect(chapterRow(page, 1).locator('button', { hasText: /^Continue$/ })).toBeVisible();

  await expect(chapterRow(page, 2)).not.toHaveClass(/here/);
  await expect(chapterRow(page, 2).locator('.shelf-about')).toHaveText('10 words');
  await expect(chapterRow(page, 2).locator('button', { hasText: /^Start$/ })).toBeVisible();
});

test('the chapter screen of a book not started offers Start Chapter 1 and no chapter in progress', async ({ page }) => {
  await page.goto('/');
  await importMarkdown(page, 'story.md', STORY);
  await openChapters(page, 'story');

  await expect(page.locator('.chapters-book p')).toHaveText('3 chapters · 0% typed');
  await expect(page.getByRole('button', { name: 'Start Chapter 1', exact: true })).toBeVisible();
  await expect(page.locator('li.shelf-row.chapter.here')).toHaveCount(0);
  await expect(page.locator('button.completed')).toHaveCount(0);
  await expect(page.locator('button', { hasText: /^Start$/ })).toHaveCount(3);
});

test('Start on a later chapter opens it and moves the saved place to its start', async ({ page }) => {
  await page.goto('/');
  await importMarkdown(page, 'story.md', STORY);
  await page.keyboard.type('The colour of ');
  await waitForPlace(page, { chapter: 0, paragraph: 0, char: 'The colour of '.length });
  await openChapters(page, 'story');

  await chapterRow(page, 2).locator('button', { hasText: /^Start$/ }).click();
  await expect(page.locator('.book p')).toHaveText('The End');
  await expect(page.locator('.ts-para').first()).toContainText('Night fell');
  await expect(typed(page)).toHaveCount(0);
  await waitForPlace(page, { chapter: 2, paragraph: 0, char: 0 });
});

test('the main button opens the chapter the reader is in, at the saved word', async ({ page }) => {
  await page.goto('/');
  await importMarkdown(page, 'story.md', STORY);
  await intoSecondChapter(page, 'It came ');
  await openChapters(page, 'story');

  await page.getByRole('button', { name: 'Continue Chapter 2', exact: true }).click();
  await expect(page.locator('.book p')).toHaveText('The Middle');
  await expect(typed(page)).toHaveCount(letters('It came'));
});

test('a completed chapter shows Type again when pointed at', async ({ page }) => {
  await page.goto('/');
  await importMarkdown(page, 'story.md', STORY);
  await intoSecondChapter(page, 'It came ');
  await openChapters(page, 'story');

  const completed = chapterRow(page, 0).locator('button.completed');
  await expect(completed.locator('.rest')).toBeVisible();
  await expect(completed.locator('.over')).toBeHidden();
  await completed.hover();
  await expect(completed.locator('.over')).toHaveText('Type again');
  await expect(completed.locator('.over')).toBeVisible();
  await expect(completed.locator('.rest')).toBeHidden();
  await expect(completed).toHaveAccessibleName('Type The Start again');
});

test('typing a completed chapter again does not move the saved place, and finishing it offers the next chapter', async ({
  page,
}) => {
  await page.goto('/');
  await importMarkdown(page, 'story.md', STORY);
  await intoSecondChapter(page, 'It came ');
  const saved = { chapter: 1, paragraph: 0, char: 'It came '.length };
  await openChapters(page, 'story');

  await chapterRow(page, 0).locator('button.completed').click();
  await expect(page.locator('.book p')).toHaveText('The Start');
  await expect(typed(page)).toHaveCount(0);

  await page.keyboard.type('The colour ');
  await expect(typed(page)).toHaveCount(letters('The colour'));
  // Give a wrongly made save time to land; the poll cannot tell "not yet" from "never".
  await page.waitForTimeout(500);
  expect(await storedPlace(page)).toEqual(saved);

  await page.keyboard.type('of the sea was grey. Nobody spoke at all. A gull cried over the wall.');
  await expect(page.getByRole('heading', { name: 'Chapter complete.' })).toBeVisible();
  await page.waitForTimeout(500);
  expect(await storedPlace(page)).toEqual(saved);

  // The next chapter is the one the reader was in, so it opens at the saved word.
  await page.getByRole('button', { name: 'Next chapter' }).click();
  await expect(page.locator('.book p')).toHaveText('The Middle');
  await expect(typed(page)).toHaveCount(letters('It came'));
});

test('a heading that looks like a page number is flagged, with a choice to merge or keep it', async ({ page }) => {
  await page.goto('/');
  await importMarkdown(page, 'pages.md', PAGES);
  await openChapters(page, 'pages');

  await expect(page.locator('.chapters-book p')).toHaveText('3 chapters · 0% typed');
  const row = chapterRow(page, 1);
  await expect(row.locator('.chapter-warning')).toHaveText('3 words. This may be a page number, not a chapter.');
  await expect(row.getByRole('button', { name: 'Merge into The Start', exact: true })).toBeVisible();
  await expect(row.getByRole('button', { name: 'Keep', exact: true })).toBeVisible();
  // Only the page number is flagged.
  await expect(page.locator('.chapter-warning')).toHaveCount(1);
});

test('merging a page number into the chapter before it joins their words, and the choice survives a reload', async ({
  page,
}) => {
  await page.goto('/');
  await importMarkdown(page, 'pages.md', PAGES);
  await openChapters(page, 'pages');
  await expect(chapterRow(page, 0).locator('.shelf-about')).toHaveText('17 words');

  await chapterRow(page, 1).getByRole('button', { name: 'Merge into The Start', exact: true }).click();

  await expect(page.locator('.chapter-warning')).toHaveCount(0);
  await expect(page.locator('li.shelf-row.chapter')).toHaveCount(2);
  await expect(chapterRow(page, 0).locator('.shelf-about')).toHaveText('20 words');
  await expect(chapterRow(page, 1).locator('.shelf-title')).toHaveText('The Next');
  await expect(page.locator('.chapters-book p')).toHaveText('2 chapters · 0% typed');

  await page.getByRole('button', { name: 'Library', exact: true }).click();
  await expect(rowOf(page, 'pages').locator('.shelf-about')).toHaveText('Chapter 1 of 2');

  await page.reload();
  await openChapters(page, 'pages');
  await expect(page.locator('.chapter-warning')).toHaveCount(0);
  await expect(page.locator('li.shelf-row.chapter')).toHaveCount(2);
  await expect(page.locator('.chapters-book p')).toHaveText('2 chapters · 0% typed');
});

test('keeping a flagged chapter removes the warning and keeps it as a chapter', async ({ page }) => {
  await page.goto('/');
  await importMarkdown(page, 'pages.md', PAGES);
  await openChapters(page, 'pages');

  await chapterRow(page, 1).getByRole('button', { name: 'Keep', exact: true }).click();
  await expect(page.locator('.chapter-warning')).toHaveCount(0);
  await expect(page.locator('li.shelf-row.chapter')).toHaveCount(3);
  await expect(chapterRow(page, 1).locator('.shelf-title')).toHaveText('117');
  await expect(chapterRow(page, 1).locator('.shelf-about')).toHaveText('3 words');
  await expect(page.locator('.chapters-book p')).toHaveText('3 chapters · 0% typed');

  await page.reload();
  await openChapters(page, 'pages');
  await expect(page.locator('.chapter-warning')).toHaveCount(0);
  await expect(page.locator('li.shelf-row.chapter')).toHaveCount(3);
});

test('a place saved before merging a chapter still opens on the same word afterwards', async ({ page }) => {
  await page.goto('/');
  await importMarkdown(page, 'pages.md', PAGES);
  await openChapters(page, 'pages');
  await chapterRow(page, 2).locator('button', { hasText: /^Start$/ }).click();
  await expect(page.locator('.book p')).toHaveText('The Next');
  await page.keyboard.type('It came back ');
  const saved = { chapter: 2, paragraph: 0, char: 'It came back '.length };
  await waitForPlace(page, saved);
  const count = letters('It came back');
  await expect(typed(page)).toHaveCount(count);
  const nextLetter = await page.locator('.c:not(.ok)').first().textContent();
  expect(nextLetter).toBe('a');

  await openChapters(page, 'pages');
  await chapterRow(page, 1).getByRole('button', { name: 'Merge into The Start', exact: true }).click();
  // The chapters are renumbered, and the one the reader is in is now the second.
  await page.getByRole('button', { name: 'Continue Chapter 2', exact: true }).click();

  await expect(page.locator('.book p')).toHaveText('The Next');
  await expect(typed(page)).toHaveCount(count);
  await expect(page.locator('.c:not(.ok)').first()).toHaveText(nextLetter ?? '');
  expect(await storedPlace(page)).toEqual(saved);
  await page.keyboard.type('at ');
  await expect(typed(page)).toHaveCount(letters('It came back at'));
  // Typing on saves in the book's own chapters again, not the joined ones.
  await waitForPlace(page, { chapter: 2, paragraph: 0, char: 'It came back at '.length });
});

test("a merged chapter's paragraphs are typed as part of the chapter before it", async ({ page }) => {
  await page.goto('/');
  await importMarkdown(page, 'pages.md', PAGES);
  await openChapters(page, 'pages');
  await chapterRow(page, 1).getByRole('button', { name: 'Merge into The Start', exact: true }).click();

  // Start of the first chapter, with the page number now part of it: 20 words.
  await page.getByRole('button', { name: 'Start Chapter 1', exact: true }).click();
  await expect(page.locator('.book p')).toHaveText('The Start');
  await expect(page.locator('.ts-para')).toHaveCount(3);
  await expect(page.locator('.ts-para').last()).toContainText('Mind the gap');
});

test('the trash button asks first, and keeping the book leaves it in the library', async ({ page }) => {
  await page.goto('/');
  await importMarkdown(page, 'story.md', STORY);
  await openChapters(page, 'story');

  let message = '';
  page.once('dialog', (dialog) => {
    message = dialog.message();
    void dialog.dismiss();
  });
  await page.getByRole('button', { name: 'Remove from device' }).click();
  await expect.poll(() => message).toContain('story');
  await expect(page.getByRole('heading', { level: 1, name: 'story' })).toBeVisible();

  await page.getByRole('button', { name: 'Library', exact: true }).click();
  await expect(rowOf(page, 'story')).toHaveCount(1);
});

test('removing a book from its chapters takes it out of the library but keeps the saved place', async ({ page }) => {
  await page.goto('/');
  await importMarkdown(page, 'story.md', STORY);
  await page.keyboard.type('The colour of ');
  const saved = { chapter: 0, paragraph: 0, char: 'The colour of '.length };
  await waitForPlace(page, saved);
  await openChapters(page, 'story');

  page.once('dialog', (dialog) => void dialog.accept());
  await page.getByRole('button', { name: 'Remove from device' }).click();

  await expect(page.locator('main.shelf')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Reading now' })).toHaveCount(0);
  await expect(rowOf(page, 'story')).toHaveCount(0);
  await expect(page.locator('li.shelf-row[data-book]')).toHaveCount(1);
  expect(await storedPlace(page)).toEqual(saved);
});

test('removing the book being typed puts the sample on the page and forgets the last book', async ({ page }) => {
  await page.goto('/');
  await importMarkdown(page, 'story.md', STORY);
  await page.keyboard.type('The colour of ');
  await waitForPlace(page, { chapter: 0, paragraph: 0, char: 'The colour of '.length });
  expect(await page.evaluate(() => localStorage.getItem('typeshelf:reading'))).not.toBeNull();
  await openChapters(page, 'story');

  page.once('dialog', (dialog) => void dialog.accept());
  await page.getByRole('button', { name: 'Remove from device' }).click();
  await expect(rowOf(page, 'story')).toHaveCount(0);

  await page.locator('button.mark').click();
  await expect(page.locator('.book h1')).toHaveText('Pride and Prejudice');
  await expect(typed(page)).toHaveCount(0);
  await expect(page.locator('.ts')).toHaveClass(/ts-focused/);
  expect(await page.evaluate(() => localStorage.getItem('typeshelf:reading'))).toBeNull();

  // A reload does not bring the removed book back.
  await page.reload();
  await expect(page.locator('.book h1')).toHaveText('Pride and Prejudice');
});

test('removing a book that is not the one being typed leaves the typing alone', async ({ page }) => {
  await page.goto('/');
  await importMarkdown(page, 'story.md', STORY);
  await importMarkdown(page, 'pages.md', PAGES);
  await page.keyboard.type('The colour ');
  await openChapters(page, 'story');

  page.once('dialog', (dialog) => void dialog.accept());
  await page.getByRole('button', { name: 'Remove from device' }).click();
  await expect(rowOf(page, 'story')).toHaveCount(0);

  await page.locator('button.mark').click();
  await expect(page.locator('.book h1')).toHaveText('pages');
  await expect(typed(page)).toHaveCount(letters('The colour'));
});

test('Start on the sample entry types the sample and forgets the last book', async ({ page }) => {
  await page.goto('/');
  await importMarkdown(page, 'story.md', STORY);
  await openLibrary(page);

  const sample = page.locator('li.shelf-row[data-book="sample"]');
  // The sample has no chapters to open.
  await expect(sample.locator('button.shelf-book')).toHaveCount(0);
  await sample.locator('button', { hasText: /^Start$/ }).click();

  await expect(page.locator('main.shelf')).toHaveCount(0);
  await expect(page.locator('.book h1')).toHaveText('Pride and Prejudice');
  await expect(page.locator('.ts')).toHaveClass(/ts-focused/);
  expect(await page.evaluate(() => localStorage.getItem('typeshelf:reading'))).toBeNull();
  await page.keyboard.type('It is ');
  await expect(typed(page)).toHaveCount(letters('It is'));
});

test('a finished book is under Finished at 100%, and Open leads to its chapters', async ({ page }) => {
  await page.goto('/');
  await importMarkdown(page, 'short.md', SHORT);
  await page.keyboard.type('The colour of the sea was grey. A gull cried.');
  await expect(page.getByRole('heading', { name: 'Book complete.' })).toBeVisible();
  await waitForPlace(page, { chapter: 0, paragraph: 1, char: 'A gull cried.'.length });
  await openLibrary(page);

  const finished = rowOf(section(page, 'Finished'), 'short');
  await expect(finished.locator('.shelf-percent')).toHaveText('100%');
  await expect(finished.locator('.shelf-about')).toHaveText('Chapter 1 of 1');
  await expect(section(page, 'Reading now')).toHaveCount(0);
  await expect(section(page, 'Not started').locator('li.shelf-row')).toHaveCount(1);

  await finished.locator('button', { hasText: /^Open$/ }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'short' })).toBeVisible();
  await expect(page.locator('.chapters-book p')).toHaveText('1 chapter · 100% typed');
  await expect(page.locator('button.go')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^(Continue|Start) Chapter/ })).toHaveCount(0);
  await expect(chapterRow(page, 0).locator('button.completed .rest')).toHaveText('Completed');
});

test('the library and a chapter screen with a warning row look as intended', async ({ page }, testInfo) => {
  await page.goto('/');
  await importMarkdown(page, 'story.md', STORY);
  await page.keyboard.type('The colour of the sea ');
  await waitForPlace(page, { chapter: 0, paragraph: 0, char: 'The colour of the sea '.length });
  await openLibrary(page);
  await expect(rowOf(section(page, 'Reading now'), 'story')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('library.png'), fullPage: true });

  await importMarkdown(page, 'pages.md', PAGES);
  await openChapters(page, 'pages');
  await expect(page.locator('.chapter-warning')).toHaveCount(1);
  await page.screenshot({ path: testInfo.outputPath('chapters.png'), fullPage: true });
});
