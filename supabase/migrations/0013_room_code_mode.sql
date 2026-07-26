-- 0013_room_code_mode.sql
-- Widen get_room_by_code() to report the room's MODE and LIVES_SETTING
-- (Session 19; the gap flagged at the end of Session 18).
--
-- THE GAP
-- ---------------------------------------------------------------------------
-- 0002 gave a joiner exactly four facts about a room they are not yet in:
-- id, status, tier, current_round. Session 18 then added two things that change
-- what game they are walking into — `mode` decides whether they are joining a
-- simultaneous race or a turn-based elimination match, and `lives_setting`
-- decides how many mistakes they get. Neither was reachable before joining,
-- because the only other route to a rooms row is the members-only SELECT policy.
-- So a joiner had to commit first and find out afterwards.
--
-- WHY A DROP AND RECREATE
-- ---------------------------------------------------------------------------
-- `create or replace function` cannot change a function's OUT parameters, and
-- for a RETURNS TABLE function the column list IS the OUT parameters — replacing
-- it in place fails with 42P13 ("cannot change return type of existing
-- function"). The function must be dropped and rebuilt, which also means the
-- grant has to be reissued: DROP takes the privileges with it.
--
-- Nothing else depends on this function (no policy, no view, no other function),
-- so the drop is safe. Verified before writing this migration rather than
-- assumed.
--
-- BACKWARD COMPATIBLE FOR THE CLIENT. src/lib/rooms.ts destructures id/status/
-- tier off the result and ignores anything else, so the extra columns are inert
-- until Session 20 reads them. This migration deliberately does NOT change the
-- shape of what already worked — it only adds.
--
-- STILL NO host_id. The whole reason this function exists is to let a
-- non-member resolve a code without an open SELECT policy on rooms, and the
-- Session 7b verification specifically checked that it leaks no host_id. Both
-- new columns are facts a joiner needs to make a decision; neither is sensitive.

drop function if exists public.get_room_by_code(text);

create or replace function public.get_room_by_code(p_code text)
returns table (
  id            uuid,
  status        text,
  tier          text,
  current_round int,
  mode          text,
  lives_setting int
)
language sql
stable
security definer
set search_path = public
as $$
  select r.id, r.status, r.tier, r.current_round, r.mode, r.lives_setting
  from public.rooms r
  where upper(r.code) = upper(p_code)
    and r.status in ('lobby', 'active')
  limit 1;
$$;

comment on function public.get_room_by_code(text) is
  'Join-by-code lookup: returns minimal info (no host_id) for a lobby/active room by code, including mode and lives_setting so a joiner knows which game they are entering. SECURITY DEFINER so a non-member can resolve a code without an open SELECT policy on rooms.';

-- Reissued because DROP FUNCTION discarded the 0002 grants along with the
-- function. Same boundary as before: signed-in players only, never anon.
revoke all on function public.get_room_by_code(text) from public, anon;
grant execute on function public.get_room_by_code(text) to authenticated;
