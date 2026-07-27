import { useCallback, useEffect, useRef, useState } from "react";
import type {
  DifficultyTier,
  GameEngineApi,
  GameOptions,
  GameState,
  WordEntry,
} from "../types";
import { wordsForTier } from "../data/words";

// Seconds per word. MUST stay in sync with public.round_seconds() in
// supabase/migrations/0010 — the client renders the countdown, the server
// enforces it, and 0010 is the single source of truth the multiplayer path
// reads by RPC rather than duplicating.
//
// The curve descends smoothly to `hard` and then FLATTENS: expert and master
// both sit at hard's 13s. That is deliberate (Session 15) — the top three tiers
// take their difficulty from word content, not from extra time pressure. Do not
// tighten expert/master below 13.
//
// Note this RAISED expert from its previous 11s. easy/medium/hard are unchanged.
const ROUND_SECONDS: Record<DifficultyTier, number> = {
  novice: 22,
  easy: 20,
  building: 18,
  medium: 16,
  advanced: 14,
  hard: 13,
  expert: 13,
  master: 13,
};

const FEEDBACK_DELAY_MS = 1100;

// How many words make one singleplayer game.
//
// Added in Session 16, when the bank went from 30 words per tier to 150. Without
// a cap the queue is the whole tier, so a game would have silently become five
// times longer — a content change turning into a gameplay change nobody asked
// for. 30 keeps a game exactly the length it has always been; the extra words
// make the POOL deeper (less repetition between games), not the game longer.
//
// The multiplayer counterpart is public.rounds_per_game() (=10) in migration
// 0006. The two are independent on purpose: a solo run and a race are different
// lengths by design, and the server owns its own value.
const WORDS_PER_GAME = 30;

function checkAnswer(word: WordEntry, guess: string): boolean {
  return guess.trim().toLowerCase() === word.word.toLowerCase();
}

function shuffle<T>(arr: T[]): T[] {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

const initialState: GameState = {
  tier: null,
  status: "idle",
  currentWord: null,
  score: 0,
  streak: 0,
  bestStreak: 0,
  timeLeft: 0,
  wordsRemaining: 0,
  untimed: false,
  hideDefinition: false,
  lastResponseMs: null,
};

export function useGameEngine(): GameEngineApi {
  const [state, setState] = useState<GameState>(initialState);
  const queueRef = useRef<WordEntry[]>([]);
  const timerRef = useRef<number | null>(null);
  // When the current word was revealed. Session 23: this is what makes the
  // response time real rather than derived from `timeLeft`, which only moves in
  // whole seconds and would quantise every answer to the nearest second — far
  // too coarse for a WPM figure. performance.now() is monotonic, so it cannot be
  // skewed by a clock adjustment mid-word.
  const revealedAtRef = useRef<number | null>(null);

  const clearTimer = () => {
    if (timerRef.current !== null) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
  };

  const advanceWord = useCallback((tier: DifficultyTier, untimed: boolean) => {
    const next = queueRef.current.shift();
    if (!next) {
      clearTimer();
      setState((s) => ({ ...s, status: "finished", currentWord: null }));
      return;
    }
    revealedAtRef.current = performance.now();
    setState((s) => ({
      ...s,
      status: "playing",
      currentWord: next,
      // Cleared on reveal so the previous word's timing can never bleed into
      // the next word's feedback line.
      lastResponseMs: null,
      // Practice mode holds timeLeft at 0 rather than freezing it at the round
      // length. That's deliberate on two counts: nothing renders a countdown in
      // untimed mode anyway, and submitGuess's time bonus is `10 + timeLeft`, so
      // a frozen full clock would silently hand out a perfect bonus on every
      // word and make practice scores incomparable with timed ones. At 0 a
      // practice word is worth its flat 10 points and the scoring code needs no
      // special case at all.
      timeLeft: untimed ? 0 : ROUND_SECONDS[tier],
      wordsRemaining: queueRef.current.length,
    }));
    // Speaking is NOT triggered here. RoundScreen announces the word (lead-in
    // phrase + pause + word) when it renders a new one, which keeps narration
    // identical for singleplayer and multiplayer and lets the spoken lead-in and
    // the on-screen lead-in come from the same call. Triggering it here too
    // would speak every word twice.
  }, []);

  const startGame = useCallback(
    (tier: DifficultyTier, options?: GameOptions) => {
      const untimed = options?.untimed ?? false;
      const hideDefinition = options?.hideDefinition ?? false;
      clearTimer();
      queueRef.current = shuffle(wordsForTier(tier)).slice(0, WORDS_PER_GAME);
      setState({
        ...initialState,
        tier,
        score: 0,
        streak: 0,
        bestStreak: 0,
        untimed,
        hideDefinition,
      });
      advanceWord(tier, untimed);
    },
    [advanceWord]
  );

  const submitGuess = useCallback(
    (guess: string) => {
      // Read the clock BEFORE the state updater, which React may call later or
      // more than once — measuring inside it would time the render, not the answer.
      const startedAt = revealedAtRef.current;
      const elapsedMs = startedAt === null ? null : Math.round(performance.now() - startedAt);

      setState((s) => {
        if (s.status !== "playing" || !s.currentWord) return s;
        const correct = checkAnswer(s.currentWord, guess);
        const streak = correct ? s.streak + 1 : 0;
        const points = correct ? 10 + Math.max(0, s.timeLeft) : 0;
        return {
          ...s,
          status: correct ? "correct" : "incorrect",
          score: s.score + points,
          streak,
          bestStreak: Math.max(s.bestStreak, streak),
          lastResponseMs: elapsedMs,
        };
      });
    },
    []
  );

  // Skipping submits nothing, so there is no response time to report — null,
  // not 0, which would read as an impossibly fast answer.
  const skipWord = useCallback(() => {
    setState((s) => ({ ...s, status: "incorrect", streak: 0, lastResponseMs: null }));
  }, []);

  // Countdown timer while a round is active. Practice mode never starts one, so
  // there is no tick and no auto-incorrect-on-timeout — the word simply waits.
  useEffect(() => {
    if (state.status !== "playing" || state.untimed) return;
    clearTimer();
    timerRef.current = window.setInterval(() => {
      setState((s) => {
        if (s.status !== "playing") return s;
        if (s.timeLeft <= 1) {
          // A timeout answered nothing, so it reports no response time.
          return { ...s, status: "incorrect", timeLeft: 0, streak: 0, lastResponseMs: null };
        }
        return { ...s, timeLeft: s.timeLeft - 1 };
      });
    }, 1000);
    return clearTimer;
  }, [state.status, state.untimed]);

  // Move to the next word after feedback is shown
  useEffect(() => {
    if (state.status !== "correct" && state.status !== "incorrect") return;
    if (!state.tier) return;
    const t = window.setTimeout(
      () => advanceWord(state.tier as DifficultyTier, state.untimed),
      FEEDBACK_DELAY_MS
    );
    return () => window.clearTimeout(t);
  }, [state.status, state.tier, state.untimed, advanceWord]);

  useEffect(() => clearTimer, []);

  const resetToMenu = useCallback(() => {
    clearTimer();
    queueRef.current = [];
    setState(initialState);
  }, []);

  return { state, startGame, submitGuess, skipWord, resetToMenu };
}
