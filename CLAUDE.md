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
- `RoundScreen` is the ONLY place that announces a word, via
  `announceWord()`, for both the initial reveal and the replay button. The
  engine hooks deliberately do not speak: both modes render `RoundScreen`, so
  one call site gives singleplayer and multiplayer identical narration and
  keeps the spoken lead-in identical to the displayed one. Re-adding a
  `speakWord()` call to `useGameEngine` or `useMultiplayerGame` would speak
  every word twice.
- No component may assume there is exactly one player in a way that's hard
  to reverse later (e.g. hardcoded "your score" logic that can't extend to
  multiple players' scores once multiplayer exists).
- Every colour comes from a CSS custom property defined in `src/index.css`.
  Never hardcode a hex value in `App.css` or a component — the app ships a
  light and a dark theme, and a literal colour is invisible in one of them.
  Adding a token means adding it to BOTH palettes in the same edit.
- `src/lib/theme.ts` is the only place that reads or writes the theme. The
  stored value is `"light" | "dark" | null`, where null means "follow the OS";
  only an explicit toggle writes, so a player who never touches it keeps
  tracking their system setting.

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
  untimed: boolean;         // Session 13
  hideDefinition: boolean;  // Session 13
}

// Session 13. Optional and additive: omitting it is exactly the old behaviour.
interface GameOptions {
  untimed?: boolean;
  hideDefinition?: boolean;
}

interface GameEngineApi {
  state: GameState;
  startGame: (tier: DifficultyTier, options?: GameOptions) => void;
  submitGuess: (guess: string) => void;
  skipWord: () => void;
  resetToMenu: () => void;
}
```

`untimed` and `hideDefinition` describe how the CURRENT game is being played,
not a stored preference — they're picked per run on the difficulty screen and
live in `GameState` so screens render from state alone, like every other field.
They are singleplayer-only: `useMultiplayerGame` accepts `options` and drops it
(a room's clock is enforced by `advance_round_tx` and the word is shared, so one
client cannot opt out of either) and always reports both as `false`.

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

The UI was **redesigned around the bee/honeycomb concept** (Session 12). This
was a presentation-only change: `src/hooks/`, `src/types.ts`, `src/lib/rooms.ts`
and `src/lib/tts.ts` were not touched, and `checkAnswer`/`GameEngineApi` are
unchanged. Icons come from `lucide-react` (the lighter install of the two
candidates; +5.2 kB raw / +2.0 kB gzip for 8 icons, so it tree-shakes). No emoji
are used as UI any more.

Rules this redesign must keep:
- The tier cards' `clip-path` hexagon IS the tap target — browsers hit-test
  against the clipped shape, not the layout box. So `getBoundingClientRect`
  alone OVERSTATES the target and is not a sufficient check; measure the
  inscribed area with `elementFromPoint` probes. Measured live: 90px inscribed
  square at 380px viewport, 84px at 320px, against a 44px floor.
- `.tier-card` needs both `width: 100%` (form controls resolve `normal` grid
  alignment to `start`, not `stretch`, so a bare button won't fill its column)
  and `min-width: 0` (otherwise the blurb's min-content width floors the grid
  and it silently eats the shell's padding on narrow phones). Both were real
  bugs caught by measuring.
- A `clip-path` also clips borders, outlines and box-shadows, so the hex rim is
  an inset `::before` and `:focus-visible` thickens that rim. Don't "fix" focus
  by adding an outline — it will not be visible.
- All motion is decoration on top of a state that is already visible without it
  (a coloured border, a number changing). That is what makes the single global
  `prefers-reduced-motion: reduce` block in `index.css` safe: it can switch
  everything off without hiding information. Keep new animations inside that
  guarantee rather than adding per-rule opt-outs.
- The streak pulse re-triggers by REMOUNTING the span via a changing `key`.
  A CSS animation does not replay on a re-render, only on a remount. It fires
  on an increase only — a streak reset deliberately doesn't animate.

A **global settings panel** and a **redesigned difficulty screen** landed in
Session 13. `SettingsPanel` is the single home for cross-cutting preferences —
display name, voice/rate/volume, theme, an in-app reduce-motion override, and a
reset-best-scores action behind a two-step in-panel confirm. It absorbed Session
11's `VoiceSettings` and Session 12's floating `ThemeToggle`; **both components
were deleted**, so don't go looking for them.

Rules this session must keep:
- Settings holds only genuinely global preferences. Per-run modifiers
  (practice mode, hide definition) belong on the difficulty screen and travel
  through `startGame`'s `GameOptions`, never through localStorage.
- The in-app reduce-motion override can only ADD suppression on top of the OS
  `prefers-reduced-motion`. There is deliberately no way to use it to force
  animation back on for someone whose system asked for less.
- Practice mode holds `timeLeft` at 0 rather than freezing it at the round
  length. Scoring is `10 + timeLeft` per word, so a frozen full clock would
  hand out a perfect time bonus on every word. At 0 the scoring code needs no
  special case.
- For the same reason, practice runs do NOT record best scores — an untimed
  score isn't on the same scale as a timed one. `hideDefinition` runs DO count;
  that mode is harder, not easier.
- The tier bars are `clip-path` shapes, so the same Session 12 rule applies:
  `getBoundingClientRect` overstates the tap target and `elementFromPoint`
  probing is the only honest measurement.

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
