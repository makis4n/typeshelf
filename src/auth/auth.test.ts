import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Auth, friendlyError, linkProblem, type AuthClient, type AuthState } from './auth';
import { accountConfig } from './config';

type Session = { user: { id: string; email?: string } } | null;

/** A stand-in for Supabase's auth client: records what was asked, answers as told. */
class FakeClient implements AuthClient {
  calls: { method: string; args: unknown[] }[] = [];
  /** The error the next call should come back with. */
  nextError: { message: string; code?: string; name?: string; status?: number } | null = null;
  /** The session a sign-up comes back with (null when a verification email was sent). */
  signUpSession: Session = null;
  unsubscribed = false;
  private callback: ((event: string, session: Session) => void) | undefined;

  emit(event: string, session: Session): void {
    this.callback?.(event, session);
  }

  private answer(method: string, ...args: unknown[]) {
    this.calls.push({ method, args });
    const error = this.nextError;
    this.nextError = null;
    return Promise.resolve({ error });
  }

  getSession = () => Promise.resolve({ data: { session: null }, error: null });
  onAuthStateChange = (callback: (event: string, session: Session) => void) => {
    this.callback = callback;
    return { data: { subscription: { unsubscribe: () => (this.unsubscribed = true) } } };
  };
  signInWithPassword = (credentials: unknown) => this.answer('signInWithPassword', credentials);
  signUp = async (credentials: unknown) => {
    const { error } = await this.answer('signUp', credentials);
    return { data: { session: error ? null : this.signUpSession }, error };
  };
  signInWithOAuth = (credentials: unknown) => this.answer('signInWithOAuth', credentials);
  resend = (credentials: unknown) => this.answer('resend', credentials);
  resetPasswordForEmail = (email: string, options?: unknown) => this.answer('resetPasswordForEmail', email, options);
  updateUser = (attributes: unknown) => this.answer('updateUser', attributes);
  signOut = (options?: unknown) => this.answer('signOut', options);
}

const HOME = 'https://typeshelf.example/';
const ANNA = { user: { id: 'user-anna', email: 'anna@example.test' } };

