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
- `DEFAULT_VOICE_NAME` ("Google UK English Male") is a chosen-by-ear hard
  default, checked in `pickAutoVoice` BEFORE the quality heuristic. Don't
  "simplify" it into a big score bonus: a bonus would still lose to some
  future Neural/Premium voice on another platform, and the point is that this
  exact voice wins wherever it exists. Priority is saved override > this >
  heuristic. The heuristic itself is untouched and still covers every browser
  that doesn't ship this voice. Its companion `DEFAULT_VOICE_RATE` (0.90)
  applies only when this voice is the one actually in effect, which is why
  `getRate()` has to consult `resolveVoice()` rather than return a constant.
- `RoundScreen` is the ONLY place that speaks a word. The engine hooks
  deliberately do not speak: both modes render `RoundScreen`, so one call site
  gives singleplayer and multiplayer identical narration and keeps the spoken
  lead-in identical to the displayed one. Adding a speak call to
  `useGameEngine` or `useMultiplayerGame` would speak every word twice.
  It uses two entry points, and the split is deliberate (Session 17):
  - initial reveal -> `announceWord()`, which speaks a lead-in phrase, pauses,
    then the word, and returns the phrase so the screen can show it;
  - "Hear it again" -> `repeatWord()`, which speaks ONLY the word. On a replay
    the lead-in is pure latency in front of the thing the player asked for.
    `repeatWord` replaced the old unused `speakWord`; don't reintroduce it.
  The on-screen `.lead-in` line is NOT cleared or re-rolled by a replay — it
  still describes the announcement that introduced this word.
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
// Eight tiers since Session 15, ordered easiest to hardest. TIER_ORDER in
// types.ts is the single source of the ordering — never hardcode a tier list
// beside it, and use TIER_META/TIERS in src/lib/tiers.ts for labels.
type DifficultyTier =
  | "novice" | "easy" | "building" | "medium"
  | "advanced" | "hard" | "expert" | "master";

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

**Eight difficulty tiers** since Session 15 (migration `0010_eight_tiers.sql`,
applied and verified live by `supabase/scripts/verify_tiers.mjs`).

Order, easiest to hardest, with round length:

| tier     | seconds | notes                                  |
|----------|---------|----------------------------------------|
| novice   | 22      | new                                    |
| easy     | 20      | unchanged anchor                       |
| building | 18      | new                                    |
| medium   | 16      | unchanged anchor                       |
| advanced | 14      | new                                    |
| hard     | 13      | unchanged anchor                       |
| expert   | 13      | **raised from 11s**                    |
| master   | 13      | new                                    |

Rules this scheme must keep:
- The original four keep their EXACT string values (`easy`/`medium`/`hard`/
  `expert`) even though their relative position shifted. That is the only
  reason no data migration was needed: existing `spellingbee:best:<tier>`
  localStorage keys and existing `words.tier`/`rooms.tier` rows stayed valid.
  Never rename them.
- The curve descends smoothly to `hard` and then FLATTENS — expert and master
  sit at hard's 13s. Deliberate: the top three tiers get their difficulty from
  word content, not extra time pressure. Do not tighten them below 13.
- `ROUND_SECONDS` in `useGameEngine.ts` and `public.round_seconds()` in 0010
  must stay in sync, and the multiplayer path must keep reading the SQL
  function by RPC rather than importing the client constant (the Session 9b
  rule). Verified live: an expert room rendered a 13s countdown from the server.
- `TIER_ORDER` (types.ts) is the one place the ordering lives; `TIER_META` /
  `TIERS` (src/lib/tiers.ts) is the one place labels live. Before Session 15
  the difficulty screen, the lobby picker and the waiting room each kept their
  own list — don't reintroduce that.
- Eight bars stay ONE page-scrolling stack. Bars went 64px -> 54px and the gap
  8px -> 6px so all eight fit ~474px, inside a phone viewport. An inner scroll
  container was rejected: it would hide the hardest tiers behind a scrollbar
  inside a page that already scrolls.

The **word bank is ~1200 words, 150 per tier** (Session 16). The Session 15
placeholders are gone. Sourcing, licensing and the definition rule live in
`supabase/WORDLIST_SOURCES.md` — read that before touching word content.

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

A **draining timer bar** sits under the guess input (Session 17). It is shared
by both modes for free, because both render `RoundScreen`.

Rules this bar must keep:
- It is a pure VIEW of `GameState.timeLeft`. No timer, interval, animation
  clock or round-length constant lives in `RoundScreen` — adding one would put
  a second source of truth next to the engine that already owns the countdown.
- Its full scale comes from the largest `timeLeft` seen for the current word
  (`spanRef`), NOT from a constant. That is the whole reason one bar can serve
  both engines: singleplayer's `ROUND_SECONDS` and multiplayer's server-derived
  `round_seconds()` each arrive as the opening value of `timeLeft`. Never
  "improve" this by importing `ROUND_SECONDS` — the Session 9b rule forbids the
  multiplayer path from ever seeing it. In multiplayer the peak can't overshoot
  either, because `useMultiplayerGame` already clamps `timeLeft` to
  `constants.roundSeconds`.
- The smooth drain is a 1s linear CSS `transition` on width, nothing else. Both
  engines tick in whole seconds; the transition is what makes that read as
  motion. It costs a ≤1s visual lag behind the numeral, which is the accepted
  price of not running a second clock.
- The fill is keyed by word id so a new round SNAPS back to full instead of
  animating upward.
- Practice mode renders no bar at all (`untimed` holds `timeLeft` at 0, so a
  track would just sit empty), and the bar is `aria-hidden` because `ScoreBar`
  already exposes the same countdown as text.
- Urgency is two threshold classes (`low` <=45%, `critical` <=20%), not a
  computed gradient, so both themes stay readable and the colours stay tokens.
  Under reduced motion the global `index.css` block collapses the transition
  and the pulse; the bar then steps once a second and loses no information,
  which is exactly the Session 12 guarantee.

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
