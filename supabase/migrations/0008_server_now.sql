-- 0008_server_now.sql
-- Expose the server's clock so clients can render a server-derived countdown.
--
-- The round deadline is round_started_at + round_seconds(tier), both server
-- values. To turn that into "seconds left" a client still has to compare it
-- against *now* — and the browser's own clock is not a safe reference: a device
-- with a skewed clock would show a countdown that doesn't match anyone else's,
-- and a player could skew it deliberately.
--
-- So the client measures its offset from this function once per game and ticks
-- against server time. The HTTP `Date` header would almost work, but it has
-- one-second resolution, which is enough to make two clients disagree by a
-- whole second on a countdown displayed in whole seconds.
--
-- Read-only and leaks nothing: the current time is not a secret.
create or replace function public.server_now()
returns timestamptz
language sql
stable
as $$ select now(); $$;

comment on function public.server_now() is
  'Server clock, used by clients to sync their countdown offset. Read-only; the round deadline itself still comes from rooms.round_started_at.';

revoke all on function public.server_now() from public, anon;
grant execute on function public.server_now() to authenticated, service_role;
