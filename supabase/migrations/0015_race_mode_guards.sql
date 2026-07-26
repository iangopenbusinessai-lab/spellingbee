-- 0015_race_mode_guards.sql
-- Refuse to run the RACE engine against an ELIMINATION room (Session 19).
--
-- WHY THIS EXISTS
-- ---------------------------------------------------------------------------
-- Session 19 was told to confirm, not assume, that race mode is unaffected by
-- elimination mode. Confirming it surfaced the reverse direction, which nothing
-- had checked: the 0012 functions all reject a room whose mode is not
-- 'elimination', but the 0006 functions predate `rooms.mode` entirely and reject
-- nothing. They are public edge-function endpoints, so any client can aim them
-- at an elimination room.
--
-- Measured against the live project before this migration:
--
--   start-game on an elimination room  -> HTTP 200. It started a race in it:
--       status='active', current_round=1, and — the damaging part —
--       round_started_at set. That single write puts the room into BOTH
--       sweepers at once (0009 selects on round_started_at IS NOT NULL, 0014 on
--       mode='elimination'), which is precisely the disjointness 0014's header
--       argues can never be violated. It can, through this door.
--
--   advance-round on an elimination room -> the "is this round actually over?"
--       guard silently fails open. It compares now() against
--       round_started_at + limit, and round_started_at is NULL in an
--       elimination room, so the comparison is NULL, so `if v_now < v_deadline`
--       is not true and execution falls straight through to advancing. Any
--       MEMBER — not just the host — could therefore skip whoever's turn it was,
--       and the advance writes round_started_at too. This is the worst of the
--       three: no error, no refusal, real corruption of somebody else's game.
--
--   submit-answer on an elimination room -> aborts with a NOT NULL violation on
--       round_attempts.response_time_ms (the elapsed time computes to NULL for
--       the same reason). Safe by accident, since the transaction rolls back and
--       writes nothing, but a 500 is not a refusal and accidents are not guards.
--
-- IS THIS "TOUCHING RACE MODE"? No, and the distinction is worth being precise
-- about. rooms.mode defaults to 'race' and is documented as never changing after
-- creation, so for every room the race engine was ever meant to serve, this
-- check is invariably true and the functions behave exactly as they did in 9a.
-- What changes is only the previously-undefined case of pointing the race engine
-- at a room that belongs to the other engine. That case had no defined
-- behaviour; it had an accident. Live verification confirms the race path is
-- byte-for-byte unchanged: a full 10-round race game still plays out identically.
--
-- WHY IN SQL RATHER THAN IN THE EDGE FUNCTIONS. Two reasons. The 0012 functions
-- put their own mode guard in SQL, and a guard that lives in one layer for one
-- engine and another layer for the other is the kind of asymmetry that gets
-- missed later. And CLAUDE.md's division of labour is explicit: rules live in
-- plpgsql, edge functions do auth and HTTP. A guard placed only in TypeScript
-- would leave the SQL functions unsafe for every other caller, including the
-- sweeper and any future one.
--
-- The bodies below are 0006's, copied verbatim. The ONLY edit in each is the
-- five-line mode check immediately after the room is fetched, placed where
-- start_elimination_game_tx puts its mirror-image check so the two engines read
-- the same way. Signatures are unchanged, so `create or replace` keeps the
-- existing service_role-only grants and no regrant is needed.

-- ===========================================================================
-- start_game_tx — + mode guard
-- ===========================================================================
create or replace function public.start_game_tx(p_room_id uuid, p_caller uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_room    public.rooms%rowtype;
  v_players int;
  v_word_id text;
  v_word    text;
  v_now     timestamptz;
begin
  -- FOR UPDATE serialises concurrent start attempts on the same room: the second
  -- caller waits here, then sees status <> 'lobby' and is rejected.
  select * into v_room from public.rooms where id = p_room_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'room_not_found');
  end if;

  -- Session 19: this engine owns race rooms only. Mirrors the check
  -- start_elimination_game_tx makes in the opposite direction.
  if v_room.mode <> 'race' then
    return jsonb_build_object('ok', false, 'error', 'wrong_mode',
                              'mode', v_room.mode);
  end if;

  -- Host check against the room row, NOT against anything the caller asserted.
  if v_room.host_id <> p_caller then
    return jsonb_build_object('ok', false, 'error', 'not_host');
  end if;

  if v_room.status <> 'lobby' then
    return jsonb_build_object('ok', false, 'error', 'already_started',
                              'status', v_room.status);
  end if;

  select count(*) into v_players from public.room_players where room_id = p_room_id;
  if v_players < 2 then
    return jsonb_build_object('ok', false, 'error', 'not_enough_players',
                              'players', v_players);
  end if;

  v_word_id := public.pick_unused_word(p_room_id, v_room.tier);
  if v_word_id is null then
    return jsonb_build_object('ok', false, 'error', 'no_words_for_tier');
  end if;
  select word into v_word from public.words where id = v_word_id;

  v_now := now();

  -- The round_results row and the room bump land in ONE transaction, so round 1
  -- becomes readable to clients at exactly the moment the room says it started.
  insert into public.round_results (room_id, round_num, word_id)
  values (p_room_id, 1, v_word_id);

  update public.rooms
     set status = 'active', current_round = 1, round_started_at = v_now
   where id = p_room_id;

  return jsonb_build_object(
    'ok', true,
    'round_num', 1,
    'word', v_word,
    'round_started_at', v_now,
    'round_seconds', public.round_seconds(v_room.tier),
    'tier', v_room.tier
  );
