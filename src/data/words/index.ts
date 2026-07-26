import type { DifficultyTier, WordEntry } from "../../types";
import { NOVICE_WORDS } from "./novice";
import { EASY_WORDS } from "./easy";
import { BUILDING_WORDS } from "./building";
import { MEDIUM_WORDS } from "./medium";
import { ADVANCED_WORDS } from "./advanced";
import { HARD_WORDS } from "./hard";
import { EXPERT_WORDS } from "./expert";
import { MASTER_WORDS } from "./master";

// The word bank, one file per tier (Session 16). It was a single file while the
// bank was 120 entries; at ~1200 that file was unreviewable and every tier edit
// touched it, so it is split by tier. Nothing outside this directory imports a
// tier file directly — `wordsForTier` stays the only accessor, exactly as
// before, so the split is invisible to the rest of the app.
//
// Sourcing, licensing and the definition-authoring rule: supabase/WORDLIST_SOURCES.md
// Integrity + difficulty-gradient checks: scripts/verify_words.mjs

const BY_TIER: Record<DifficultyTier, WordEntry[]> = {
  novice: NOVICE_WORDS,
  easy: EASY_WORDS,
  building: BUILDING_WORDS,
  medium: MEDIUM_WORDS,
  advanced: ADVANCED_WORDS,
  hard: HARD_WORDS,
  expert: EXPERT_WORDS,
  master: MASTER_WORDS,
};

export const WORD_BANK: WordEntry[] = Object.values(BY_TIER).flat();

export function wordsForTier(tier: DifficultyTier): WordEntry[] {
  return BY_TIER[tier];
}
