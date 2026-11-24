/**
 * The account's database, reached through Supabase. This file only moves
 * rows: the rules (newest save wins, own rows only) live in the database
 * itself, in `supabase/migrations`.
 *
 * Only the type of the Supabase client is imported here, so this file does
 * not pull the library into the first page load.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { KeyCount, ProgressRecord, SessionRecord, WordCount } from '../store/types';
import type { Remote, RemoteSettings } from './remote';

const iso = (ms: number) => new Date(ms).toISOString();
const ms = (isoTime: string) => new Date(isoTime).getTime();

/** Supabase reports failure in the result instead of throwing; the sync expects a rejection. */
function check(result: { error: { message: string } | null }): void {
  if (result.error) throw new Error(result.error.message);
}

interface ProgressRow {
  book_id: string;
  fingerprint: string;
  chapter: number;
  paragraph: number;
  char_offset: number;
  updated_at: string;
  device_id: string;
}

export function supabaseRemote(client: SupabaseClient, userId: string): Remote {
  return {
    async pushProgress(rows: readonly ProgressRecord[]) {
      check(
        await client.from('book_progress').upsert(
          rows.map((row) => ({
            user_id: userId,
            book_id: row.bookId,
            fingerprint: row.fingerprint,
            chapter: row.position.chapter,
            paragraph: row.position.paragraph,
            char_offset: row.position.char,
            updated_at: iso(row.updatedAt),
            device_id: row.deviceId,
          })),
          { onConflict: 'user_id,book_id' },
        ),
      );
    },

    async pushSessions(rows: readonly SessionRecord[]) {
      check(
        await client.from('typing_sessions').upsert(
          rows.map((row) => ({
            user_id: userId,
            id: row.id,
            book_id: row.bookId,
            started_at: iso(row.startedAt),
            ended_at: iso(row.endedAt),
            active_ms: Math.round(row.activeMs),
            words: Math.round(row.words),
            wpm: row.wpm,
            accuracy: row.accuracy,
            device_id: row.deviceId,
          })),
          // A session is written once; one sent again is left alone.
          { onConflict: 'user_id,id', ignoreDuplicates: true },
        ),
      );
    },

    async pushKeyCounts(deviceId: string, rows: readonly KeyCount[]) {
      const updatedAt = iso(Date.now());
      check(
        await client.from('key_stats').upsert(
          rows.map((row) => ({
            user_id: userId,
            device_id: deviceId,
            key: row.key,
            hits: row.hits,
            misses: row.misses,
            total_ms: row.totalMs,
            updated_at: updatedAt,
          })),
          { onConflict: 'user_id,device_id,key' },
        ),
      );
    },

    async pushWordCounts(deviceId: string, rows: readonly WordCount[]) {
      const updatedAt = iso(Date.now());
      check(
        await client.from('word_stats').upsert(
          rows.map((row) => ({
            user_id: userId,
            device_id: deviceId,
            word: row.word,
            hits: row.hits,
            misses: row.misses,
            updated_at: updatedAt,
          })),
          { onConflict: 'user_id,device_id,word' },
        ),
      );
    },

    async pushSettings(settings: RemoteSettings) {
      check(
        await client.from('user_settings').upsert(
          {
            user_id: userId,
            data: settings.data,
            updated_at: iso(settings.updatedAt),
            device_id: settings.deviceId,
          },
          { onConflict: 'user_id' },
        ),
      );
    },

    async pullProgress(): Promise<ProgressRecord[]> {
      const result = await client
        .from('book_progress')
        .select('book_id, fingerprint, chapter, paragraph, char_offset, updated_at, device_id');
      check(result);
      return ((result.data ?? []) as ProgressRow[]).map((row) => ({
        bookId: row.book_id,
        fingerprint: row.fingerprint,
        position: { chapter: row.chapter, paragraph: row.paragraph, char: row.char_offset },
        updatedAt: ms(row.updated_at),
        deviceId: row.device_id,
      }));
    },

    async pullSettings(): Promise<RemoteSettings | null> {
      const result = await client.from('user_settings').select('data, updated_at, device_id').maybeSingle();
      check(result);
      const row = result.data as { data: unknown; updated_at: string; device_id: string } | null;
      return row ? { data: row.data, updatedAt: ms(row.updated_at), deviceId: row.device_id } : null;
    },
  };
}
