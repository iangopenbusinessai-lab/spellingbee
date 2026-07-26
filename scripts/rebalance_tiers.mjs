// rebalance_tiers.mjs — stage 3 of the word-sourcing pipeline (Session 16).
//
//   node scripts/rebalance_tiers.mjs [--dry]
//
// Enforces the property the tiers are supposed to have: mean SCOWL rarity must
// RISE across TIER_ORDER. Hand-authoring 1200 words inevitably drifts — a batch
// written for "building" came out commoner on average than the batch written
// for "easy" — and eyeballing that is hopeless at this scale.
//
// It fixes drift by swapping words between ADJACENT tiers only: the rarest
// movable word in the lower tier trades places with the commonest movable word
// in the higher one. Adjacent-only keeps every word close to where it was
// judged to belong; a word never jumps from novice to master.
//
// "Movable" excludes the 120 original hand-curated entries (ids 1-30 in easy,
// medium, hard, expert). Those were curated by spelling difficulty rather than
// frequency and CLAUDE.md pins them where they are, so they are anchors.
//
// Definitions travel with their word. Ids are renumbered per tier afterwards so
// the prefix always matches the tier.

import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(repoRoot, "package.json"));
const dir = join(repoRoot, "src", "data", "words");
const dry = process.argv.includes("--dry");

const TIER_ORDER = ["novice", "easy", "building", "medium", "advanced", "hard", "expert", "master"];
const PREFIX = { novice: "n", easy: "e", building: "b", medium: "m", advanced: "a", hard: "h", expert: "x", master: "z" };
const CONST = {
  novice: "NOVICE_WORDS", easy: "EASY_WORDS", building: "BUILDING_WORDS", medium: "MEDIUM_WORDS",
  advanced: "ADVANCED_WORDS", hard: "HARD_WORDS", expert: "EXPERT_WORDS", master: "MASTER_WORDS",
};
const LEGACY_MAX = { easy: 30, medium: 30, hard: 30, expert: 30 };

const SIZES = [10, 20, 35, 40, 50, 55, 60, 70];
const bucketOf = new Map();
for (const n of SIZES) {
  for (const w of require(`wordlist-english/english-words-${n}.json`)) {
    if (!bucketOf.has(w)) bucketOf.set(w, n);
  }
}
// Words SCOWL doesn't list at all are rare by definition; score them at the top.
const rarity = (w) => bucketOf.get(w.toLowerCase()) ?? 70;

// --- load ------------------------------------------------------------------
const entryRe =
  /^\s*\{\s*id:\s*"([^"]+)",\s*word:\s*"([^"]+)",\s*tier:\s*"([^"]+)",\s*definition:\s*"((?:[^"\\]|\\.)*)"\s*\},?\s*$/;
const headers = {};
const byTier = Object.fromEntries(TIER_ORDER.map((t) => [t, []]));

for (const tier of TIER_ORDER) {
  const src = readFileSync(join(dir, `${tier}.ts`), "utf8");
  headers[tier] = src.slice(0, src.indexOf("export const"));
  for (const line of src.split(/\r?\n/)) {
    const m = entryRe.exec(line);
    if (!m) continue;
    const [, id, word, t, definition] = m;
    const num = Number(id.replace(/^\D+/, ""));
    const legacy = LEGACY_MAX[t] !== undefined && num <= LEGACY_MAX[t];
    byTier[t].push({ word, definition, legacy });
  }
}

const mean = (t) => byTier[t].reduce((a, e) => a + rarity(e.word), 0) / byTier[t].length;
const report = (label) =>
  console.log(label + "  " + TIER_ORDER.map((t) => `${t.slice(0, 4)}:${mean(t).toFixed(1)}`).join("  "));

report("before:");

// --- swap until monotonic ---------------------------------------------------
let swaps = 0;
for (let pass = 0; pass < 400; pass++) {
  let violated = -1;
  for (let i = 0; i < TIER_ORDER.length - 1; i++) {
    // Require a real gap, not a tie, so the ordering is unambiguous.
    if (mean(TIER_ORDER[i]) >= mean(TIER_ORDER[i + 1]) - 0.25) { violated = i; break; }
  }
  if (violated === -1) break;

  const lo = TIER_ORDER[violated], hi = TIER_ORDER[violated + 1];
  const loMovable = byTier[lo].filter((e) => !e.legacy);
  const hiMovable = byTier[hi].filter((e) => !e.legacy);
  if (!loMovable.length || !hiMovable.length) {
    console.error(`no movable words left to fix ${lo} -> ${hi}`);
    break;
  }
  // rarest in the lower tier, commonest in the higher tier
  const up = loMovable.reduce((a, b) => (rarity(b.word) > rarity(a.word) ? b : a));
  const down = hiMovable.reduce((a, b) => (rarity(b.word) < rarity(a.word) ? b : a));
  if (rarity(up.word) <= rarity(down.word)) {
    console.error(`cannot improve ${lo} -> ${hi} by swapping; stopping`);
    break;
  }
  byTier[lo][byTier[lo].indexOf(up)] = down;
  byTier[hi][byTier[hi].indexOf(down)] = up;
  swaps++;
}

report("after: ");
console.log(`\n${swaps} swap(s)`);
const monotonic = TIER_ORDER.every((t, i) => i === 0 || mean(t) > mean(TIER_ORDER[i - 1]));
console.log(monotonic ? "rarity is now strictly increasing" : "STILL NOT MONOTONIC");

if (dry) process.exit(monotonic ? 0 : 1);

// --- renumber + write -------------------------------------------------------
for (const tier of TIER_ORDER) {
  const legacyMax = LEGACY_MAX[tier] ?? 0;
  let n = legacyMax;
  const lines = byTier[tier].map((e, i) => {
    const id = e.legacy ? `${PREFIX[tier]}${i + 1}` : `${PREFIX[tier]}${++n}`;
    return `  { id: "${id}", word: "${e.word}", tier: "${tier}", definition: "${e.definition}" },`;
  });
  const out = `${headers[tier]}export const ${CONST[tier]}: WordEntry[] = [\n${lines.join("\n")}\n];\n`;
  writeFileSync(join(dir, `${tier}.ts`), out);
}
console.log("rewrote 8 tier files");
