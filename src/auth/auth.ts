/**
 * Signing in and out. Wraps the part of the Supabase auth client the app
 * uses, turns its events into one small state, and its errors into
 * sentences a reader can act on.
 *
 * The client is passed in, so this file does not load the Supabase library
 * itself, and tests can hand it a stand-in.
 */

export interface AuthUser {
  id: string;
  email: string;
}

export type AuthState =
  /** Still finding out whether someone is signed in. */
  | { status: 'loading' }
  | { status: 'guest' }
  | { status: 'signed-in'; user: AuthUser }
  /** Arrived through a password-reset link: signed in, and owed a new password. */
  | { status: 'recovery'; user: AuthUser };

export type Outcome =
  | { ok: true }
  | {
      ok: false;
      message: string;
      /** The email has not been verified yet, so offering to resend the link makes sense. */
      unverified?: boolean;
    };

export type SignUpOutcome =
  /** `verify` is true when a link was emailed and must be followed before signing in. */
  { ok: true; verify: boolean } | { ok: false; message: string };

interface ErrorLike {
  message: string;
  code?: string;
  name?: string;
  status?: number;
}

interface SessionLike {
  user: { id: string; email?: string };
}

type Failable = Promise<{ error: ErrorLike | null }>;

/** The part of Supabase's auth client used here. */
export interface AuthClient {
  getSession(): Promise<{ data: { session: SessionLike | null }; error: ErrorLike | null }>;
  onAuthStateChange(callback: (event: string, session: SessionLike | null) => void): {
    data: { subscription: { unsubscribe(): void } };
  };
  signInWithPassword(credentials: { email: string; password: string }): Failable;
  signUp(credentials: {
    email: string;
    password: string;
    options?: { emailRedirectTo?: string };
  }): Promise<{ data: { session: SessionLike | null }; error: ErrorLike | null }>;
  signInWithOAuth(credentials: { provider: 'google'; options?: { redirectTo?: string } }): Failable;
  resend(credentials: { type: 'signup'; email: string; options?: { emailRedirectTo?: string } }): Failable;
  resetPasswordForEmail(email: string, options?: { redirectTo?: string }): Failable;
  updateUser(attributes: { password: string }): Failable;
  signOut(options?: { scope?: 'local' | 'global' | 'others' }): Failable;
}

/** The shortest password accepted. The server enforces the same number. */
export const MIN_PASSWORD_LENGTH = 8;

const LINK_FAILED = 'That link did not work. Ask for a new one.';

/**
 * Shown when a link from an email is opened in a browser other than the one
 * that asked for it. Links only sign in the browser that requested them, so
 * that a link made by someone else cannot sign this browser in to their account.
 */
export const OTHER_BROWSER =
  'That link has to be opened in the browser where you asked for it. If you were verifying your email, it is verified now: sign in below. If you were resetting your password, ask for a new link from here.';

const MESSAGES: Record<string, string> = {
  invalid_credentials: 'That email and password do not match.',
  email_not_confirmed: 'This email is not verified yet. Follow the link we sent you, then sign in.',
  user_already_exists: 'There is already an account with this email. Sign in instead.',
  email_exists: 'There is already an account with this email. Sign in instead.',
  weak_password: `Choose a longer password: at least ${MIN_PASSWORD_LENGTH} characters.`,
  same_password: 'The new password has to be different from the old one.',
  email_address_invalid: 'That does not look like an email address.',
  validation_failed: 'That does not look like an email address.',
  over_email_send_rate_limit: 'Too many emails in a short time. Wait a minute, then try again.',
  over_request_rate_limit: 'Too many attempts in a short time. Wait a minute, then try again.',
  provider_disabled: 'Signing in with Google is not available yet.',
  signup_disabled: 'New accounts are not being opened at the moment.',
  user_banned: 'This account has been suspended.',
  session_not_found: 'You have been signed out. Sign in again.',
  otp_expired: 'That link has expired or was already used. Ask for a new one.',
};

/** An auth error as a sentence the reader can act on. */
export function friendlyError(error: ErrorLike): string {
  const known = error.code ? MESSAGES[error.code] : undefined;
  if (known) return known;
  // The request never got an answer.
  if (error.name === 'AuthRetryableFetchError' || error.status === 0) {
    return 'Could not reach the server. Check your connection and try again.';
  }
  return error.message || 'Something went wrong. Try again.';
}

/**
 * A link from an email can come back with a problem in the address
 * (expired, already used). Returns the sentence to show, or null.
 *
 * Only this file's own sentences are ever returned. The address also
 * carries a free-text description, but anyone can put anything there, and
 * showing it would let a crafted link put words in the site's mouth.
 */
