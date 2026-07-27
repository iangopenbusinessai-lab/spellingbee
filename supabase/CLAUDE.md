# supabase/ — migrations and the generated seed

Moved out of the root CLAUDE.md so it loads when you are working in this
directory rather than in every session.

**Migration debt from Session 15 is resolved.** `0011_reseed_words.sql` is the
canonical, generated seed and supersedes the word rows in 0003 and 0010. Those
two are left in place because they are already applied remotely and rewriting an
applied migration would diverge local and remote history. Regenerate 0011 — never
hand-edit it — with:

```
node supabase/scripts/gen_seed.mjs supabase/migrations/0011_reseed_words.sql
```

It is a pure upsert with no deletes, because `round_results.word_id` has a
foreign key onto `words.id`; deletes aren't needed anyway since the id space is a
superset of everything 0003 and 0010 inserted.

Word content itself (sourcing, id prefixes, the definition rule, the verify
gate) is documented in `src/data/words/CLAUDE.md`.
