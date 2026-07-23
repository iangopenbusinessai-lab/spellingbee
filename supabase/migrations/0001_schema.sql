-- 0001_schema.sql
-- Multiplayer schema for Spelling Bee (Session 7).
-- Tables only; RLS + policies live in 0002_rls.sql, word seed in 0003_seed_words.sql.
--
-- Identity model: every player (guest or signed-in) is a real Supabase Auth
-- user created via anonymous sign-in, so every foreign key references
-- auth.users(id) / auth.uid() from day one. A guest can later upgrade to an
-- email account without any FK here changing.

-- gen_random_uuid() lives in pgcrypto; present by default on Supabase but
-- required explicitly so the migration is self-contained.
create extension if not exists pgcrypto;

-- Shared tier domain, kept identical to DifficultyTier in src/types.ts.
-- Declared once as a CHECK on each table (no enum type, so the singleplayer
-- word bank and multiplayer rooms can never drift apart on allowed values).

-- ---------------------------------------------------------------------------
-- words: the shared word bank, seeded from src/data/words.ts in 0003.
-- Mirrors WordEntry (id, word, tier, definition, partOfSpeech?). id is text to
-- preserve the existing "e1"/"m1"/... ids so singleplayer and multiplayer refer
-- to words the same way.
-- ---------------------------------------------------------------------------
create table public.words (
  id             text primary key,
  word           text not null,
  tier           text not null check (tier in ('easy', 'medium', 'hard', 'expert')),
  definition     text not null,
  part_of_speech text
);

comment on table public.words is
  'Shared word bank for singleplayer and multiplayer. Seeded from src/data/words.ts. Read-only to clients.';

-- ---------------------------------------------------------------------------
-- rooms: one row per game room, joined by a short human-readable code.
-- status/current_round become edge-function-only writes in Session 9; the RLS
-- migration blocks all client UPDATE/DELETE on this table now.
-- ---------------------------------------------------------------------------
create table public.rooms (
  id            uuid primary key default gen_random_uuid(),
  -- Short, unambiguous invite code (charset excludes 0/O/1/I/L). Generation
  -- happens client-/edge-side; here it just has to be unique. Length is bounded
  -- loosely so the generator can evolve without a schema change.
  code          text not null unique check (char_length(code) between 4 and 12),
  status        text not null default 'lobby' check (status in ('lobby', 'active', 'finished')),
  tier          text not null check (tier in ('easy', 'medium', 'hard', 'expert')),
  host_id       uuid not null references auth.users (id) on delete cascade,
  current_round int  not null default 0,
  created_at    timestamptz not null default now()
);

comment on table public.rooms is
  'Game rooms joined by short code. Client may create a room it hosts; status/current_round are edge-function-only writes (Session 9).';

-- ---------------------------------------------------------------------------
-- room_players: membership + per-player score/streak. score/streak become
-- edge-function-only writes in Session 9; the RLS migration grants clients
-- UPDATE on display_name only.
-- ---------------------------------------------------------------------------
create table public.room_players (
  room_id      uuid not null references public.rooms (id) on delete cascade,
  player_id    uuid not null references auth.users (id) on delete cascade,
  display_name text not null,
  score        int  not null default 0,
  streak       int  not null default 0,
  connected_at timestamptz not null default now(),
  primary key (room_id, player_id)
);

comment on table public.room_players is
  'Room membership. A player inserts/updates only their own row, and may change only display_name; score/streak are edge-function-only writes (Session 9).';

-- Lookup of "which rooms is this user in" (used by is_room_member and clients).
create index room_players_player_id_idx on public.room_players (player_id);

-- ---------------------------------------------------------------------------
-- round_results: authoritative per-round outcome. All writes are edge-function
-- only (Session 9); clients get read-only access via RLS.
-- ---------------------------------------------------------------------------
create table public.round_results (
  room_id          uuid not null references public.rooms (id) on delete cascade,
  round_num        int  not null,
  word_id          text not null references public.words (id),
  winner_id        uuid references auth.users (id),
  response_time_ms int,
  ended_at         timestamptz,
  primary key (room_id, round_num)
);

comment on table public.round_results is
  'Authoritative per-round outcome. Written by edge functions only (Session 9); clients read-only.';
