# Spelling Race — CLAUDE.md

## Project overview
Word-spelling race game, built singleplayer first, multiplayer planned.
Stack: Vite + React + TypeScript, deployed to GitHub Pages via GitHub Actions.
Repo: https://github.com/iangopenbusinessai-lab/spellingbee (confirm/update if different)
Live: https://iangopenbusinessai-lab.github.io/spellingbee/

## CRITICAL: vite.config.ts
`base` must always be `'/spellingbee/'` — never change this, never remove it,
never revert to `base: '/'`. If the repo name above is wrong, update both
this file and vite.config.ts together, never just one.

## Deploy
Deploys via `.github/workflows/deploy.yml` on every push to `main`
(GitHub Actions → Pages). Do NOT introduce the `gh-pages` npm package or a
`gh-pages` branch — this project deploys via Actions only.

## Architecture rules — never violate
- All game state flows through the `GameState` shape in `src/types.ts`.
  Components only ever receive `GameState` as a prop — never call
  `useGameEngine` (or any future game-state hook) directly from inside a
  presentational component like `RoundScreen` or `ScoreBar`.
- Answer checking lives behind a single function boundary inside the engine
  hook — never inline the string-comparison logic anywhere else. This is the
  seam where multiplayer later swaps local comparison for a server
  round-trip without touching the UI.
- `WordEntry`'s shape is stable: `id, word, tier, definition, partOfSpeech?`.
  Don't bolt ad-hoc fields onto individual words — extend the interface if a
  field is genuinely needed everywhere, and update this file when you do.
- All speech synthesis goes through `src/lib/tts.ts` — never call
  `window.speechSynthesis` directly from a component.
- No component may assume there is exactly one player in a way that's hard
  to reverse later (e.g. hardcoded "your score" logic that can't extend to
  multiple players' scores once multiplayer exists).

## Core types (do not change without updating this file)
```ts
type DifficultyTier = "easy" | "medium" | "hard" | "expert";

interface WordEntry {
  id: string;
  word: string;
  tier: DifficultyTier;
  definition: string;
  partOfSpeech?: string;
}

type RoundStatus = "idle" | "playing" | "correct" | "incorrect" | "finished";

interface GameState {
  tier: DifficultyTier | null;
  status: RoundStatus;
  currentWord: WordEntry | null;
  score: number;
  streak: number;
  bestStreak: number;
  timeLeft: number;
  wordsRemaining: number;
}
```

## Current state
Singleplayer is complete and deployed: difficulty select → timed word round
with spoken pronunciation → scoring/streak tracking → results screen.

The multiplayer backend schema is live and verified (Sessions 7 / 7b). A real
Supabase project holds the `words`, `rooms`, `room_players`, and
`round_results` tables with RLS enforced; the migrations live in `supabase/`
and were applied via `supabase db push`. Verified against the live project:
anonymous sign-in works, `words` is seeded with all 120 words (30 per tier),
and the write-protection policies hold — clients cannot directly change
`rooms.status` or `room_players.score`, and `get_room_by_code()` leaks no
`host_id`.

The multiplayer **lobby** is wired up (Session 8) and runs alongside
singleplayer, which is untouched. `src/lib/supabaseClient.ts` exports the one
client (env vars only, never hardcoded); `useSupabaseUser` signs the visitor in
anonymously once per load using supabase-js's default session persistence.
`src/lib/rooms.ts` is the only place that talks to the room tables — create,
join-by-code via `get_room_by_code()`, self-leave, and a Realtime subscription
to `room_players`. Lobby cap is `PLAYER_CAP = 8`, enforced best-effort on the
client (join-then-back-out); race-free enforcement is the edge function's job.
Migrations `0004_realtime.sql` (adds `room_players` to the realtime publication)
and `0005_self_leave.sql` (a player may DELETE only their own row, only while
`status='lobby'`) were applied via `supabase db push`.

The **server-authoritative round engine** is live (Session 9a). Migration
`0006_round_engine.sql` adds `rooms.round_started_at`, the `round_attempts`
audit table, and three plpgsql transition functions; three edge functions
(`start-game`, `submit-answer`, `advance-round`) are deployed. Verified against
the live project by `supabase/scripts/verify_functions.mjs` and
`verify_race.mjs`.

Rules this engine must keep:
- Game logic lives in the plpgsql functions in `0006`, NOT in the edge
  functions, because each transition is multi-statement and contended and a
  plpgsql function is a single transaction. Edge functions do auth + HTTP only.
- `start_game_tx` / `submit_answer_tx` / `advance_round_tx` take the acting
  player as a parameter, so they are granted to `service_role` ONLY. Never
  grant them to `authenticated` — that would let any client impersonate anyone.
- `submit-answer` accepts no client-supplied correctness or timing. Response
  time is measured from `rooms.round_started_at` to server receipt. Don't add a
  client-time parameter "for accuracy".
- The winner is claimed by a conditional `UPDATE ... WHERE winner_id IS NULL`.
  Don't refactor that into a read-then-write.
- `ROUND_SECONDS` in `useGameEngine.ts` and `public.round_seconds()` must stay
  in sync — the client renders the countdown, the server enforces it.

**Multiplayer is playable end to end** (Session 9b). `useMultiplayerGame(roomId)`
satisfies `GameEngineApi` exactly, so `App.tsx` runs it beside `useGameEngine`
and the screens can't tell which engine produced their `GameState`.
`rooms.ts`'s `startGame()` is no longer a stub — it, `submitAnswer` and
`advanceRound` call the edge functions. Migration `0007` publishes `rooms` and
`round_results` to Realtime; `0008` adds `server_now()`.

Rules this hook must keep:
- It computes NO outcomes. Correctness, winner, scores and game-over all
  arrive as database changes over Realtime. Never add a local answer
  comparison — that seam belongs to the server.
- Round timing is server-derived: the deadline is `rooms.round_started_at` plus
  `round_seconds(tier)` fetched by RPC, and "now" comes from `serverClock.ts`,
  which syncs against `server_now()`. Never import or copy `ROUND_SECONDS`
  from `useGameEngine.ts` into the multiplayer path.
- `timeLeft` must derive from the ticking `nowMs` STATE. Deriving it from
  `serverNow()` inside a memo silently freezes the countdown, because React
  can't see the clock move (this bug shipped and was caught in testing).
- `skipWord` is intentionally a no-op: the word is shared and rounds end on a
  winner or the server clock, so there is no per-player skip to perform. The
  Skip button is hidden via `RoundScreen`'s `canSkip={false}` rather than left
  as a dead control.
- Leaving mid-game: the player's `room_players` row stays (0005 permits
  self-delete only in 'lobby'), so their score remains on the scoreboard and
  they simply forfeit the remaining rounds. The game continues without them.

