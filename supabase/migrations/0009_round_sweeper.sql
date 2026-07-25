-- 0009_round_sweeper.sql
-- Advance expired rounds from the database itself, on a schedule (Session 10).
--
-- THE PROBLEM THIS SOLVES
-- Session 9b made round advancement client-driven: a member's polling loop
-- calls the advance-round edge function once the server clock says the round
-- is over. That works while somebody is watching, but browsers throttle timers
-- in hidden tabs — with every player's tab backgrounded past Chrome's
-- intensive-throttling threshold, rounds were measured advancing 40-60s late,
-- and with every tab CLOSED nothing advances at all. A game with no client
-- attached simply stops.
--
-- pg_cron calls the sweep below every few seconds, so a room advances whether
-- or not any client exists.
--
-- WHY A SQL SWEEP RATHER THAN A SCHEDULED EDGE FUNCTION
-- Same reasoning as 0006: the transition is multi-statement and contended, and
-- a plpgsql function is one transaction. Going out through an edge function
-- would add an HTTP hop and a second place that knows how to advance a round.
-- This function deliberately contains NO game rules — it finds candidate rooms
-- and calls advance_round_tx, which stays the single authority on whether a
-- round is actually over and what happens next.

-- ---------------------------------------------------------------------------
-- pg_cron. Verified on this project: version 1.6.4, which supports sub-minute
-- interval schedules ('5 seconds'), not just 5-field cron syntax. Supabase
-- installs the extension into pg_catalog; its own objects live in schema cron.
-- ---------------------------------------------------------------------------
create extension if not exists pg_cron;

-- ---------------------------------------------------------------------------
-- sweep_expired_rounds — the scheduled caller.
--
-- ON THE CANDIDATE FILTER: this selects on `status = 'active'` and nothing
-- else. It deliberately does NOT re-derive "is this round over" — that rule
-- (time limit + grace for an unwon round, feedback window for a won one) lives
-- in advance_round_tx, and copying it here would create a second definition
-- that could silently drift from the real one. advance_round_tx is already a
-- no-op for a room that isn't due: it returns round_in_progress without
-- writing. So the sweep asks about every active room and lets the authority
-- answer, which costs a cheap rejected call per active room per tick.
--
-- ON THE ACTOR: advance_round_tx takes the acting player only to enforce its
-- "callers must be a member" guard — p_player is used for nothing else. The
-- sweep has no human caller, so it passes the room's earliest-joined member
-- (in practice the host). This satisfies the guard without changing any
-- transition logic, and no game rule depends on which member is named.
--
-- CONCURRENCY: advance_round_tx opens with `select ... for update` on the room
-- and then rejects any call whose p_expected_round no longer matches
-- rooms.current_round. If a client's advance-round lands at the same moment,
-- one of the two takes the row lock first; the other blocks, re-reads the
-- committed row, sees current_round has moved, and returns
-- {advanced:false, note:"already_advanced"}. Double-advancement is therefore
-- impossible regardless of who calls, which is exactly the property 9a's
-- conditional-update pattern was built for.
-- ---------------------------------------------------------------------------
create or replace function public.sweep_expired_rounds()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  r          record;
  v_actor    uuid;
  v_res      jsonb;
  v_checked  int := 0;
  v_advanced int := 0;
  v_finished int := 0;
begin
  for r in
    select rm.id, rm.current_round
    from public.rooms rm
    where rm.status = 'active'
      and rm.round_started_at is not null
    order by rm.round_started_at
    -- Bound the work per tick so one sweep can never hold room locks for an
    -- unbounded time. Well above any plausible concurrent-game count here;
    -- rooms are processed oldest-round-first so nothing can be starved.
    limit 200
  loop
    v_checked := v_checked + 1;

    -- Any member satisfies advance_round_tx's membership guard; earliest join
    -- is the host in practice. A room with no members is skipped rather than
    -- erroring.
    select player_id into v_actor
      from public.room_players
     where room_id = r.id
     order by connected_at
     limit 1;

    if v_actor is null then
      continue;
    end if;

    v_res := public.advance_round_tx(r.id, v_actor, r.current_round);

    if coalesce((v_res->>'advanced')::boolean, false) then
      v_advanced := v_advanced + 1;
    end if;
    if coalesce((v_res->>'finished')::boolean, false) then
      v_finished := v_finished + 1;
    end if;
  end loop;

  return jsonb_build_object(
    'checked', v_checked,
    'advanced', v_advanced,
    'finished', v_finished,
    'swept_at', now()
  );
end;
$$;

comment on function public.sweep_expired_rounds() is
  'pg_cron entry point: asks advance_round_tx about every active room so rounds progress with no client attached. Contains no game rules. Not client-callable.';

-- Not an exposed RPC. Same boundary as the 0006 transition functions: revoked
-- from every client role, so a browser calling /rest/v1/rpc/sweep_expired_rounds
-- gets 42501. The pg_cron job runs as the function's owner, which retains
-- EXECUTE regardless of these revokes.
revoke all on function public.sweep_expired_rounds() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Schedule: every 5 seconds.
--
-- Chosen as the tightest interval that is clearly safe to run forever on this
-- project. It bounds unattended advancement latency at ~5s on top of the
-- round's own deadline, versus the 40-60s (or unbounded, with tabs closed)
-- that 9b's client-only loop allowed. Going tighter buys little: the client
-- fast path already advances in ~150ms whenever anyone is watching, so this
-- interval only governs the unattended case.
--
-- Idempotent: unschedule first so re-running the migration re-points the job
-- rather than failing on a duplicate jobname.
-- ---------------------------------------------------------------------------
do $sched$
begin
  if exists (select 1 from cron.job where jobname = 'sweep-expired-rounds') then
    perform cron.unschedule('sweep-expired-rounds');
  end if;

  perform cron.schedule(
    'sweep-expired-rounds',
    '5 seconds',
    $cmd$select public.sweep_expired_rounds();$cmd$
  );
end
$sched$;
