import { expect, test, type Page } from '@playwright/test';
import { sample } from '../src/sample/pride-and-prejudice';

/** The keys a person presses on a plain keyboard for printed text. */
function keysFor(text: string): string {
  return text.replace(/[“”]/g, '"').replace(/[‘’]/g, "'");
}

async function open(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.locator('.ts-para').first()).toBeVisible();
  await page.locator('.ts').click();
  await expect(page.locator('.ts')).toHaveClass(/ts-focused/);
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

const stat = (page: Page, name: string) => page.locator(`[data-stat="${name}"]`);

test('keeps every key when typed far faster than a person can', async ({ page }, testInfo) => {
  await open(page);

  // 5 ms between keys is about 2,400 words per minute.
  const text = sample.paragraphs.slice(0, 3).join(' ');
  await page.keyboard.type(`${keysFor(text)} `, { delay: 5 });

  const letters = text.replace(/\s+/g, '').length;
  await expect(page.locator('.c.ok')).toHaveCount(letters);
  await expect(page.locator('.c.bad, .c.extra, .c.miss, .w.flawed')).toHaveCount(0);
  await expect(stat(page, 'accuracy')).toHaveText('100%');

  await page.waitForTimeout(300); // let the caret and scroll settle for the picture
  await page.screenshot({ path: testInfo.outputPath('three-paragraphs.png') });
});

test('flow mode shows mistakes and lets you go back to fix them', async ({ page }) => {
  await open(page);
  const first = page.locator('.w').first(); // "It"

  await page.keyboard.type('Ix');
  await expect(first.locator('.c').nth(0)).toHaveClass('c ok');
  await expect(first.locator('.c').nth(1)).toHaveClass('c bad');

  await page.keyboard.type(' '); // leave the word with the mistake in it
  await expect(first).toHaveClass(/flawed/);

  await page.keyboard.press('Backspace'); // step back into it
  await expect(first).not.toHaveClass(/flawed/);
  await page.keyboard.press('Backspace');
  await page.keyboard.type('t ');
  await expect(first.locator('.c.ok')).toHaveCount(2);
  await expect(first).not.toHaveClass(/flawed/);

  // A correct word is locked: Backspace at the start of the next word stays put.
  await page.keyboard.press('Backspace');
  await page.keyboard.type('is');
  await expect(page.locator('.w').nth(1).locator('.c.ok')).toHaveCount(2);
});

test('stop on error (letter) refuses a wrong key', async ({ page }) => {
  await open(page);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await setting(page, 'Stop on error', 'Letter').click();
  await page.keyboard.press('Escape'); // closing settings hands the keyboard back
  await expect(page.locator('.ts')).toHaveClass(/ts-focused/);

  await page.keyboard.type('x');
  await expect(page.locator('.c.bad')).toHaveCount(0);
  await expect(page.locator('.c.ok')).toHaveCount(0);

  await page.keyboard.type('It ');
  await expect(page.locator('.w').first().locator('.c.ok')).toHaveCount(2);
  // One wrong key out of four.
  await expect(stat(page, 'accuracy')).toHaveText('75%');
});

test('types the whole chapter: scrolls, drops old paragraphs, finishes', async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  await open(page);

  // Record the longest stretch the page was too busy to respond.
  await page.evaluate(() => {
    const store = window as unknown as { longestTask: number };
    store.longestTask = 0;
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) store.longestTask = Math.max(store.longestTask, entry.duration);
    }).observe({ type: 'longtask' });
  });

  const half = Math.floor(sample.paragraphs.length / 2);
  await page.keyboard.type(`${keysFor(sample.paragraphs.slice(0, half).join(' '))} `, { delay: 2 });

  // Mid-chapter the caret must still be inside the visible window.
  await page.waitForTimeout(300);
  const view = (await page.locator('.ts-view').boundingBox())!;
  const caret = (await page.locator('.ts-caret').boundingBox())!;
  expect(caret.y).toBeGreaterThanOrEqual(view.y);
  expect(caret.y + caret.height).toBeLessThanOrEqual(view.y + view.height);
  await page.screenshot({ path: testInfo.outputPath('mid-chapter.png') });

  await page.keyboard.type(keysFor(sample.paragraphs.slice(half).join(' ')), { delay: 2 });

  await expect(page.getByText('Chapter complete.')).toBeVisible();
  await expect(stat(page, 'accuracy')).toHaveText('100%');
  await expect(stat(page, 'progress')).toHaveText('100%');
  await expect(page.locator('.c.bad, .c.extra, .c.miss, .w.flawed')).toHaveCount(0);

  // Paragraphs far above the caret are removed from the page.
  expect(await page.locator('.ts-para').count()).toBeLessThan(sample.paragraphs.length);

  const longestTask = await page.evaluate(() => (window as unknown as { longestTask: number }).longestTask);
  testInfo.annotations.push({ type: 'longest busy stretch', description: `${Math.round(longestTask)} ms` });
  console.log(`longest busy stretch while typing the chapter: ${Math.round(longestTask)} ms`);
  expect(longestTask).toBeLessThan(200);

  await page.screenshot({ path: testInfo.outputPath('finished.png') });
});

