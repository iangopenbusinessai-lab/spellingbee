import type { WordEntry } from "../types";

// v1 seed list — small sample per tier so the game loop is playable end to end.
// Swap this for a larger curated bank (frequency list, SAT/GRE vocab, etc.)
// once the core loop feels right. Keep the shape the same: id/word/tier/definition.
export const WORD_BANK: WordEntry[] = [
  { id: "e1", word: "garden", tier: "easy", definition: "A plot of land for growing plants" },
  { id: "e2", word: "pencil", tier: "easy", definition: "A tool used for writing or drawing" },
  { id: "e3", word: "yellow", tier: "easy", definition: "The color of a lemon" },
  { id: "e4", word: "castle", tier: "easy", definition: "A large fortified building" },
  { id: "e5", word: "bridge", tier: "easy", definition: "A structure that crosses a river or gap" },

  { id: "m1", word: "rhythm", tier: "medium", definition: "A strong, regular repeated pattern of sound" },
  { id: "m2", word: "narrate", tier: "medium", definition: "To give a spoken account of something" },
  { id: "m3", word: "occasion", tier: "medium", definition: "A particular time or event" },
  { id: "m4", word: "vacuum", tier: "medium", definition: "A space entirely devoid of matter" },
  { id: "m5", word: "privilege", tier: "medium", definition: "A special right granted to a person or group" },

  { id: "h1", word: "conscience", tier: "hard", definition: "An inner sense of right and wrong" },
  { id: "h2", word: "bureaucracy", tier: "hard", definition: "A system of government with many departments" },
  { id: "h3", word: "silhouette", tier: "hard", definition: "The dark shape of something against a light background" },
  { id: "h4", word: "millennium", tier: "hard", definition: "A period of one thousand years" },
  { id: "h5", word: "reconnaissance", tier: "hard", definition: "Military observation of enemy territory" },

  { id: "x1", word: "bromocriptine", tier: "expert", definition: "A drug used to treat certain hormonal disorders" },
  { id: "x2", word: "pharmaceutical", tier: "expert", definition: "Relating to the preparation of medicinal drugs" },
  { id: "x3", word: "onomatopoeia", tier: "expert", definition: "A word that phonetically imitates a sound" },
  { id: "x4", word: "idiosyncrasy", tier: "expert", definition: "A distinctive habit or peculiarity" },
  { id: "x5", word: "chiaroscuro", tier: "expert", definition: "The treatment of light and shade in art" },
];

export function wordsForTier(tier: WordEntry["tier"]): WordEntry[] {
  return WORD_BANK.filter((w) => w.tier === tier);
}
