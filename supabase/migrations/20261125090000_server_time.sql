-- The account's own clock, for signed-in devices to check theirs against.
--
-- "Most recent save wins" compares save times stamped by devices. A device
-- whose clock is wrong would win or lose for the wrong reason, so each
-- device measures how far its clock is from this one and stamps its saves
-- in the account's time instead.
create function public.server_time()
returns timestamptz
language sql
stable
set search_path = ''
as $$
  select now();
$$;

revoke all on function public.server_time() from public, anon;
grant execute on function public.server_time() to authenticated;
