-- 0012_elimination_engine.sql
-- Turn-based elimination multiplayer (Session 18) — schema + atomic transitions.
--
-- WHAT THIS REPLACES
-- ------------------------------------------------------------------------------
-- The Session 9a engine (0006) is a SIMULTANEOUS RACE: every player gets the same
-- word at the same moment and the fastest correct answer takes the round. This
-- migration introduces a different game entirely:
--
--   * one player at a time is given a word (the turn holder);
--   * a correct answer survives and passes the turn along a fixed rotation;
--   * a wrong answer OR a timeout costs the turn holder a life;
--   * at 0 lives that player is eliminated and dropped from the rotation;
--   * the game ends the instant exactly one non-eliminated player remains.
--
-- There is no round budget in this mode. `rounds_per_game()` belonged to the race
-- model — an elimination game ends on elimination, not on a round count — so it is
-- neither read nor changed here.
--
-- 0006 is the reference for HOW these functions are built (`for update` on the
-- room, conditional `UPDATE ... WHERE` instead of read-then-write, edge function =
-- auth + HTTP while SQL = the atomic transition), NOT for what they decide.
--
-- WHY BOTH ENGINES STILL EXIST AFTER THIS MIGRATION
-- ------------------------------------------------------------------------------
-- The race engine is live: three deployed edge functions call it and a pg_cron job
-- (0009) drives it. This session is schema + plpgsql only — no edge function and no
-- sweeper changes — so dropping 0006's functions here would break a deployed,
-- playing app between sessions. Instead `rooms.mode` marks which engine owns a
-- room, and the two sets of functions coexist until the edge-function cutover.
--
-- THE INTERLOCK THAT KEEPS THEM APART (important, and deliberately structural)
-- ------------------------------------------------------------------------------
-- `sweep_expired_rounds()` (0009) selects rooms on
--     status = 'active' AND round_started_at IS NOT NULL
-- and hands them to `advance_round_tx`, which knows only the race rules. An
-- elimination room reaching that sweep would be corrupted: it would close the turn,
-- pick a word with no turn holder, and bump the round behind this engine's back.
--
-- So an elimination game NEVER writes `rooms.round_started_at`. It leaves it NULL
-- forever and keeps its per-turn clock on `round_results.turn_started_at` instead.
-- That single fact excludes every elimination room from the existing sweep without
-- editing one character of 0009 — the guard is in the data shape, not in a second
-- copy of a rule that could drift from the first.
--
-- Per-turn timing lives on `round_results` rather than on `rooms` for a second
-- reason too: each turn has its OWN decayed duration (see below), so "how long is
-- the current turn" is a property of the turn, not of the room.
--
-- The new functions additionally reject any room whose `mode` is not 'elimination',
-- so the interlock holds from both directions. The race functions are left byte
-- for byte as 0006 wrote them; the next session retires them along with the edge
-- functions that call them.
--
-- WHO IS IN THE GAME
-- ------------------------------------------------------------------------------
-- The roster is fixed at the moment the game starts. `turn_order` is what records
-- that: start_elimination_game_tx deals a slot to everyone present, and every
-- later question ("is this player still standing?", "who goes next?", "has anyone
-- won?") is asked only of players holding a slot. A row without one is a
-- spectator. This is not a cosmetic distinction — see the mid-game-join note by
-- the room_players columns for the denial of service it closes.

-- ===========================================================================
-- 1. Avatars
--
-- A small FIXED preset set, not free-form text and not an upload: the column
-- stores a key and the client maps it to art in a later session. Defined here as
-- an immutable function so the CHECK constraint and any future client-facing
-- picker read the SAME list — a hand-copied list in two places is exactly the
-- drift this codebase keeps refusing to introduce.
-- ===========================================================================
create or replace function public.avatar_keys()
returns text[]
language sql
immutable
as $$
  select array[
    'bee',      -- the default; the app's own identity
    'queen',
    'drone',
    'hive',
    'honey',
    'blossom',
    'clover',
    'wasp'
  ]::text[];
$$;

comment on function public.avatar_keys() is
  'The fixed set of selectable avatar keys. Single source: room_players.avatar CHECKs against this, and the client picker should render it.';

grant execute on function public.avatar_keys() to authenticated, service_role;

-- ===========================================================================
-- 2. Tunable decay parameters
--
-- Every number the decay curve depends on, in ONE place, so tuning is a single
-- edit and no caller can hold a stale copy. Exposed to clients as well as the
-- server: a later session may want to show "speeding up!" when a threshold is
-- crossed, and it must read the same numbers the server enforces.
--
-- These are a FIRST PASS. They are expected to move once the mode is played; the
-- mechanism below is what this session fixes, not the constants.
-- ===========================================================================
create or replace function public.decay_params()
returns jsonb
language sql
immutable
as $$
  select jsonb_build_object(
    -- --- trigger 1: player count -------------------------------------------
    -- Cut applied the moment the field is down to ceil(N/2) survivors ...
    'player_cut_base',   0.10,
    -- ... plus this much more for every further elimination past that point,
    -- so the pressure keeps building instead of being one flat step.
    'player_cut_step',   0.05,
    -- Ceiling on trigger 1 alone, so a very large lobby cannot decay away the
    -- whole round on player count by itself. It does NOT bind at today's lobby
    -- cap of 8: the deepest reachable step there is ceil(8/2)-2 = 2, i.e. 0.20.
    -- It starts binding from a starting field of 12.
    'player_cut_max',    0.30,

    -- --- trigger 2: table streak, stage 1 -----------------------------------
    'streak_stage1_at',  5,
    'streak_cut_stage1', 0.10,

    -- --- trigger 3: table streak, stage 2 -----------------------------------
    -- Reached at a streak of 9 and ADDITIVE with stage 1, never a replacement
    -- for it: total streak cut becomes 0.10 + 0.15 = 0.25. A table on a run of
    -- 9 is therefore materially more pressured than one on a run of 5, which is
    -- the entire point of having a second stage.
    'streak_stage2_at',  9,
    'streak_cut_stage2', 0.15,

    -- --- floor --------------------------------------------------------------
    -- No combination of triggers may produce a turn shorter than this. It does
    -- not bind today: with a lobby cap of 8 the deepest REACHABLE combined cut
    -- is 1 - (0.80 * 0.75) = 40%, which on the hardest 13s tier still leaves 8s.
    -- The floor exists to keep a future retune honest, not to shape the curve
    -- as it currently stands.
    'min_seconds',       6
  );
$$;

comment on function public.decay_params() is
  'Every tunable in the turn-duration decay curve, in one place. Read by decayed_round_seconds(); safe for clients to read.';

grant execute on function public.decay_params() to authenticated, service_role;

-- ===========================================================================
-- 3. decayed_round_seconds — the ONE definition of how long a turn lasts.
--
-- Same discipline as round_seconds(): the server computes it, the client asks
-- for it, and no client ever derives its own deadline. This function is callable
-- on its own with arbitrary inputs precisely so the curve can be tested and
-- inspected without staging a game.
--
-- THREE INDEPENDENT TRIGGERS, ALL STACKABLE
-- ---------------------------------------------------------------------------
-- 1. PLAYER COUNT. Let N be the number of players when the game STARTED (not the
--    current count) and R the number not yet eliminated. Decay begins once
--    R <= ceil(N/2), and deepens by player_cut_step for each elimination beyond
--    that threshold, capped at player_cut_max.
--
--    EXCEPTION: when N = 2 this trigger never applies at all. A 1v1 is a duel
--    from its first turn — there is no "field thinning out" to reward, and
--    ceil(2/2) = 1 would in any case only be reached at the moment the game ends.
--
-- 2. STREAK, STAGE 1. `rooms.table_streak` counts consecutive correct answers
--    across the WHOLE table, by any player, and resets to 0 on any miss or
--    timeout. At streak_stage1_at it takes streak_cut_stage1 off the turn.
--
-- 3. STREAK, STAGE 2. At the higher streak_stage2_at the same counter takes
--    streak_cut_stage2 off IN ADDITION to stage 1's cut, not instead of it.
--
-- THE COMBINATION FORMULA — spelled out because three stacking factors are easy
-- to get subtly wrong and impossible to reverse-engineer from the code later:
--
--     player_cut = 0                       when N = 2, or R > ceil(N/2)
--                = min(player_cut_max,
--                      player_cut_base + player_cut_step * (ceil(N/2) - R))
--
--     streak_cut = 0                                        when streak < stage1
--                = streak_cut_stage1                        when stage1 <= streak < stage2
--                = streak_cut_stage1 + streak_cut_stage2    when streak >= stage2
--
--     seconds    = round( round_seconds(tier)
--                         * (1 - player_cut)
--                         * (1 - streak_cut) )
--     seconds    = greatest(min_seconds, least(round_seconds(tier), seconds))
--
-- MULTIPLICATIVE, NOT ADDITIVE. The two cuts are combined as independent
-- surviving fractions rather than summed percentages. Summing them can reach or
-- exceed 100% as the tunables grow (0.30 + 0.25 is fine today, but the next
-- person to raise a constant would not find out until a turn was zero seconds
-- long); multiplying cannot ever reach zero, and each factor keeps meaning
-- exactly "this trigger removes this share of what was left".
--
-- ORDER OF APPLICATION. Multiplication commutes, so the two factors may be
-- applied in either order and the result is identical — the order matters only
-- for the CLAMP, which is why there is exactly one clamp and it is applied ONCE,
-- last, to the fully combined value. Clamping between the two factors would make
-- the order significant and the result surprising.
-- ===========================================================================
create or replace function public.decayed_round_seconds(
  p_tier               text,
  p_starting_players   int,
  p_remaining_players  int,
  p_streak             int
)
returns int
language plpgsql
immutable
as $$
declare
  v_p          jsonb := public.decay_params();
  v_base       int   := public.round_seconds(p_tier);
  v_threshold  int;
  v_steps      int;
  v_player_cut numeric := 0;
  v_streak_cut numeric := 0;
  v_secs       int;
begin
  -- Reject nonsense loudly rather than returning a plausible-looking number.
  -- Every internal caller passes values it has just read from the room, so a
  -- failure here means a real bug upstream and should not be smoothed over.
  if p_starting_players is null or p_remaining_players is null or p_streak is null then
    raise exception 'decayed_round_seconds: null player counts or streak'
      using errcode = '22023';
  end if;
  if p_starting_players < 2 then
    raise exception 'decayed_round_seconds: starting players must be >= 2, got %', p_starting_players
      using errcode = '22023';
  end if;
  if p_remaining_players < 0 or p_remaining_players > p_starting_players then
    raise exception 'decayed_round_seconds: remaining (%) must be between 0 and starting (%)',
      p_remaining_players, p_starting_players
      using errcode = '22023';
  end if;
  if p_streak < 0 then
    raise exception 'decayed_round_seconds: streak must be >= 0, got %', p_streak
      using errcode = '22023';
  end if;

  -- Trigger 1 — player count. Skipped entirely for a 1v1.
  if p_starting_players > 2 then
    v_threshold := ceil(p_starting_players::numeric / 2)::int;
    if p_remaining_players <= v_threshold then
      v_steps := v_threshold - p_remaining_players;   -- 0 exactly at the threshold
      v_player_cut := least(
        (v_p->>'player_cut_max')::numeric,
        (v_p->>'player_cut_base')::numeric + (v_p->>'player_cut_step')::numeric * v_steps
      );
    end if;
  end if;

  -- Triggers 2 and 3 — table streak. Stage 2 ADDS to stage 1.
  if p_streak >= (v_p->>'streak_stage2_at')::int then
    v_streak_cut := (v_p->>'streak_cut_stage1')::numeric + (v_p->>'streak_cut_stage2')::numeric;
  elsif p_streak >= (v_p->>'streak_stage1_at')::int then
    v_streak_cut := (v_p->>'streak_cut_stage1')::numeric;
  end if;

  v_secs := round(v_base * (1 - v_player_cut) * (1 - v_streak_cut))::int;

  -- The single clamp, applied once to the combined value (see header).
  return greatest((v_p->>'min_seconds')::int, least(v_base, v_secs));
end;
$$;

comment on function public.decayed_round_seconds(text, int, int, int) is
  'Turn duration after all three decay triggers (player count, streak stage 1, streak stage 2), combined multiplicatively and clamped once. Single source of truth; clients read it, never recompute it.';

grant execute on function public.decayed_round_seconds(text, int, int, int) to authenticated, service_role;

-- ===========================================================================
-- 4. Schema
-- ===========================================================================

-- --- rooms -----------------------------------------------------------------
--
-- `mode` is chosen at creation like `tier` is, and defaults to 'race' so every
-- room that already exists keeps the engine it was created under.
--
-- On client-settable columns: clients hold a table-level INSERT grant on rooms
-- (0002), so a crafted insert can seed current_turn_player_id / starting_players /
-- table_streak / winner_id. That is harmless because start_elimination_game_tx
-- overwrites all four at game start and nothing reads them before then — stated
-- here rather than left for someone to rediscover.
alter table public.rooms
  add column if not exists mode text not null default 'race'
    check (mode in ('race', 'elimination'));

alter table public.rooms
  add column if not exists lives_setting int not null default 3
    check (lives_setting between 1 and 9);

alter table public.rooms
  add column if not exists current_turn_player_id uuid references auth.users (id);

alter table public.rooms
  add column if not exists starting_players int;

alter table public.rooms
  add column if not exists table_streak int not null default 0
    check (table_streak >= 0);

alter table public.rooms
  add column if not exists winner_id uuid references auth.users (id);

comment on column public.rooms.mode is
  'Which engine owns this room: race (0006) or elimination (0012). Set at creation, never changed afterwards.';
comment on column public.rooms.lives_setting is
  'Lives each player starts an elimination game with. Per-room, chosen at creation like tier. Default 3.';
comment on column public.rooms.current_turn_player_id is
  'Whose turn it is right now in an elimination game. NULL in a race room, and NULL once the game is finished.';
comment on column public.rooms.starting_players is
  'Player count captured at game start. The decay curve measures the field against this, not against the live count.';
comment on column public.rooms.table_streak is
  'Consecutive correct answers across the whole table, any player. Reset to 0 by any miss or timeout. Drives decay triggers 2 and 3.';
comment on column public.rooms.winner_id is
  'Last player standing, set when an elimination game finishes. NULL while playing, and NULL in the degenerate draw case (see apply_turn_outcome).';

-- --- room_players ----------------------------------------------------------
--
-- lives/is_eliminated/turn_order are all overwritten by start_elimination_game_tx
-- from rooms.lives_setting, so the defaults here only ever describe a player
-- sitting in a lobby. The same overwrite is what makes the table-level INSERT
-- grant safe: a client that joins claiming lives = 99 has that value replaced the
-- moment the game starts. (start_elimination_game_tx resets score and streak for
-- the same reason.)
alter table public.room_players
  add column if not exists lives int not null default 3
    check (lives >= 0);

alter table public.room_players
  add column if not exists is_eliminated boolean not null default false;

alter table public.room_players
  add column if not exists turn_order int;

alter table public.room_players
  add column if not exists avatar text not null default 'bee'
    check (avatar = any (public.avatar_keys()));

comment on column public.room_players.lives is
  'Lives remaining. Set from rooms.lives_setting at game start; a wrong answer or a timeout costs one.';
comment on column public.room_players.is_eliminated is
  'True once lives hit 0. An eliminated player is skipped by the turn rotation and may not answer.';
comment on column public.room_players.turn_order is
  'Position in the fixed rotation, 0-based. Assigned randomly once at game start; NULL until then.';
comment on column public.room_players.avatar is
  'Chosen avatar key, constrained to avatar_keys(). Client-settable (unlike lives/turn_order) and never reset by the engine.';

-- Avatar is a player's own cosmetic choice, so it joins display_name as the only
-- column a client may UPDATE. The CHECK above is what makes that safe: an
-- arbitrary string is rejected by the constraint, not merely by convention.
grant update (display_name, avatar) on public.room_players to authenticated;

-- --- mid-game joins --------------------------------------------------------
--
-- 0002 grants clients INSERT on room_players behind a policy that pins
-- player_id to auth.uid() but says NOTHING about the room's status, and
-- get_room_by_code() happily returns 'active' rooms. So a client can join a game
-- already in progress. Under the race engine that is harmless — an extra player
-- just starts answering. Under THIS engine it was a live denial of service:
-- such a row has turn_order NULL and is_eliminated false, so it counts as a
-- survivor, which (a) makes "last player standing" unreachable forever and
-- (b) pushes the survivor count above rooms.starting_players, at which point
-- decayed_round_seconds raises 22023 and every subsequent answer AND timeout in
-- that room aborts. One uninvited insert would wedge a game permanently.
--
-- It is fixed in two independent places, because either alone would leave a
-- sharp edge:
--
--   1. HERE, at the perimeter: a restrictive policy refuses the insert outright.
--      Restrictive policies AND with the permissive ones from 0002 rather than
--      OR-ing, so this can only ever subtract permission. It is scoped to
--      elimination rooms that have left the lobby, so race rooms keep 0002's
--      behaviour exactly and 0006 is untouched.
--
--   2. In the engine (see elimination_survivors below): a player is a survivor
--      only if they were actually dealt into the rotation. Even if a row appears
--      by some other route, it is inert rather than corrupting.
--
-- Unlike 0005's self-leave policy, this one cannot subquery rooms directly. That
-- policy works because a player leaving is already a member, so `rooms: members
-- can read their room` lets them see the row; a JOINER is not a member yet, so
-- the same subquery would return nothing and refuse every join, including
-- legitimate ones. Hence the security definer helper.
--
-- No legitimate flow needs a mid-game insert: a reconnecting player still has
-- their row (0005 permits self-delete only in 'lobby'), so they re-enter by
-- reading it, not by re-inserting.
create or replace function public.room_accepts_new_players(p_room_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select not exists (
    select 1 from public.rooms r
    where r.id = p_room_id
      and r.mode = 'elimination'
      and r.status <> 'lobby'
  );
$$;

comment on function public.room_accepts_new_players(uuid) is
  'False only for an elimination room that has left the lobby. SECURITY DEFINER because a joiner is not yet a member and so cannot see the rooms row under its own RLS.';

revoke all on function public.room_accepts_new_players(uuid) from public, anon;
grant execute on function public.room_accepts_new_players(uuid) to authenticated, service_role;

drop policy if exists "room_players: no joining an elimination game in progress" on public.room_players;
create policy "room_players: no joining an elimination game in progress"
  on public.room_players
  as restrictive
  for insert
  to authenticated
  with check (public.room_accepts_new_players(room_id));

-- ---------------------------------------------------------------------------
-- elimination_survivors — the ONE definition of "still standing".
--
-- `turn_order is not null` is the load-bearing half of this predicate. It means
-- "was dealt into the rotation by start_elimination_game_tx", which is exactly
-- the population rooms.starting_players counted. Tying the two together by
-- construction is what guarantees survivors <= starting_players, which is in
-- turn what decayed_round_seconds refuses to accept a violation of. Anyone
-- holding a row without a turn_order is a spectator: never counted, never given
-- a turn, and unable to keep a finished game alive.
--
-- VOLATILE, not STABLE. It is called mid-transaction, after the UPDATE that set
-- is_eliminated, and it must observe that write. A STABLE function would in fact
-- see it too (each plpgsql statement takes a fresh snapshot that includes
-- earlier statements in the same transaction), but the correctness of the win
-- condition should not rest on the reader knowing that rule.
-- ---------------------------------------------------------------------------
create or replace function public.elimination_survivors(p_room_id uuid)
returns int
language sql
volatile
as $$
  select count(*)::int
  from public.room_players
  where room_id = p_room_id
    and turn_order is not null
    and not is_eliminated;
$$;

comment on function public.elimination_survivors(uuid) is
  'Count of players still standing: dealt into the rotation (turn_order not null) and not eliminated. Single definition of the win condition''s population.';

revoke all on function public.elimination_survivors(uuid) from public, anon, authenticated;
grant execute on function public.elimination_survivors(uuid) to service_role;

-- --- round_results ---------------------------------------------------------
--
-- Reused rather than replaced by a new `turns` table, because pick_unused_word()
-- derives "already used" from exactly this table and it is already published to
-- Realtime and covered by a members-only SELECT policy (0002/0007). A new table
-- would have needed all three rebuilt for no gain.
--
-- How to tell the two engines' rows apart:
--   turn_player_id IS NULL  -> a race round (0006). Timing came from
--                              rooms.round_started_at + round_seconds(tier).
--   turn_player_id NOT NULL -> an elimination turn. Timing is turn_started_at +
--                              this row's own round_seconds, and `outcome` is
--                              NULL while the turn is still open.
alter table public.round_results
  add column if not exists turn_player_id uuid references auth.users (id);

alter table public.round_results
  add column if not exists turn_started_at timestamptz;

alter table public.round_results
  add column if not exists round_seconds int;

alter table public.round_results
  add column if not exists outcome text
    check (outcome in ('correct', 'wrong', 'timeout'));

comment on column public.round_results.turn_player_id is
  'Whose turn this row is. NULL marks a pre-Session-18 race round; NOT NULL marks an elimination turn.';
comment on column public.round_results.turn_started_at is
  'Server timestamp this turn''s clock starts. Deliberately NOT rooms.round_started_at: keeping that NULL is what excludes elimination rooms from the 0009 race sweeper.';
comment on column public.round_results.round_seconds is
  'This turn''s decayed duration, frozen at the moment the turn was created so later eliminations cannot retroactively shorten a turn in progress.';
comment on column public.round_results.outcome is
  'How the turn resolved: correct / wrong / timeout. NULL while the turn is still open (or for a race round).';

-- ===========================================================================
-- 5. start_elimination_game_tx — lobby -> active, turn 1.
--
-- TURN ORDER RANDOMIZATION: `row_number() over (order by random())`. One pass
-- over the roster, assigning 0..n-1 in a shuffled order — a uniform permutation
-- with no retry loop and no client input. It is computed ONCE here and never
-- recomputed: the rotation is fixed for the whole game and elimination only
-- removes players from it, so the surviving order stays stable and predictable
-- for the players watching it.
-- ===========================================================================
create or replace function public.start_elimination_game_tx(
  p_room_id uuid,
  p_caller  uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_room    public.rooms%rowtype;
  v_players int;
  v_first   uuid;
  v_word_id text;
  v_word    text;
  v_secs    int;
  v_now     timestamptz;
begin
  -- Same serialisation as start_game_tx: the second concurrent caller waits on
  -- this lock, then finds status <> 'lobby' and is rejected rather than starting
  -- the game twice.
  select * into v_room from public.rooms where id = p_room_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'room_not_found');
  end if;

  if v_room.mode <> 'elimination' then
    return jsonb_build_object('ok', false, 'error', 'wrong_mode',
                              'mode', v_room.mode);
  end if;

  -- Host check against the room row, never against anything the caller asserted.
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

  -- Shuffle the rotation and reset every per-game counter in one statement.
  -- Resetting score/streak here is also what neutralises the table-level INSERT
  -- grant on room_players: whatever a joiner put in those columns is replaced.
  -- `avatar` is deliberately absent — that is the player's own choice to keep.
  with ordered as (
    select player_id,
           (row_number() over (order by random()) - 1)::int as ord
    from public.room_players
    where room_id = p_room_id
  )
  update public.room_players rp
     set turn_order    = o.ord,
         lives         = v_room.lives_setting,
         is_eliminated = false,
         score         = 0,
         streak        = 0
    from ordered o
   where rp.room_id = p_room_id
     and rp.player_id = o.player_id;

  select player_id into v_first
    from public.room_players
   where room_id = p_room_id
   order by turn_order
   limit 1;

  -- At the opening turn nothing has decayed yet: the field is whole and the
  -- streak is zero, so this necessarily equals round_seconds(tier). It is still
  -- routed through decayed_round_seconds so there is exactly one code path that
  -- decides a turn's length.
  v_secs := public.decayed_round_seconds(v_room.tier, v_players, v_players, 0);

  -- One transaction, same reveal guarantee as 0006: the turn's word becomes
  -- readable to clients at exactly the moment the room says the turn began.
  insert into public.round_results
    (room_id, round_num, word_id, turn_player_id, turn_started_at, round_seconds)
  values
    (p_room_id, 1, v_word_id, v_first, v_now, v_secs);

  -- round_started_at is pointedly NOT set. See the interlock note in the header:
  -- leaving it NULL is what keeps the 0009 race sweeper away from this room.
  update public.rooms
     set status                 = 'active',
         current_round          = 1,
         current_turn_player_id = v_first,
         starting_players       = v_players,
         table_streak           = 0,
         winner_id              = null
   where id = p_room_id;

  return jsonb_build_object(
    'ok', true,
    'round_num', 1,
    'word', v_word,
    'turn_player_id', v_first,
    'turn_started_at', v_now,
    'round_seconds', v_secs,
    'lives', v_room.lives_setting,
    'starting_players', v_players,
    'tier', v_room.tier
  );
end;
$$;

comment on function public.start_elimination_game_tx(uuid, uuid) is
  'Host-only lobby->active for an elimination room: randomizes the turn rotation, deals lives from rooms.lives_setting, and opens turn 1. service_role only.';

-- ===========================================================================
-- 6. apply_turn_outcome — the ONE place a turn resolves.
--
-- Everything that happens after "we know whether this turn was answered
-- correctly" lives here and nowhere else: scoring, life loss, elimination, the
-- table streak, the win check, choosing the next turn holder, and computing the
-- next turn's decayed duration. Both entry points (a submitted answer and a
-- server-clock timeout) call it, which is what stops a timeout from growing its
-- own slightly-different copy of the elimination rule — the same reasoning that
-- made advance_round_tx the single advancement path in 0006.
--
-- PRECONDITIONS, enforced by the callers rather than re-checked here:
--   * the caller already holds `select ... for update` on the room, so every
--     write below is inside that serialised section;
--   * the room is 'active', in mode 'elimination', and p_round_num is its
--     current round;
--   * p_player is the turn holder for that round.
-- It is not client-callable and not part of the public surface (see grants).
-- ===========================================================================
create or replace function public.apply_turn_outcome(
  p_room_id    uuid,
  p_round_num  int,
  p_player     uuid,
  p_correct    boolean,
  p_outcome    text,
  p_elapsed_ms int,
  p_now        timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_room       public.rooms%rowtype;
  v_turn_secs  int;
  v_points     int := 0;
  v_lives      int;
  v_eliminated boolean := false;
  v_streak     int;
  v_remaining  int;
  v_winner     uuid;
  v_next       uuid;
  v_current_order int;   -- the RESOLVING player's slot; the rotation reads forward from it
  v_next_num   int;
  v_word_id    text;
  v_word       text;
  v_secs       int;
  v_starts     timestamptz;
  v_top_lives  int;
  v_top_score  int;
  v_run_lives  int;
  v_run_score  int;
begin
  -- Close the turn with a conditional UPDATE rather than a read-then-write: only
  -- the caller that finds ended_at still NULL owns this resolution. Belt and
  -- braces next to the room lock, and the pattern 0006 established for the
  -- winner claim.
  update public.round_results
     set outcome          = p_outcome,
         ended_at         = p_now,
         winner_id        = case when p_correct then p_player else null end,
         response_time_ms = case when p_correct then p_elapsed_ms else null end
   where room_id   = p_room_id
     and round_num = p_round_num
     and ended_at is null
  returning round_seconds into v_turn_secs;

  if not found then
    return jsonb_build_object('ok', false, 'error', 'turn_already_resolved');
  end if;

  -- Plain SELECT: we are inside the caller's transaction and its row lock, and
  -- it sees our own uncommitted writes. Re-locking here would be a no-op.
  select * into v_room from public.rooms where id = p_room_id;

  if p_correct then
    -- Scoring keeps the singleplayer shape (10 + whole seconds left) but is
    -- measured against THIS turn's decayed length, so a short late-game turn is
    -- worth less bonus than a long opening one. Deliberate: the clock is the
    -- difficulty, so it should also be the reward.
    v_points := 10 + greatest(0, ((v_turn_secs * 1000 - p_elapsed_ms) / 1000)::int);

    update public.room_players
       set score  = score + v_points,
           streak = streak + 1
     where room_id = p_room_id and player_id = p_player
    returning lives into v_lives;

    update public.rooms
       set table_streak = table_streak + 1
     where id = p_room_id
    returning table_streak into v_streak;
  else
    -- A wrong answer and a timeout are the same event to the game: one life.
    update public.room_players
       set lives  = greatest(0, lives - 1),
           streak = 0
     where room_id = p_room_id and player_id = p_player
    returning lives into v_lives;

    if v_lives = 0 then
      update public.room_players
         set is_eliminated = true
       where room_id = p_room_id
         and player_id = p_player
         and not is_eliminated;
      v_eliminated := found;
    end if;

    update public.rooms set table_streak = 0 where id = p_room_id;
    v_streak := 0;
  end if;

  -- --- win condition -------------------------------------------------------
  -- Checked on every resolution, not only on an elimination, so it can never be
  -- missed. "Last player standing" is literally this count reaching 1.
  v_remaining := public.elimination_survivors(p_room_id);

  if v_remaining <= 1 then
    select player_id into v_winner
      from public.room_players
     where room_id = p_room_id
       and turn_order is not null
       and not is_eliminated
     limit 1;   -- NULL only if a lives_setting of 1 somehow took the last two at once

    update public.rooms
       set status                 = 'finished',
           winner_id              = v_winner,
           current_turn_player_id = null
     where id = p_room_id;

    return jsonb_build_object(
      'ok', true, 'correct', p_correct, 'outcome', p_outcome,
      'points', v_points, 'lives', v_lives, 'eliminated', v_eliminated,
      'table_streak', v_streak, 'remaining_players', v_remaining,
      'finished', true, 'winner_id', v_winner, 'reason', 'last_player_standing'
    );
  end if;

  -- --- word supply ---------------------------------------------------------
  -- A tier holds ~150 words and an elimination game is short, so this is a
  -- degenerate case rather than an expected ending — but it must not corrupt the
  -- game, so it ends it. The winner is whoever is strictly ahead on lives, then
  -- on score; a genuine tie finishes with winner_id NULL, which is an honest draw
  -- rather than an arbitrary pick.
  v_word_id := public.pick_unused_word(p_room_id, v_room.tier);
  if v_word_id is null then
    select lives, score into v_top_lives, v_top_score
      from public.room_players
     where room_id = p_room_id and turn_order is not null and not is_eliminated
     order by lives desc, score desc
     limit 1;

    select lives, score into v_run_lives, v_run_score
      from public.room_players
     where room_id = p_room_id and turn_order is not null and not is_eliminated
     order by lives desc, score desc
     offset 1 limit 1;

    if v_top_lives > v_run_lives or (v_top_lives = v_run_lives and v_top_score > v_run_score) then
      select player_id into v_winner
        from public.room_players
       where room_id = p_room_id and turn_order is not null and not is_eliminated
       order by lives desc, score desc
       limit 1;
    else
      v_winner := null;
    end if;

    update public.rooms
       set status                 = 'finished',
           winner_id              = v_winner,
           current_turn_player_id = null
     where id = p_room_id;

    return jsonb_build_object(
      'ok', true, 'correct', p_correct, 'outcome', p_outcome,
      'points', v_points, 'lives', v_lives, 'eliminated', v_eliminated,
      'table_streak', v_streak, 'remaining_players', v_remaining,
      'finished', true, 'winner_id', v_winner, 'reason', 'no_words_for_tier'
    );
  end if;

  -- --- pass the turn -------------------------------------------------------
  -- Next live player clockwise from the current one, wrapping around. Eliminated
  -- players are filtered out by the WHERE, so a player who was knocked out by
  -- this very resolution is skipped without any special case — and because
  -- turn_order is never renumbered, the surviving players keep the rotation they
  -- have been watching all game.
  --
  -- Both queries carry `turn_order is not null` for the same reason the survivor
  -- count does. The first would exclude a spectator anyway (NULL > n is NULL, not
  -- true), but the wrap-around ORDER BY sorts NULLs LAST rather than excluding
  -- them, so without the predicate a spectator could be handed a turn nobody
  -- could take. Stated once, applied uniformly, rather than relying on two
  -- different accidents of NULL semantics.
  select turn_order into v_current_order
    from public.room_players
   where room_id = p_room_id and player_id = p_player;

  select player_id into v_next
    from public.room_players
   where room_id = p_room_id
     and turn_order is not null
     and not is_eliminated
     and turn_order > v_current_order
   order by turn_order
   limit 1;

  if v_next is null then
    select player_id into v_next
      from public.room_players
     where room_id = p_room_id
       and turn_order is not null
       and not is_eliminated
     order by turn_order
     limit 1;
  end if;

  select word into v_word from public.words where id = v_word_id;

  -- The next turn's length is computed from the state AFTER this resolution:
  -- the survivor count and table streak that this turn just produced.
  v_secs := public.decayed_round_seconds(
    v_room.tier, v_room.starting_players, v_remaining, v_streak
  );

  -- The feedback window is folded into the clock instead of needing a second
  -- round trip: the next turn's row exists immediately, but its clock starts
  -- feedback_ms from now, so every client shows the same beat of "right/wrong"
  -- before the next player is on the hook. submit_turn_answer_tx refuses
  -- submissions that arrive before that instant.
  v_starts   := p_now + (public.feedback_ms() || ' milliseconds')::interval;
  v_next_num := p_round_num + 1;

  insert into public.round_results
    (room_id, round_num, word_id, turn_player_id, turn_started_at, round_seconds)
  values
    (p_room_id, v_next_num, v_word_id, v_next, v_starts, v_secs);

  update public.rooms
     set current_round          = v_next_num,
         current_turn_player_id = v_next
   where id = p_room_id;

  return jsonb_build_object(
    'ok', true, 'correct', p_correct, 'outcome', p_outcome,
    'points', v_points, 'lives', v_lives, 'eliminated', v_eliminated,
    'table_streak', v_streak, 'remaining_players', v_remaining,
    'finished', false,
    'next_round_num', v_next_num,
    'next_turn_player_id', v_next,
    'next_word', v_word,
    'next_turn_started_at', v_starts,
    'next_round_seconds', v_secs
  );
end;
$$;

comment on function public.apply_turn_outcome(uuid, int, uuid, boolean, text, int, timestamptz) is
  'Internal: resolves one turn (score or life loss, elimination, table streak, win check, next turn + its decayed duration). Assumes the caller holds the room lock. Not client-callable.';

-- ===========================================================================
-- 7. submit_turn_answer_tx — the turn holder's answer.
--
-- Accepts no client-supplied correctness and no client-supplied timing, exactly
-- as submit_answer_tx does not: the word is read from the server's own turn row
-- and the elapsed time is measured from turn_started_at to server receipt.
-- ===========================================================================
create or replace function public.submit_turn_answer_tx(
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
  v_rp         public.room_players%rowtype;
  v_word       text;
  v_now        timestamptz;
  v_elapsed_ms int;
  v_limit_ms   int;
  v_correct    boolean;
begin
  -- FOR UPDATE from the start: unlike the race engine, resolving an answer here
  -- MOVES the turn, so the whole check-then-resolve sequence has to be inside
  -- one serialised section on the room row. Two concurrent submissions queue
  -- here; the second wakes to a room whose current_round has already moved and
  -- is rejected by the stale-round check below.
  select * into v_room from public.rooms where id = p_room_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'room_not_found');
  end if;

  if v_room.mode <> 'elimination' then
    return jsonb_build_object('ok', false, 'error', 'wrong_mode', 'mode', v_room.mode);
  end if;

  select * into v_rp from public.room_players
   where room_id = p_room_id and player_id = p_player;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'not_a_member');
  end if;

  if v_room.status <> 'active' then
    return jsonb_build_object('ok', false, 'error', 'room_not_active',
                              'status', v_room.status);
  end if;

  -- Stale round: a delayed or replayed request for a turn that has already
  -- resolved can never score. Same guard, same name, as 0006.
  if p_round_num <> v_room.current_round then
    return jsonb_build_object('ok', false, 'error', 'stale_round',
                              'current_round', v_room.current_round);
  end if;

  -- OUT OF TURN. The defining rejection of this engine, and the reason the room
  -- row is locked above: current_turn_player_id is read inside the serialised
  -- section, so it cannot have moved between the check and the resolution.
  if v_rp.is_eliminated then
    return jsonb_build_object('ok', false, 'error', 'eliminated');
  end if;

  if v_room.current_turn_player_id is distinct from p_player then
    return jsonb_build_object('ok', false, 'error', 'not_your_turn',
                              'current_turn_player_id', v_room.current_turn_player_id);
  end if;

  select * into v_rr from public.round_results
   where room_id = p_room_id and round_num = p_round_num;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'turn_not_started');
  end if;

  -- Defensive: the room and the turn row must name the same holder. They are
  -- written together in one transaction, so disagreement means corruption, and
  -- corruption should stop the call rather than pick one of the two to believe.
  if v_rr.turn_player_id is distinct from p_player then
    return jsonb_build_object('ok', false, 'error', 'not_your_turn',
                              'current_turn_player_id', v_rr.turn_player_id);
  end if;

  if v_rr.ended_at is not null then
    return jsonb_build_object('ok', false, 'error', 'turn_already_resolved');
  end if;

  v_now := now();

  -- Turn hasn't opened yet: the previous resolution set this turn's clock
  -- feedback_ms into the future. Rejected explicitly rather than silently
  -- clamped to zero, which would hand the next player a full time bonus for
  -- answering during someone else's feedback. late_grace_ms is reused as a
  -- symmetric tolerance so a client a few ms ahead of the server is not punished.
  if v_now < v_rr.turn_started_at - (public.late_grace_ms() || ' milliseconds')::interval then
    return jsonb_build_object('ok', false, 'error', 'turn_not_started',
                              'turn_started_at', v_rr.turn_started_at);
  end if;

  v_elapsed_ms := greatest(0, floor(extract(epoch from (v_now - v_rr.turn_started_at)) * 1000)::int);
  v_limit_ms   := v_rr.round_seconds * 1000;

  -- Past the deadline: this is a timeout, and timeout_turn_tx owns timeouts.
  -- Rejecting instead of resolving keeps one rule in one place.
  if v_elapsed_ms > v_limit_ms + public.late_grace_ms() then
    return jsonb_build_object('ok', false, 'error', 'turn_expired',
                              'response_time_ms', v_elapsed_ms,
                              'round_seconds', v_rr.round_seconds);
  end if;

  select w.word into v_word from public.words w where w.id = v_rr.word_id;
  v_correct := lower(btrim(p_guess)) = lower(v_word);

  -- One attempt per player per round, enforced by the PK rather than by a
  -- read-then-check. In this mode a second attempt is already impossible (the
  -- turn resolves on the first), so this is the backstop for a retried HTTP call.
  begin
    insert into public.round_attempts
      (room_id, round_num, player_id, guess, is_correct, response_time_ms)
    values
      (p_room_id, p_round_num, p_player, p_guess, v_correct, v_elapsed_ms);
  exception when unique_violation then
    return jsonb_build_object('ok', false, 'error', 'already_submitted');
  end;

  return public.apply_turn_outcome(
    p_room_id,
    p_round_num,
    p_player,
    v_correct,
    case when v_correct then 'correct' else 'wrong' end,
    v_elapsed_ms,
    v_now
  );