for (const size of [
  { width: 1920, height: 1080 },
  { width: 1280, height: 720 },
  { width: 700, height: 500 },
]) {
  test(`fills a ${size.width}x${size.height} window without page scroll`, async ({ page }, testInfo) => {
    await page.setViewportSize(size);
    await open(page);
    await page.keyboard.type(`${keysFor(sample.paragraphs.slice(0, 2).join(' '))} `, { delay: 2 });
    await page.waitForTimeout(300);

    // Nothing spills past the window in either direction.
    const overflow = await page.evaluate(() => ({
      x: document.documentElement.scrollWidth - window.innerWidth,
      y: document.documentElement.scrollHeight - window.innerHeight,
    }));
    expect(overflow.x).toBeLessThanOrEqual(0);
    expect(overflow.y).toBeLessThanOrEqual(0);

    // The text runs nearly edge to edge, and the numbers sit at the bottom.
    const view = (await page.locator('.ts-view').boundingBox())!;
    const meter = (await page.locator('.meter').boundingBox())!;
    expect(view.width).toBeGreaterThan(size.width * 0.85);
    expect(size.height - (meter.y + meter.height)).toBeLessThan(40);

    // The caret stays inside the visible text.
    const caret = (await page.locator('.ts-caret').boundingBox())!;
    expect(caret.y).toBeGreaterThanOrEqual(view.y);
    expect(caret.y + caret.height).toBeLessThanOrEqual(view.y + view.height);

    await page.screenshot({ path: testInfo.outputPath('window.png') });
  });
}

test('first line is undimmed, the caret is steady, and the paused note is centred in the window', async ({ page }, testInfo) => {
  await open(page);
  const surface = page.locator('.ts');

  // At the top of a chapter nothing has scrolled, so the top edge does not fade.
  await expect(surface).not.toHaveClass(/ts-scrolled/);
  await page.waitForTimeout(1500);
  const caretAnimation = await page
    .locator('.ts-caret')
    .evaluate((node) => getComputedStyle(node, '::before').animationName);
  expect(caretAnimation).toBe('none');
  await page.screenshot({ path: testInfo.outputPath('chapter-start.png') });

  // Once the text has moved up, the top edge fades.
  await page.keyboard.type(`${keysFor(sample.paragraphs.slice(0, 6).join(" "))} `, { delay: 8 }); // over two seconds, so speeds show
  await expect(surface).toHaveClass(/ts-scrolled/);
  await expect(stat(page, 'recent-speed')).toHaveText(/^\d+ wpm$/);
  await expect(stat(page, 'average-speed')).toHaveText(/^\d+ wpm$/);

  // Losing focus shows the paused note in the middle of the window.
  await page.locator('.ts-capture').blur();
  const hint = page.locator('.ts-hint');
  await expect(hint).toHaveCSS('opacity', '1');
  const window = page.viewportSize()!;
  const note = (await hint.boundingBox())!;
  expect(Math.abs(note.x + note.width / 2 - window.width / 2)).toBeLessThan(2);
  expect(Math.abs(note.y + note.height / 2 - window.height / 2)).toBeLessThan(2);
  await page.screenshot({ path: testInfo.outputPath('paused.png') });
});

