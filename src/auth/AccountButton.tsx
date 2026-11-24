import { createEffect, createSignal, Match, on, onCleanup, Show, Switch } from 'solid-js';
import { account } from '../account';
import type { SyncState } from '../sync/sync';
import { MIN_PASSWORD_LENGTH, type Outcome } from './auth';
import './account.css';

/** The steps a signed-out reader moves between. */
type Screen = 'sign-in' | 'sign-up' | 'verify' | 'forgot' | 'reset-sent';

const SYNC_NOTE: Record<SyncState, string> = {
  synced: 'Everything on this browser is saved to your account.',
  waiting: 'Saving your latest changes…',
  syncing: 'Saving your latest changes…',
  failed:
    'Could not reach your account. Your changes are safe on this browser and will be sent when the connection is back.',
};

/**
 * The account entry in the page header, and the modal behind it: sign in,
 * create an account, verify, reset a password, sign out.
 *
 * Shows nothing at all when accounts are switched off.
 */
export function AccountButton(props: {
  /** Called when the modal closes, so the keyboard can go back to the text. */
  onClose: () => void;
}) {
  const [view, setView] = createSignal(account.view());
  onCleanup(account.subscribe(setView));

  const [screen, setScreen] = createSignal<Screen>('sign-in');
  const [email, setEmail] = createSignal('');
  const [password, setPassword] = createSignal('');
  const [problem, setProblem] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);
  let dialog!: HTMLDialogElement;

  const status = () => view().auth.status;
  const signedInEmail = () => {
    const auth = view().auth;
    return 'user' in auth ? auth.user.email : '';
  };

  const open = () => {
    if (!dialog.open) dialog.showModal();
  };
  const close = () => {
    dialog.close();
    props.onClose();
  };
  const go = (next: Screen) => {
    setProblem(null);
    setPassword('');
    setScreen(next);
  };

  // A reset link lands here signed in and owing a new password: ask for it straight away.
  createEffect(
    on(status, (now, before) => {
      if (now === 'recovery') open();
      // Signing in from the modal is done; get out of the way.
      if (now === 'signed-in' && before === 'guest' && dialog.open) close();
      // Signed out: the next visit to the modal starts from the beginning.
      if (now === 'guest' && (before === 'signed-in' || before === 'recovery')) go('sign-in');
    }),
  );

  // An emailed link that did not work is explained as soon as the page opens.
  createEffect(() => {
    const notice = view().notice;
    if (!notice) return;
    setProblem(notice);
    account.dismissNotice();
    open();
  });

  /** Run one request: one at a time, with any failure shown in the modal. */
  const run = async (request: () => Promise<Outcome>, then?: () => void) => {
    if (busy()) return;
    setBusy(true);
    setProblem(null);
    try {
      const outcome = await request();
      if (outcome.ok) then?.();
      else setProblem(outcome.message);
    } catch {
      setProblem('Something went wrong. Try again.');
    } finally {
      setBusy(false);
    }
  };

  const submit = (handler: () => void) => (event: SubmitEvent) => {
    event.preventDefault();
    handler();
  };

  const signIn = () =>
    run(async () => {
      const outcome = await account.signIn(email(), password());
      // Not verified yet: offer the link again instead of a dead end.
      if (!outcome.ok && outcome.unverified) setScreen('verify');
      return outcome;
    }, () => setPassword(''));

  const signUp = () =>
    run(async () => {
      const outcome = await account.signUp(email(), password());
      if (outcome.ok && outcome.verify) go('verify');
      return outcome;
    }, () => setPassword(''));

  const title = () => {
    if (status() === 'recovery') return 'Choose a new password';
    if (status() === 'signed-in') return 'Your account';
    return {
      'sign-in': 'Sign in',
      'sign-up': 'Create an account',
      verify: 'Check your inbox',
      forgot: 'Reset your password',
      'reset-sent': 'Check your inbox',
    }[screen()];
  };

  const EmailField = () => (
    <label>
      Email
      <input
        type="email"
        name="email"
        autocomplete="email"
        required
        value={email()}
        onInput={(event) => setEmail(event.currentTarget.value)}
      />
    </label>
  );

  const PasswordField = (field: { label: string; fresh: boolean }) => (
    <label>
      {field.label}
      <input
        type="password"
        name="password"
        autocomplete={field.fresh ? 'new-password' : 'current-password'}
        minLength={field.fresh ? MIN_PASSWORD_LENGTH : undefined}
        required
        value={password()}
        onInput={(event) => setPassword(event.currentTarget.value)}
      />
    </label>
  );

  const Google = () => (
    <>
      <div class="or">or</div>
      <button type="button" class="wide" disabled={busy()} onClick={() => run(() => account.signInWithGoogle())}>
        Continue with Google
      </button>
    </>
  );

  return (
    <Show when={view().available}>
      <Show when={status() !== 'loading'}>
        <Show
          when={status() === 'guest'}
          fallback={
            <button type="button" class="icon" aria-label="Account" title={signedInEmail()} onClick={open}>
              {/* Person outline from the Lucide icon set (ISC licence). */}
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
                <path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" />
                <circle cx="12" cy="7" r="4" />
              </svg>
            </button>
          }
        >
          <button type="button" onClick={open}>
            Sign in
          </button>
        </Show>
      </Show>

      <dialog
        ref={dialog}
        class="settings account"
        aria-labelledby="account-title"
        on:close={() => props.onClose()}
        onClick={(event) => {
          // A click on the dimmed area outside the panel lands on the dialog itself.
          if (event.target === dialog) close();
        }}
      >
        <div class="panel">
          <header>
            <h2 id="account-title">{title()}</h2>
            <button type="button" class="icon" aria-label="Close account" onClick={close}>
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

          <Show when={problem()}>
            <p class="problem" role="alert">
              {problem()}
            </p>
          </Show>

          <Switch>
            <Match when={status() === 'recovery'}>
              <form onSubmit={submit(() => run(() => account.setNewPassword(password()), () => (setPassword(''), close())))}>
                <p>Pick a new password for {signedInEmail()}.</p>
                <PasswordField label={`New password (at least ${MIN_PASSWORD_LENGTH} characters)`} fresh />
                <button type="submit" class="primary" disabled={busy()}>
                  Save password
                </button>
              </form>
            </Match>

            <Match when={status() === 'signed-in'}>
              <div class="stack">
                <p class="who">{signedInEmail()}</p>
                <p data-sync={view().sync ?? 'synced'}>{SYNC_NOTE[view().sync ?? 'synced']}</p>
                <button type="button" class="wide" disabled={busy()} onClick={() => run(() => account.signOut(), close)}>
                  Sign out
                </button>
              </div>
            </Match>

            <Match when={screen() === 'sign-in'}>
              <form onSubmit={submit(signIn)}>
                <p>Your place in every book, your stats and your settings, on any device.</p>
                <EmailField />
                <PasswordField label="Password" fresh={false} />
                <button type="submit" class="primary" disabled={busy()}>
                  Sign in
                </button>
                <div class="links">
                  <button type="button" class="link" onClick={() => go('sign-up')}>
                    Create an account
                  </button>
                  <button type="button" class="link" onClick={() => go('forgot')}>
                    Forgot password?
                  </button>
                </div>
                <Google />
              </form>
            </Match>

            <Match when={screen() === 'sign-up'}>
              <form onSubmit={submit(signUp)}>
                <p>What you have typed on this browser so far is kept and added to your account.</p>
                <EmailField />
                <PasswordField label={`Password (at least ${MIN_PASSWORD_LENGTH} characters)`} fresh />
                <button type="submit" class="primary" disabled={busy()}>
                  Create account
                </button>
                <div class="links">
                  <button type="button" class="link" onClick={() => go('sign-in')}>
                    I already have an account
                  </button>
                </div>
                <Google />
              </form>
            </Match>

            <Match when={screen() === 'verify'}>
              <div class="stack">
                <p>
                  We sent a link to <strong>{email()}</strong>. Open it to verify your email, then sign in. If you
                  already have an account with this email, just sign in.
                </p>
                <button
                  type="button"
                  class="wide"
                  disabled={busy()}
                  onClick={() => run(() => account.resendVerification(email()))}
                >
                  Send the link again
                </button>
                <button type="button" class="link" onClick={() => go('sign-in')}>
                  Back to sign in
                </button>
              </div>
            </Match>

            <Match when={screen() === 'forgot'}>
              <form onSubmit={submit(() => run(() => account.requestPasswordReset(email()), () => go('reset-sent')))}>
                <p>Enter your email and we will send a link for choosing a new password.</p>
                <EmailField />
                <button type="submit" class="primary" disabled={busy()}>
                  Send reset link
                </button>
                <div class="links">
                  <button type="button" class="link" onClick={() => go('sign-in')}>
                    Back to sign in
                  </button>
                </div>
              </form>
            </Match>

            <Match when={screen() === 'reset-sent'}>
              <div class="stack">
                <p>
                  If there is an account for <strong>{email()}</strong>, a link for choosing a new password is on its
                  way.
                </p>
                <button type="button" class="link" onClick={() => go('sign-in')}>
                  Back to sign in
                </button>
              </div>
            </Match>
          </Switch>
        </div>
      </dialog>
    </Show>
  );
}