end;
$$;

comment on function public.submit_turn_answer_tx(uuid, int, uuid, text) is
  'The turn holder answers. Validates membership, turn ownership and the server clock, then resolves through apply_turn_outcome. Rejects out-of-turn, eliminated, stale, early and expired submissions explicitly. service_role only.';

-- ===========================================================================
-- 8. timeout_turn_tx — the turn holder ran out of time.
--
-- A timeout is worth exactly one life, the same as a wrong answer, so this does
-- nothing but establish that the deadline really has passed and then hand over to
-- apply_turn_outcome. The caller's claim that time is up is never trusted: it is
-- re-derived from turn_started_at and this turn's own frozen round_seconds
-- against the server clock, which is what makes "time's up" unfakeable.
--
-- p_caller is OPTIONAL. A client-triggered nudge passes the requesting player and
-- gets the membership guard; the scheduled sweeper (next session) passes NULL,
-- because a timeout is a pure server-clock fact with no acting player. 0009 had to
-- invent an actor to satisfy advance_round_tx's guard — this signature says so
-- instead of pretending.
--
-- No round_attempts row is written for a timeout: that table records submissions,
-- and there was none. `round_results.outcome = 'timeout'` is the record.
-- ===========================================================================
create or replace function public.timeout_turn_tx(
  p_room_id        uuid,
  p_expected_round int,
  p_caller         uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_room     public.rooms%rowtype;
  v_rr       public.round_results%rowtype;
  v_now      timestamptz;
  v_deadline timestamptz;
begin
  select * into v_room from public.rooms where id = p_room_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'room_not_found');
  end if;

  if v_room.mode <> 'elimination' then
    return jsonb_build_object('ok', false, 'error', 'wrong_mode', 'mode', v_room.mode);
  end if;

  if p_caller is not null
     and not exists (select 1 from public.room_players
                     where room_id = p_room_id and player_id = p_caller) then
    return jsonb_build_object('ok', false, 'error', 'not_a_member');
  end if;

  if v_room.status = 'finished' then
    return jsonb_build_object('ok', true, 'resolved', false, 'finished', true);
  end if;

  if v_room.status <> 'active' then
    return jsonb_build_object('ok', false, 'error', 'room_not_active',
                              'status', v_room.status);
  end if;

  -- Lost the race to whoever advanced this turn already. Idempotent rather than
  -- an error, exactly as advance_round_tx treats the same situation: the caller
  -- wanted the turn moved on and it has been.
  if p_expected_round <> v_room.current_round then
    return jsonb_build_object('ok', true, 'resolved', false, 'finished', false,
                              'current_round', v_room.current_round,
                              'note', 'already_advanced');
  end if;

  select * into v_rr from public.round_results
   where room_id = p_room_id and round_num = v_room.current_round;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'turn_not_started');
  end if;

  if v_rr.ended_at is not null then
    return jsonb_build_object('ok', true, 'resolved', false, 'finished', false,
                              'note', 'already_advanced');
  end if;

  v_now := now();
  v_deadline := v_rr.turn_started_at
                + ((v_rr.round_seconds * 1000 + public.late_grace_ms()) || ' milliseconds')::interval;

  if v_now < v_deadline then
    return jsonb_build_object('ok', false, 'error', 'turn_in_progress',
                              'reason', 'time_remaining',
                              'deadline', v_deadline);
  end if;

  return public.apply_turn_outcome(
    p_room_id,
    v_room.current_round,
    v_rr.turn_player_id,
    false,
    'timeout',
    v_rr.round_seconds * 1000,
    v_now
  );