test('settings open from the cog, hold rules and theme, and typing resumes on close', async ({ page }, testInfo) => {
  await open(page);
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  await expect(dialog).toBeHidden();

  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(dialog).toBeVisible();
  await expect(setting(page, 'Stop on error', 'Off')).toHaveAttribute('aria-pressed', 'true');

  await dialog.getByRole('button', { name: 'Night' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(dialog.getByRole('button', { name: 'Night' })).toHaveAttribute('aria-pressed', 'true');
  await page.waitForTimeout(300); // let colours settle for the picture
  await page.screenshot({ path: testInfo.outputPath('settings.png') });

  // Keys typed while settings are open do not reach the text.
  await page.keyboard.type('It');
  await expect(page.locator('.c.ok')).toHaveCount(0);

  await dialog.getByRole('button', { name: 'Close settings' }).click();
  await expect(dialog).toBeHidden();
  await page.keyboard.type('It');
  await expect(page.locator('.c.ok')).toHaveCount(2);

  // The choices survive a reload.
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
});

test('stop on error (word) keeps mistakes visible but refuses space until the word is right', async ({ page }) => {
  await open(page);
  await openSettings(page);
  await setting(page, 'Stop on error', 'Word').click();
  await closeSettings(page);

  const first = page.locator('.w').first(); // "It"
  await page.keyboard.type('Ix ');
  await expect(first.locator('.c.bad')).toHaveCount(1);
  await page.keyboard.type('is'); // still in the first word, so these are extra letters
  await expect(first.locator('.c.extra')).toHaveCount(2);

  for (let i = 0; i < 3; i++) await page.keyboard.press('Backspace');
  await page.keyboard.type('t is');
  await expect(first.locator('.c.ok')).toHaveCount(2);
  await expect(page.locator('.w').nth(1).locator('.c.ok')).toHaveCount(2);
});

test('strict space turns a stray space into a mistake', async ({ page }) => {
  await open(page);

  // Off by default: a space before the word starts is ignored.
  await page.keyboard.type(' It');
  await expect(page.locator('.w').first().locator('.c.ok')).toHaveCount(2);
  await expect(stat(page, 'accuracy')).toHaveText('100%');

  await page.getByRole('button', { name: 'Restart' }).click();
  await openSettings(page);
  await setting(page, 'Strict space', 'On').click();
  await closeSettings(page);

  await page.keyboard.type(' ');
  await expect(page.locator('.w').first().locator('.c').first()).toHaveClass('c bad');
});

test('spelling converts the text and restarts the chapter', async ({ page }) => {
  await open(page);
  const text = () => page.locator('.ts-scroll').innerText();
  expect(await text()).toContain('neighbourhood');

  await page.keyboard.type('It is');
  await openSettings(page);
  await setting(page, 'Spelling', 'American').click();
  await closeSettings(page);

  expect(await text()).toContain('neighborhood');
  expect(await text()).not.toContain('neighbourhood');
  await expect(page.locator('.c.ok')).toHaveCount(0); // the chapter started over

  // The choice survives a reload.
  await page.reload();
  await expect(page.locator('.ts-para').first()).toBeVisible();
  expect(await text()).toContain('neighborhood');
});

test('picking the spelling that is already chosen keeps what was typed', async ({ page }) => {
  await open(page);
  await page.keyboard.type('It is');
  await expect(page.locator('.c.ok')).toHaveCount(4);

  await openSettings(page);
  await expect(setting(page, 'Spelling', 'As printed')).toHaveAttribute('aria-pressed', 'true');
  await setting(page, 'Spelling', 'As printed').click();
  await closeSettings(page);

  await expect(page.locator('.c.ok')).toHaveCount(4); // the chapter did not start over
});

test('two open tabs do not undo each other’s settings', async ({ page, context }) => {
  await open(page);
  const other = await context.newPage();
  await open(other);

  await openSettings(other);
  await setting(other, 'Caret style', 'Block').click();
  await closeSettings(other);

  // The first tab still holds the settings it loaded before that change.
  await page.bringToFront();
  await openSettings(page);
  await setting(page, 'Smooth caret', 'Fast').click();
  await closeSettings(page);

  await other.reload();
  await expect(other.locator('.ts-para').first()).toBeVisible();
  await expect(other.locator('.ts')).toHaveAttribute('data-caret', 'block');
  await expect(other.locator('.ts')).toHaveAttribute('data-smooth', 'fast');
});

test('caret style and smooth caret change the caret', async ({ page }, testInfo) => {
  await open(page);
  const caret = page.locator('.ts-caret');
  const firstLetter = page.locator('.c').first();
  const shape = () =>
    caret.evaluate((node) => {
      const style = getComputedStyle(node, '::before');
      return { width: parseFloat(style.width), height: parseFloat(style.height) };
    });

  // Line: a thin bar. Smooth by default.
  expect((await shape()).width).toBeLessThanOrEqual(3);
  expect(await caret.evaluate((node) => getComputedStyle(node).transitionDuration)).not.toMatch(/^0s/);

  for (const style of ['Block', 'Underline', 'Box']) {
    await openSettings(page);
    await setting(page, 'Caret style', style).click();
    await closeSettings(page);
    await page.waitForTimeout(200);

    // These three span the letter that is due.
    const letter = (await firstLetter.boundingBox())!;
    expect(Math.abs((await shape()).width - letter.width)).toBeLessThan(1.5);
    await page.locator('.ts-view').screenshot({ path: testInfo.outputPath(`caret-${style.toLowerCase()}.png`) });
  }
  expect((await shape()).height).toBeGreaterThan(10); // box is letter height

  await openSettings(page);
  await setting(page, 'Smooth caret', 'Off').click();
  await page.screenshot({ path: testInfo.outputPath('settings-all.png') });
  await closeSettings(page);
  expect(await caret.evaluate((node) => getComputedStyle(node).transitionDuration)).toMatch(/^0s/);

  // Typing still lands every key with the new caret.
  await page.keyboard.type('It is a truth', { delay: 5 });
  await expect(page.locator('.c.ok')).toHaveCount(10);
});

test('freedom mode lets backspace re-enter a correct word', async ({ page }) => {
  await open(page);
  const first = page.locator('.w').first(); // "It"

  // Off by default: "It" is right, so Backspace at the next word does nothing.
  await page.keyboard.type('It ');
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Backspace');
  await expect(first.locator('.c.ok')).toHaveCount(2);

  await openSettings(page);
  await setting(page, 'Freedom mode', 'On').click();
  await closeSettings(page);

  await page.keyboard.press('Backspace'); // back into "It"
  await page.keyboard.press('Backspace'); // remove the "t"
  await expect(first.locator('.c.ok')).toHaveCount(1);
});

test('caret speed options change the glide time, and the caret can be hidden', async ({ page }) => {
  await open(page);
  const caret = page.locator('.ts-caret');
  const glide = () => caret.evaluate((node) => getComputedStyle(node).transitionDuration.split(',')[0].trim());

  expect(await glide()).toBe('0.1s'); // medium is the default
  for (const [label, expected] of [
    ['Slow', '0.15s'],
    ['Fast', '0.085s'],
    ['Off', '0s'],
  ]) {
    await openSettings(page);
    await setting(page, 'Smooth caret', label).click();
    await closeSettings(page);
    expect(await glide()).toBe(expected);
  }

  await expect(caret).toBeVisible();
  await openSettings(page);
  await setting(page, 'Caret style', 'Off').click();
  await closeSettings(page);
  await expect(caret).toBeHidden();

  // Typing works the same with no caret on the page.
  await page.keyboard.type('It is', { delay: 5 });
  await expect(page.locator('.c.ok')).toHaveCount(4);
});

/** How far up the text is drawn, in px (0 at the top of the chapter). */
const scrolledBy = (page: Page) =>
  page.locator('.ts-scroll').evaluate((node) => Math.abs(new DOMMatrixReadOnly(getComputedStyle(node).transform).m42));

test('scroll text is off by default, then lets the wheel move the text and typing brings it back', async ({ page }) => {
  await open(page);
  await page.locator('.ts-view').hover();

  // Off by default: the wheel does nothing.
  await page.mouse.wheel(0, 400);
  await page.waitForTimeout(250);
  expect(await scrolledBy(page)).toBe(0);

  await openSettings(page);
  await setting(page, 'Scroll text', 'On').click();
  await expect(setting(page, 'Type on jump back', 'On')).toHaveAttribute('aria-pressed', 'true'); // the default
  await setting(page, 'Type on jump back', 'Off').click();
  await closeSettings(page);
  await page.locator('.ts-view').hover();

  await page.mouse.wheel(0, 400);
  await expect.poll(() => scrolledBy(page)).toBe(400);
  await expect(page.locator('.c.ok')).toHaveCount(0); // scrolling types nothing

  // All the way down: the last paragraph is reachable and scrolling stops there.
  for (let i = 0; i < 40; i++) await page.mouse.wheel(0, 1000);
  await expect(page.locator('.ts-para')).toHaveCount(sample.paragraphs.length);
  await expect(page.locator('.ts-para').last()).toBeInViewport();
  const bottom = await scrolledBy(page);
  await page.mouse.wheel(0, 1000);
  await page.waitForTimeout(100);
  expect(await scrolledBy(page)).toBe(bottom);

  // And back up past the top stops at the first line.
  for (let i = 0; i < 60; i++) await page.mouse.wheel(0, -1000);
  await expect.poll(() => scrolledBy(page)).toBe(0);

  // Scroll away again, then press a key: the view returns to the caret and the key is not typed.
  await page.mouse.wheel(0, 900);
  await expect.poll(() => scrolledBy(page)).toBe(900);
  await page.keyboard.type('x');
  await expect.poll(() => scrolledBy(page)).toBe(0);
  await expect(page.locator('.c.ok, .c.bad')).toHaveCount(0);
  await expect(stat(page, 'accuracy')).toHaveText('100%');

  // Backspace and Enter also only bring the view back.
  await page.keyboard.type('It ');
  for (const key of ['Backspace', 'Enter']) {
    await page.mouse.wheel(0, 900);
    await expect.poll(() => scrolledBy(page)).toBe(900);
    await page.keyboard.press(key);
    await expect.poll(() => scrolledBy(page)).toBe(0);
  }

  // Once back, typing works as normal.
  await page.keyboard.type('is');
  await expect(page.locator('.c.ok')).toHaveCount(4);
  await expect(page.locator('.c.bad')).toHaveCount(0);

  // With "Type on jump back" on, the key that jumps back is typed too.
  await openSettings(page);
  await setting(page, 'Type on jump back', 'On').click();
  await closeSettings(page);
  await page.locator('.ts-view').hover();
  await page.mouse.wheel(0, 900);
  await expect.poll(() => scrolledBy(page)).toBe(900);
  await page.keyboard.type(' a');
  await expect.poll(() => scrolledBy(page)).toBe(0);
  await expect(page.locator('.c.ok')).toHaveCount(5);
});

test('turning scroll text on mid-chapter puts back paragraphs that had been removed', async ({ page }) => {
  await page.setViewportSize({ width: 700, height: 500 });
  await open(page);

  const half = Math.floor(sample.paragraphs.length / 2);
  const typed = sample.paragraphs.slice(0, half).join(' ');
  await page.keyboard.type(`${keysFor(typed)} `, { delay: 2 });
  const text = () => page.locator('.ts-scroll').innerText();
  expect(await text()).not.toContain('It is a truth universally acknowledged'); // removed far above

  await openSettings(page);
  await setting(page, 'Scroll text', 'On').click();
  await closeSettings(page);

  expect(await text()).toContain('It is a truth universally acknowledged');
  await expect(page.locator('.c.ok')).toHaveCount(typed.replace(/\s+/g, '').length); // still shown as typed

  // The caret has not moved on screen, and the top of the chapter can be scrolled to.
  const view = (await page.locator('.ts-view').boundingBox())!;
  const caret = (await page.locator('.ts-caret').boundingBox())!;
  expect(caret.y).toBeGreaterThanOrEqual(view.y);
  expect(caret.y + caret.height).toBeLessThanOrEqual(view.y + view.height);

  await page.locator('.ts-view').hover();
  for (let i = 0; i < 60; i++) await page.mouse.wheel(0, -1000);
  await expect.poll(() => scrolledBy(page)).toBe(0);
  await expect(page.locator('.ts-para').first()).toBeInViewport();
});

test('auto next paragraph moves on without space or Enter', async ({ page }) => {
  await open(page);
  await openSettings(page);
  await setting(page, 'Auto next paragraph', 'On').click();
  await closeSettings(page);

  // Three paragraphs typed with nothing pressed between them.
  const paragraphs = sample.paragraphs.slice(0, 3);
  await page.keyboard.type(paragraphs.map(keysFor).join(''), { delay: 3 });

  const letters = paragraphs.join('').replace(/\s+/g, '').length;
  await expect(page.locator('.c.ok')).toHaveCount(letters);
  await expect(page.locator('.c.bad, .c.extra, .c.miss, .w.flawed')).toHaveCount(0);
  await expect(page.locator('.ts-para').nth(3)).toHaveClass(/now/);
  await expect(stat(page, 'accuracy')).toHaveText('100%');

  // A space or Enter pressed out of habit changes nothing.
  await page.keyboard.press('Enter');
  await page.keyboard.type(' Mr.');
  await expect(page.locator('.ts-para').nth(3).locator('.w').first().locator('.c.ok')).toHaveCount(3);
  await expect(stat(page, 'accuracy')).toHaveText('100%');
});

for (const width of [1440, 1024]) {
  test(`every setting description fits on one line at ${width}px wide`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await open(page);
    await openSettings(page);

    // Check each description for every choice of "Stop on error", whose text changes.
    for (const option of ['Off', 'Word', 'Letter']) {
      await setting(page, 'Stop on error', option).click();
      const lines = await page.locator('.setting p').evaluateAll((notes) =>
        notes.map((note) => Math.round(note.getBoundingClientRect().height / parseFloat(getComputedStyle(note).lineHeight))),
      );
      expect(lines.length).toBe(17);
      expect(lines.every((count) => count === 1)).toBe(true);
    }
    await page.screenshot({ path: testInfo.outputPath('settings.png') });
  });
}

test('"Type on jump back" is nested under Scroll text and unavailable until scrolling is on', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page);
  await openSettings(page);

  const row = page.locator('.setting.nested', { hasText: 'Type on jump back' });
  await expect(row).toBeVisible();
  const parentLeft = (await page.getByRole('heading', { name: 'Scroll text' }).boundingBox())!.x;
  const childLeft = (await page.getByRole('heading', { name: 'Type on jump back' }).boundingBox())!.x;
  expect(childLeft).toBeGreaterThan(parentLeft + 10); // indented

  // Scroll text is off by default, so the nested setting cannot be changed.
  await expect(row).toHaveClass(/unavailable/);
  await expect(setting(page, 'Type on jump back', 'Off')).toBeDisabled();
  await expect(setting(page, 'Type on jump back', 'On')).toBeDisabled();
  await page.screenshot({ path: testInfo.outputPath('nested-off.png') });

  await setting(page, 'Scroll text', 'On').click();
  await expect(row).not.toHaveClass(/unavailable/);
  await setting(page, 'Type on jump back', 'Off').click();
  await expect(setting(page, 'Type on jump back', 'Off')).toHaveAttribute('aria-pressed', 'true');
  await page.screenshot({ path: testInfo.outputPath('nested-on.png') });

  // Switching the parent off greys it out again but keeps the choice.
  await setting(page, 'Scroll text', 'Off').click();
  await expect(setting(page, 'Type on jump back', 'Off')).toBeDisabled();
  await expect(setting(page, 'Type on jump back', 'Off')).toHaveAttribute('aria-pressed', 'true');
});

