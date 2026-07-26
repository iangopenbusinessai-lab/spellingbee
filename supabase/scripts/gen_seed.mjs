// gen_seed.mjs — regenerates the consolidated word seed migration from the
// split tier files in src/data/words/.
//
//   node supabase/scripts/gen_seed.mjs supabase/migrations/0011_reseed_words.sql
//
// Session 16 rewrote this. It used to read a single src/data/words.ts and emit
// 0003; the bank is now eight files and the canonical seed is 0011, which
// SUPERSEDES both 0003 (the original 120) and 0010's placeholder rows.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const dir = join(repoRoot, "src", "data", "words");

const TIER_ORDER = ["novice", "easy", "building", "medium", "advanced", "hard", "expert", "master"];
const entryRe =
  /\{\s*id:\s*"([^"]+)",\s*word:\s*"([^"]+)",\s*tier:\s*"([^"]+)",\s*definition:\s*"((?:[^"\\]|\\.)*)"\s*(?:,\s*partOfSpeech:\s*"([^"]+)")?\s*\}/g;

const rows = [];
const perTier = {};
for (const tier of TIER_ORDER) {
  const src = readFileSync(join(dir, `${tier}.ts`), "utf8");
  let m;
  let n = 0;
  while ((m = entryRe.exec(src)) !== null) {
    rows.push({ id: m[1], word: m[2], tier: m[3], definition: m[4], pos: m[5] ?? null });
    n++;
  }
  perTier[tier] = n;
}

if (rows.length < 1000) {
  console.error(`Only parsed ${rows.length} words — that looks like a parse failure. Aborting.`);
  process.exit(1);
}
if (new Set(rows.map((r) => r.id)).size !== rows.length) {
  console.error("Duplicate ids — run scripts/verify_words.mjs. Aborting.");
  process.exit(1);
}

const sq = (s) => "'" + s.replace(/'/g, "''") + "'";
const val = (r) =>
  `  (${sq(r.id)}, ${sq(r.word)}, ${sq(r.tier)}, ${sq(r.definition)}, ${r.pos === null ? "null" : sq(r.pos)})`;

const counts = TIER_ORDER.map((t) => `--   ${t.padEnd(9)} ${String(perTier[t]).padStart(4)}`).join("\n");

const out = `-- 0011_reseed_words.sql
-- Session 16: the consolidated word bank. GENERATED — do not hand-edit.
--   node supabase/scripts/gen_seed.mjs supabase/migrations/0011_reseed_words.sql
--
-- This file SUPERSEDES the word rows in 0003 (the original 120) and 0010 (the
-- Session 15 placeholders). Those two are left in place because they are already
-- applied remotely and rewriting an applied migration would diverge local and
-- remote history; from here on this is the only file that seeds words.
--
-- ${rows.length} words across ${TIER_ORDER.length} tiers:
${counts}
--
-- Upsert with no deletes, deliberately: round_results.word_id has a foreign key
-- onto words.id, so deleting a word a past game referenced would fail. Deletes
-- aren't needed anyway — this id space is a superset of everything 0003 and 0010
-- inserted, so every existing row is updated in place. The only rows whose WORD
-- changes are the 32 Session 15 placeholder ids, which only ever appeared in
-- development test games.
--
-- Idempotent: safe to re-run. Runs as the migration owner (postgres), which
-- bypasses RLS, so no client INSERT policy is needed on public.words.

insert into public.words (id, word, tier, definition, part_of_speech) values
${rows.map(val).join(",\n")}
on conflict (id) do update set
  word = excluded.word,
  tier = excluded.tier,
  definition = excluded.definition,
  part_of_speech = excluded.part_of_speech;
`;

writeFileSync(process.argv[2], out);
console.log(`wrote ${rows.length} words to ${process.argv[2]}`);
for (const t of TIER_ORDER) console.log(`  ${t.padEnd(9)} ${perTier[t]}`);
