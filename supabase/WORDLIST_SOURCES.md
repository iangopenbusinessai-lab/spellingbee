# Word list sources and licensing

Session 16. This records where the ~1200-word bank came from, what licence the
source carries, and — separately — where the **definitions** came from, because
those are two different questions with two different answers.

## The short version

- **Words** come from SCOWL via the MIT-licensed `wordlist-english` npm package.
- **Definitions are not from any dictionary.** Every one is written fresh for
  this project. No definition text was copied, paraphrased, or "reworded" from a
  dictionary, Wiktionary, WordNet, or anywhere else.

## Word source

**Package:** [`wordlist-english`](https://www.npmjs.com/package/wordlist-english) v1.2.1
**Package licence:** MIT
**Upstream:** [SCOWL](http://wordlist.aspell.net/) (Spell Checker Oriented Word Lists) by Kevin Atkinson

SCOWL is the list family that spell-checkers are built from. It ships words
graded into "size" buckets by how common they are — size 10 is roughly the most
common few thousand English words, size 70 is genuinely obscure. That grading is
what makes it suitable here: it gives an objective rarity signal to tier
against, rather than a guess.

The buckets are **incremental** — a word appears in the first size at which
SCOWL includes it — so a word's bucket number is effectively its rarity score.

### SCOWL copyright notice

SCOWL's licence requires the copyright notice to travel with derived work. The
full notice ships in `node_modules/wordlist-english/Copyright`. The core grant:

> The collective work is Copyright 2000-2016 by Kevin Atkinson as well as any of
> the copyrights mentioned below:
>
> Copyright 2000-2016 by Kevin Atkinson
>
> Permission to use, copy, modify, distribute and sell these word lists, the
> associated scripts, the output created from the scripts, and its documentation
> for any purpose is hereby granted without fee, provided that the above
> copyright notice appears in all copies and that both that copyright notice and
> this permission notice appear in supporting documentation. Kevin Atkinson makes
> no representations about the suitability of this array for any purpose. It is
> provided "as is" without express or implied warranty.

SCOWL incorporates several public-domain and permissively-licensed sources,
including the Moby lexicon (explicitly placed in the public domain) and the
ENABLE list. `wordlist-english` is only a build dependency of the pipeline
scripts — it is **not** shipped in the app bundle, and no SCOWL data is
redistributed. Only the ~1080 word strings we selected end up in this repo.

### What was explicitly NOT done

No commercial dictionary site was scraped. Individual words are not
copyrightable, but a scraped proprietary *list plus definitions* dataset is a
derived database and exactly the thing to avoid. Nothing here touched one.

## Definitions

All 1200 definitions are original, written for this project, in a deliberately
consistent house style: one sentence, no trailing full stop, no use of the word
itself inside its own definition, aimed at a learner rather than a lexicographer.

This is the same rule the original 120 hand-curated words followed, applied at
scale. The house style is itself a safeguard — dictionary definitions read
nothing like "A round object you throw, kick or bounce".

Spot-checking for accidental closeness to real dictionary phrasing is part of
the session checklist; a random sample per tier is reviewed rather than just the
first few entries, since the first few are the ones most likely to have been
written carefully.

## The pipeline

Three scripts, run in order. None of them run at build time — the bank is
checked in as plain TypeScript.

| script | stage |
|---|---|
| `scripts/build_candidates.mjs` | pull a filtered candidate pool per tier from the SCOWL buckets |
| *(manual)* | select words from the pool and write definitions |
| `scripts/rebalance_tiers.mjs` | swap words between adjacent tiers until mean rarity rises strictly |
| `scripts/verify_words.mjs` | uniqueness, id prefixes, counts, difficulty gradient |
| `supabase/scripts/gen_seed.mjs` | regenerate the Postgres seed migration from the bank |

The manual stage in the middle is load-bearing, not laziness. An automatic
selection from SCOWL alone would pick thousands of words nobody can define
accurately — inflected forms, dialect terms, obscure taxonomy — and a wrong
definition is worse than a missing word. So the frequency data decides *tiering*
and the candidate pool bounds *what may be chosen*, while a human-readable
definition is written only for words whose meaning is actually known.

## Tier mapping

Calibrated against the 120 pre-existing hand-curated words rather than guessed.
Those were graded by **spelling** difficulty, not frequency (`rhythm` is a common
word that is hard to spell), so the mapping is a considered fit:

| tier | SCOWL buckets | length filter | mean rarity achieved |
|---|---|---|---|
| novice | 10 | 3–5 | 12.6 |
| easy | 10–20 | 4–7 | 19.0 |
| building | 20 | 5–8 | 19.4 |
| medium | 20–35 | 5–9 | 23.5 |
| advanced | 35 | 6–10 | 24.1 |
| hard | 35–40 | 7–12 | 30.6 |
| expert | 50–55 | 7–14 | 39.5 |
| master | 60–70 | 8–16 | 47.9 |

Calibration anchors: `vicissitude` → 50, `zeitgeist` → 55, `usufruct` and
`zugzwang` → 70. Expert sits around the first two; master clears them.

Mean word **length** is reported but deliberately not enforced as monotonic.
A short obscure word (`nadir`, `ennui`, `cabal`, `jejune`) is still hard to
spell, and forcing length to rise would push exactly those out of the top tiers.
Frequency leads; length is a secondary filter on the candidate pool only.

## Filtering applied to candidates

- lowercase `a-z` only — drops proper nouns, hyphenates and possessives
- per-tier length bounds
- mechanical inflections dropped where the stem is itself a word (`-s`, `-ing`,
  `-ed`, `-er`, `-est`, `-ly`), which otherwise flood the pool with near-duplicates
- a vulgarity/slur blocklist, matched as substrings — deliberately blunt, since
  this is a spelling game for learners and the pool is many times oversized
- anything already in the bank
