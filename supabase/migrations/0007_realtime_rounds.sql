-- 0007_realtime_rounds.sql
-- Publish the two tables the multiplayer round loop reacts to (Session 9b).
--
-- 0004 published room_players for the lobby's live roster. The in-game loop
-- needs the other two halves of the round state written by 0006:
--
--   rooms          -> status, current_round, round_started_at
--                     (a round starting, and the game finishing)
--   round_results  -> INSERT = this round's word is now revealed
--                     UPDATE = this round's winner has been decided
--
-- Together these replace polling entirely: every client learns about a new
-- round, a winner, or game-over from the same server writes, so nobody derives
-- game state locally.
--
-- RLS still applies to the stream. A subscriber receives only changes to rows
-- their SELECT policy allows — rooms."members can read their room" and
-- round_results."members can read results", both is_room_member() — so a
-- client cannot subscribe its way into another room's words or winners.
--
-- Word secrecy is unaffected: the round_results row for round N is inserted in
-- the same transaction that bumps rooms.current_round (see 0006), so this
-- stream never carries a future round's word_id ahead of its round.
--
-- Idempotent, same guard as 0004: re-running ALTER PUBLICATION ADD TABLE on an
-- existing member would error.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'rooms'
  ) then
    alter publication supabase_realtime add table public.rooms;
  end if;

  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'round_results'
  ) then
    alter publication supabase_realtime add table public.round_results;
  end if;
end
$$;
