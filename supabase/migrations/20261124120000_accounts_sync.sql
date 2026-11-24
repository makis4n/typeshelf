-- typeshelf: per-user tables for progress, sessions, weak-key counts and settings.
--
-- Every table carries the owner's id and has row-level security on, so a
-- signed-in person can only read and write their own rows. Signed-out
-- visitors (the `anon` role) get nothing at all.
--
-- Book text is never stored here. Imported books stay on the device; a row
-- only names the book and carries its fingerprint, so a second device can
-- match the same file.

-- ---- shared pieces ---------------------------------------------------------

-- "Most recent save wins", enforced where it cannot be bypassed: a write that
-- carries an older save time than the row already has is quietly dropped, so
-- a device that was offline cannot overwrite a newer save when it reconnects.
-- A save time from a clock that runs ahead is pulled back to the server's
-- time, so one wrong clock cannot win for ever.
create function public.keep_newest_save()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.updated_at > now() + interval '5 minutes' then
    new.updated_at := now();
  end if;
  if tg_op = 'UPDATE' and new.updated_at < old.updated_at then
    return null;
  end if;
  return new;
end;
$$;

-- ---- book progress ---------------------------------------------------------

create table public.book_progress (
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  -- `gutenberg:<number>` or `import:<fingerprint>`.
  book_id text not null check (char_length(book_id) between 1 and 200),
  -- Lowercase hex SHA-256 of the book, as in the app's `Book.fingerprint`.
  fingerprint text not null check (fingerprint ~ '^[0-9a-f]{64}$'),
  -- The app's `Position`: chapter, paragraph, and characters of the paragraph typed.
  chapter integer not null check (chapter >= 0),
  paragraph integer not null check (paragraph >= 0),
  char_offset integer not null check (char_offset >= 0),
  -- When the device saved this place (the device's clock, not the server's).
  updated_at timestamptz not null,
  -- Which browser saved it, so a device can tell its own save from another's.
  device_id text not null check (char_length(device_id) between 1 and 64),
  primary key (user_id, book_id)
);

create trigger book_progress_keep_newest
  before insert or update on public.book_progress
  for each row execute function public.keep_newest_save();

-- ---- typing sessions -------------------------------------------------------

-- One row per sitting with a book. Written once, never changed.
create table public.typing_sessions (
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  -- Made up by the device, so sending the same session twice is harmless.
  id uuid not null,
  book_id text not null check (char_length(book_id) between 1 and 200),
  started_at timestamptz not null,
  ended_at timestamptz not null,
  -- Typing time with pauses taken out.
  active_ms integer not null check (active_ms >= 0),
  words integer not null check (words >= 0),
  wpm real not null check (wpm >= 0),
  -- Share of key presses that were right, 0 to 1.
  accuracy real not null check (accuracy between 0 and 1),
  device_id text not null check (char_length(device_id) between 1 and 64),
  primary key (user_id, id),
  check (ended_at >= started_at)
);

create index typing_sessions_by_time on public.typing_sessions (user_id, started_at desc);
create index typing_sessions_by_book on public.typing_sessions (user_id, book_id, started_at desc);

-- ---- weak-key data ---------------------------------------------------------

-- Counts only, never a log of what was typed in what order.
--
-- Each device keeps its own running totals and sends the totals, not the
-- change. Sending the same totals twice therefore changes nothing, and a
-- person's numbers are the sum over their devices (see the views below).

create table public.key_stats (
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  device_id text not null check (char_length(device_id) between 1 and 64),
  -- The character that was expected, or a pair of characters.
  key text not null check (char_length(key) between 1 and 8),
  hits bigint not null default 0 check (hits >= 0),
  misses bigint not null default 0 check (misses >= 0),
  -- Time spent on the correct presses, for finding slow keys.
  total_ms bigint not null default 0 check (total_ms >= 0),
  updated_at timestamptz not null default now(),
  primary key (user_id, device_id, key)
);

create table public.word_stats (
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  device_id text not null check (char_length(device_id) between 1 and 64),
  word text not null check (char_length(word) between 1 and 64),
  hits bigint not null default 0 check (hits >= 0),
  misses bigint not null default 0 check (misses >= 0),
  updated_at timestamptz not null default now(),
  primary key (user_id, device_id, word)
);

-- A person's totals across all their devices. `security_invoker` makes the
-- views obey the row-level security of the tables underneath.
create view public.key_totals
with (security_invoker = true) as
select user_id, key, sum(hits)::bigint as hits, sum(misses)::bigint as misses, sum(total_ms)::bigint as total_ms
from public.key_stats
group by user_id, key;

create view public.word_totals
with (security_invoker = true) as
select user_id, word, sum(hits)::bigint as hits, sum(misses)::bigint as misses
from public.word_stats
group by user_id, word;

-- ---- settings --------------------------------------------------------------

create table public.user_settings (
  user_id uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  -- The app's `Settings` object. The app checks every value when it reads it back.
  data jsonb not null check (jsonb_typeof(data) = 'object' and pg_column_size(data) < 8192),
  updated_at timestamptz not null,
  device_id text not null check (char_length(device_id) between 1 and 64)
);

create trigger user_settings_keep_newest
  before insert or update on public.user_settings
  for each row execute function public.keep_newest_save();

-- ---- access rules ----------------------------------------------------------

alter table public.book_progress enable row level security;
alter table public.typing_sessions enable row level security;
alter table public.key_stats enable row level security;
alter table public.word_stats enable row level security;
alter table public.user_settings enable row level security;

-- One rule per table: signed-in people, own rows only, for reading and for
-- every kind of write. `with check` stops a row being written or moved under
-- someone else's id.
create policy "own rows only" on public.book_progress
  for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "own rows only" on public.typing_sessions
  for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "own rows only" on public.key_stats
  for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "own rows only" on public.word_stats
  for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "own rows only" on public.user_settings
  for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

-- Table rights, stated outright instead of relying on the project's defaults.
revoke all on public.book_progress, public.typing_sessions, public.key_stats, public.word_stats, public.user_settings
  from anon, authenticated;
revoke all on public.key_totals, public.word_totals from anon, authenticated;

grant select, insert, update, delete
  on public.book_progress, public.typing_sessions, public.key_stats, public.word_stats, public.user_settings
  to authenticated;
grant select on public.key_totals, public.word_totals to authenticated;

revoke all on function public.keep_newest_save() from public, anon, authenticated;
