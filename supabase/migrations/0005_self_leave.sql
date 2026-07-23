-- 0005_self_leave.sql
-- Allow a player to leave a lobby by deleting their OWN room_players row,
-- and ONLY while the room is still in 'lobby' status.
--
-- Session 7's 0002_rls.sql deferred all room_players deletes to Session 9 edge
-- functions so in-game scores could be reconciled first. That reasoning holds
-- for active/finished games, but a player leaving a lobby before the game
-- starts has no score to reconcile, and the client lobby (Session 8) needs a
-- real "leave" (and capacity back-out) rather than leaving ghost rows behind.
--
-- This grant/policy is deliberately narrow and does NOT touch the
-- server-authoritative rooms.status write, which stays edge-function-only:
--   * player_id = auth.uid()  -> you can only ever delete your OWN membership
--   * room must be in 'lobby'  -> once the game is active, deletes are blocked
--     again and remain a Session 9 edge-function concern (kick/forfeit).

grant delete on public.room_players to authenticated;

-- Reason: a player may remove only their own lobby membership (self-leave); the
-- status guard keeps in-game/finished rows immutable to clients so scoring
-- stays server-authoritative in Session 9.
create policy "room_players: player can leave own lobby row"
  on public.room_players for delete
  to authenticated
  using (
    player_id = auth.uid()
    and exists (
      select 1 from public.rooms r
      where r.id = room_players.room_id
        and r.status = 'lobby'
    )
  );
