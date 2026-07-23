-- 0002_rls.sql
-- Row Level Security + column-level grants for the Session 7 schema.
--
-- Two layers of defense, both must pass for a client write to succeed:
--   1. GRANTs decide which columns/operations the anon/authenticated roles may
--      touch at all. This is how "update display_name but NOT score/streak" is
--      enforced -- RLS alone cannot restrict columns on UPDATE, but column
--      GRANTs can.
--   2. RLS policies decide which *rows* a permitted operation may touch.
--
-- Note on roles: anonymous sign-in produces a user with the `authenticated`
-- role (JWT claim is_anonymous=true), NOT the `anon` role. `anon` is the
-- no-session role. Since every player signs in anonymously before playing,
-- client policies target `authenticated`.

-- ---------------------------------------------------------------------------
-- Reset default grants. Supabase's default privileges hand anon/authenticated
-- broad table access; revoke it so every grant below is explicit and auditable.
-- ---------------------------------------------------------------------------
revoke all on public.words         from anon, authenticated;
revoke all on public.rooms         from anon, authenticated;
revoke all on public.room_players  from anon, authenticated;
revoke all on public.round_results from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Helper: is the current user a member of this room?
-- SECURITY DEFINER so it reads room_players as the function owner and bypasses
-- RLS. This is essential to avoid infinite recursion: the room_players SELECT
-- policy needs to check membership, but querying room_players from inside its
-- own policy would recurse. Running the check as the owner breaks that loop.
-- ---------------------------------------------------------------------------
create or replace function public.is_room_member(p_room_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.room_players
    where room_id = p_room_id
      and player_id = auth.uid()
  );
$$;

comment on function public.is_room_member(uuid) is
  'True if auth.uid() is a member of the given room. SECURITY DEFINER to bypass RLS and avoid recursion in room_players/rooms policies.';

revoke all on function public.is_room_member(uuid) from public, anon;
grant execute on function public.is_room_member(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Helper: look up a room by its invite code.
-- SECURITY DEFINER so a not-yet-member can find a room to join WITHOUT an open
-- SELECT policy on rooms. Returns only the minimal fields a joiner needs
-- (never host_id or anything sensitive), and only lobby/active rooms so a
-- finished game's code can't be probed. Case-insensitive on the code.
-- ---------------------------------------------------------------------------
create or replace function public.get_room_by_code(p_code text)
returns table (id uuid, status text, tier text, current_round int)
language sql
stable
security definer
set search_path = public
as $$
  select r.id, r.status, r.tier, r.current_round
  from public.rooms r
  where upper(r.code) = upper(p_code)
    and r.status in ('lobby', 'active')
  limit 1;
$$;

comment on function public.get_room_by_code(text) is
  'Join-by-code lookup: returns minimal info (no host_id) for a lobby/active room by code. SECURITY DEFINER so a non-member can find a room before joining, without an open SELECT policy on rooms.';

revoke all on function public.get_room_by_code(text) from public, anon;
grant execute on function public.get_room_by_code(text) to authenticated;

-- ===========================================================================
-- words
-- ===========================================================================
alter table public.words enable row level security;

grant select on public.words to authenticated;

-- Reason: the word bank is public reference data every player needs to render
-- rounds; readable by any authenticated user (incl. anonymous sign-ins).
create policy "words: authenticated can read"
  on public.words for select
  to authenticated
  using (true);

-- Reason: word bank is server-owned reference data seeded by migration only;
-- no client insert/update/delete. Omitting those policies (with no grant)
-- denies them by default -- documented here rather than left implicit.

-- ===========================================================================
-- rooms
-- ===========================================================================
alter table public.rooms enable row level security;

-- No UPDATE/DELETE grant: clients can never modify or remove a room. status and
-- current_round are edge-function-only (Session 9), which runs with the service
-- role and bypasses RLS entirely.
grant select, insert on public.rooms to authenticated;

-- Reason: members read their own room's full row; non-members must use
-- get_room_by_code() instead of an open SELECT, so room details aren't
-- enumerable by outsiders.
create policy "rooms: members can read their room"
  on public.rooms for select
  to authenticated
  using (public.is_room_member(id));

-- Reason: a client may create a room only as its own host; host_id is pinned to
-- auth.uid() so nobody can create a room owned by someone else.
create policy "rooms: host can create own room"
  on public.rooms for insert
  to authenticated
  with check (host_id = auth.uid());

-- Reason: no UPDATE or DELETE policy exists (and no grant), so all client writes
-- to status/current_round/etc. are blocked; only edge functions (service role)
-- may advance a room.

-- ===========================================================================
-- room_players
-- ===========================================================================
alter table public.room_players enable row level security;

-- Column-level grant is the key control: UPDATE is allowed ONLY on
-- display_name. Attempting to UPDATE score or streak fails with "permission
-- denied for column", regardless of RLS. score/streak are edge-function-only
-- writes (Session 9).
grant select, insert on public.room_players to authenticated;
grant update (display_name) on public.room_players to authenticated;

-- Reason: a player can see everyone in a room they belong to (scoreboard), but
-- not the rosters of rooms they aren't in. is_room_member is SECURITY DEFINER
-- to avoid recursion on this very table.
create policy "room_players: members can read the roster"
  on public.room_players for select
  to authenticated
  using (public.is_room_member(room_id));

-- Reason: a player may add only themselves to a room (join); player_id is
-- pinned to auth.uid() so nobody can insert another user into a room.
create policy "room_players: player can join as self"
  on public.room_players for insert
  to authenticated
  with check (player_id = auth.uid());

-- Reason: a player may edit only their own row (display_name rename). The column
-- grant above restricts *which* columns; this policy restricts *which* rows.
-- USING and WITH CHECK both pin to auth.uid() so a player can't retarget the
-- update to someone else's row.
create policy "room_players: player can update own row"
  on public.room_players for update
  to authenticated
  using (player_id = auth.uid())
  with check (player_id = auth.uid());

-- Reason: no DELETE policy/grant -- leaving/kicking is deferred to Session 9
-- edge functions so scores can be reconciled first.

-- ===========================================================================
-- round_results
-- ===========================================================================
alter table public.round_results enable row level security;

-- Read only; all writes are edge-function-only (service role bypasses RLS).
grant select on public.round_results to authenticated;

-- Reason: room members can read the round history/results of their own room;
-- non-members cannot. No client write policy exists, so inserts/updates from
-- the client are denied -- only edge functions record round outcomes.
create policy "round_results: members can read results"
  on public.round_results for select
  to authenticated
  using (public.is_room_member(room_id));
