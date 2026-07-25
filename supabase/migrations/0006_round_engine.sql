-- 0006_round_engine.sql
-- Server-authoritative round engine (Session 9a).
--
-- ARCHITECTURE — why the game logic lives in SQL rather than in the edge function
-- ------------------------------------------------------------------------------
-- Every state transition here is multi-statement AND concurrent:
--   * two players can submit a correct answer in the same millisecond
--   * two clients can call advance-round at the same moment
--   * a round must become visible to clients only once it has actually started
-- A plpgsql function runs in a single transaction, so a conditional UPDATE plus
-- the follow-up writes are atomic together. Doing the same from an edge function
-- over PostgREST would be a read-then-write race across separate HTTP calls.
--
-- So the split is:
--   edge function  = authentication (whose token is this?) + HTTP contract
--   SQL function   = the atomic state transition
--
-- SECURITY: these functions take the acting player as a PARAMETER, so a client
-- able to call them directly could impersonate anyone. They are therefore
-- granted to service_role ONLY (see grants at the bottom) — reachable exclusively
-- through an edge function that has already verified the caller's JWT.
--
-- WORD SECRECY: the word for round N is written to round_results at the instant
-- round N starts, in the same transaction that bumps rooms.current_round. Since
-- clients read words through round_results (members-only SELECT, migration 0002),
-- a future round's word simply does not exist in any client-readable row yet.
-- That is what prevents prefetching. Once a round starts the client necessarily
-- learns the text — it has to pronounce it via the Web Speech API — which is an
-- accepted property of the design, not a hole this migration tries to close.

-- ---------------------------------------------------------------------------
-- rooms.round_started_at — the server clock reference for the current round.
-- Every response time and every timeout is measured from this, never from a
-- client-reported duration.
-- ---------------------------------------------------------------------------
alter table public.rooms
  add column if not exists round_started_at timestamptz;

comment on column public.rooms.round_started_at is
  'Server timestamp when the current round began. Sole reference for response times and timeouts; set only by the Session 9a SQL functions.';

-- ---------------------------------------------------------------------------
-- round_attempts — one row per player per round, inserted on every submission.
--
-- Two jobs:
--   1. The (room_id, round_num, player_id) primary key IS the duplicate-submission
--      guard: a second submission from the same player in the same round raises
--      unique_violation rather than needing a read-then-check.
--   2. An audit trail of wrong answers, which round_results (one row per round)
--      structurally cannot hold.
--
-- Deliberately has NO grants and NO policies: RLS is enabled and nothing is
-- granted to anon/authenticated, so it is server-only. Clients never need it,
-- and not exposing it means one player's correct guess can't leak the word to
-- others still typing during the feedback window.
-- ---------------------------------------------------------------------------
create table if not exists public.round_attempts (
  room_id          uuid not null references public.rooms (id) on delete cascade,
  round_num        int  not null,
  player_id        uuid not null references auth.users (id) on delete cascade,
  guess            text not null,
  is_correct       boolean not null,
  response_time_ms int  not null,
  created_at       timestamptz not null default now(),
  primary key (room_id, round_num, player_id)
);

comment on table public.round_attempts is
  'Every answer submission (right or wrong). PK doubles as the one-attempt-per-player-per-round guard. Server-only: RLS on, no grants.';

alter table public.round_attempts enable row level security;

-- Reason: written by edge functions (service role, bypasses RLS) only. No grant
-- and no policy for anon/authenticated means every client read and write is
-- denied by default — stated explicitly rather than left implicit.

-- ---------------------------------------------------------------------------
-- Tunable game constants, as functions so there is exactly one definition each.
-- ---------------------------------------------------------------------------

-- Seconds per word, mirroring ROUND_SECONDS in src/hooks/useGameEngine.ts.
-- Keep the two in sync: the client renders the countdown, the server enforces it.
create or replace function public.round_seconds(p_tier text)
returns int
language sql
immutable
as $$
  select case p_tier
    when 'easy'   then 20
    when 'medium' then 16
    when 'hard'   then 13
    when 'expert' then 11
    else 16
  end;
$$;

-- How many rounds make a game. The word bank holds 30 per tier, and a 30-round
-- match is far too long, so a game ends at this many rounds OR when the tier's
-- unused words run out, whichever comes first. Product decision — change here.
create or replace function public.rounds_per_game()
returns int
language sql
immutable
as $$ select 10; $$;

