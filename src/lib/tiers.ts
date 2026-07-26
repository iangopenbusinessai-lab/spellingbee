import { TIER_ORDER, type DifficultyTier } from "../types";

// Display metadata for the eight tiers. One table, so the difficulty screen,
// the lobby's create-room picker and the waiting room can never disagree about
// what a tier is called — before Session 15 each of those kept its own list.
//
// Ordering is NOT repeated here: iterate TIER_ORDER from types.ts.
export const TIER_META: Record<DifficultyTier, { label: string; blurb: string }> = {
  novice: { label: "Novice", blurb: "First words, short and simple" },
  easy: { label: "Easy", blurb: "Common everyday words" },
  building: { label: "Building", blurb: "Longer, still familiar" },
  medium: { label: "Medium", blurb: "Trickier spellings" },
  advanced: { label: "Advanced", blurb: "Unusual letter patterns" },
  hard: { label: "Hard", blurb: "Multi-syllable words" },
  expert: { label: "Expert", blurb: "Competition-level" },
  master: { label: "Master", blurb: "Championship rarities" },
};

/** Tier list in difficulty order, with display metadata attached. */
export const TIERS = TIER_ORDER.map((id) => ({ id, ...TIER_META[id] }));