test('auto pause: idle time pauses, the next key resumes and is typed, and the pause is not timed', async ({ page }, testInfo) => {
  test.setTimeout(60_000);
  await open(page);
  const surface = page.locator('.ts');
  const hint = page.locator('.ts-hint');

  await openSettings(page);
  await expect(setting(page, 'Auto pause', '10 s')).toHaveAttribute('aria-pressed', 'true'); // the default
  await setting(page, 'Auto pause', '5 s').click();
  await closeSettings(page);

  // Nothing pauses before typing starts.
  await page.waitForTimeout(5600);
  await expect(surface).not.toHaveClass(/ts-paused/);

  // About 2.5 seconds of typing, then stop.
  await page.keyboard.type('It is a truth universally acknowledged,', { delay: 60 });
  await expect(surface).not.toHaveClass(/ts-paused/);
  const seconds = async () => {
    const [m, sec] = (await stat(page, 'time').innerText()).split(':').map(Number);
    return m * 60 + sec;
  };
  const atLastKey = await seconds();

  // With no key pressed, the timer keeps ticking second by second.
  await page.waitForTimeout(2000);
  const twoSecondsOn = await seconds();
  expect(twoSecondsOn - atLastKey).toBeGreaterThanOrEqual(1);
  expect(twoSecondsOn - atLastKey).toBeLessThanOrEqual(3);
  await page.waitForTimeout(2000);
  expect(await seconds()).toBeGreaterThan(twoSecondsOn);

  // When the pause appears it rewinds to the last key and stays there.
  await page.waitForTimeout(1600);
  await expect(surface).toHaveClass(/ts-paused/);
  await expect.poll(seconds).toBeLessThanOrEqual(atLastKey + 1);
  const frozen = await seconds();
  await page.waitForTimeout(1500);
  expect(await seconds()).toBe(frozen);
  await expect(surface).toHaveClass(/ts-focused/); // paused by idling, not by leaving
  await expect(hint).toHaveCSS('opacity', '1');
  await page.screenshot({ path: testInfo.outputPath('idle-paused.png') });

  // The next key resumes and is typed.
  const before = await page.locator('.c.ok').count();
  await page.keyboard.type(' that');
  await expect(surface).not.toHaveClass(/ts-paused/);
  await expect(page.locator('.c.ok')).toHaveCount(before + 4);

  // The 5.6 second break is not in the typing time: about 2.5 s typed, not 8.
  await expect(stat(page, 'time')).toHaveText(/^0:0[23]$/);
});

