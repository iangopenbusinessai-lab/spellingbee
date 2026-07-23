export type DifficultyTier = "easy" | "medium" | "hard" | "expert";

export interface WordEntry {
  id: string;
  word: string;
  tier: DifficultyTier;
  definition: string;
  partOfSpeech?: string;
}

export type RoundStatus = "idle" | "playing" | "correct" | "incorrect" | "finished";

export interface GameState {
  tier: DifficultyTier | null;
  status: RoundStatus;
  currentWord: WordEntry | null;
  score: number;
  streak: number;
  bestStreak: number;
  timeLeft: number;
  wordsRemaining: number;
}
