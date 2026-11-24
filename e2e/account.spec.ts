/**
 * Accounts in the browser.
 *
 * The first test runs on the ordinary guest-only site. The rest run on a
 * second site built with accounts switched on and pointed at the local
 * Supabase stack; they are skipped, with the reason, when that stack is not
 * running (`pnpm db:start`). Emails are caught by the stack's own test inbox
 * and read from there.
 */

import { expect, test, type Page } from '@playwright/test';
import { ACCOUNT_PORT } from '../playwright.config';
import { admin, visitor, type Stack } from '../supabase/tests/stack';

const stack: Stack | undefined = process.env.TYPESHELF_E2E_STACK
  ? (JSON.parse(process.env.TYPESHELF_E2E_STACK) as Stack)
  : undefined;
const SITE = `http://localhost:${ACCOUNT_PORT}/`;

const newEmail = (label: string) => `${label}-${crypto.randomUUID()}@example.test`;
const newPassword = () => `pw-${crypto.randomUUID()}`;

/** Wait until the text can be typed on, which is the moment accounts are allowed to start loading. */
async function typingReady(page: Page): Promise<void> {
  await expect(page.locator('.surface .w').first()).toBeVisible();
}

/** The newest link emailed to this address, straight from the local stack's test inbox. */
async function emailedLink(to: string): Promise<string> {
  let link: string | undefined;
  await expect
    .poll(
      async () => {
        const found = await fetch(`${stack!.mailUrl}/api/v1/search?query=${encodeURIComponent(`to:${to}`)}`);
        const { messages } = (await found.json()) as { messages: { ID: string }[] };
        if (messages.length === 0) return false;
        const message = await fetch(`${stack!.mailUrl}/api/v1/message/${messages[0]!.ID}`);
        const { Text } = (await message.json()) as { Text: string };
        link = /https?:\/\/\S*\/auth\/v1\/verify\S*/.exec(Text)?.[0];
        return link !== undefined;
      },
      { message: `an email to ${to}`, timeout: 15_000 },
    )
    .toBe(true);
  return link!;
}

/** Make an account that is already verified, without going through the inbox. */
async function verifiedAccount(label: string): Promise<{ id: string; email: string; password: string }> {
  const email = newEmail(label);
  const password = newPassword();
  const { data, error } = await admin(stack!).auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw error;
  return { id: data.user.id, email, password };
}

async function signIn(page: Page, email: string, password: string): Promise<void> {
  await page.getByRole('button', { name: 'Sign in', exact: true }).first().click();
  const dialog = page.getByRole('dialog', { name: 'Sign in' });
  await dialog.getByLabel('Email').fill(email);
  await dialog.getByLabel('Password').fill(password);
  await dialog.getByRole('button', { name: 'Sign in' }).click();
}