test('auto pause off: idling never pauses, but leaving the text still does', async ({ page }) => {
  test.setTimeout(60_000);
  await open(page);
  const surface = page.locator('.ts');

  await openSettings(page);
  await setting(page, 'Auto pause', '5 s').click();
  await setting(page, 'Auto pause', 'Off').click();
  await closeSettings(page);

  await page.keyboard.type('It is');
  await page.waitForTimeout(5600);
  await expect(surface).not.toHaveClass(/ts-paused/);

  await page.locator('.ts-capture').blur();
  await expect(surface).toHaveClass(/ts-paused/);
  await page.locator('.ts').click();
  await expect(surface).not.toHaveClass(/ts-paused/);
});

test('metrics settings change the recent speed label and the time format', async ({ page }) => {
  await open(page);
  const recentLabel = page.locator('.meter dt').first();
  await expect(recentLabel).toHaveText('Last minute');
  await page.keyboard.type('It is a truth universally acknowledged,', { delay: 60 });
  await expect(stat(page, 'time')).toHaveText(/^0:0[23]$/);

  await openSettings(page);
  await setting(page, 'Recent speed window', '15 s').click();
  await expect(recentLabel).toHaveText('Last 15 s');
  await setting(page, 'Recent speed window', '5 min').click();
  await expect(recentLabel).toHaveText('Last 5 min');
  await setting(page, 'Smallest time unit', 'Minutes').click();
  await expect(stat(page, 'time')).toHaveText('0 min');
  await closeSettings(page);

  // Both choices survive a reload.
  await page.reload();
  await expect(page.locator('.ts-para').first()).toBeVisible();
  await expect(page.locator('.meter dt').first()).toHaveText('Last 5 min');
  await expect(stat(page, 'time')).toHaveText('0 min');
});

