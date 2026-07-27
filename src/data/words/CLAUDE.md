# Word bank — src/data/words/

Moved out of the root CLAUDE.md so it loads when you are actually touching word
content, instead of in every session. Sourcing, licensing and the definition
rule live in `supabase/WORDLIST_SOURCES.md` — read that before touching word
content.

The **word bank is ~1200 words, 150 per tier** (Session 16). The Session 15
placeholders are gone.

- Words come from **SCOWL** via the MIT `wordlist-english` package, whose "size"
  buckets are a rarity grading. **Definitions are not from any dictionary** —
  every one is written fresh for this project, one sentence, no trailing full
  stop, never using the word inside its own definition. That rule is not
  negotiable and applies to every word added from here on.
- The bank is **split one file per tier** under `src/data/words/`, behind
  `src/data/words/index.ts`. Nothing outside that directory imports a tier file:
  `wordsForTier` is still the only accessor, so the split is invisible upstream.
- id prefixes: novice `n`, easy `e`, building `b`, medium `m`, advanced `a`,
  hard `h`, expert `x`, master `z`. Unique across the whole bank.
- The original 120 hand-curated words keep their exact ids, words, definitions
  and tiers (`e1`-`e30`, `m1`-`m30`, `h1`-`h30`, `x1`-`x30`). They are anchors —
  `rebalance_tiers.mjs` will not move them.
- Pipeline: `scripts/build_candidates.mjs` (pool from SCOWL) → hand-authored
  definitions → `scripts/rebalance_tiers.mjs` (swap between ADJACENT tiers until
  mean rarity rises strictly) → `scripts/verify_words.mjs` (uniqueness, prefixes,
  counts, gradient) → `supabase/scripts/gen_seed.mjs` (regenerate the seed).
  Run `verify_words.mjs` after ANY word change; it is the gate.
- Mean **rarity** must rise strictly across tiers and is enforced. Mean **length**
  is reported but deliberately not enforced: a short obscure word (`nadir`,
  `ennui`, `cabal`) is still hard, and forcing length monotonic would push
  exactly those out of the top tiers.
- `WORDS_PER_GAME` (=30) in `useGameEngine.ts` caps a singleplayer game. Added in
  Session 16 because 150 words per tier would otherwise have made a game five
  times longer — the extra words deepen the POOL, they don't lengthen the game.
  The multiplayer counterpart is `public.rounds_per_game()` (=10); the two are
  independent by design.

After changing word content, regenerate the seed — see `supabase/CLAUDE.md`.
