-- 0004_realtime.sql
-- Enable Supabase Realtime (postgres_changes) for the lobby's live player list.
--
-- The waiting-room UI subscribes to room_players for a given room_id and
-- updates as players join/leave. Realtime only streams changes for tables in
-- the `supabase_realtime` publication, so add room_players to it. RLS still
-- applies to the stream: a subscriber receives only changes to rows their
-- room_players SELECT policy (is_room_member) permits — i.e. their own room.
--
-- Idempotent: skip if the table is already published (re-running ALTER
-- PUBLICATION ADD TABLE on an existing member would error).
do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'room_players'
  ) then
    alter publication supabase_realtime add table public.room_players;
  end if;
end
$$;
