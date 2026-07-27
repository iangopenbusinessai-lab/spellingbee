import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  DifficultyTier,
  GameEngineApi,
  GameOptions,
  GameState,
  RoundStatus,
  WordEntry,
} from "../types";
import { getSupabase } from "../lib/supabaseClient";
import {
  advanceRound,
  PLAYER_COLUMNS,
  startEliminationGame,
  startGame as startGameFn,
  submitAnswer,
  submitTurn,
  type RoomMode,
} from "../lib/rooms";
import { coerceAvatar, type AvatarKey } from "../lib/avatars";
import { secondsUntil, serverNow, syncServerClock } from "../lib/serverClock";

// useMultiplayerGame — the multiplayer counterpart of useGameEngine.
//
// It satisfies GameEngineApi exactly, so App.tsx can swap it in without any
// component knowing which engine is behind the GameState it renders.
//
// The defining difference from singleplayer: this hook computes NO game
// outcomes. Correctness, the round winner, scores, the round clock and
// game-over are all decided by the Session 9a edge functions and arrive here as
// database changes over Realtime. This hook's whole job is to translate those
// server facts into the GameState shape the UI already speaks.
//
// In particular there is no local answer comparison anywhere in this file —
// that seam is exactly what CLAUDE.md reserved for the server round-trip.

/** Row shape of the parts of `rooms` this hook reads. */
interface RoomRow {
  id: string;
  tier: DifficultyTier;
  status: "lobby" | "active" | "finished";
  current_round: number;
  round_started_at: string | null;
  host_id: string;
  // --- Session 20: elimination columns (0012) -------------------------------
  mode: RoomMode;
  lives_setting: number;
  current_turn_player_id: string | null;
  starting_players: number | null;
  table_streak: number;
  /** Last player standing, set by the server when an elimination game ends. */
  winner_id: string | null;
}

/** Row shape of the current round in `round_results`. */
interface RoundRow {
  round_num: number;
  word_id: string;
  winner_id: string | null;
  response_time_ms: number | null;
  ended_at: string | null;
  // --- Session 20: elimination columns (0012) -------------------------------
  /** Whose turn this row is. NULL marks a race round. */
  turn_player_id: string | null;
  turn_started_at: string | null;
  /** THIS turn's decayed duration, frozen by the server when the turn opened. */
  round_seconds: number | null;
  outcome: TurnOutcome | null;
}

export type TurnOutcome = "correct" | "wrong" | "timeout";

interface PlayerRow {
  player_id: string;
  display_name: string;
  score: number;
  streak: number;
  lives: number;
  is_eliminated: boolean;
  turn_order: number | null;
  avatar: AvatarKey;
}

/** A resolved past turn, used only to order eliminations. */
interface PastTurn {
  round_num: number;
  turn_player_id: string | null;
  outcome: TurnOutcome | null;
}

/** The last turn that actually resolved, with the word it was played on. */
export interface ResolvedTurn {
  roundNum: number;
  playerId: string | null;
  outcome: TurnOutcome | null;
  word: string | null;
}

/** Server-owned timing constants. Never hardcoded here — see fetchConstants. */
interface GameConstants {
  roundSeconds: number;
  roundsPerGame: number;
  feedbackMs: number;
  graceMs: number;
}

/**
 * Extra multiplayer-only facts the shared GameState has no field for. Returned
 * alongside `state` rather than bolted onto GameState, so the core contract in
 * types.ts stays exactly as Session 6 defined it.
 */
export interface MultiplayerExtras {
  /** I have answered but the round is still live for everyone else. */
  awaitingOthers: boolean;
  /** One-line summary of how the round ended, e.g. "Alex won this round". */
  resultNote: string | null;
  /** Live scoreboard for every player in the room. */
  players: PlayerRow[];
  /** Am I the room's host? */
  isHost: boolean;
  /** My auth user id, once resolved (used to mark "you" in rosters). */
  currentUserId: string | null;
  /** Most recent failure worth showing the player. */
  error: string | null;