test('with auto pause off the timer runs until you leave, then freezes where it is', async ({ page }) => {
  await open(page);
  await openSettings(page);
  await setting(page, 'Auto pause', 'Off').click();
  await closeSettings(page);

  const seconds = async () => {
    const [m, sec] = (await stat(page, 'time').innerText()).split(':').map(Number);
    return m * 60 + sec;
  };
  await expect(stat(page, 'time')).toHaveText('0:00');
  await page.waitForTimeout(1200);
  await expect(stat(page, 'time')).toHaveText('0:00'); // not started before the first key

  await page.keyboard.type('It');
  await page.waitForTimeout(3300);
  const running = await seconds();
  expect(running).toBeGreaterThanOrEqual(3); // ticking with no keys pressed

  await page.locator('.ts-capture').blur(); // leave the text
  await page.waitForTimeout(400);
  const left = await seconds();
  expect(left).toBeGreaterThanOrEqual(running); // no rewind on leaving
  await page.waitForTimeout(1600);
  expect(await seconds()).toBe(left); // frozen while away

  await page.locator('.ts').click();
  await page.waitForTimeout(1500);
  expect(await seconds()).toBe(left); // still stopped until the next key
  await page.keyboard.type(' is');
  await page.waitForTimeout(1300);
  expect(await seconds()).toBeGreaterThan(left);
});

test('a scroll bar shows while scrolling by hand and tracks the position', async ({ page }, testInfo) => {
  await open(page);
  const bar = page.locator('.ts-bar');
  const thumb = page.locator('.ts-thumb');
  await expect(bar).toHaveCSS('opacity', '0');

  await openSettings(page);
  await setting(page, 'Scroll text', 'On').click();
  await closeSettings(page);
  await page.locator('.ts-view').hover();
  await expect(bar).toHaveCSS('opacity', '0'); // not until you scroll

  await page.mouse.wheel(0, 300);
  await expect(bar).toHaveCSS('opacity', '1');
  const view = (await page.locator('.ts-view').boundingBox())!;
  const near = (await thumb.boundingBox())!;
  expect(near.x).toBeGreaterThan(view.x + view.width); // in the right-hand gutter
  expect(near.height).toBeLessThan(view.height);
  await page.screenshot({ path: testInfo.outputPath('scroll-bar.png') });

  // Further down, the thumb is lower; at the end it reaches the bottom of the track.
  for (let i = 0; i < 3; i++) await page.mouse.wheel(0, 400);
  await expect.poll(async () => (await thumb.boundingBox())!.y).toBeGreaterThan(near.y);
  for (let i = 0; i < 40; i++) await page.mouse.wheel(0, 1000);
  await expect
    .poll(async () => {
      const box = (await thumb.boundingBox())!;
      return Math.abs(box.y + box.height - (view.y + view.height));
    })
    .toBeLessThan(2);

  // It fades out shortly after scrolling stops.
  await expect(bar).toHaveCSS('opacity', '0', { timeout: 3000 });

  // And it goes away at once when a key jumps back to the caret.
  await page.mouse.wheel(0, -200);
  await expect(bar).toHaveCSS('opacity', '1');
  await page.keyboard.type('I');
  await expect(bar).not.toHaveClass(/ts-bar-on/);
  await expect(page.locator('.ts')).not.toHaveClass(/ts-bar-on/);
});

test('no empty space under the end of a chapter, when typing or scrolling', async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  await open(page);
  const view = page.locator('.ts-view');
  const lastPara = page.locator('.ts-para').last();
  /** Gap in px between the bottom of the last paragraph and the bottom of the window of text. */
  const gapBelow = async () => {
    const box = (await view.boundingBox())!;
    const last = (await lastPara.boundingBox())!;
    return box.y + box.height - (last.y + last.height);
  };

  // Type to within a few words of the end.
  const text = keysFor(sample.paragraphs.join(' '));
  await page.keyboard.type(text.slice(0, -30), { delay: 2 });
  await page.waitForTimeout(400);
  await expect(lastPara).toContainText('its solace was visiting and news.'); // the chapter's last paragraph
  expect(Math.abs(await gapBelow())).toBeLessThan(2); // last line sits on the bottom edge
  await expect(page.locator('.ts')).toHaveClass(/ts-at-end/); // and is not faded
  const caret = (await page.locator('.ts-caret').boundingBox())!;
  const box = (await view.boundingBox())!;
  expect(caret.y + caret.height).toBeLessThanOrEqual(box.y + box.height + 1);
  await page.screenshot({ path: testInfo.outputPath('chapter-end.png') });

  // The same holds when scrolling to the end by hand.
  await page.getByRole('button', { name: 'Restart' }).click();
  await openSettings(page);
  await setting(page, 'Scroll text', 'On').click();
  await closeSettings(page);
  await view.hover();
  for (let i = 0; i < 40; i++) await page.mouse.wheel(0, 1000);
  await expect(page.locator('.ts-para')).toHaveCount(sample.paragraphs.length);
  await expect.poll(async () => Math.abs(await gapBelow())).toBeLessThan(2);
  await expect(page.locator('.ts')).toHaveClass(/ts-at-end/);

  // Away from the end the bottom edge fades again.
  await page.mouse.wheel(0, -600);
  await expect(page.locator('.ts')).not.toHaveClass(/ts-at-end/);
});

