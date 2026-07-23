import { readFileSync, writeFileSync } from "node:fs";

const src = readFileSync(process.argv[2], "utf8");

// Match each single-line WordEntry object literal from words.ts.
const re =
  /\{\s*id:\s*"([^"]+)",\s*word:\s*"([^"]+)",\s*tier:\s*"([^"]+)",\s*definition:\s*"((?:[^"\\]|\\.)*)"\s*(?:,\s*partOfSpeech:\s*"([^"]+)")?\s*\}/g;

const rows = [];
let m;
while ((m = re.exec(src)) !== null) {
  const [, id, word, tier, definition, pos] = m;
  rows.push({ id, word, tier, definition, pos: pos ?? null });
}

if (rows.length !== 120) {
  console.error(`Expected 120 words, parsed ${rows.length}. Aborting.`);
  process.exit(1);
}

const sq = (s) => "'" + s.replace(/'/g, "''") + "'";
const val = (r) =>
  `  (${sq(r.id)}, ${sq(r.word)}, ${sq(r.tier)}, ${sq(r.definition)}, ${
    r.pos === null ? "null" : sq(r.pos)
  })`;

const header = `-- 0003_seed_words.sql
-- Seeds the 120-word bank so multiplayer and singleplayer draw from the
-- same source. Generated from src/data/words.ts by supabase/scripts/gen_seed.mjs
-- (do not hand-edit; regenerate if the word bank changes).
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

writeFileSync(process.argv[3], header);
const byTier = rows.reduce((a, r) => ((a[r.tier] = (a[r.tier] ?? 0) + 1), a), {});
console.error(`Wrote ${rows.length} rows:`, JSON.stringify(byTier));
