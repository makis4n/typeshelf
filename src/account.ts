/**
 * Ties accounts together for the page: loads the account service after the
 * typing view is ready, keeps track of who is signed in, and runs the sync
 * for them.
 *
 * With no account service configured (see `auth/config.ts`) none of this
 * does anything: `start` returns at once, nothing is loaded, and the page
 * shows no sign-in.
 */

import {
  Auth,
  linkProblem,
  OTHER_BROWSER,
  type AuthState,
  type AuthUser,
  type Outcome,
  type SignUpOutcome,
} from './auth/auth';
import { accountConfig, type AccountConfig } from './auth/config';
import { loadSettings, onSettingsSaved, type Settings } from './settings';
import { UserStore } from './store/userStore';
import { storedSettingsPort } from './sync/settingsPort';
import { supabaseRemote } from './sync/supabaseRemote';
import { Sync, type SyncState } from './sync/sync';

/** What the account button and its modal show. */
export interface AccountView {
  /** False when accounts are switched off; the page then shows nothing about them. */
  available: boolean;
  auth: AuthState;
  /** How the signed-in reader's changes are doing, or null when nobody is signed in. */
  sync: SyncState | null;
  /** Something the reader should be told as soon as the page opens, like an expired link. */
  notice: string | null;
}

/** How the account reaches the page's settings. */
export interface AccountHooks {
  /** Put the account's settings into effect on the page. They are already saved in the browser. */
  applySettings(next: Settings): void;
}

/** Where the account library keeps the session in localStorage. */
const SESSION_KEY = 'typeshelf:auth';

/** Who the session kept in this browser belongs to, if there is one. It may be out of date; see `Auth`. */
function storedUser(): AuthUser | null {
  try {
    const session: unknown = JSON.parse(localStorage.getItem(SESSION_KEY) ?? 'null');
    const user = (session as { user?: { id?: unknown; email?: unknown } } | null)?.user;
    if (typeof user?.id !== 'string' || user.id === '') return null;
    return { id: user.id, email: typeof user.email === 'string' ? user.email : '' };
  } catch {
    return null;
  }
}

/** How long sign-out waits for the last changes to be sent before going ahead. */
const SIGN_OUT_FLUSH_MS = 4000;

export class Account {
  private current: AccountView;
  private readonly listeners = new Set<(view: AccountView) => void>();
  private started = false;
  private auth: Auth | undefined;
  private syncing: Sync | undefined;
  /** The account the sync is running for; undefined for a guest, null until the first answer is in. */
  private syncUser: string | undefined | null = null;
  /** Changes of who owns the local store, done strictly one after the other. */
  private handover: Promise<void> = Promise.resolve();

  constructor(private readonly config: AccountConfig | null) {
    this.current = { available: config !== null, auth: { status: 'loading' }, sync: null, notice: null };
  }

  view(): AccountView {
    return this.current;
  }