  // --- Session 20: elimination-only facts ------------------------------------
  // Added here, as extras, for exactly the reason the race-only fields above
  // were: GameState is the contract every screen shares, and none of this has
  // any meaning in singleplayer. GameEngineApi did not need to change.
  /** Which engine this room runs. 'race' for every pre-Session-18 room. */
  mode: RoomMode;
  /** Lives each player was dealt. From rooms.lives_setting. */
  livesSetting: number;
  /** How many players the game started with (the decay curve's denominator). */
  startingPlayers: number | null;
  /** Consecutive correct answers across the whole table. Drives decay. */
  tableStreak: number;
  /** Whose turn it is right now. NULL in a race room and once the game ends. */
  currentTurnPlayerId: string | null;
  /** Is it MY turn? The only thing that unlocks the guess input. */
  isMyTurn: boolean;
  /**
   * My answer is in flight. Acknowledges the submission only — it says nothing
   * about whether the answer was right, which is still the server's to say.
   */
  submitting: boolean;
  /** Have I been knocked out? Switches me to the spectator view. */
  amEliminated: boolean;
  /** My remaining lives, or null before the game starts. */
  myLives: number | null;
  /** Players still standing. */
  survivors: number;
  /**
   * Player ids in the order they were knocked out, first out first.
   *
   * Derived for PRESENTATION only, and only over players the server has
   * already flagged is_eliminated — this does not decide who is out, it orders
   * people the server says are out. The key is the round number of each
   * player's last losing turn, which is by definition the turn that took their
   * final life, since a player gets no further turns after being eliminated.
   */
  eliminationOrder: string[];
  /** How the last turn resolved, while that resolution is on screen. */
  turnOutcome: TurnOutcome | null;
  /**
   * The most recently resolved turn, including the WORD it was played on.
   *
   * Deliberately NOT gated on the feedback window, unlike turnOutcome above.
   * The elimination moment needs the word that knocked a player out, and it
   * latches at the instant `amEliminated` flips — which is driven by a Realtime
   * row change, not by the clock. Gating this on the clock-derived feedback
   * window meant a throttled tab latched the knockout with no word and fell
   * back to generic text; live testing caught exactly that.
   */
  lastResolvedTurn: ResolvedTurn | null;
  /** Set when the game is over: the last player standing. */
  winnerId: string | null;
  winnerName: string | null;
}

export interface MultiplayerGame extends GameEngineApi {
  extras: MultiplayerExtras;
}

const IDLE_STATE: GameState = {
  tier: null,
  status: "idle",
  currentWord: null,
  score: 0,
  streak: 0,
  bestStreak: 0,
  timeLeft: 0,
  wordsRemaining: 0,
  // Session 13's per-game modifiers are singleplayer-only: a room's timing is
  // enforced by the server round engine and the word is shared, so neither can
  // be honoured per-client. Reported as false forever, which is exactly the
  // behaviour every screen had before the fields existed.
  untimed: false,
  hideDefinition: false,
};