test('the scroll bar can be dragged, and the track can be clicked', async ({ page }) => {
  await open(page);
  const thumb = page.locator('.ts-thumb');
  const bar = page.locator('.ts-bar');
  const centre = async () => {
    const box = (await thumb.boundingBox())!;
    return { x: box.x + box.width / 2, y: box.y + box.height / 2, height: box.height };
  };

  // With scrolling off, the bar cannot be reached.
  await expect(bar).toHaveCSS('pointer-events', 'none');

  await openSettings(page);
  await setting(page, 'Scroll text', 'On').click();
  await closeSettings(page);
  const track = (await bar.boundingBox())!;

  // Hovering the gutter shows the bar; dragging the thumb down scrolls the text.
  await page.mouse.move(track.x + track.width / 2, track.y + 10);
  await expect(bar).toHaveCSS('opacity', '1');
  const start = await centre();
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x, start.y + 120, { steps: 6 });
  await expect(page.locator('.ts')).toHaveClass(/ts-dragging/);
  const dragged = await scrolledBy(page);
  expect(dragged).toBeGreaterThan(200);
  // The thumb follows the pointer. (It may settle by a few px on grab, when the
  // rest of the chapter loads and its size becomes exact.)
  expect(Math.abs((await centre()).y - (start.y + 120))).toBeLessThan(8);

  // Dragging far past the bottom stops at the last line; back past the top stops at the first.
  await page.mouse.move(start.x, track.y + track.height + 400, { steps: 4 });
  const bottom = await scrolledBy(page);
  expect(bottom).toBeGreaterThan(dragged);
  await expect(page.locator('.ts')).toHaveClass(/ts-at-end/);
  await page.mouse.move(start.x, track.y - 400, { steps: 4 });
  expect(await scrolledBy(page)).toBe(0);
  await page.mouse.up();
  await expect(page.locator('.ts')).not.toHaveClass(/ts-dragging/);
  await expect(page.locator('.c.ok, .c.bad')).toHaveCount(0); // dragging types nothing

  // Clicking the track jumps there.
  await page.mouse.click(track.x + track.width / 2, track.y + track.height * 0.75);
  const jumped = await scrolledBy(page);
  expect(jumped).toBeGreaterThan(bottom * 0.5);
  expect(jumped).toBeLessThan(bottom);

  // A key still jumps back to the caret.
  await page.keyboard.type('It');
  await expect.poll(() => scrolledBy(page)).toBe(0);
});

test('click to jump: off by default, then a click on a later word skips to it', async ({ page }, testInfo) => {
  await open(page);
  const words = page.locator('.w');
  const caretX = async () => (await page.locator('.ts-caret').boundingBox())!.x;

  // Off by default: clicking a word does nothing.
  const startX = await caretX();
  await words.nth(6).click();
  expect(await caretX()).toBe(startX);
  await expect(page.locator('.c.skip')).toHaveCount(0);

  await openSettings(page);
  await setting(page, 'Click to jump', 'On').click();
  await closeSettings(page);

  // Type two words and half of the third, then jump to the seventh ("single").
  await page.keyboard.type('It is a truth un', { delay: 60 });
  await expect(stat(page, 'accuracy')).toHaveText('100%');
  await page.waitForTimeout(400);
  const before = Number((await stat(page, 'average-speed').innerText()).replace(/\D/g, '') || 0);

  await expect(words.nth(8)).toHaveText('single');
  await words.nth(8).click();
  await page.waitForTimeout(250);

  // The caret is at the clicked word, and the page still has the keyboard.
  const target = (await words.nth(8).boundingBox())!;
  expect(Math.abs((await caretX()) - target.x)).toBeLessThan(2);
  await expect(page.locator('.ts')).toHaveClass(/ts-focused/);

  // Words in between are marked skipped, not wrong; the half-typed one keeps its letters.
  await expect(words.nth(4).locator('.c.ok')).toHaveCount(2); // "un" of "universally,"
  await expect(words.nth(4)).toHaveClass(/flawed/);
  for (const i of [5, 6, 7]) await expect(words.nth(i).locator('.c.skip')).toHaveCount(await words.nth(i).locator('.c').count());
  await expect(page.locator('.c.bad')).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('jumped.png') });

  // Accuracy is untouched and speed did not go up because of the jump.
  await expect(stat(page, 'accuracy')).toHaveText('100%');
  const after = Number((await stat(page, 'average-speed').innerText()).replace(/\D/g, '') || 0);
  expect(after).toBeLessThanOrEqual(before);

  // Typing carries on from the new place.
  await page.keyboard.type('single man');
  await expect(words.nth(8).locator('.c.ok')).toHaveCount(6);
  await expect(words.nth(9).locator('.c.ok')).toHaveCount(3);

  // Clicking an earlier word does nothing.
  await page.waitForTimeout(300); // let the caret finish gliding
  const here = await caretX();
  await words.nth(1).click();
  expect(await caretX()).toBe(here);
});

