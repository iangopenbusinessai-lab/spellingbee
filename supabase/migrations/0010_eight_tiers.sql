-- 0010_eight_tiers.sql
-- Session 15: widen the tier domain from 4 values to 8.
--
-- Ordering, easiest to hardest:
--   novice, easy, building, medium, advanced, hard, expert, master
--
-- The original four keep their EXACT string values even though their relative
-- position shifted. That is the whole reason this migration needs no data
-- backfill: every existing words.tier and rooms.tier value is still legal, and
-- every existing "spellingbee:best:<tier>" localStorage key on the client still
-- points at the same tier it always did.
--
-- This migration changes which tier values are ALLOWED and how long each tier's
-- round is. It does not touch the atomic round-transition logic in 0006.

-- ---------------------------------------------------------------------------
-- 1. Widen the CHECK constraints.
--
-- Postgres names an inline column CHECK "<table>_<column>_check", so both are
-- dropped by that generated name. `if exists` keeps this re-runnable.
-- ---------------------------------------------------------------------------
alter table public.words  drop constraint if exists words_tier_check;
alter table public.rooms  drop constraint if exists rooms_tier_check;

alter table public.words
  add constraint words_tier_check check (tier in (
    'novice', 'easy', 'building', 'medium', 'advanced', 'hard', 'expert', 'master'
  ));

alter table public.rooms
  add constraint rooms_tier_check check (tier in (
    'novice', 'easy', 'building', 'medium', 'advanced', 'hard', 'expert', 'master'
  ));

-- ---------------------------------------------------------------------------
-- 2. Round length for all 8 tiers.
--
-- Still the SINGLE source of truth the client reads by RPC (the Session 9b
-- rule: useMultiplayerGame must never copy ROUND_SECONDS from useGameEngine).
-- Mirrors ROUND_SECONDS in src/hooks/useGameEngine.ts — keep the two in sync.
--
-- The curve descends smoothly to `hard` and then FLATTENS: expert and master
-- both sit at hard's 13s. Deliberate — the top three tiers get their difficulty
-- from word content, not from extra time pressure. Do not tighten them below 13.
--
-- NOTE this raises `expert` from 11s to 13s. easy/medium/hard are unchanged, so
-- no existing tier gets HARDER; expert gets slightly more forgiving.
--
-- The `else 16` fallback is kept: an unrecognised tier can no longer reach here
-- through the CHECK above, but a NULL or a future value should still yield a
-- playable round rather than a null deadline.
-- ---------------------------------------------------------------------------
create or replace function public.round_seconds(p_tier text)
returns int
language sql
immutable
as $$
  select case p_tier
    when 'novice'   then 22
    when 'easy'     then 20
    when 'building' then 18
    when 'medium'   then 16
    when 'advanced' then 14
    when 'hard'     then 13
    when 'expert'   then 13
    when 'master'   then 13
    else 16
  end;
$$;

grant execute on function public.round_seconds(text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. PLACEHOLDER words for the four new tiers.
--
-- NOT curated and NOT final: 8 words each, purely so a room created at one of
-- these tiers is playable instead of failing start-game with no_words_for_tier.
-- Generated from the matching placeholder block in src/data/words.ts, which
-- carries the same warning.
--
-- Session 16's word-sourcing pipeline replaces all of this with ~150 real words
-- per tier and will regenerate the seed wholesale. Because 0003 is already
-- applied against the live project it is left untouched rather than hand-edited;
-- that means the full bank now spans 0003 + this file until 16 consolidates it.
--
-- A game on these tiers ends after 8 rounds rather than rounds_per_game()=10.
-- That is already handled, not a bug: advance_round_tx finishes the game when
-- pick_unused_word returns null (0006).
--
-- Idempotent, same on-conflict shape as 0003.
-- ---------------------------------------------------------------------------
insert into public.words (id, word, tier, definition, part_of_speech) values
  ('n1', 'cat', 'novice', 'A small furry pet that purrs', null),
  ('n2', 'sun', 'novice', 'The bright star that lights the day', null),
  ('n3', 'book', 'novice', 'Pages bound together for reading', null),
  ('n4', 'milk', 'novice', 'A white drink that comes from cows', null),
  ('n5', 'tree', 'novice', 'A tall plant with a trunk and branches', null),
  ('n6', 'hand', 'novice', 'The part of your body at the end of your arm', null),
  ('n7', 'door', 'novice', 'What you open to go into a room', null),
  ('n8', 'fish', 'novice', 'An animal that lives and swims in water', null),
  ('b1', 'puzzle', 'building', 'A game or problem that tests your cleverness', null),
  ('b2', 'market', 'building', 'A place where goods are bought and sold', null),
  ('b3', 'silent', 'building', 'Making no sound at all', null),
  ('b4', 'journey', 'building', 'A trip from one place to another', null),
  ('b5', 'picture', 'building', 'A drawing, painting or photograph', null),
  ('b6', 'kitchen', 'building', 'The room where food is prepared', null),
  ('b7', 'monster', 'building', 'A large frightening imaginary creature', null),
  ('b8', 'whisper', 'building', 'To speak very quietly', null),
  ('a1', 'corridor', 'advanced', 'A long passage inside a building', null),
  ('a2', 'reliable', 'advanced', 'Able to be trusted to do what is expected', null),
  ('a3', 'ceremony', 'advanced', 'A formal event held to mark an occasion', null),
  ('a4', 'gradual', 'advanced', 'Happening slowly over a period of time', null),
  ('a5', 'opponent', 'advanced', 'Someone you compete against', null),
  ('a6', 'sincere', 'advanced', 'Genuine and free from pretence', null),
  ('a7', 'turbulent', 'advanced', 'Marked by violent or unsteady movement', null),
  ('a8', 'vacancy', 'advanced', 'A position or space that is unoccupied', null),
  ('z1', 'chiaroscuro', 'master', 'The treatment of light and shade in a work of art', null),
  ('z2', 'eleemosynary', 'master', 'Relating to or dependent on charity', null),
  ('z3', 'logorrhoea', 'master', 'Excessive and often incoherent talkativeness', null),
  ('z4', 'prestidigitation', 'master', 'Skilful sleight of hand performed as entertainment', null),
  ('z5', 'sesquipedalian', 'master', 'Given to using very long words', null),
  ('z6', 'usufruct', 'master', 'The legal right to use another''s property short of destroying it', null),
  ('z7', 'vicissitude', 'master', 'A change of circumstance, typically an unwelcome one', null),
  ('z8', 'zugzwang', 'master', 'A chess position where any move a player makes worsens it', null)
on conflict (id) do update set
  word = excluded.word,
  tier = excluded.tier,
  definition = excluded.definition,
  part_of_speech = excluded.part_of_speech;
