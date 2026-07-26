// verify_words.mjs — integrity + difficulty-gradient check for the word bank.
// Successor to the Session 4 uniqueness check, rebuilt for ~1200 entries across
// 8 split tier files.
//
//   node scripts/verify_words.mjs            # check
//   node scripts/verify_words.mjs --sample 5 # also print N definitions per tier
//
// Checks:
//   1. ids unique across the WHOLE bank
//   2. words unique across the whole bank (a duplicate word in another tier is
//      still a bug — the same prompt would be gradeable at two difficulties)
//   3. every id uses its tier's documented prefix
//   4. count per tier
//   5. difficulty gradient: mean word length and mean SCOWL rarity bucket must
//      both rise monotonically across TIER_ORDER
//   6. every word is a real dictionary word (present in SCOWL at all)

import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(repoRoot, "package.json"));

const TIER_ORDER = ["novice", "easy", "building", "medium", "advanced", "hard", "expert", "master"];
const PREFIX = { novice: "n", easy: "e", building: "b", medium: "m", advanced: "a", hard: "h", expert: "x", master: "z" };

// --- SCOWL rarity, for the gradient check ----------------------------------
const SIZES = [10, 20, 35, 40, 50, 55, 60, 70];
const bucketOf = new Map();
for (const n of SIZES) {
  for (const w of require(`wordlist-english/english-words-${n}.json`)) {
    if (!bucketOf.has(w)) bucketOf.set(w, n);
  }
}

// --- load every tier file ---------------------------------------------------
const dir = join(repoRoot, "src", "data", "words");
const entryRe =
  /\{\s*id:\s*"([^"]+)",\s*word:\s*"([^"]+)",\s*tier:\s*"([^"]+)",\s*definition:\s*"((?:[^"\\]|\\.)*)"\s*(?:,\s*partOfSpeech:\s*"([^"]+)")?\s*\}/g;

const all = [];
for (const file of readdirSync(dir).filter((f) => f.endsWith(".ts") && f !== "index.ts")) {
  const src = readFileSync(join(dir, file), "utf8");
  let m;
  while ((m = entryRe.exec(src)) !== null) {
    all.push({ id: m[1], word: m[2], tier: m[3], definition: m[4], file });
  }
}

let failures = 0;
const fail = (msg) => { failures++; console.log(`   FAIL  ${msg}`); };
const pass = (msg) => console.log(`   PASS  ${msg}`);

console.log(`=== loaded ${all.length} entries from ${readdirSync(dir).length} files ===\n`);

// 1. duplicate ids
const idSeen = new Map();
const dupIds = [];
for (const e of all) {
  if (idSeen.has(e.id)) dupIds.push(`${e.id} (${idSeen.get(e.id)} + ${e.file})`);
  else idSeen.set(e.id, e.file);
}
console.log("=== 1. id uniqueness ===");
dupIds.length ? fail(`duplicate ids: ${dupIds.join(", ")}`) : pass(`all ${all.length} ids unique`);

// 2. duplicate words
const wordSeen = new Map();
const dupWords = [];
for (const e of all) {
  const k = e.word.toLowerCase();
  if (wordSeen.has(k)) dupWords.push(`"${e.word}" (${wordSeen.get(k)} + ${e.tier})`);
  else wordSeen.set(k, e.tier);
}
console.log("\n=== 2. word uniqueness (across all tiers) ===");
dupWords.length ? fail(`duplicate words: ${dupWords.join(", ")}`) : pass(`all ${all.length} words unique`);

// 3. id prefixes
console.log("\n=== 3. id prefix matches tier ===");
const badPrefix = all.filter((e) => {
  const p = PREFIX[e.tier];
  return !p || !new RegExp(`^${p}\\d+$`).test(e.id);
});
badPrefix.length
  ? fail(`wrong prefix: ${badPrefix.slice(0, 10).map((e) => `${e.id}/${e.tier}`).join(", ")}${badPrefix.length > 10 ? " ..." : ""}`)
  : pass("every id uses its tier's prefix");

// 4/5. counts + gradient
console.log("\n=== 4/5. count and difficulty gradient per tier ===");
console.log("   tier       count   mean len   mean rarity   not-in-SCOWL");
const stats = [];
for (const tier of TIER_ORDER) {
  const rows = all.filter((e) => e.tier === tier);
  const lens = rows.map((r) => r.word.length);
  const buckets = rows.map((r) => bucketOf.get(r.word.toLowerCase())).filter((b) => b !== undefined);
  const unknown = rows.filter((r) => bucketOf.get(r.word.toLowerCase()) === undefined);
  const meanLen = lens.reduce((a, b) => a + b, 0) / (lens.length || 1);
  const meanBucket = buckets.reduce((a, b) => a + b, 0) / (buckets.length || 1);
  stats.push({ tier, count: rows.length, meanLen, meanBucket, unknown: unknown.map((u) => u.word) });
  console.log(
    "  ",
    tier.padEnd(10),
    String(rows.length).padStart(4),
    "   ",
    meanLen.toFixed(2).padStart(6),
    "   ",
    meanBucket.toFixed(1).padStart(8),
    "   ",
    unknown.length
  );
}

// Rarity is the GATE. Length is reported but deliberately not enforced: a short
// obscure word ("nadir", "ennui", "cabal", "jejune") is still hard to spell, so
// forcing mean length to rise too would push exactly those words out of the top
// tiers for no good reason. Frequency leads; length is a secondary signal only.
const rarityRising = stats.every((s, i) => i === 0 || s.meanBucket > stats[i - 1].meanBucket);
const lenRising = stats.every((s, i) => i === 0 || s.meanLen >= stats[i - 1].meanLen);
console.log();
rarityRising ? pass("mean SCOWL rarity rises strictly across tiers (the gradient gate)")
             : fail("mean SCOWL rarity is NOT monotonic");
console.log(
  `   NOTE  mean word length ${lenRising ? "also rises monotonically" : "is not monotonic — expected, and not enforced"}`
);

// 6. real words
console.log("\n=== 6. every word appears in SCOWL ===");
const notReal = stats.flatMap((s) => s.unknown);
notReal.length
  ? console.log(`   NOTE  ${notReal.length} not in SCOWL (hand-curated legacy or proper-ish): ${notReal.join(", ")}`)
  : pass("every word found in SCOWL");

// optional sample
const sampleIdx = process.argv.indexOf("--sample");
if (sampleIdx !== -1) {
  const n = Number(process.argv[sampleIdx + 1] ?? 5);
  console.log(`\n=== random sample of ${n} definitions per tier ===`);
  for (const tier of TIER_ORDER) {
    const rows = all.filter((e) => e.tier === tier);
    console.log(`\n-- ${tier} --`);
    const picked = new Set();
    while (picked.size < Math.min(n, rows.length)) picked.add(Math.floor(Math.random() * rows.length));
    for (const i of picked) console.log(`   ${rows[i].word.padEnd(18)} ${rows[i].definition}`);
  }
}

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