test('tape: the text is one line that slides under a caret that stays put', async ({ page }, testInfo) => {
  test.setTimeout(90_000);
  await open(page);
  const caret = page.locator('.ts-caret');
  const view = page.locator('.ts-view');
  const caretAt = async () => (await caret.boundingBox())!;

  await page.keyboard.type('It is', { delay: 20 });
  await openSettings(page);
  await expect(setting(page, 'Tape step', 'Letter')).toBeDisabled(); // only for tape
  await setting(page, 'Moving text', 'Tape').click();
  await expect(setting(page, 'Tape step', 'Letter')).toBeEnabled();
  await expect(setting(page, 'Tape step', 'Letter')).toHaveAttribute('aria-pressed', 'true');
  await closeSettings(page);
  await expect(page.locator('.ts')).toHaveClass(/ts-tape/);
  await expect(page.locator('.c.ok')).toHaveCount(4); // what was typed is kept

  // One line: every word sits at the same height.
  const tops = await page.locator('.w').evaluateAll((words) => [...new Set(words.map((w) => Math.round(w.getBoundingClientRect().top)))]);
  expect(tops).toHaveLength(1);

  // The caret is a third of the way across and does not move as letters are typed.
  await page.waitForTimeout(300);
  const box = (await view.boundingBox())!;
  const start = await caretAt();
  expect(Math.abs(start.x - (box.x + box.width / 3))).toBeLessThan(3);
  await page.keyboard.type(' a truth universally acknowledged, that a single man', { delay: 20 });
  await page.waitForTimeout(300);
  const later = await caretAt();
  expect(Math.abs(later.x - start.x)).toBeLessThan(2);
  expect(Math.abs(later.y - start.y)).toBeLessThan(2);
  await expect(page.locator('.c.bad, .c.extra')).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('tape.png') });

  // Paragraph breaks work on the tape, and far-off paragraphs are dropped.
  const rest = keysFor(sample.paragraphs.slice(0, 12).join(' ')).slice('It is a truth universally acknowledged, that a single man'.length);
  await page.keyboard.type(`${rest} `, { delay: 2 });
  await page.waitForTimeout(300);
  await expect(page.locator('.c.bad, .c.extra, .w.flawed')).toHaveCount(0);
  await expect(stat(page, 'accuracy')).toHaveText('100%');
  expect(Math.abs((await caretAt()).x - start.x)).toBeLessThan(2);
  expect(await page.locator('.ts-para').count()).toBeLessThan(13);
  expect(await page.locator('.ts-scroll').innerText()).not.toContain('It is a truth universally');

  // Word step: the caret travels inside a word and returns to the same spot at each new word.
  await openSettings(page);
  await setting(page, 'Tape step', 'Word').click();
  await closeSettings(page);
  await page.waitForTimeout(300);
  const wordStart = await caretAt();
  expect(Math.abs(wordStart.x - start.x)).toBeLessThan(3);
  await page.keyboard.type('"Wh', { delay: 20 });
  await page.waitForTimeout(300);
  expect((await caretAt()).x).toBeGreaterThan(wordStart.x + 10);
  await page.keyboard.type('y, ', { delay: 20 });
  await page.waitForTimeout(300);
  expect(Math.abs((await caretAt()).x - wordStart.x)).toBeLessThan(3);
});

test('typewriter: the line being typed is held in the middle of the window', async ({ page }, testInfo) => {
  await open(page);
  const view = (await page.locator('.ts-view').boundingBox())!;
  const middle = view.y + view.height / 2;
  const caretMid = async () => {
    const box = (await page.locator('.ts-caret').boundingBox())!;
    return box.y + box.height / 2;
  };
  const lineHeight = (await page.locator('.ts-caret').boundingBox())!.height;

  await openSettings(page);
  await setting(page, 'Moving text', 'Typewriter').click();
  await expect(setting(page, 'Tape step', 'Letter')).toBeDisabled();
  await closeSettings(page);

  // After a few paragraphs the typed line sits within a line of the middle, and stays there.
  await page.keyboard.type(`${keysFor(sample.paragraphs.slice(0, 6).join(' '))} `, { delay: 2 });
  await page.waitForTimeout(400);
  const first = await caretMid();
  expect(Math.abs(first - middle)).toBeLessThan(lineHeight);
  await page.keyboard.type(`${keysFor(sample.paragraphs.slice(6, 10).join(' '))} `, { delay: 2 });
  await page.waitForTimeout(400);
  expect(Math.abs((await caretMid()) - first)).toBeLessThan(2);
  await page.screenshot({ path: testInfo.outputPath('typewriter.png') });

  // Off again: the line goes back to about a third of the way down.
  await openSettings(page);
  await setting(page, 'Moving text', 'Off').click();
  await closeSettings(page);
  await page.waitForTimeout(400);
  expect(await caretMid()).toBeLessThan(first - lineHeight / 2);
  await expect(page.locator('.c.bad')).toHaveCount(0);
});

test('tape margin moves where the caret is held, and is only available in tape', async ({ page }, testInfo) => {
  await open(page);
  const view = (await page.locator('.ts-view').boundingBox())!;
  const share = async () => ((await page.locator('.ts-caret').boundingBox())!.x - view.x) / view.width;

  await openSettings(page);
  await expect(setting(page, 'Tape margin', 'Third')).toBeDisabled();
  await setting(page, 'Moving text', 'Tape').click();
  await expect(setting(page, 'Tape margin', 'Third')).toHaveAttribute('aria-pressed', 'true'); // the default
  await closeSettings(page);
  await page.keyboard.type('It is a truth', { delay: 10 });
  await page.waitForTimeout(300);
  expect(await share()).toBeCloseTo(1 / 3, 2);

  for (const [label, expected] of [
    ['Centre', 0.5],
    ['Left', 0.14],
  ] as const) {
    await openSettings(page);
    await setting(page, 'Tape margin', label).click();
    await closeSettings(page);
    await page.waitForTimeout(300);
    expect(await share()).toBeCloseTo(expected, 2);
    await expect(page.locator('.c.ok')).toHaveCount(10); // typing is kept across the change
    await page.screenshot({ path: testInfo.outputPath(`tape-${label.toLowerCase()}.png`) });
  }

  // It still holds while typing on.
  await page.keyboard.type(' universally', { delay: 10 });
  await page.waitForTimeout(300);
  expect(await share()).toBeCloseTo(0.14, 2);
});