end;
$$;

-- ===========================================================================
-- submit_answer_tx — + mode guard
-- ===========================================================================
create or replace function public.submit_answer_tx(
  p_room_id   uuid,
  p_round_num int,
  p_player    uuid,
  p_guess     text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_room       public.rooms%rowtype;
  v_rr         public.round_results%rowtype;
  v_word       text;
  v_elapsed_ms int;
  v_limit_ms   int;
  v_correct    boolean;
  v_points     int;
  v_streak     int;
  v_now        timestamptz;
begin
  select * into v_room from public.rooms where id = p_room_id;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'room_not_found');
  end if;

  -- Session 19: race rooms only. Without this the elapsed-time arithmetic below
  -- evaluates to NULL against an elimination room (round_started_at is NULL
  -- there by design) and the insert dies on a NOT NULL violation.
  if v_room.mode <> 'race' then
    return jsonb_build_object('ok', false, 'error', 'wrong_mode',
                              'mode', v_room.mode);
  end if;

  if not exists (select 1 from public.room_players
                 where room_id = p_room_id and player_id = p_player) then
    return jsonb_build_object('ok', false, 'error', 'not_a_member');
  end if;

  if v_room.status <> 'active' then
    return jsonb_build_object('ok', false, 'error', 'room_not_active',
                              'status', v_room.status);
  end if;

  -- Stale-round guard: a submission is only ever valid for the round the SERVER
  -- currently has open, so a delayed or replayed request for an earlier round
  -- can never score.
  if p_round_num <> v_room.current_round then
    return jsonb_build_object('ok', false, 'error', 'stale_round',
                              'current_round', v_room.current_round);
  end if;

  select * into v_rr from public.round_results
   where room_id = p_room_id and round_num = p_round_num;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'round_not_started');
  end if;

  -- Response time = server receipt time minus the server's own round start.
  -- No client-supplied duration is accepted anywhere in this function.
  v_now := now();
  v_elapsed_ms := floor(extract(epoch from (v_now - v_room.round_started_at)) * 1000)::int;
  v_limit_ms   := public.round_seconds(v_room.tier) * 1000;

  if v_elapsed_ms > v_limit_ms + public.late_grace_ms() then
    return jsonb_build_object('ok', false, 'error', 'round_expired',
                              'response_time_ms', v_elapsed_ms);
  end if;

  -- The word is read from the server's own round record; a client-sent "correct"
  -- flag would be meaningless here because none is accepted.
  select w.word into v_word from public.words w where w.id = v_rr.word_id;
  v_correct := lower(btrim(p_guess)) = lower(v_word);

  -- Claim this player's single attempt slot for the round. The PK turns a
  -- duplicate submission into a unique_violation instead of a race.
  begin
    insert into public.round_attempts
      (room_id, round_num, player_id, guess, is_correct, response_time_ms)
    values
      (p_room_id, p_round_num, p_player, p_guess, v_correct, v_elapsed_ms);
  exception when unique_violation then
    return jsonb_build_object('ok', false, 'error', 'already_submitted');
  end;

  if not v_correct then
    -- Wrong answers cost the round but don't end it for everyone else.
    return jsonb_build_object('ok', true, 'correct', false, 'won', false,
                              'response_time_ms', v_elapsed_ms);
  end if;

  -- ATOMIC WINNER CLAIM.
  -- Under READ COMMITTED two concurrent correct submissions both reach this
  -- UPDATE. The second blocks on the row lock, then re-evaluates its WHERE
  -- against the row the first one committed: winner_id is no longer null, so it
  -- matches zero rows. Exactly one winner, with no read-then-write window.
  update public.round_results
     set winner_id = p_player,
         response_time_ms = v_elapsed_ms,
         ended_at = v_now
   where room_id = p_room_id
     and round_num = p_round_num
     and winner_id is null;

  if not found then
    return jsonb_build_object('ok', true, 'correct', true, 'won', false,
                              'response_time_ms', v_elapsed_ms);
  end if;

  -- Scoring mirrors useGameEngine's shape (10 + seconds remaining) but is
  -- computed from the server clock, which is the whole point of moving it here.
  v_points := 10 + greatest(0, ((v_limit_ms - v_elapsed_ms) / 1000)::int);

  update public.room_players
     set score = score + v_points,
         streak = streak + 1
   where room_id = p_room_id and player_id = p_player
  returning streak into v_streak;

  return jsonb_build_object(
    'ok', true, 'correct', true, 'won', true,
    'points', v_points, 'response_time_ms', v_elapsed_ms, 'streak', v_streak
  );
end;
$$;