test('with no account service configured there is no sign-in and nothing is loaded for it', async ({ page }) => {
  const scripts: string[] = [];
  page.on('request', (request) => scripts.push(request.url()));
  await page.goto('/');
  await typingReady(page);
  await page.keyboard.type('It is');
  // Longer than accounts would take to load if they were going to.
  await page.waitForTimeout(2500);
  await expect(page.getByRole('button', { name: 'Sign in' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Account', exact: true })).toHaveCount(0);
  expect(scripts.filter((url) => /@supabase|supabase-js|:54321/i.test(url))).toEqual([]);
  expect(await page.evaluate(() => indexedDB.databases().then((all) => all.map((db) => db.name)))).not.toContain(
    'typeshelf-user',
  );
});

test.describe('with accounts switched on', () => {
  test.skip(!stack, `needs the local Supabase stack: ${process.env.TYPESHELF_E2E_STACK_MISSING}`);

  test('the account library is a file of its own, fetched by the page after it has started', async ({ page }) => {
    const scripts: string[] = [];
    page.on('request', (request) => {
      if (request.resourceType() === 'script') scripts.push(request.url());
    });
    await page.goto(SITE);
    await typingReady(page);
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();

    // The scripts the page itself names are the first load; the library is not in them.
    const first = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>('script[src], link[rel=modulepreload]')].map(
        (el) => (el as HTMLScriptElement).src || (el as HTMLLinkElement).href,
      ),
    );
    expect(first.length).toBeGreaterThan(0);
    const carriesLibrary = async (url: string) => (await (await page.request.get(url)).text()).includes('GoTrueClient');
    for (const url of first) expect(await carriesLibrary(url), url).toBe(false);
    // It arrives separately, asked for by the running page.
    const later = scripts.filter((url) => !first.includes(url));
    const found = await Promise.all(later.map(carriesLibrary));
    expect(found).toContain(true);

    // Typing works meanwhile, and keys typed into the modal do not reach the text.
    await page.keyboard.type('It ');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.getByRole('dialog', { name: 'Sign in' }).getByLabel('Email').fill('is a truth');
    await page.getByRole('button', { name: 'Close account' }).click();
    await page.keyboard.type('is');
    await expect(page.locator('.surface .w').nth(1)).toHaveText(/is/);
  });

  test('sign up, verify by the emailed link, and end up signed in', async ({ page }, testInfo) => {
    const email = newEmail('signup');
    const password = newPassword();
    await page.goto(SITE);
    await typingReady(page);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.screenshot({ path: testInfo.outputPath('sign-in.png') });
    await page.getByRole('button', { name: 'Create an account' }).click();

    const create = page.getByRole('dialog', { name: 'Create an account' });
    await create.getByLabel('Email').fill(email);
    await create.getByLabel(/Password/).fill(password);
    await create.getByRole('button', { name: 'Create account' }).click();

    const inbox = page.getByRole('dialog', { name: 'Check your inbox' });
    await expect(inbox).toContainText(email);
    await page.screenshot({ path: testInfo.outputPath('check-inbox.png') });

    // Not verified yet: signing in is refused and the link is offered again.
    await inbox.getByRole('button', { name: 'Back to sign in' }).click();
    const again = page.getByRole('dialog', { name: 'Sign in' });
    await again.getByLabel('Email').fill(email);
    await again.getByLabel('Password').fill(password);
    await again.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('dialog', { name: 'Check your inbox' }).getByRole('alert')).toContainText(
      'not verified yet',
    );

    await page.goto(await emailedLink(email));
    await typingReady(page);
    await page.getByRole('button', { name: 'Account', exact: true }).click();
    const mine = page.getByRole('dialog', { name: 'Your account' });
    await expect(mine).toContainText(email);
    await expect(mine.locator('[data-sync]')).toHaveAttribute('data-sync', 'synced');
    await page.screenshot({ path: testInfo.outputPath('account.png') });

    // The link's token is gone from the address bar.
    expect(page.url()).not.toContain('code=');

    await mine.getByRole('button', { name: 'Sign out' }).click();
    await expect(page.getByRole('dialog')).toBeHidden();
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
    // Signed out for good: a reload does not bring the session back.
    await page.reload();
    await typingReady(page);
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
  });

  test('an emailed link opened in a different browser signs nobody in, and says what to do', async ({ page, browser }) => {
    const email = newEmail('elsewhere');
    const password = newPassword();
    await page.goto(SITE);
    await typingReady(page);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.getByRole('button', { name: 'Create an account' }).click();
    const create = page.getByRole('dialog', { name: 'Create an account' });
    await create.getByLabel('Email').fill(email);
    await create.getByLabel(/Password/).fill(password);
    await create.getByRole('button', { name: 'Create account' }).click();
    await expect(page.getByRole('dialog', { name: 'Check your inbox' })).toBeVisible();

    // The link is opened on another device.
    const other = await (await browser.newContext()).newPage();
    await other.goto(await emailedLink(email));
    const dialog = other.getByRole('dialog', { name: 'Sign in' });
    await expect(dialog.getByRole('alert')).toContainText('browser where you asked for it');
    await expect(other.getByRole('button', { name: 'Account', exact: true })).toHaveCount(0);
    expect(other.url()).not.toContain('code=');

    // The email is verified all the same, so signing in with the password works there.
    await dialog.getByLabel('Email').fill(email);
    await dialog.getByLabel('Password').fill(password);
    await dialog.getByRole('button', { name: 'Sign in' }).click();
    await expect(other.getByRole('button', { name: 'Account', exact: true })).toBeVisible();
  });

  test('a setting arriving from another device does not restart a chapter being typed', async ({ page }) => {
    const user = await verifiedAccount('spelling');
    await page.goto(SITE);
    await typingReady(page);
    await signIn(page, user.email, user.password);
    await expect(page.getByRole('button', { name: 'Account', exact: true })).toBeVisible();
    await page.keyboard.type('It is a truth ');
    // "It is a truth": ten letters typed correctly.
    await expect(page.locator('.c.ok')).toHaveCount(10);

    // Another device changes the spelling and the caret; this tab catches up when it comes back into view.
    const { error } = await admin(stack!)
      .from('user_settings')
      .upsert({ user_id: user.id, data: { spelling: 'american', caretStyle: 'block' }, updated_at: new Date(Date.now() + 2000).toISOString(), device_id: 'phone' });
    expect(error).toBeNull();
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));

    // The caret changes at once; the typed text stays where it was.
    await expect(page.locator('.surface')).toHaveAttribute('data-caret', 'block');
    await expect(page.locator('.c.ok')).toHaveCount(10);
    // The new spelling is chosen in settings and takes effect at the next start.
    await page.getByRole('button', { name: 'Settings' }).click();
    await expect(
      page.getByRole('dialog', { name: 'Settings' }).getByRole('group', { name: 'Spelling' }).getByRole('button', { name: 'American' }),
    ).toHaveAttribute('aria-pressed', 'true');
  });

  test('a wrong password is refused with a plain sentence', async ({ page }) => {
    const user = await verifiedAccount('wrong');
    await page.goto(SITE);
    await typingReady(page);
    await signIn(page, user.email, 'not-the-password');
    await expect(page.getByRole('dialog', { name: 'Sign in' }).getByRole('alert')).toHaveText(
      'That email and password do not match.',
    );
    await expect(page.getByRole('button', { name: 'Account', exact: true })).toHaveCount(0);
  });

  test('a forgotten password is reset through the emailed link', async ({ page }) => {
    const user = await verifiedAccount('reset');
    const replacement = newPassword();
    await page.goto(SITE);
    await typingReady(page);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.getByRole('button', { name: 'Forgot password?' }).click();
    const forgot = page.getByRole('dialog', { name: 'Reset your password' });
    await forgot.getByLabel('Email').fill(user.email);
    await forgot.getByRole('button', { name: 'Send reset link' }).click();
    await expect(page.getByRole('dialog', { name: 'Check your inbox' })).toContainText(user.email);

    // The link opens the page with the new-password form already up.
    await page.goto(await emailedLink(user.email));
    const choose = page.getByRole('dialog', { name: 'Choose a new password' });
    await expect(choose).toBeVisible();
    await choose.getByLabel(/New password/).fill('short');
    await choose.getByRole('button', { name: 'Save password' }).click();
    await expect(choose).toBeVisible(); // too short: the form does not go through
    await choose.getByLabel(/New password/).fill(replacement);
    await choose.getByRole('button', { name: 'Save password' }).click();
    await expect(choose).toBeHidden();

    await page.getByRole('button', { name: 'Account', exact: true }).click();
    await page.getByRole('dialog', { name: 'Your account' }).getByRole('button', { name: 'Sign out' }).click();

    // The old password no longer works; the new one does.
    await signIn(page, user.email, user.password);
    await expect(page.getByRole('dialog', { name: 'Sign in' }).getByRole('alert')).toBeVisible();
    await page.getByRole('dialog', { name: 'Sign in' }).getByLabel('Password').fill(replacement);
    await page.getByRole('dialog', { name: 'Sign in' }).getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('button', { name: 'Account', exact: true })).toBeVisible();
  });

  test('a link carrying someone else’s sign-in does not sign this browser in as them', async ({ page }) => {
    // The attacker signs in to their own account elsewhere and builds a link from their own tokens.
    const attacker = await verifiedAccount('attacker');
    const elsewhere = visitor(stack!);
    const { data, error } = await elsewhere.auth.signInWithPassword({ email: attacker.email, password: attacker.password });
    if (error || !data.session) throw error ?? new Error('no session');
    const crafted =
      `${SITE}#access_token=${data.session.access_token}&refresh_token=${data.session.refresh_token}` +
      `&expires_in=3600&expires_at=${data.session.expires_at}&token_type=bearer&type=magiclink`;

    // The victim, a guest who has changed a setting, opens it.
    await page.goto(SITE);
    await typingReady(page);
    await page.getByRole('button', { name: 'Settings' }).click();
    await page
      .getByRole('dialog', { name: 'Settings' })
      .getByRole('group', { name: 'Caret style' })
      .getByRole('button', { name: 'Box' })
      .click();
    await page.getByRole('button', { name: 'Close settings' }).click();
    await page.goto(crafted);
    await page.reload();
    await typingReady(page);

    // Still a guest, the tokens are gone from the address, and nothing of theirs went to the attacker's account.
    await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Account', exact: true })).toHaveCount(0);
    expect(page.url()).not.toContain('access_token');
    await page.waitForTimeout(1500);
    const leaked = await admin(stack!).from('user_settings').select('data').eq('user_id', attacker.id);
    expect(leaked.data).toEqual([]);
  });

  test('a link problem never shows text taken from the address', async ({ page }) => {
    await page.goto(`${SITE}#error=server_error&error_description=Your+account+is+locked.+Call+0800+123+456`);
    const alert = page.getByRole('dialog', { name: 'Sign in' }).getByRole('alert');
    await expect(alert).toBeVisible();
    await expect(alert).not.toContainText('0800');
  });

  test('an expired link is explained instead of failing silently', async ({ page }) => {
    await page.goto(`${SITE}#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid`);
    await expect(page.getByRole('dialog', { name: 'Sign in' }).getByRole('alert')).toContainText('expired');
  });

  test('a setting changed in one browser arrives in another after signing in', async ({ browser }) => {
    test.setTimeout(60_000);
    const user = await verifiedAccount('settings');

    // Browser one: sign in, then change a setting.
    const one = await (await browser.newContext()).newPage();
    await one.goto(SITE);
    await typingReady(one);
    await signIn(one, user.email, user.password);
    await expect(one.getByRole('button', { name: 'Account', exact: true })).toBeVisible();
    await one.getByRole('button', { name: 'Settings' }).click();
    await one
      .getByRole('dialog', { name: 'Settings' })
      .getByRole('group', { name: 'Caret style' })
      .getByRole('button', { name: 'Block' })
      .click();
    await one.getByRole('button', { name: 'Close settings' }).click();

    // It reaches the account with the next batch, with nobody pressing anything.
    await expect
      .poll(
        async () => {
          const { data } = await admin(stack!).from('user_settings').select('data').eq('user_id', user.id).maybeSingle();
          return (data?.data as { caretStyle?: string } | undefined)?.caretStyle;
        },
        { timeout: 25_000 },
      )
      .toBe('block');

    // Browser two: a fresh guest with default settings signs in and gets the account's.
    const two = await (await browser.newContext()).newPage();
    await two.goto(SITE);
    await typingReady(two);
    await expect(two.locator('.surface')).toHaveAttribute('data-caret', 'line');
    await signIn(two, user.email, user.password);
    await expect(two.locator('.surface')).toHaveAttribute('data-caret', 'block');
    // And it sticks on this browser.
    await two.reload();
    await typingReady(two);
    await expect(two.locator('.surface')).toHaveAttribute('data-caret', 'block');
  });

  test('a guest who becomes a new account keeps the settings they chose as a guest', async ({ page }) => {
    const user = await verifiedAccount('guest-settings');
    await page.goto(SITE);
    await typingReady(page);
    await page.getByRole('button', { name: 'Settings' }).click();
    await page
      .getByRole('dialog', { name: 'Settings' })
      .getByRole('group', { name: 'Caret style' })
      .getByRole('button', { name: 'Underline' })
      .click();
    await page.getByRole('button', { name: 'Close settings' }).click();

    await signIn(page, user.email, user.password);
    await expect(page.getByRole('button', { name: 'Account', exact: true })).toBeVisible();
    await expect
      .poll(async () => {
        const { data } = await admin(stack!).from('user_settings').select('data').eq('user_id', user.id).maybeSingle();
        return (data?.data as { caretStyle?: string } | undefined)?.caretStyle;
      })
      .toBe('underline');
    await expect(page.locator('.surface')).toHaveAttribute('data-caret', 'underline');
  });
});