export function linkProblem(location: { hash: string; search: string }): string | null {
  for (const part of [location.hash.replace(/^#/, ''), location.search.replace(/^\?/, '')]) {
    const params = new URLSearchParams(part);
    if (!params.has('error') && !params.has('error_code')) continue;
    const code = params.get('error_code') ?? '';
    return MESSAGES[code] ?? LINK_FAILED;
  }
  return null;
}

function userOf(session: SessionLike): AuthUser {
  return { id: session.user.id, email: session.user.email ?? '' };
}

function fail(error: ErrorLike): { ok: false; message: string; unverified?: boolean } {
  const failure: { ok: false; message: string; unverified?: boolean } = { ok: false, message: friendlyError(error) };
  if (error.code === 'email_not_confirmed') failure.unverified = true;
  return failure;
}

export class Auth {
  private state: AuthState = { status: 'loading' };
  private readonly listeners = new Set<(state: AuthState) => void>();
  private readonly subscription: { unsubscribe(): void };

  /**
   * @param client     Supabase's auth client, or a stand-in
   * @param redirectTo the page that links in emails, and Google, send the reader back to
   * @param stored     who the session kept in this browser's storage belongs to, if there is one
   */
  constructor(
    private readonly client: AuthClient,
    private readonly redirectTo: string,
    private readonly stored: () => AuthUser | null = () => null,
  ) {
    this.subscription = client.onAuthStateChange((event, session) => {
      // Supabase holds a lock while it calls this. Anything that talks to
      // Supabase again must wait until the call has returned.
      setTimeout(() => this.onEvent(event, session), 0);
    }).data.subscription;
  }

  /** Stop listening to the client. */
  dispose(): void {
    this.subscription.unsubscribe();
    this.listeners.clear();
  }

  current(): AuthState {
    return this.state;
  }

  /** Be told when the state changes. Returns the way to stop. */
  subscribe(listener: (state: AuthState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private set(next: AuthState): void {
    const before = this.state;
    const same =
      before.status === next.status &&
      (!('user' in before) || !('user' in next) || (before.user.id === next.user.id && before.user.email === next.user.email));
    if (same) return;
    this.state = next;
    for (const listener of this.listeners) listener(next);
  }

  private onEvent(event: string, session: SessionLike | null): void {
    if (!session) {
      // "No session" is not always a sign-out. When the page loads offline (or the auth server
      // is down) with a stored session whose token has run out, the client cannot renew it and
      // reports none, but keeps it and renews it when it can. That reader is still signed in:
      // treating them as signed out would empty their browser of their places for nothing.
      // A real sign-out, or the server refusing the session, arrives as SIGNED_OUT.
      const kept = event === 'SIGNED_OUT' ? null : this.stored();
      this.set(kept ? { status: 'signed-in', user: kept } : { status: 'guest' });
      return;
    }
    const user = userOf(session);
    if (event === 'PASSWORD_RECOVERY') {
      this.set({ status: 'recovery', user });
      return;
    }
    // Token refreshes and the like arrive while a new password is still owed.
    if (this.state.status === 'recovery' && this.state.user.id === user.id) return;
    this.set({ status: 'signed-in', user });
  }

  async signIn(email: string, password: string): Promise<Outcome> {
    const { error } = await this.client.signInWithPassword({ email: email.trim(), password });
    return error ? fail(error) : { ok: true };
  }

  /** Open an account. Usually ends with a verification link in the reader's inbox. */
  async signUp(email: string, password: string): Promise<SignUpOutcome> {
    if (password.length < MIN_PASSWORD_LENGTH) return { ok: false, message: MESSAGES.weak_password! };
    const { data, error } = await this.client.signUp({
      email: email.trim(),
      password,
      options: { emailRedirectTo: this.redirectTo },
    });
    if (error) return { ok: false, message: friendlyError(error) };
    // With verification on there is no session until the link is followed.
    return { ok: true, verify: data.session === null };
  }

  /** Send the verification link again. */
  async resendVerification(email: string): Promise<Outcome> {
    const { error } = await this.client.resend({
      type: 'signup',
      email: email.trim(),
      options: { emailRedirectTo: this.redirectTo },
    });
    return error ? fail(error) : { ok: true };
  }

  /** Leave for Google's sign-in page. On success the page navigates away and comes back signed in. */
  async signInWithGoogle(): Promise<Outcome> {
    const { error } = await this.client.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: this.redirectTo },
    });
    return error ? fail(error) : { ok: true };
  }

  /** Email a link for choosing a new password. Says nothing about whether the account exists. */
  async requestPasswordReset(email: string): Promise<Outcome> {
    const { error } = await this.client.resetPasswordForEmail(email.trim(), { redirectTo: this.redirectTo });
    return error ? fail(error) : { ok: true };
  }

  /** Set the password. Used after arriving through a reset link. */
  async setNewPassword(password: string): Promise<Outcome> {
    if (password.length < MIN_PASSWORD_LENGTH) return { ok: false, message: MESSAGES.weak_password! };
    const { error } = await this.client.updateUser({ password });
    if (error) return fail(error);
    if (this.state.status === 'recovery') this.set({ status: 'signed-in', user: this.state.user });
    return { ok: true };
  }

  /** Sign out on this browser only; other devices stay signed in. */
  async signOut(): Promise<Outcome> {
    const { error } = await this.client.signOut({ scope: 'local' });
    // Signed out here even if the server could not be told.
    this.set({ status: 'guest' });
    return error && error.name !== 'AuthSessionMissingError' ? fail(error) : { ok: true };
  }
}