-- ===========================================================================
-- advance_round_tx — + mode guard
--
-- The most important of the three. Its timeout guard compares now() against
-- round_started_at + limit; in an elimination room round_started_at is NULL, so
-- that comparison is NULL, so the guard does not fire and the function advances
-- a turn it knows nothing about. A guard that fails OPEN on NULL is worse than
-- no guard, because it reads like protection.
-- ===========================================================================
create or replace function public.advance_round_tx(
  p_room_id        uuid,
  p_player         uuid,
  p_expected_round int
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_room      public.rooms%rowtype;
  v_rr        public.round_results%rowtype;
  v_now       timestamptz;
  v_deadline  timestamptz;
  v_word_id   text;
  v_word      text;
  v_next      int;
begin
  -- FOR UPDATE serialises concurrent advance calls on this room. The loser of
  -- the race wakes up, finds current_round already moved, and returns the
  -- idempotent "someone else advanced" result instead of double-advancing.
  select * into v_room from public.rooms where id = p_room_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'room_not_found');
  end if;

  -- Session 19: race rooms only. See the header — without this, any MEMBER of
  -- an elimination room can advance somebody else's turn.
  if v_room.mode <> 'race' then
    return jsonb_build_object('ok', false, 'error', 'wrong_mode',
                              'mode', v_room.mode);
  end if;

  if not exists (select 1 from public.room_players
                 where room_id = p_room_id and player_id = p_player) then
    return jsonb_build_object('ok', false, 'error', 'not_a_member');
  end if;

  if v_room.status = 'finished' then
    return jsonb_build_object('ok', true, 'advanced', false, 'finished', true);
  end if;

  if v_room.status <> 'active' then
    return jsonb_build_object('ok', false, 'error', 'room_not_active',
                              'status', v_room.status);
  end if;

  if p_expected_round <> v_room.current_round then
    return jsonb_build_object('ok', true, 'advanced', false, 'finished', false,
                              'current_round', v_room.current_round,
                              'note', 'already_advanced');
  end if;

  select * into v_rr from public.round_results
   where room_id = p_room_id and round_num = v_room.current_round;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'round_not_started');
  end if;

  v_now := now();

  if v_rr.winner_id is not null then
    -- Won: hold the next word until everyone has seen the feedback.
    v_deadline := v_rr.ended_at + (public.feedback_ms() || ' milliseconds')::interval;
    if v_now < v_deadline then
      return jsonb_build_object('ok', false, 'error', 'round_in_progress',
                                'reason', 'feedback_window');
    end if;
  else
    -- Unwon: only a real server-clock timeout ends it. This is the check that
    -- makes "time's up" unfakeable by a client.
    v_deadline := v_room.round_started_at
                  + ((public.round_seconds(v_room.tier) * 1000
                      + public.late_grace_ms()) || ' milliseconds')::interval;
    if v_now < v_deadline then
      return jsonb_build_object('ok', false, 'error', 'round_in_progress',
                                'reason', 'time_remaining');
    end if;
    -- Close out the timed-out round with no winner.
    update public.round_results
       set ended_at = v_now
     where room_id = p_room_id and round_num = v_room.current_round
       and ended_at is null;
  end if;

  -- Streak = consecutive rounds WON. Anyone who didn't take this round loses it
  -- (on a timeout, that is everybody).
  update public.room_players
     set streak = 0
   where room_id = p_room_id
     and (v_rr.winner_id is null or player_id <> v_rr.winner_id);

  v_next := v_room.current_round + 1;

  -- Game over when the round budget is spent or the tier's words run out.
  v_word_id := public.pick_unused_word(p_room_id, v_room.tier);
  if v_word_id is null or v_room.current_round >= public.rounds_per_game() then
    update public.rooms set status = 'finished' where id = p_room_id;
    return jsonb_build_object('ok', true, 'advanced', false, 'finished', true,
                              'rounds_played', v_room.current_round);
  end if;

  select word into v_word from public.words where id = v_word_id;

  -- Same one-transaction reveal as start_game_tx: the next word becomes readable
  -- exactly when the room says the next round started, never before.
  insert into public.round_results (room_id, round_num, word_id)
  values (p_room_id, v_next, v_word_id);

  update public.rooms
     set current_round = v_next, round_started_at = v_now
   where id = p_room_id;

  return jsonb_build_object(
    'ok', true, 'advanced', true, 'finished', false,
    'round_num', v_next,
    'word', v_word,
    'round_started_at', v_now,
    'round_seconds', public.round_seconds(v_room.tier),
    'previous_winner_id', v_rr.winner_id
  );
end;
$$;

-- Signatures are unchanged, so the 0006 grants (service_role only) survive
-- `create or replace`. Restated here so the boundary is visible in this file
-- too, and so re-running the migration is self-contained.
revoke all on function public.start_game_tx(uuid, uuid)               from public, anon, authenticated;
revoke all on function public.submit_answer_tx(uuid, int, uuid, text) from public, anon, authenticated;
revoke all on function public.advance_round_tx(uuid, uuid, int)       from public, anon, authenticated;

grant execute on function public.start_game_tx(uuid, uuid)               to service_role;
grant execute on function public.submit_answer_tx(uuid, int, uuid, text) to service_role;
grant execute on function public.advance_round_tx(uuid, uuid, int)       to service_role;
