import { useCallback, useEffect, useRef, useState } from "react";
import type { DifficultyTier, GameEngineApi, GameState, WordEntry } from "../types";
import { wordsForTier } from "../data/words";

// Fewer seconds per word as difficulty rises. Tune once you have real
// playtesting data — this is a starting guess, not a balanced curve.
const ROUND_SECONDS: Record<DifficultyTier, number> = {
  easy: 20,
  medium: 16,
  hard: 13,
  expert: 11,
};

const FEEDBACK_DELAY_MS = 1100;

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
};

export function useGameEngine(): GameEngineApi {
  const [state, setState] = useState<GameState>(initialState);
  const queueRef = useRef<WordEntry[]>([]);
  const timerRef = useRef<number | null>(null);

  const clearTimer = () => {
    if (timerRef.current !== null) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
  };

  const advanceWord = useCallback((tier: DifficultyTier) => {
    const next = queueRef.current.shift();
    if (!next) {
      clearTimer();
      setState((s) => ({ ...s, status: "finished", currentWord: null }));
      return;
    }
    setState((s) => ({
      ...s,
      status: "playing",
      currentWord: next,
      timeLeft: ROUND_SECONDS[tier],
      wordsRemaining: queueRef.current.length,
    }));
    // Speaking is NOT triggered here. RoundScreen announces the word (lead-in
    // phrase + pause + word) when it renders a new one, which keeps narration
    // identical for singleplayer and multiplayer and lets the spoken lead-in and
    // the on-screen lead-in come from the same call. Triggering it here too
    // would speak every word twice.
  }, []);

  const startGame = useCallback(
    (tier: DifficultyTier) => {
      clearTimer();
      queueRef.current = shuffle(wordsForTier(tier));
      setState({ ...initialState, tier, score: 0, streak: 0, bestStreak: 0 });
      advanceWord(tier);
    },
    [advanceWord]
  );

  const submitGuess = useCallback(
    (guess: string) => {
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
        };
      });
    },
    []
  );

  const skipWord = useCallback(() => {
    setState((s) => ({ ...s, status: "incorrect", streak: 0 }));
  }, []);

  // Countdown timer while a round is active
  useEffect(() => {
    if (state.status !== "playing") return;
    clearTimer();
    timerRef.current = window.setInterval(() => {
      setState((s) => {
        if (s.status !== "playing") return s;
        if (s.timeLeft <= 1) {
          return { ...s, status: "incorrect", timeLeft: 0, streak: 0 };
        }
        return { ...s, timeLeft: s.timeLeft - 1 };
      });
    }, 1000);
    return clearTimer;
  }, [state.status]);

  // Move to the next word after feedback is shown
  useEffect(() => {
    if (state.status !== "correct" && state.status !== "incorrect") return;
    if (!state.tier) return;
    const t = window.setTimeout(() => advanceWord(state.tier as DifficultyTier), FEEDBACK_DELAY_MS);
    return () => window.clearTimeout(t);
  }, [state.status, state.tier, advanceWord]);

  useEffect(() => clearTimer, []);

  const resetToMenu = useCallback(() => {
    clearTimer();
    queueRef.current = [];
    setState(initialState);
  }, []);

  return { state, startGame, submitGuess, skipWord, resetToMenu };
}