**Rounds now advance with no client attached** (Session 10). Migration `0009`
enables pg_cron (1.6.4 on this project, which supports sub-minute interval
schedules) and runs `sweep_expired_rounds()` every 5 seconds. Verified live:
with both browser tabs CLOSED, a game advanced rounds 2→10 and reached
`finished` entirely on its own, at a steady 20.0s per round.

Rules this sweeper must keep:
- It contains NO game rules. It selects rooms on `status = 'active'` and calls
  `advance_round_tx`, which stays the single authority on whether a round is
  over. Do NOT add a deadline predicate to the sweep's WHERE clause — that
  would create a second copy of the rule that can drift. `advance_round_tx` is
  already a cheap no-op for a room that isn't due.
- It passes the room's earliest-joined member as the acting player purely to
  satisfy `advance_round_tx`'s membership guard; `p_player` is used for nothing
  else and no game rule depends on which member is named.
- It is not an exposed RPC — revoked from anon/authenticated, so a client
  calling it gets 42501. The pg_cron job runs as the function owner.

The client polling loop from 9b is KEPT as the primary fast path, deliberately
against the "make it a 30s fallback" suggestion. Reason: the sweeper's floor is
its 5s tick, so relying on it alone would stretch every round transition's
feedback window from ~1.25s to 1.1-6.1s for games someone is actually watching
— a visible regression in the common case. Keeping both gives ~150ms
transitions when anyone is present and a guaranteed ≤5s backstop when nobody
is. They cannot conflict: `advance_round_tx` takes `for update` on the room and
rejects any call whose expected round no longer matches, so at most one caller
can ever advance a given round (verified with 6 concurrent client calls per
round racing the sweeper — exactly one winner each time, contiguous rounds, no
errors).

## Naming note
Local dev folder/npm package name may still say "spelling-race" from
initial scaffolding — that's cosmetic and doesn't need to match the repo
name. The GitHub repo and deployed URL are "spellingbee". Use
"spellingbee" as the prefix for any localStorage keys going forward
(e.g. "spellingbee:best:easy"), not "spelling-race".

## Commands
- `npm run dev` — local dev server
- `npm run build` — production build (also runs `tsc -b`, must pass clean)
- Push to `main` — auto-deploys via GitHub Actions, no manual deploy step