-- Grace added to the round limit before a submission is rejected as late. The
-- measured time is the server's RECEIPT time, so it includes the client's
-- network latency; without a grace, a player who answered at 15.9s on a 16s
-- round could be rejected purely for having a slow connection.
create or replace function public.late_grace_ms()
returns int
language sql
immutable
as $$ select 750; $$;

-- How long the round-over feedback stays on screen before the next word. Mirrors
-- FEEDBACK_DELAY_MS in useGameEngine.ts. Enforced server-side so every client
-- advances together — otherwise the first client to call advance-round would
-- yank the next word onto everyone else's screen mid-feedback.
create or replace function public.feedback_ms()
returns int
language sql
immutable
as $$ select 1100; $$;

-- ---------------------------------------------------------------------------
-- Helper: pick a word for this room that it hasn't used yet this session.
-- "Used" is derived from round_results (one row per round, holding word_id), so
-- there is no separate used-words column or table to keep in sync.
-- ---------------------------------------------------------------------------
create or replace function public.pick_unused_word(p_room_id uuid, p_tier text)
returns text
language sql
volatile
as $$
  select w.id
  from public.words w
  where w.tier = p_tier
    and not exists (
      select 1 from public.round_results rr
      where rr.room_id = p_room_id and rr.word_id = w.id
    )
  order by random()
  limit 1;
$$;

-- ===========================================================================
-- start_game_tx — lobby -> active, round 1.
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

comment on function public.start_game_tx(uuid, uuid) is
  'Host-only lobby->active transition: validates host/status/player-count, picks round 1s word, and starts the clock. service_role only.';

-- ===========================================================================
-- submit-answer — correctness and timing computed entirely server-side.
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

comment on function public.submit_answer_tx(uuid, int, uuid, text) is
  'Server-side answer validation: checks membership/round, computes correctness and response time from the server clock, and atomically awards the round to the first correct submission. service_role only.';

-- ===========================================================================
-- advance_round_tx — the SINGLE path from "round over" to "next word".
--
-- WHY ONE FUNCTION FOR BOTH ENDINGS (design decision, per the session brief):
-- A round ends either because somebody won it or because time ran out. A
-- timeout has no winning request to piggyback on, so a separate advancement
-- entry point is needed regardless. Having the winning submit-answer ALSO
-- advance would mean two copies of "reset streaks, pick the next word, detect
-- exhaustion, finish the game" — and it would skip the feedback window, since
-- the server cannot schedule a delayed write. So both endings funnel through
-- here, and the function decides whether the round is genuinely over.
--
-- It is callable by any member, which is safe because the caller's claim that
-- time is up is never trusted: the server re-derives it from round_started_at
-- against its own clock. A losing player calling this early is rejected.
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

comment on function public.advance_round_tx(uuid, uuid, int) is
  'Single advancement path for both a won and a timed-out round. Re-derives "round is over" from the server clock, so a client cannot force an early advance. service_role only.';

-- ---------------------------------------------------------------------------
-- GRANTS — the security boundary for this whole migration.
--
-- These functions accept the acting player as a parameter, so direct client
-- access would be impersonation. Only service_role (i.e. an edge function that
-- has already verified the caller's JWT) may execute them.
-- ---------------------------------------------------------------------------
revoke all on function public.start_game_tx(uuid, uuid)              from public, anon, authenticated;
revoke all on function public.submit_answer_tx(uuid, int, uuid, text) from public, anon, authenticated;
revoke all on function public.advance_round_tx(uuid, uuid, int)      from public, anon, authenticated;

grant execute on function public.start_game_tx(uuid, uuid)               to service_role;
grant execute on function public.submit_answer_tx(uuid, int, uuid, text) to service_role;
grant execute on function public.advance_round_tx(uuid, uuid, int)       to service_role;

-- Internal helpers: never client-callable either.
revoke all on function public.pick_unused_word(uuid, text) from public, anon, authenticated;
grant execute on function public.pick_unused_word(uuid, text) to service_role;

-- Constants are harmless to read and useful to clients for rendering the
-- countdown, so these stay executable by signed-in players.
grant execute on function public.round_seconds(text)  to authenticated, service_role;
grant execute on function public.rounds_per_game()    to authenticated, service_role;
grant execute on function public.late_grace_ms()      to authenticated, service_role;
grant execute on function public.feedback_ms()        to authenticated, service_role;