  /** Be told when the view changes. Returns the way to stop. */
  subscribe(listener: (view: AccountView) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private update(patch: Partial<AccountView>): void {
    this.current = { ...this.current, ...patch };
    for (const listener of this.listeners) listener(this.current);
  }

  /** The running sync, for the code that saves a reader's place. Undefined for guests. */
  sync(): Sync | undefined {
    return this.syncing;
  }

  /**
   * Call once the typing view is on the page. The account service is loaded
   * when the browser next has a quiet moment, so it never delays typing.
   */
  start(hooks: AccountHooks): void {
    if (!this.config || this.started) return;
    this.started = true;
    const config = this.config;
    const load = () => {
      this.load(config, hooks).catch((error: unknown) => {
        // No accounts this visit; typing as a guest is unaffected.
        console.warn('typeshelf: accounts could not be started', error);
        this.update({ available: false });
      });
    };
    if (typeof requestIdleCallback === 'function') requestIdleCallback(load, { timeout: 2000 });
    else setTimeout(load, 200);
  }

  private inOrder(step: () => Promise<unknown>): void {
    this.handover = this.handover
      .then(step)
      .then(
        () => undefined,
        (error: unknown) => console.warn('typeshelf: the local store could not be handed over', error),
      );
  }

  private async load(config: AccountConfig, hooks: AccountHooks): Promise<void> {
    // Read before the library loads: it clears the address once it has dealt with it.
    const notice = linkProblem(window.location);
    const address = new URL(window.location.href);
    // Sign-in tokens in the address are never accepted (see `flowType` below), so they are
    // not left lying in the address bar and the history either.
    if (/(^|[#&])(access_token|refresh_token)=/.test(address.hash)) {
      history.replaceState(history.state, '', address.pathname + address.search);
    }
    const cameWithCode = address.searchParams.has('code');

    const [{ createClient }, store] = await Promise.all([import('@supabase/supabase-js'), UserStore.open()]);
    // PKCE: a link only signs in the browser that asked for it, because that browser holds
    // the other half of a secret. Without it, anyone could craft a link carrying their own
    // sign-in, and a reader who opened it would be typing into the sender's account.
    const client = createClient(config.url, config.anonKey, { auth: { flowType: 'pkce', storageKey: SESSION_KEY } });
    const auth = new Auth(client.auth, window.location.origin + window.location.pathname, storedUser);
    this.auth = auth;

    onSettingsSaved(() => void this.syncing?.settingsChanged());

    // Read from and written to the browser's stored copy, which all tabs share (see `storedSettingsPort`).
    const settings = storedSettingsPort((next) => hooks.applySettings(next));

    auth.subscribe((state) => {
      const userId = 'user' in state ? state.user.id : undefined;
      const first = this.syncUser === null;
      if (userId !== this.syncUser) {
        this.syncing?.stop();
        this.syncing = undefined;
        this.syncUser = userId;
        if (userId) {
          const sync = new Sync({ store, remote: supabaseRemote(client, userId), userId, settings });
          this.syncing = sync;
          sync.onState((next) => {
            if (this.syncing === sync) this.update({ sync: next });
          });
          // Only the takeover is waited for; the first round may take as long as the network does.
          this.inOrder(() => sync.begin());
        } else {
          // Nobody is signed in, however that came about (a sign-out, an expired session, a
          // session that ended while the page was closed). What the account had not sent is
          // put aside for it, and the browser starts again as a clean guest's.
          this.inOrder(() => store.endAccountSession(loadSettings()));
        }
      }
      this.update({ auth: state, sync: this.syncing?.current() ?? null });

      // A link opened in a different browser from the one that asked for it cannot sign in.
      if (first && cameWithCode && state.status === 'guest') {
        const clean = new URL(window.location.href);
        clean.searchParams.delete('code');
        history.replaceState(history.state, '', clean.pathname + clean.search + clean.hash);
        this.update({ notice: OTHER_BROWSER });
      }
    });

    // Leaving the tab is a natural end of a batch; coming back is a moment to catch up.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') void this.syncing?.flushNow();
      else void this.syncing?.refresh();
    });
    window.addEventListener('pagehide', () => void this.syncing?.flushNow());

    if (notice) this.update({ notice });
  }

  dismissNotice(): void {
    if (this.current.notice !== null) this.update({ notice: null });
  }

  // ---- signing in and out ---------------------------------------------------

  private get ready(): Auth {
    if (!this.auth) throw new Error('Accounts are not ready yet.');
    return this.auth;
  }

  signIn(email: string, password: string): Promise<Outcome> {
    return this.ready.signIn(email, password);
  }

  signUp(email: string, password: string): Promise<SignUpOutcome> {
    return this.ready.signUp(email, password);
  }

  resendVerification(email: string): Promise<Outcome> {
    return this.ready.resendVerification(email);
  }

  signInWithGoogle(): Promise<Outcome> {
    return this.ready.signInWithGoogle();
  }

  requestPasswordReset(email: string): Promise<Outcome> {
    return this.ready.requestPasswordReset(email);
  }

  setNewPassword(password: string): Promise<Outcome> {
    return this.ready.setNewPassword(password);
  }

  /**
   * Sign out on this browser.
   *
   * The last changes are sent first. Then this browser forgets the
   * account's progress and counts, so the next person to use it starts as a
   * fresh guest. Anything that could not be sent (offline) is not thrown
   * away: it is put aside on this browser, out of reach of any other
   * account, and goes up when the same account signs in here again.
   */
  async signOut(): Promise<Outcome> {
    const sync = this.syncing;
    if (sync) {
      await Promise.race([sync.flushNow(), new Promise((resolve) => setTimeout(resolve, SIGN_OUT_FLUSH_MS))]);
    }
    // Becoming a guest stops the sync and hands the store over (see `load`).
    return this.ready.signOut();
  }
}

/** The page's one account. */
export const account = new Account(accountConfig());
