/**
 * Finds the local Supabase stack for the database tests.
 *
 * The address and keys are read from the running stack itself
 * (`supabase status`), so nothing is hard-coded or committed. They are the
 * throwaway keys of a database that only exists on this machine.
 */

import { execFileSync } from 'node:child_process';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

export interface Stack {
  url: string;
  anonKey: string;
  serviceKey: string;
  mailUrl: string;
}

/** The running local stack, or the reason there is none. */
export function findStack(): Stack | { missing: string } {
  let raw: string;
  try {
    raw = execFileSync('pnpm', ['dlx', 'supabase', 'status', '-o', 'env'], {
      encoding: 'utf8',
      timeout: 60_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message.split('\n')[0] : String(error);
    return { missing: `the local Supabase stack is not running (start it with \`pnpm db:start\`): ${detail}` };
  }
  const values = new Map<string, string>();
  for (const line of raw.split('\n')) {
    const match = /^([A-Z_]+)="?(.*?)"?$/.exec(line.trim());
    if (match) values.set(match[1]!, match[2]!);
  }
  const url = values.get('API_URL');
  const anonKey = values.get('ANON_KEY');
  const serviceKey = values.get('SERVICE_ROLE_KEY');
  if (!url || !anonKey || !serviceKey) {
    return { missing: '`supabase status` did not report an address and keys' };
  }
  return { url, anonKey, serviceKey, mailUrl: values.get('MAILPIT_URL') ?? 'http://127.0.0.1:54324' };
}

const quiet = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } };

/** A client that is nobody: what a signed-out visitor's browser has. */
export function visitor(stack: Stack): SupabaseClient {
  return createClient(stack.url, stack.anonKey, quiet);
}

/** The all-powerful client, used only to set tests up and to look behind the access rules. */
export function admin(stack: Stack): SupabaseClient {
  return createClient(stack.url, stack.serviceKey, quiet);
}

export interface TestUser {
  id: string;
  email: string;
  client: SupabaseClient;
}

/** Make a throwaway, already-verified account and sign a client in as it. */
export async function makeUser(stack: Stack, label: string): Promise<TestUser> {
  const email = `${label}-${crypto.randomUUID()}@example.test`;
  const password = crypto.randomUUID();
  const created = await admin(stack).auth.admin.createUser({ email, password, email_confirm: true });
  if (created.error) throw created.error;
  const client = createClient(stack.url, stack.anonKey, quiet);
  const signedIn = await client.auth.signInWithPassword({ email, password });
  if (signedIn.error) throw signedIn.error;
  return { id: created.data.user.id, email, client };
}

export async function removeUser(stack: Stack, user: TestUser | undefined): Promise<void> {
  if (user) await admin(stack).auth.admin.deleteUser(user.id);
}