end;
$$;

comment on function public.timeout_turn_tx(uuid, int, uuid) is
  'Resolves an expired turn as a life lost, after re-deriving the deadline from the server clock. p_caller optional: a member for a client nudge, NULL for the scheduled sweeper. service_role only.';

-- ===========================================================================
-- 9. GRANTS — the security boundary, identical in shape to 0006's.
--
-- The three transition functions take the acting player as a parameter, so a
-- client able to call them directly could impersonate anyone. service_role only,
-- reachable exclusively through an edge function that has already verified the
-- caller's JWT. apply_turn_outcome is stricter still: it assumes a lock its
-- caller took, so it is not a valid entry point for anyone.
--
-- The two pure calculations are safe and useful to clients — a client must be
-- able to ask how long the current turn is without ever computing it itself —
-- and are granted alongside round_seconds().
-- ===========================================================================
revoke all on function public.start_elimination_game_tx(uuid, uuid)                              from public, anon, authenticated;
revoke all on function public.submit_turn_answer_tx(uuid, int, uuid, text)                       from public, anon, authenticated;
revoke all on function public.timeout_turn_tx(uuid, int, uuid)                                   from public, anon, authenticated;
revoke all on function public.apply_turn_outcome(uuid, int, uuid, boolean, text, int, timestamptz) from public, anon, authenticated;

grant execute on function public.start_elimination_game_tx(uuid, uuid)                              to service_role;
grant execute on function public.submit_turn_answer_tx(uuid, int, uuid, text)                       to service_role;
grant execute on function public.timeout_turn_tx(uuid, int, uuid)                                   to service_role;
grant execute on function public.apply_turn_outcome(uuid, int, uuid, boolean, text, int, timestamptz) to service_role;
