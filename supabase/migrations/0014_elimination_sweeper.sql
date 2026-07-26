-- 0014_elimination_sweeper.sql
-- Advance expired ELIMINATION turns with no client attached (Session 19).
--
-- WHAT THIS ADDS AND WHAT IT POINTEDLY DOES NOT TOUCH
-- ---------------------------------------------------------------------------
-- 0009 gave race mode an unattended clock: pg_cron calls sweep_expired_rounds()
-- every 5 seconds, which asks advance_round_tx about every active race room.
-- Elimination rooms are invisible to it, because 0009 filters on
--     status = 'active' AND round_started_at IS NOT NULL
-- and an elimination game never writes rooms.round_started_at (that NULL is the
-- deliberate interlock documented in 0012 — it is what keeps the race sweeper
-- from corrupting a turn-based room). Verified live in Session 18, not assumed.
--
-- The consequence is that today an elimination turn only ends if somebody calls
-- submit-turn. A player who closes their tab on their own turn stalls the game
-- for everyone else, permanently.
--
-- This migration is an ADDITION: sweep_expired_rounds() is not altered, not
-- dropped, and not re-created, and its cron job is left exactly as 0009
-- scheduled it. A SECOND function and a SECOND job handle elimination. That is
-- a deliberate choice over folding both into one sweeper:
--
--   * the two engines' "is it over?" rules live in different SQL functions
--     (advance_round_tx vs timeout_turn_tx), so a combined loop would need a
--     branch on mode — a rule about engines living in the sweeper, which is
--     exactly what 0009 says the sweeper must never contain;
--   * rewriting a function that has been running in production since Session 10
--     to add a feature it doesn't need is risk with no upside.
--
-- THE TWO SWEEPS CANNOT COLLIDE. Their candidate sets are provably disjoint:
-- a room is in 0009's sweep only if round_started_at IS NOT NULL, which only
-- the race engine ever writes; a room is in this sweep only if mode =
-- 'elimination', and start_elimination_game_tx never writes round_started_at.
-- No room can satisfy both. (Even if one somehow did, both transition functions
-- open with `select ... for update` on the room and reject a call whose expected
-- round has moved, so the worst case is one wasted call — the same property
-- 0009 relies on when a client races it.)
--
-- NO DEADLINE PREDICATE — this is the one place the brief and 0009's stated rule
-- pull in different directions, and 0009 wins. It would be easy to write
--     ... and rr.turn_started_at + rr.round_seconds * interval '1 second' < now()
-- into the WHERE clause below, and the brief describes the sweep in those terms.
-- But 0009 says, in as many words: "Do NOT add a deadline predicate to the
-- sweep's WHERE clause -- that would create a second copy of the rule that can
-- drift." That rule applies here with more force, not less: an elimination
-- turn's deadline is turn_started_at plus THIS TURN'S OWN frozen round_seconds
-- plus late_grace_ms(), where the duration came from the three-trigger decay
-- curve. Restating that arithmetic here would put a copy of the decay contract
-- in a scheduler, and the day someone retunes decay_params() the two would
-- silently disagree. timeout_turn_tx already re-derives the deadline from the
-- server clock and returns turn_in_progress without writing when a turn is not
-- due, so it is a cheap no-op — the identical bargain 0009 struck. The outcome
-- is the same; only the number of places that know the rule differs.

-- ---------------------------------------------------------------------------
-- sweep_expired_turns — the scheduled caller for elimination rooms.
--
-- ON THE ACTOR: unlike 0009, this passes no acting player at all.
-- timeout_turn_tx takes p_caller as an OPTIONAL parameter specifically for this
-- caller (see 0012): a timeout is a pure server-clock fact with no human behind
-- it. 0009 had to invent an actor — the room's earliest-joined member — purely
-- to satisfy advance_round_tx's membership guard. This signature says so
-- instead of pretending, so there is no fictitious player in the audit trail.
--
-- ON THE ORDERING: 0009 sorts oldest-round-first so that a backlog beyond the
-- per-tick limit cannot starve anyone. The analogous key here is the current
-- turn's start time, which lives on round_results rather than on rooms, hence
-- the join. The join is for ORDERING only — it filters nothing that matters,
-- since an active elimination room always has a row for its current round
-- (start_elimination_game_tx and apply_turn_outcome each insert it in the same
-- transaction that bumps current_round). A room somehow missing that row is
-- skipped here and would have been told turn_not_started anyway.
-- ---------------------------------------------------------------------------
create or replace function public.sweep_expired_turns()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  r          record;
  v_res      jsonb;
  v_checked  int := 0;
  v_resolved int := 0;
  v_finished int := 0;
begin
  for r in
    select rm.id, rm.current_round
    from public.rooms rm
    join public.round_results rr
      on rr.room_id = rm.id
     and rr.round_num = rm.current_round
    where rm.status = 'active'
      and rm.mode = 'elimination'
    order by rr.turn_started_at
    -- Same bound and same reasoning as 0009: one tick can never hold room locks
    -- for an unbounded time, and oldest-turn-first means nothing is starved.
    limit 200
  loop
    v_checked := v_checked + 1;

    -- p_caller omitted -> NULL. timeout_turn_tx decides whether this turn is
    -- actually due; this loop does not know and must not guess.
    v_res := public.timeout_turn_tx(r.id, r.current_round);

    -- A turn was really resolved only when the authority says it produced a
    -- timeout outcome. turn_in_progress (not due) and already_advanced (a
    -- client got there first) both land here as neither resolved nor finished.
    if coalesce(v_res->>'outcome', '') = 'timeout' then
      v_resolved := v_resolved + 1;
    end if;
    if coalesce((v_res->>'finished')::boolean, false) then
      v_finished := v_finished + 1;
    end if;
  end loop;

  return jsonb_build_object(
    'checked', v_checked,
    'resolved', v_resolved,
    'finished', v_finished,
    'swept_at', now()
  );
end;
$$;

comment on function public.sweep_expired_turns() is
  'pg_cron entry point for elimination rooms: asks timeout_turn_tx about every active elimination room so turns time out with no client attached. Contains no game rules. Not client-callable.';

-- Not an exposed RPC, same boundary as sweep_expired_rounds() and the 0012
-- transition functions: a browser hitting /rest/v1/rpc/sweep_expired_turns gets
-- 42501. The pg_cron job runs as the function's owner, which keeps EXECUTE.
revoke all on function public.sweep_expired_turns() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Schedule: every 5 seconds, matching 0009.
--
-- The same reasoning applies unchanged — this interval governs only the
-- unattended case, since a watching client's own timeout call resolves a turn
-- in ~150ms. Matching 0009 rather than picking a new number also means the two
-- engines have the same worst-case unattended latency, so neither feels
-- different to play when everyone has closed their tab.
--
-- Idempotent in the same shape as 0009: unschedule first so re-running this
-- migration re-points the job instead of failing on a duplicate jobname.
-- ---------------------------------------------------------------------------
do $sched$
begin
  if exists (select 1 from cron.job where jobname = 'sweep-expired-turns') then
    perform cron.unschedule('sweep-expired-turns');
  end if;

  perform cron.schedule(
    'sweep-expired-turns',
    '5 seconds',
    $cmd$select public.sweep_expired_turns();$cmd$
  );
end
$sched$;
