import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DifficultyTier, GameEngineApi, GameState, RoundStatus, WordEntry } from "../types";
import { getSupabase } from "../lib/supabaseClient";
import { advanceRound, startGame as startGameFn, submitAnswer } from "../lib/rooms";
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
}

/** Row shape of the current round in `round_results`. */
interface RoundRow {
  round_num: number;
  word_id: string;
  winner_id: string | null;
  response_time_ms: number | null;
  ended_at: string | null;
}

interface PlayerRow {
  player_id: string;
  display_name: string;
  score: number;
  streak: number;
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
};

export function useMultiplayerGame(roomId: string | null): MultiplayerGame {
  const [room, setRoom] = useState<RoomRow | null>(null);
  const [round, setRound] = useState<RoundRow | null>(null);
  const [word, setWord] = useState<WordEntry | null>(null);
  const [players, setPlayers] = useState<PlayerRow[]>([]);
  const [constants, setConstants] = useState<GameConstants | null>(null);
  const [userId, setUserId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Outcome of MY submission for the current round. Set only from the server's
  // response to submit-answer — never guessed locally, never optimistic.
  const [myOutcome, setMyOutcome] = useState<RoundStatus | null>(null);
  const submittedRoundRef = useRef<number | null>(null);

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

    const { data: roomData } = await supabase
      .from("rooms")
      .select("id,tier,status,current_round,round_started_at,host_id")
      .eq("id", roomId)
      .maybeSingle();
    if (!roomData) return;
    const r = roomData as unknown as RoomRow;
    setRoom(r);

    const { data: playerData } = await supabase
      .from("room_players")
      .select("player_id,display_name,score,streak")
      .eq("room_id", roomId)
      .order("connected_at", { ascending: true });
    setPlayers((playerData ?? []) as unknown as PlayerRow[]);

    if (r.current_round > 0) {
      const { data: roundData } = await supabase
        .from("round_results")
        .select("round_num,word_id,winner_id,response_time_ms,ended_at")
        .eq("room_id", roomId)
        .eq("round_num", r.current_round)
        .maybeSingle();
      if (roundData) {
        const rr = roundData as unknown as RoundRow;
        setRound(rr);
        void loadWord(rr.word_id);
      }
    } else {
      setRound(null);
      setWord(null);
    }
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
      setMyOutcome(null);
      setBestStreak(0);
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
  const deadlineMs = useMemo(() => {
    if (!room?.round_started_at || !constants) return null;
    return new Date(room.round_started_at).getTime() + constants.roundSeconds * 1000;
  }, [room?.round_started_at, constants]);

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
  const timeLeft =
    roundEnded || !deadlineMs
      ? 0
      : Math.min(constants?.roundSeconds ?? Infinity, secondsUntil(deadlineMs, nowMs));

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

  const awaitingOthers = Boolean(room?.status === "active" && myOutcome && !roundEnded);

  const status: RoundStatus = useMemo(() => {
    if (!room || room.status === "lobby") return "idle";
    if (room.status === "finished") return "finished";
    // Active. Once the round is closed everyone sees a result; a player who
    // never answered simply didn't get it.
    if (roundEnded) return myOutcome ?? "incorrect";
    // I've answered and the round is still live — locked out, awaiting others.
    if (myOutcome) return myOutcome;
    return "playing";
  }, [room, roundEnded, myOutcome]);

  const resultNote = useMemo(() => {
    if (!roundEnded || !room || room.status !== "active") return null;
    if (!round?.winner_id) return "Time's up — nobody got it.";
    if (round.winner_id === userId) {
      const ms = round.response_time_ms;
      return ms != null ? `You won this round in ${(ms / 1000).toFixed(1)}s` : "You won this round";
    }
    return `${winnerName} won this round`;
  }, [roundEnded, room, round, userId, winnerName]);

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
      wordsRemaining: constants
        ? Math.max(0, constants.roundsPerGame - room.current_round)
        : 0,
    };
  }, [room, status, word, me, bestStreak, timeLeft, constants]);

  // ---- GameEngineApi surface ----------------------------------------------

  /**
   * Begin the game. The `tier` argument required by GameEngineApi is ignored:
   * a multiplayer room's tier is fixed when the room is created, and the server
   * reads it from the room row. Accepting it keeps the shared contract intact.
   */
  const startGame = useCallback(
    (_tier: DifficultyTier) => {
      if (!roomId) return;
      setError(null);
      void startGameFn(roomId).then((res) => {
        if (!res.ok) setError(res.error);
      });
    },
    [roomId]
  );

  /**
   * Submit an answer. The status only changes when the SERVER says what the
   * answer was — there is no optimistic local result, and no comparison here.
   */
  const submitGuess = useCallback(
    (guess: string) => {
      if (!roomId || !room || room.status !== "active") return;
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
    [roomId, room, myOutcome]
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
    extras: { awaitingOthers, resultNote, players, isHost, currentUserId: userId, error },
  };
}