function setup() {
  const client = new FakeClient();
  const auth = new Auth(client, HOME);
  const seen: AuthState[] = [];
  auth.subscribe((state) => seen.push(state));
  /** Deliver an event the way the real client does, then let the deferred handling run. */
  const event = (name: string, session: Session) => {
    client.emit(name, session);
    vi.runAllTimers();
  };
  return { client, auth, seen, event };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('who is signed in', () => {
  it('starts out not knowing, then becomes a guest when there is no session', () => {
    const { auth, event } = setup();
    expect(auth.current()).toEqual({ status: 'loading' });
    event('INITIAL_SESSION', null);
    expect(auth.current()).toEqual({ status: 'guest' });
  });

  it('becomes signed in when a session arrives', () => {
    const { auth, event } = setup();
    event('INITIAL_SESSION', ANNA);
    expect(auth.current()).toEqual({ status: 'signed-in', user: { id: 'user-anna', email: 'anna@example.test' } });
  });

  it('handles an event only after the client has finished delivering it', () => {
    // Supabase holds a lock while it calls back; reacting inside the call can deadlock.
    const { client, auth } = setup();
    client.emit('SIGNED_IN', ANNA);
    expect(auth.current().status).toBe('loading');
    vi.runAllTimers();
    expect(auth.current().status).toBe('signed-in');
  });

  it('does not announce the same person twice (token refreshes, tab focus)', () => {
    const { seen, event } = setup();
    event('SIGNED_IN', ANNA);
    event('TOKEN_REFRESHED', ANNA);
    event('SIGNED_IN', ANNA);
    expect(seen).toHaveLength(1);
  });

  it('announces a different person', () => {
    const { seen, event } = setup();
    event('SIGNED_IN', ANNA);
    event('SIGNED_IN', { user: { id: 'user-ben', email: 'ben@example.test' } });
    expect(seen.map((state) => ('user' in state ? state.user.id : state.status))).toEqual(['user-anna', 'user-ben']);
  });

  it('goes back to guest on sign-out', () => {
    const { auth, event } = setup();
    event('SIGNED_IN', ANNA);
    event('SIGNED_OUT', null);
    expect(auth.current()).toEqual({ status: 'guest' });
  });

  it('stops listening when disposed', () => {
    const { client, auth } = setup();
    auth.dispose();
    expect(client.unsubscribed).toBe(true);
  });
});

describe('a session that could not be confirmed', () => {
  // The page loaded offline (or the auth server was down) with a session in storage whose
  // token had run out: the client reports "no session" although nobody signed out.
  const kept = { id: 'user-anna', email: 'anna@example.test' };

  function offlineSetup(stored: () => typeof kept | null) {
    const client = new FakeClient();
    const auth = new Auth(client, HOME, stored);
    const event = (name: string, session: Session) => {
      client.emit(name, session);
      vi.runAllTimers();
    };
    return { client, auth, event };
  }

  it('is still that reader’s, not a sign-out (N1)', () => {
    const { auth, event } = offlineSetup(() => kept);
    event('INITIAL_SESSION', null);
    expect(auth.current()).toEqual({ status: 'signed-in', user: kept });
  });

  it('carries on unchanged when the session is confirmed later', () => {
    const { auth, event } = offlineSetup(() => kept);
    const seen: AuthState[] = [];
    event('INITIAL_SESSION', null);
    auth.subscribe((state) => seen.push(state));
    event('TOKEN_REFRESHED', ANNA);
    expect(seen).toEqual([]);
    expect(auth.current().status).toBe('signed-in');
  });

  it('is a guest when the server has said no: the client then reports a sign-out', () => {
    const { auth, event } = offlineSetup(() => kept);
    event('INITIAL_SESSION', null);
    event('SIGNED_OUT', null);
    expect(auth.current()).toEqual({ status: 'guest' });
  });

  it('is a guest when there is nothing in storage', () => {
    const { auth, event } = offlineSetup(() => null);
    event('INITIAL_SESSION', null);
    expect(auth.current()).toEqual({ status: 'guest' });
  });

  it('is a guest after signing out here, even with the server unreachable', async () => {
    const { client, auth, event } = offlineSetup(() => kept);
    event('INITIAL_SESSION', null);
    client.nextError = { message: 'fetch failed', name: 'AuthRetryableFetchError', status: 0 };
    await auth.signOut();
    expect(auth.current()).toEqual({ status: 'guest' });
  });
});

describe('arriving through a password-reset link', () => {
  it('is signed in but owes a new password', () => {
    const { auth, event } = setup();
    event('PASSWORD_RECOVERY', ANNA);
    expect(auth.current().status).toBe('recovery');
  });

  it('still owes it after the other events that arrive around the link', () => {
    const { auth, event } = setup();
    event('SIGNED_IN', ANNA);
    event('PASSWORD_RECOVERY', ANNA);
    event('INITIAL_SESSION', ANNA);
    event('TOKEN_REFRESHED', ANNA);
    expect(auth.current().status).toBe('recovery');
  });

  it('is plainly signed in once the new password is saved', async () => {
    const { client, auth, event } = setup();
    event('PASSWORD_RECOVERY', ANNA);
    expect(await auth.setNewPassword('a-long-enough-password')).toEqual({ ok: true });
    expect(client.calls.at(-1)).toEqual({ method: 'updateUser', args: [{ password: 'a-long-enough-password' }] });
    expect(auth.current().status).toBe('signed-in');
  });

  it('stays owed when the server refuses the new password', async () => {
    const { client, auth, event } = setup();
    event('PASSWORD_RECOVERY', ANNA);
    client.nextError = { message: 'x', code: 'same_password' };
    const outcome = await auth.setNewPassword('a-long-enough-password');
    expect(outcome).toEqual({ ok: false, message: 'The new password has to be different from the old one.' });
    expect(auth.current().status).toBe('recovery');
  });

  it('refuses a short password without asking the server', async () => {
    const { client, auth } = setup();
    const outcome = await auth.setNewPassword('short');
    expect(outcome.ok).toBe(false);
    expect(client.calls).toEqual([]);
  });
});

describe('signing in and up', () => {
  it('signs in with the email trimmed and the password untouched', async () => {
    const { client, auth } = setup();
    expect(await auth.signIn('  anna@example.test ', ' spaced password ')).toEqual({ ok: true });
    expect(client.calls[0]).toEqual({
      method: 'signInWithPassword',
      args: [{ email: 'anna@example.test', password: ' spaced password ' }],
    });
  });

  it('explains a wrong password', async () => {
    const { client, auth } = setup();
    client.nextError = { message: 'Invalid login credentials', code: 'invalid_credentials' };
    expect(await auth.signIn('anna@example.test', 'nope')).toEqual({
      ok: false,
      message: 'That email and password do not match.',
    });
  });

  it('flags an unverified email, so the link can be offered again', async () => {
    const { client, auth } = setup();
    client.nextError = { message: 'Email not confirmed', code: 'email_not_confirmed' };
    const outcome = await auth.signIn('anna@example.test', 'password');
    expect(outcome).toMatchObject({ ok: false, unverified: true });
  });

  it('signs up and reports that a verification link was sent, pointing it back at this site', async () => {
    const { client, auth } = setup();
    expect(await auth.signUp('anna@example.test', 'a-long-enough-password')).toEqual({ ok: true, verify: true });
    expect(client.calls[0]!.args[0]).toMatchObject({ options: { emailRedirectTo: HOME } });
  });

  it('signs up straight in when the server asks for no verification', async () => {
    const { client, auth } = setup();
    client.signUpSession = ANNA;
    expect(await auth.signUp('anna@example.test', 'a-long-enough-password')).toEqual({ ok: true, verify: false });
  });

  it('refuses a short password at sign-up without asking the server', async () => {
    const { client, auth } = setup();
    const outcome = await auth.signUp('anna@example.test', '1234567');
    expect(outcome.ok).toBe(false);
    expect(client.calls).toEqual([]);
  });

  it('resends the verification link', async () => {
    const { client, auth } = setup();
    expect(await auth.resendVerification('anna@example.test')).toEqual({ ok: true });
    expect(client.calls[0]).toEqual({
      method: 'resend',
      args: [{ type: 'signup', email: 'anna@example.test', options: { emailRedirectTo: HOME } }],
    });
  });

  it('starts Google sign-in, coming back to this site', async () => {
    const { client, auth } = setup();
    expect(await auth.signInWithGoogle()).toEqual({ ok: true });
    expect(client.calls[0]).toEqual({
      method: 'signInWithOAuth',
      args: [{ provider: 'google', options: { redirectTo: HOME } }],
    });
  });

  it('says so when Google sign-in is not set up', async () => {
    const { client, auth } = setup();
    client.nextError = { message: 'Unsupported provider', code: 'provider_disabled' };
    expect(await auth.signInWithGoogle()).toEqual({ ok: false, message: 'Signing in with Google is not available yet.' });
  });

  it('asks for a password-reset link that comes back to this site', async () => {
    const { client, auth } = setup();
    expect(await auth.requestPasswordReset(' anna@example.test')).toEqual({ ok: true });
    expect(client.calls[0]).toEqual({
      method: 'resetPasswordForEmail',
      args: ['anna@example.test', { redirectTo: HOME }],
    });
  });
});

describe('signing out', () => {
  it('signs out on this browser only', async () => {
    const { client, auth, event } = setup();
    event('SIGNED_IN', ANNA);
    expect(await auth.signOut()).toEqual({ ok: true });
    expect(client.calls[0]).toEqual({ method: 'signOut', args: [{ scope: 'local' }] });
    expect(auth.current()).toEqual({ status: 'guest' });
  });

  it('is signed out here even when the server could not be told', async () => {
    const { client, auth, event } = setup();
    event('SIGNED_IN', ANNA);
    client.nextError = { message: 'fetch failed', name: 'AuthRetryableFetchError', status: 0 };
    const outcome = await auth.signOut();
    expect(outcome.ok).toBe(false);
    expect(auth.current()).toEqual({ status: 'guest' });
  });
});

describe('error sentences', () => {
  it('knows the common cases by their code', () => {
    expect(friendlyError({ message: 'x', code: 'over_email_send_rate_limit' })).toMatch(/Too many emails/);
    expect(friendlyError({ message: 'x', code: 'weak_password' })).toMatch(/at least 8 characters/);
    expect(friendlyError({ message: 'x', code: 'user_already_exists' })).toMatch(/Sign in instead/);
  });

  it('recognises a request that never got an answer', () => {
    expect(friendlyError({ message: 'Failed to fetch', name: 'AuthRetryableFetchError' })).toMatch(/Could not reach/);
  });

  it("falls back to the server's own words, or a plain sentence when there are none", () => {
    expect(friendlyError({ message: 'Something specific', code: 'never_heard_of_it' })).toBe('Something specific');
    expect(friendlyError({ message: '' })).toBe('Something went wrong. Try again.');
  });
});

describe('a link that comes back with a problem', () => {
  it('is nothing on an ordinary address', () => {
    expect(linkProblem({ hash: '', search: '' })).toBeNull();
    expect(linkProblem({ hash: '#access_token=abc&type=signup', search: '' })).toBeNull();
  });

  it('explains an expired link', () => {
    const hash = '#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired';
    expect(linkProblem({ hash, search: '' })).toMatch(/expired/);
  });

  it('never repeats text from the address, which anyone could have written', () => {
    const search = '?error=server_error&error_description=Your+account+is+locked.+Call+0800+123+456';
    expect(linkProblem({ hash: '', search })).toBe('That link did not work. Ask for a new one.');
    expect(linkProblem({ hash: `#${search.slice(1)}`, search: '' })).toBe('That link did not work. Ask for a new one.');
  });
});

describe('where the account service lives', () => {
  it('is off when either value is missing or blank', () => {
    expect(accountConfig({})).toBeNull();
    expect(accountConfig({ VITE_SUPABASE_URL: 'https://x.supabase.co' })).toBeNull();
    expect(accountConfig({ VITE_SUPABASE_ANON_KEY: 'key' })).toBeNull();
    expect(accountConfig({ VITE_SUPABASE_URL: '  ', VITE_SUPABASE_ANON_KEY: 'key' })).toBeNull();
  });

  it('is off when the address is not a web address', () => {
    expect(accountConfig({ VITE_SUPABASE_URL: 'not a url', VITE_SUPABASE_ANON_KEY: 'key' })).toBeNull();
    expect(accountConfig({ VITE_SUPABASE_URL: 'ftp://x.example', VITE_SUPABASE_ANON_KEY: 'key' })).toBeNull();
  });

  it('is on with both, trimmed', () => {
    expect(accountConfig({ VITE_SUPABASE_URL: ' https://x.supabase.co ', VITE_SUPABASE_ANON_KEY: ' key ' })).toEqual({
      url: 'https://x.supabase.co',
      anonKey: 'key',
    });
  });
});
