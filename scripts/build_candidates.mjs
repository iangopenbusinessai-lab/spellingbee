// build_candidates.mjs — stage 1 of the word-sourcing pipeline (Session 16).
//
//   node scripts/build_candidates.mjs [outfile.json]
//
// Produces a FILTERED CANDIDATE POOL per tier from SCOWL rarity buckets. It
// deliberately does NOT produce the final word bank: definitions are written by
// hand from the pool (see supabase/WORDLIST_SOURCES.md for why), so the pool is
// intentionally several times larger than the ~150 words each tier needs.
//
// Source: wordlist-english (MIT), built from SCOWL. Its "size" buckets are a
// rarity grading — 10 is the most common few thousand words, 70 is genuinely
// obscure. Buckets are INCREMENTAL: a word appears in the first size at which
// SCOWL includes it, so a word's bucket is its rarity score.
//
// Tier -> bucket mapping was calibrated against the 120 hand-curated words that
// already existed, not guessed. Those were graded by SPELLING difficulty rather
// than pure frequency (`rhythm` is a common word that is hard to spell), so the
// mapping is a considered fit rather than a clean 1:1:
//
//   existing tier medians -> easy 20, medium 10(!), hard 35, expert 50
//   anchors -> vicissitude 50, zeitgeist 55, usufruct/zugzwang 70
//
// Frequency leads; length is a secondary filter only, because a short obscure
// word is still hard.

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(repoRoot, "package.json"));

const SIZES = [10, 20, 35, 40, 50, 55, 60, 70];

/** Rarity bucket per word: the first SCOWL size that includes it. */
const bucketOf = new Map();
/** Everything SCOWL knows, for stem checks below. */
const allWords = new Set();
for (const n of SIZES) {
  for (const w of require(`wordlist-english/english-words-${n}.json`)) {
    allWords.add(w);
    if (!bucketOf.has(w)) bucketOf.set(w, n);
  }
}

// tier -> { buckets, minLen, maxLen }
const TIER_RULES = {
  novice:   { buckets: [10],         minLen: 3,  maxLen: 5 },
  easy:     { buckets: [10, 20],     minLen: 4,  maxLen: 7 },
  building: { buckets: [20],         minLen: 5,  maxLen: 8 },
  medium:   { buckets: [20, 35],     minLen: 5,  maxLen: 9 },
  advanced: { buckets: [35],         minLen: 6,  maxLen: 10 },
  hard:     { buckets: [35, 40],     minLen: 7,  maxLen: 12 },
  expert:   { buckets: [50, 55],     minLen: 7,  maxLen: 14 },
  master:   { buckets: [60, 70],     minLen: 8,  maxLen: 16 },
};

// Vulgarity / slurs. SCOWL's larger sizes include plenty, and this is a
// spelling game aimed at learners. Substring matching is intentionally blunt —
// a few false positives cost nothing when the pool is this oversized.
const BLOCK_SUBSTRINGS = [
  "fuck", "shit", "cunt", "nigg", "fagg", "whore", "slut", "rape", "rapist",
  "penis", "vagina", "seman", "semen", "scrotum", "testicle", "orgasm", "erotic",
  "porn", "incest", "bastard", "bitch", "damn", "hell", "piss", "turd", "arse",
  "wank", "bollock", "prick", "dick", "tit", "boob", "anal", "anus", "nazi",
  "kill", "murder", "suicide", "corpse", "heroin", "cocaine", "opium",
];

const isBlocked = (w) => BLOCK_SUBSTRINGS.some((b) => w.includes(b));

/**
 * Drop mechanical inflections whose stem is itself a word — they make dull
 * spelling prompts and bloat the pool with near-duplicates of each other.
 */
function isInflection(w) {
  const stems = [];
  if (w.endsWith("s") && !w.endsWith("ss")) stems.push(w.slice(0, -1), w.slice(0, -2));
  if (w.endsWith("es")) stems.push(w.slice(0, -2));
  if (w.endsWith("ing")) stems.push(w.slice(0, -3), w.slice(0, -3) + "e");
  if (w.endsWith("ed")) stems.push(w.slice(0, -1), w.slice(0, -2));
  if (w.endsWith("er") || w.endsWith("est")) stems.push(w.replace(/(er|est)$/, ""));
  if (w.endsWith("ly")) stems.push(w.slice(0, -2));
  return stems.some((s) => s.length >= 3 && allWords.has(s));
}

// Words already in the hand-curated bank keep their existing tier and must not
// be re-suggested anywhere.
const existing = new Set();
const bankDir = join(repoRoot, "src", "data", "words");
for (const f of readdirSync(bankDir).filter((f) => f.endsWith(".ts") && f !== "index.ts")) {
  const bankSrc = readFileSync(join(bankDir, f), "utf8");
  for (const m of bankSrc.matchAll(/word:\s*"([^"]+)"/g)) existing.add(m[1]);
}

const out = {};
const summary = [];
for (const [tier, rule] of Object.entries(TIER_RULES)) {
  const pool = [];
  for (const [w, b] of bucketOf) {
    if (!rule.buckets.includes(b)) continue;
    if (!/^[a-z]+$/.test(w)) continue;           // no proper nouns, no punctuation
    if (w.length < rule.minLen || w.length > rule.maxLen) continue;
    if (existing.has(w)) continue;
    if (isBlocked(w)) continue;
    if (isInflection(w)) continue;
    pool.push(w);
  }
  pool.sort();
  out[tier] = pool;
  summary.push([tier, rule.buckets.join("/"), `${rule.minLen}-${rule.maxLen}`, pool.length]);
}

console.log("tier      buckets  len     candidates");
for (const [t, b, l, n] of summary) {
  console.log(t.padEnd(9), b.padEnd(8), l.padEnd(7), n);
}

const dest = process.argv[2] ?? join(repoRoot, "scripts", "candidates.json");
writeFileSync(dest, JSON.stringify(out, null, 1));
console.log(`\nwrote ${dest}`);
