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

// Public surface of the game-engine hook. Any future hook (e.g.
// useMultiplayerGame) must satisfy this exact shape to be a drop-in
// replacement for useGameEngine in App.tsx.
export interface GameEngineApi {
  state: GameState;
  startGame: (tier: DifficultyTier) => void;
  submitGuess: (guess: string) => void;
  skipWord: () => void;
  resetToMenu: () => void;
}