export function useMultiplayerGame(roomId: string | null): MultiplayerGame {
  const [room, setRoom] = useState<RoomRow | null>(null);
  const [round, setRound] = useState<RoundRow | null>(null);
  const [word, setWord] = useState<WordEntry | null>(null);
  const [players, setPlayers] = useState<PlayerRow[]>([]);
  const [pastTurns, setPastTurns] = useState<PastTurn[]>([]);
  /** The last RESOLVED turn — see the fetch in refresh() for why this exists. */
  const [prevTurn, setPrevTurn] = useState<ResolvedTurn | null>(null);
  const [constants, setConstants] = useState<GameConstants | null>(null);
  const [userId, setUserId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Outcome of MY submission for the current round. Set only from the server's
  // response to submit-answer — never guessed locally, never optimistic.
  const [myOutcome, setMyOutcome] = useState<RoundStatus | null>(null);
  const submittedRoundRef = useRef<number | null>(null);

  // --- elimination: my own submission in flight, and its verdict --------------
  //
  // Session 22. `submitting` is set the instant the request leaves, so the UI can
  // acknowledge the keypress instead of sitting silent for the round trip. It
  // says "this was sent", never "this was right" — correctness still comes only
  // from the server.
  //
  // `ownResult` is that server's verdict, taken from submit-turn's OWN HTTP
  // response instead of waiting for the same fact to come back around over
  // Realtime. This is NOT a local outcome computation and does not weaken the
  // Session 9b rule: it is the identical value `apply_turn_outcome` broadcasts,
  // read from the direct channel the answering client already has open. Measured
  // before this change, the broadcast path added 0.9-2.4s of dead air AFTER the
  // server had already answered this very client (775ms/3196ms, 497/1649,
  // 486/1370). Everyone else still learns the outcome over Realtime — that is
  // what the broadcast is for.
  const [submitting, setSubmitting] = useState(false);
  const [ownResult, setOwnResult] = useState<ResolvedTurn | null>(null);

  const [bestStreak, setBestStreak] = useState(0);

  // Ticking server-clock reading that the countdown derives from. This holds
  // the actual time rather than a counter so that `timeLeft` has a real React
  // dependency — deriving it from serverNow() directly would make it depend on
  // a value React can't observe, and the memo below would freeze at whatever
  // the clock read when some *other* dependency last changed.
  const [nowMs, setNowMs] = useState(() => serverNow());

  const advanceAttemptRef = useRef<{ round: number; at: number } | null>(null);

  // ---- data loading --------------------------------------------------------

  const loadWord = useCallback(async (wordId: string) => {
    const { data } = await getSupabase()
      .from("words")
      .select("id,word,tier,definition,part_of_speech")
      .eq("id", wordId)
      .maybeSingle();
    if (!data) return;
    setWord({
      id: data.id as string,
      word: data.word as string,
      tier: data.tier as DifficultyTier,
      definition: data.definition as string,
      partOfSpeech: (data.part_of_speech as string | null) ?? undefined,
    });
  }, []);

  /**
   * Re-read the authoritative state. Called on mount and on every realtime
   * event: rather than reconstructing state from event payloads, we let any
   * change trigger a read of the rows themselves, which keeps this hook honest
   * about where the truth lives (and matches the lobby's existing pattern).
   */
  const refresh = useCallback(async () => {
    if (!roomId) return;
    const supabase = getSupabase();

    // EVERY read HAPPENS FIRST, EVERY setState HAPPENS LAST — deliberately.
    //
    // The first version interleaved them, setting each piece of state as its
    // query returned. Because each `await` ends React's batching, that produced
    // renders where some rows were the new ones and others were still the old:
    // in particular `players` (carrying is_eliminated) committed a tick before
    // `prevTurn` (carrying the word that did it). The elimination moment latches
    // on exactly that transition, so it saw a player who was out and no word yet,
    // and fell back to generic text. Live testing caught it.
    //
    // Collecting first and committing at the end means every render sees one
    // coherent snapshot of the room. Anything that latches on a transition — this
    // one, and anything added later — can trust what it reads alongside it.
    const { data: roomData } = await supabase
      .from("rooms")
      .select(
        "id,tier,status,current_round,round_started_at,host_id," +
          "mode,lives_setting,current_turn_player_id,starting_players,table_streak,winner_id"
      )
      .eq("id", roomId)
      .maybeSingle();
    if (!roomData) return;
    const r = roomData as unknown as RoomRow;

    const { data: playerData } = await supabase
      .from("room_players")
      .select(PLAYER_COLUMNS)
      .eq("room_id", roomId)
      .order("connected_at", { ascending: true });
    const nextPlayers = ((playerData ?? []) as unknown as PlayerRow[]).map((p) => ({
      ...p,
      avatar: coerceAvatar(p.avatar),
    }));

    let nextRound: RoundRow | null = null;
    if (r.current_round > 0) {
      const { data: roundData } = await supabase
        .from("round_results")
        .select(
          "round_num,word_id,winner_id,response_time_ms,ended_at," +
            "turn_player_id,turn_started_at,round_seconds,outcome"
        )
        .eq("room_id", roomId)
        .eq("round_num", r.current_round)
        .maybeSingle();
      if (roundData) nextRound = roundData as unknown as RoundRow;
    }

    // The PREVIOUS turn, and why it has to be fetched at all.
    //
    // apply_turn_outcome closes turn N and opens turn N+1 in ONE transaction,
    // so by the time a client sees the change, rooms.current_round is already
    // N+1 and the row for N+1 has outcome NULL. The outcome everyone needs to
    // SEE — right/wrong, whose life it cost, which word it was — lives on row N.
    // Without this fetch there is no feedback to render for anybody, including
    // the player who just answered.
    //
    // The feedback window is not a client-side timer either: the server set
    // turn N+1's turn_started_at to feedback_ms in the future, so "are we still
    // in feedback" is simply "has the next turn's clock started yet".
    let nextPrev: ResolvedTurn | null = null;
    if (r.mode === "elimination" && r.current_round > 1) {
      const { data: prevData } = await supabase
        .from("round_results")
        .select("round_num,word_id,turn_player_id,outcome")
        .eq("room_id", roomId)
        .eq("round_num", r.current_round - 1)
        .maybeSingle();
      if (prevData) {
        const pv = prevData as unknown as {
          round_num: number;
          word_id: string;
          turn_player_id: string | null;
          outcome: TurnOutcome | null;
        };
        const { data: w } = await supabase
          .from("words")
          .select("word")
          .eq("id", pv.word_id)
          .maybeSingle();
        nextPrev = {
          roundNum: pv.round_num,
          playerId: pv.turn_player_id,
          outcome: pv.outcome,
          word: (w?.word as string | undefined) ?? null,
        };
      }
    }

    // Losing turns only, and only in elimination — this exists solely to order
    // the players the server has already marked eliminated, so a race room
    // never pays for the query. Filtered server-side rather than fetching the
    // whole history and discarding most of it.
    let nextPast: PastTurn[] = [];
    if (r.mode === "elimination" && r.current_round > 0) {
      const { data: turnData } = await supabase
        .from("round_results")
        .select("round_num,turn_player_id,outcome")
        .eq("room_id", roomId)
        .in("outcome", ["wrong", "timeout"])
        .order("round_num", { ascending: true });
      nextPast = (turnData ?? []) as unknown as PastTurn[];
    }

    // --- one commit ---------------------------------------------------------
    setRoom(r);
    setPlayers(nextPlayers);
    setRound(nextRound);
    setPrevTurn(nextPrev);
    setPastTurns(nextPast);
    if (nextRound) void loadWord(nextRound.word_id);
    else setWord(null);
  }, [roomId, loadWord]);

  // ---- subscription + initial load ----------------------------------------

  useEffect(() => {
    // Inert when there's no room: nothing fetched, nothing subscribed. This is
    // what lets App.tsx call the hook unconditionally alongside useGameEngine.
    if (!roomId) {
      setRoom(null);
      setRound(null);
      setWord(null);
      setPlayers([]);
      setPastTurns([]);
      setPrevTurn(null);
      setMyOutcome(null);
      setBestStreak(0);
      setSubmitting(false);
      setOwnResult(null);
      submittedRoundRef.current = null;
      return;
    }

    let active = true;
    const supabase = getSupabase();

    void syncServerClock();
    void supabase.auth.getUser().then(({ data }) => {
      if (active) setUserId(data.user?.id ?? null);
    });
    void refresh();

    // One channel, three tables — every signal the round loop needs:
    //   rooms          -> a round started / the game finished
    //   round_results  -> the word for a round / that round's winner
    //   room_players   -> live scores
    // RLS scopes each stream to this room (migrations 0002 / 0004 / 0007).
    const channel = supabase
      .channel(`mp:${roomId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "rooms", filter: `id=eq.${roomId}` },
        () => void refresh()
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "round_results", filter: `room_id=eq.${roomId}` },
        () => void refresh()
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "room_players", filter: `room_id=eq.${roomId}` },
        () => void refresh()
      )
      .subscribe();

    return () => {
      active = false;
      void supabase.removeChannel(channel);
    };
  }, [roomId, refresh]);

  // Timing constants come from the server (migration 0006/0008), never from a
  // client-side ROUND_SECONDS copy — that duplication is exactly what this
  // session was asked to avoid.
  useEffect(() => {
    const tier = room?.tier;
    if (!tier || constants) return;
    let active = true;
    const supabase = getSupabase();

    void (async () => {
      const [secs, rounds, feedback, grace] = await Promise.all([
        supabase.rpc("round_seconds", { p_tier: tier }),
        supabase.rpc("rounds_per_game"),
        supabase.rpc("feedback_ms"),
        supabase.rpc("late_grace_ms"),
      ]);
      if (!active) return;
      if (secs.data == null || rounds.data == null) return;
      setConstants({
        roundSeconds: Number(secs.data),
        roundsPerGame: Number(rounds.data),
        feedbackMs: Number(feedback.data ?? 1100),
        graceMs: Number(grace.data ?? 750),
      });
    })();

    return () => {
      active = false;
    };
  }, [room?.tier, constants]);

  // ---- per-round bookkeeping ----------------------------------------------

  // A new round wipes my previous answer so the input unlocks.
  const currentRound = room?.current_round ?? 0;
  useEffect(() => {
    if (submittedRoundRef.current !== currentRound) {
      setMyOutcome(null);
    }
  }, [currentRound]);

  // Speaking is NOT triggered here. RoundScreen announces each new word
  // (lead-in phrase + pause + word), so multiplayer gets the narrator treatment
  // from the same implementation singleplayer uses rather than a second copy.
  // Triggering it here as well would speak every word twice.

  // ---- countdown -----------------------------------------------------------

  const roundEnded = Boolean(round?.ended_at);
  const isElimination = room?.mode === "elimination";

  // THE TURN'S LENGTH IS READ, NEVER COMPUTED.
  //
  // In elimination every turn can be a different length: the server's
  // three-trigger decay curve (player count + two streak stages) produced this
  // number and froze it on the turn row when the turn opened. The client does
  // not know decay_params() and must never try to.
  //
  // It is read from round_results.round_seconds rather than from submit-turn's
  // next_round_seconds, and that difference matters: only the player who
  // answered ever sees that HTTP response. Everyone else — the next holder,
  // every waiting player, every eliminated spectator — learns the new duration
  // from this row over Realtime. Both carry the identical server-computed
  // value, so reading the row is the same number for strictly more clients.
  const turnSeconds = round?.round_seconds ?? null;

  const deadlineMs = useMemo(() => {
    if (isElimination) {
      if (!round?.turn_started_at || turnSeconds == null) return null;
      return new Date(round.turn_started_at).getTime() + turnSeconds * 1000;
    }
    if (!room?.round_started_at || !constants) return null;
    return new Date(room.round_started_at).getTime() + constants.roundSeconds * 1000;
  }, [isElimination, round?.turn_started_at, turnSeconds, room?.round_started_at, constants]);

  /**
   * Feedback window: the server opened the next turn with its clock set
   * feedback_ms into the future, so this is simply "that clock hasn't started".
   * No client-side timer decides it, and every client agrees because they are
   * all comparing the same server timestamp against the same synced clock.
   */
  const turnOpensAtMs =
    isElimination && round?.turn_started_at ? new Date(round.turn_started_at).getTime() : null;
  const inFeedback = turnOpensAtMs != null && nowMs < turnOpensAtMs;

  useEffect(() => {
    if (room?.status !== "active" || roundEnded) return;
    const id = window.setInterval(() => setNowMs(serverNow()), 250);

    // Browsers throttle timers in background tabs (to ~1/s, and far less after
    // a few minutes), so nowMs goes stale while the tab is hidden. Re-read the
    // clock the moment it becomes visible again rather than waiting for the
    // next throttled tick to correct a visibly wrong countdown.
    const onVisible = () => {
      if (document.visibilityState === "visible") setNowMs(serverNow());
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [room?.status, roundEnded]);

  // Clamped to the round length: a stale nowMs (throttled background tab, or a
  // clock sync that hasn't landed yet) must never render a countdown LONGER
  // than the round itself, which would be obvious nonsense to the player.
  //
  // The clamp is also what makes the feedback window look right in elimination:
  // during it the deadline is more than a full turn away, so this pins the
  // display at the new turn's full duration and the bar sits full until the
  // turn actually opens, instead of over-filling.
  const clampSeconds = isElimination
    ? turnSeconds ?? Infinity
    : constants?.roundSeconds ?? Infinity;

  const timeLeft =
    roundEnded || !deadlineMs ? 0 : Math.min(clampSeconds, secondsUntil(deadlineMs, nowMs));

  // ---- round advancement ---------------------------------------------------
  //
  // 9a made advance-round a separate call so a feedback window can exist. Some
  // client has to make that call, and the server validates it against its own
  // clock, so it is safe for anyone to ask.
  //
  // The host asks first; everyone else backs him up ~1.5s later. That fallback
  // is what keeps a game alive when the host disconnects mid-game — without it
  // a host leaving would freeze the room forever.
  //
  // A polling check rather than a one-shot timer, because it self-heals: a
  // rejected call (clock a touch early, or a race with another client) is
  // simply retried on the next pass.
  const isHost = Boolean(room && userId && room.host_id === userId);

  useEffect(() => {
    if (!roomId || !room || room.status !== "active" || !round || !constants) return;

    // ELIMINATION HAS NO CLIENT FAST PATH, and this is a real (documented,
    // flagged) gap rather than an oversight.
    //
    // Race mode's advance-round is callable by any member, so a watching client
    // ends an expired round in ~150ms and the pg_cron sweep is only the
    // unattended backstop. Elimination's equivalent is timeout_turn_tx, which is
    // service_role-only and — as of Session 19 — has NO edge function in front
    // of it. So a client physically cannot nudge an expired turn, and an
    // abandoned turn ends only when 0014's 5s sweep gets to it.
    //
    // The visible consequence: when a player lets their clock run out, everyone
    // waits the turn length plus 0.75s grace plus up to 5s, where race mode
    // would have moved on almost immediately. Measured at ~15-16s on a 13s turn
    // in Session 19's verification.
    //
    // This session may not add edge functions, so it is NOT worked around here.
    // Calling advance-round would be actively wrong: since 0015 it returns
    // wrong_mode for an elimination room, and it belongs to the other engine
    // anyway. Reimplementing the timeout locally is exactly the game-rule
    // duplication the architecture forbids. Doing nothing is correct; a
    // `timeout-turn` edge function is the fix, next session.
    if (room.mode === "elimination") return;

    const id = window.setInterval(() => {
      const now = serverNow();
      const roundNum = room.current_round;

      let dueAt: number;
      if (round.ended_at) {
        // Round decided — hold for the feedback window, then move on.
        dueAt = new Date(round.ended_at).getTime() + constants.feedbackMs;
      } else if (room.round_started_at) {
        // Nobody has won yet: only a real server-clock timeout ends it.
        dueAt =
          new Date(room.round_started_at).getTime() +
          constants.roundSeconds * 1000 +
          constants.graceMs;
      } else {
        return;
      }

      dueAt += isHost ? 150 : 1600;
      if (now < dueAt) return;

      // Throttle: one attempt per round per ~1.5s.
      const last = advanceAttemptRef.current;
      if (last && last.round === roundNum && now - last.at < 1500) return;
      advanceAttemptRef.current = { round: roundNum, at: now };

      void advanceRound(roomId, roundNum).then((res) => {
        // round_in_progress / already_advanced are expected in a room where
        // several clients ask at once — not worth showing anyone.
        if (!res.ok && res.error && res.error !== "round_in_progress") {
          if (res.error !== "room_not_active") setError(res.error);
        }
      });
    }, 500);

    return () => window.clearInterval(id);
  }, [roomId, room, round, constants, isHost]);

  // ---- derived GameState ---------------------------------------------------

  const me = players.find((p) => p.player_id === userId) ?? null;

  useEffect(() => {
    if (me && me.streak > bestStreak) setBestStreak(me.streak);
  }, [me, bestStreak]);

  const winnerName = round?.winner_id
    ? players.find((p) => p.player_id === round.winner_id)?.display_name ?? "Someone"
    : null;

  // Race-only: elimination resolves a turn the instant it is answered, so there
  // is never a moment where I have answered and the turn is still open.
  const awaitingOthers = Boolean(
    !isElimination && room?.status === "active" && myOutcome && !roundEnded
  );

  /**
   * The turn whose outcome should currently be on screen.
   *
   * Mid-game that is the PREVIOUS row, because the current one is the freshly
   * opened turn (see refresh()). At game over there is no next turn, so the
   * current row is itself the resolved one.
   */
  const lastResolved: ResolvedTurn | null = useMemo(() => {
    if (!isElimination) return null;
    const fromRealtime: ResolvedTurn | null = round?.outcome
      ? {
          roundNum: round.round_num,
          playerId: round.turn_player_id,
          outcome: round.outcome,
          word: word?.word ?? null,
        }
      : prevTurn;

    // My own turn's verdict wins while it is at least as recent as the broadcast.
    // Both carry the same server decision; this one simply arrived first. Once
    // Realtime catches up the two agree, so the swap is invisible.
    if (ownResult && (!fromRealtime || ownResult.roundNum >= fromRealtime.roundNum)) {
      return ownResult;
    }
    return fromRealtime;
  }, [isElimination, round, word, prevTurn, ownResult]);

  // Drop my own copy once the broadcast has moved past it and its feedback
  // window has closed — from then on the Realtime state is complete on its own.
  useEffect(() => {
    if (!ownResult || !room) return;
    if (room.current_round > ownResult.roundNum && !inFeedback) setOwnResult(null);
  }, [ownResult, room, inFeedback]);

  /**
   * The window between my request being answered and the broadcast landing.
   * `inFeedback` can only become true once the NEXT turn's row has arrived over
   * Realtime, so without this the answering player stares at an unchanged screen
   * for the whole gap — the 0.9-2.4s measured before this change.
   */
  const ownGap = Boolean(
    ownResult && room?.status === "active" && room.current_round <= ownResult.roundNum
  );

  /** Is a resolved turn what the screen should currently be showing? */
  const resolutionVisible = inFeedback || ownGap;

  const status: RoundStatus = useMemo(() => {
    if (!room || room.status === "lobby") return "idle";
    if (room.status === "finished") return "finished";

    if (isElimination) {
      // One turn, one outcome, and every client sees the same one — there is no
      // per-player result to track here and no awaiting-others state. Feedback
      // shows during the server's feedback window (and, for the player who
      // answered, from the moment their own request came back).
      if (resolutionVisible && lastResolved?.outcome) {
        return lastResolved.outcome === "correct" ? "correct" : "incorrect";
      }
      return "playing";
    }

    // Active. Once the round is closed everyone sees a result; a player who
    // never answered simply didn't get it.
    if (roundEnded) return myOutcome ?? "incorrect";
    // I've answered and the round is still live — locked out, awaiting others.
    if (myOutcome) return myOutcome;
    return "playing";
  }, [room, roundEnded, myOutcome, isElimination, resolutionVisible, lastResolved]);

  const nameOf = useCallback(
    (id: string | null | undefined) =>
      id ? players.find((p) => p.player_id === id)?.display_name ?? "Someone" : null,
    [players]
  );

  const resultNote = useMemo(() => {
    if (isElimination) {
      if (!resolutionVisible || !lastResolved?.outcome) return null;
      const who = lastResolved.playerId === userId ? "You" : nameOf(lastResolved.playerId);
      const youAre = lastResolved.playerId === userId;
      if (lastResolved.outcome === "correct") return `${who} spelled it`;
      if (lastResolved.outcome === "timeout") return `${who} ran out of time`;
      return youAre ? "You missed it" : `${who} missed it`;
    }
    if (!roundEnded || !room || room.status !== "active") return null;
    if (!round?.winner_id) return "Time's up — nobody got it.";
    if (round.winner_id === userId) {
      const ms = round.response_time_ms;
      return ms != null ? `You won this round in ${(ms / 1000).toFixed(1)}s` : "You won this round";
    }
    return `${winnerName} won this round`;
  }, [roundEnded, room, round, userId, winnerName, isElimination, resolutionVisible, lastResolved, nameOf]);

  const state: GameState = useMemo(() => {
    if (!room) return IDLE_STATE;
    return {
      tier: room.tier,
      status,
      currentWord: room.status === "active" ? word : null,
      score: me?.score ?? 0,
      streak: me?.streak ?? 0,
      bestStreak,
      timeLeft,
      // Elimination has no round budget at all — it ends on elimination, not on
      // a count (rounds_per_game() belonged to the race model). There is no
      // honest number to put here, so it reports 0 and the elimination screen
      // renders its own header instead of ScoreBar's "to go" stat.
      wordsRemaining:
        isElimination || !constants
          ? 0
          : Math.max(0, constants.roundsPerGame - room.current_round),
      untimed: false,
      hideDefinition: false,
    };
  }, [room, status, word, me, bestStreak, timeLeft, constants, isElimination]);

  // ---- elimination-only derived facts --------------------------------------

  const amEliminated = Boolean(me?.is_eliminated);

  /**
   * Is it my turn RIGHT NOW — the single fact that unlocks the guess input.
   *
   * DERIVED FROM SERVER FACTS ONLY, DELIBERATELY NOT FROM THE CLOCK.
   *
   * The first version of this also required `!inFeedback`, so the input would
   * not appear until the turn's clock had actually started. That was wrong, and
   * live testing caught it: `inFeedback` is derived from `nowMs`, which is
   * updated by an interval, and browsers throttle intervals in hidden tabs (to
   * ~1/s, and far less after a few minutes). A stale nowMs left inFeedback
   * true for the whole turn, so the turn holder's input never appeared and they
   * could only time out. Making the countdown lag is an accepted cost of not
   * running a second clock (Session 9b); making the CONTROL vanish is not.
   *
   * Nothing is lost by dropping it. The window it guarded is ~1.1s of feedback,
   * and the server is the real guard: an answer that lands before the turn
   * opens is refused with turn_not_started, which submitGuess already treats as
   * a no-op. The worst case is now a player seeing their input about a second
   * early, instead of a player who cannot play at all.
   */
  const isMyTurn = Boolean(
    isElimination &&
      room?.status === "active" &&
      userId &&
      room.current_turn_player_id === userId &&
      !amEliminated &&
      !roundEnded
  );

  // Survivors, defined exactly as the server's elimination_survivors() defines
  // them: dealt into the rotation (turn_order not null) and not eliminated.
  const survivors = useMemo(
    () => players.filter((p) => p.turn_order !== null && !p.is_eliminated).length,
    [players]
  );

  const eliminationOrder = useMemo(() => {
    if (!isElimination) return [];
    // Each eliminated player's LAST losing turn is the turn that took their
    // final life — they get no turns after that — so ordering by it is the
    // order they went out in. This orders players the server already flagged;
    // it does not decide who is out.
    const lastLoss = new Map<string, number>();
    for (const t of pastTurns) {
      if (!t.turn_player_id) continue;
      const prev = lastLoss.get(t.turn_player_id) ?? 0;
      if (t.round_num > prev) lastLoss.set(t.turn_player_id, t.round_num);
    }
    return players
      .filter((p) => p.is_eliminated)
      .map((p) => ({ id: p.player_id, at: lastLoss.get(p.player_id) ?? 0 }))
      .sort((a, b) => a.at - b.at)
      .map((x) => x.id);
  }, [isElimination, pastTurns, players]);

  const eliminationWinnerId = room?.winner_id ?? null;

  /** Is a resolved turn currently what the screen should be showing? */
  const showingResolution = Boolean(
    isElimination && (resolutionVisible || room?.status === "finished")
  );

  // ---- GameEngineApi surface ----------------------------------------------

  /**
   * Begin the game. The `tier` argument required by GameEngineApi is ignored:
   * a multiplayer room's tier is fixed when the room is created, and the server
   * reads it from the room row. Accepting it keeps the shared contract intact.
   *
   * Session 13's `options` is ignored for the same reason, one level up: the
   * round clock is enforced by `advance_round_tx` on the server and the word is
   * shared by everyone in the room, so a single client cannot opt itself out of
   * either. Accepted and dropped rather than omitted, so this hook still
   * satisfies GameEngineApi structurally.
   */
  const startGame = useCallback(
    (_tier: DifficultyTier, _options?: GameOptions) => {
      if (!roomId) return;
      setError(null);
      // Which engine starts is read off the room, not chosen here. Since 0015
      // each endpoint refuses the other's rooms, so picking wrong would be a
      // clean 409 rather than a corrupted game — but there is no reason to
      // ever send it wrong.
      const call = room?.mode === "elimination" ? startEliminationGame : startGameFn;
      void call(roomId).then((res) => {
        if (!res.ok) setError(res.error);
      });
    },
    [roomId, room?.mode]
  );

  /**
   * Submit an answer. The status only changes when the SERVER says what the
   * answer was — there is no optimistic local result, and no comparison here.
   */
  const submitGuess = useCallback(
    (guess: string) => {
      if (!roomId || !room || room.status !== "active") return;

      if (room.mode === "elimination") {
        // A UI guard, not the rule. The server decides whose turn it is and
        // answers not_your_turn / eliminated / turn_not_started to anyone else;
        // this only avoids firing a request that is certain to be refused.
        if (!isMyTurn || submitting) return;
        const turnNum = room.current_round;
        // The word I am answering, captured before the next turn replaces it —
        // the feedback line needs it to say "the word was X".
        const submittedWord = word?.word ?? null;

        setSubmitting(true);
        void submitTurn(roomId, turnNum, guess).then((res) => {
          setSubmitting(false);
          if (res.ok && res.data) {
            // The server's own verdict, on the direct channel. Everyone else
            // gets the same fact over Realtime a beat later.
            setOwnResult({
              roundNum: turnNum,
              playerId: userId,
              outcome: res.data.outcome,
              word: submittedWord,
            });
            return;
          }
          // Expected in a room where the turn moved under us — the realtime
          // state is about to say so anyway.
          if (res.error === "stale_round" || res.error === "turn_expired") return;
          if (res.error === "turn_not_started" || res.error === "not_your_turn") return;
          setError(res.error);
        });
        return;
      }

      if (myOutcome) return; // one attempt per round (enforced server-side too)

      const roundNum = room.current_round;
      submittedRoundRef.current = roundNum;

      void submitAnswer(roomId, roundNum, guess).then((res) => {
        if (res.ok && res.data) {
          setMyOutcome(res.data.correct ? "correct" : "incorrect");
          return;
        }
        if (res.error === "already_submitted") {
          setMyOutcome("incorrect");
          return;
        }
        // Round moved on or expired under us — let the realtime state decide.
        if (res.error === "stale_round" || res.error === "round_expired") return;
        setError(res.error);
      });
    },
    [roomId, room, myOutcome, isMyTurn, submitting, word, userId]
  );

  /**
   * No-op in multiplayer, deliberately.
   *
   * Skipping is a singleplayer affordance: there, the queue is yours and
   * skipping only costs you. In a shared room the word is the same for
   * everyone and rounds end on a winner or the server clock, so one player
   * "skipping" could neither move the round on nor opt out of it — the server
   * has no such action, by design. Kept as a no-op rather than removed so the
   * GameEngineApi contract stays satisfied; the UI hides the Skip control via
   * RoundScreen's `canSkip` prop instead of showing a dead button.
   */
  const skipWord = useCallback(() => {
    /* intentionally empty — see doc comment */
  }, []);

  const resetToMenu = useCallback(() => {
    setMyOutcome(null);
    setError(null);
    submittedRoundRef.current = null;
  }, []);

  return {
    state,
    startGame,
    submitGuess,
    skipWord,
    resetToMenu,
    extras: {
      awaitingOthers,
      resultNote,
      players,
      isHost,
      currentUserId: userId,
      error,
      // --- Session 20 -------------------------------------------------------
      mode: room?.mode ?? "race",
      livesSetting: room?.lives_setting ?? 3,
      startingPlayers: room?.starting_players ?? null,
      tableStreak: room?.table_streak ?? 0,
      currentTurnPlayerId: room?.current_turn_player_id ?? null,
      isMyTurn,
      submitting,
      amEliminated,
      myLives: me?.lives ?? null,
      survivors,
      eliminationOrder,
      // Shown during the server's feedback window, and again at game over —
      // where there is no next turn, so the final resolution simply stays up.
      turnOutcome: showingResolution ? lastResolved?.outcome ?? null : null,
      lastResolvedTurn: lastResolved,
      winnerId: eliminationWinnerId,
      winnerName: nameOf(eliminationWinnerId),
    },
  };
}
