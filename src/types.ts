// Eight tiers, ordered easiest to hardest (Session 15). The original four keep
// their exact string values even though their relative position shifted — that
// is what lets existing "spellingbee:best:<tier>" localStorage entries and
// existing Postgres rows survive without a data migration. Do not rename them.
//
// TIER_ORDER below is the single source of ordering; nothing should hardcode a
// tier list alongside it.
export type DifficultyTier =
  | "novice"
  | "easy"
  | "building"
  | "medium"
  | "advanced"
  | "hard"
  | "expert"
  | "master";

/** Easiest to hardest. The only place the ordering is written down. */
export const TIER_ORDER: readonly DifficultyTier[] = [
  "novice",
  "easy",
  "building",
  "medium",
  "advanced",
  "hard",
  "expert",
  "master",
] as const;

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
  // --- Session 13 additions -------------------------------------------------
  // Both describe how the CURRENT game is being played, not a stored
  // preference: they're chosen per-game on the difficulty screen and are part
  // of GameState so the screens can render from state alone, exactly like every
  // other field. Both default to false, so an engine that doesn't support them
  // (multiplayer) reports false and every screen behaves as it did before.
  /** No countdown and no auto-timeout. `timeLeft` stays 0 and is not shown. */
  untimed: boolean;
  /** Spell from audio alone — RoundScreen renders no definition text. */
  hideDefinition: boolean;
}

/**
 * Per-game modifiers passed to startGame. Optional and additive: omitting them
 * yields exactly the pre-Session-13 behaviour.
 */
export interface GameOptions {
  untimed?: boolean;
  hideDefinition?: boolean;
}

// Public surface of the game-engine hook. Any future hook (e.g.
// useMultiplayerGame) must satisfy this exact shape to be a drop-in
// replacement for useGameEngine in App.tsx.
//
// Session 13 widened `startGame` with an optional second argument. This is a
// deliberate, documented extension of the Session 6 contract (see CLAUDE.md),
// not an ad-hoc addition. It is backwards compatible: every existing call site
// that passes only a tier keeps its old meaning, and an engine that can't honour
// the options — useMultiplayerGame, whose tier and timing are server-owned —
// ignores them and reports untimed:false / hideDefinition:false.
export interface GameEngineApi {
  state: GameState;
  startGame: (tier: DifficultyTier, options?: GameOptions) => void;
  submitGuess: (guess: string) => void;
  skipWord: () => void;
  resetToMenu: () => void;
}
