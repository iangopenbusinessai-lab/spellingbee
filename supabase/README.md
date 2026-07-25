# Supabase backend — Spelling Bee

This directory holds the multiplayer backend definition: SQL migrations and the
word-seed generator. It contains **no secrets** — connection keys live in a
gitignored `.env.local` (see [Environment variables](#environment-variables)).

Singleplayer (sessions 2–6) needs none of this and keeps working without a
Supabase project. This is the foundation for multiplayer (rooms, realtime,
edge-function answer validation) built in later sessions.

## What's here

```
supabase/
  migrations/
    0001_schema.sql        tables: words, rooms, room_players, round_results
    0002_rls.sql           RLS policies, column grants, security-definer helpers
    0003_seed_words.sql    the 120-word bank (generated, do not hand-edit)
    0004_realtime.sql      adds room_players to the realtime publication
    0005_self_leave.sql    a player may delete only their own lobby row
    0006_round_engine.sql  round state + the atomic game-transition functions
    0007_realtime_rounds.sql  publishes rooms + round_results to Realtime
    0008_server_now.sql    server clock for the client countdown
    0009_round_sweeper.sql pg_cron job advancing rounds with no client attached
  functions/
    _shared/mod.ts         auth + RPC plumbing (zero dependencies)
    start-game/            host-only lobby -> active
    submit-answer/         server-side correctness, timing and scoring
    advance-round/         the single "round over -> next word" path
  scripts/
    gen_seed.mjs           regenerates 0003 from src/data/words.ts
    verify.mjs             schema/RLS checks (Session 7b)
    verify_functions.mjs   edge-function authorization + anti-cheat checks
    verify_race.mjs        8-way winner race + server-clock timeout
    verify_sweeper_race.mjs      sweeper vs client advance: no double-advance
    verify_sweeper_realtime.mjs  clients see sweeper-driven advancement
  README.md
```

### Unattended rounds (Session 10)

Round advancement used to depend on a client's polling loop, so a game froze
when every tab was backgrounded or closed. `0009` schedules
`sweep_expired_rounds()` through pg_cron every 5 seconds; it asks
`advance_round_tx` about every active room and lets that function decide, so
the deadline rule still lives in exactly one place.

Inspect or change the job with:

```sql
select jobname, schedule, active from cron.job;
select d.status, d.start_time from cron.job_run_details d
  join cron.job j on j.jobid = d.jobid
 where j.jobname = 'sweep-expired-rounds'
 order by d.start_time desc limit 10;
```

The client loop is still the fast path (~150ms transitions when someone is
watching); the sweeper is the backstop (≤5s when nobody is). Both call the same
atomic function, so they cannot double-advance a round.

### Server authority (Session 9a)

Rounds are server-authoritative. What that guarantees is deliberately narrow:

1. **A word is revealed only once its round has started.** The word for round N
   is written to `round_results` in the same transaction that bumps
   `rooms.current_round`, so a future round's word does not exist in any
   client-readable row yet. Once a round *has* started the client necessarily
   receives the text — it has to pronounce it via the Web Speech API. That
   exposure is an accepted property of the design, the same as a pre-recorded
   audio file would have, and is not something these functions try to hide.
2. **Correctness, timing and the round winner come from the server.**
   `submit-answer` accepts no "correct" flag and no client-reported duration;
   it looks the word up itself and measures from `rooms.round_started_at` to
   the server's receipt of the call. Editing the client JS cannot award points
   or fake a fast time.

The game logic lives in plpgsql (`0006`) rather than in the edge functions
because every transition is multi-statement *and* contended — two correct
answers can land in the same millisecond. A plpgsql function is one
transaction, so the conditional winner claim and the writes that follow it are
atomic together. The edge functions do authentication and HTTP; the SQL
functions do the state transition.

Those SQL functions take the acting player as a parameter, so they are granted
to `service_role` **only** — a client token calling them directly gets
`42501 permission denied`, which `verify_functions.mjs` asserts.

Deploy them with:

```bash
npx supabase functions deploy start-game submit-answer advance-round --use-api
```

`--use-api` bundles server-side, so no local Docker is needed. The
`service_role` key is injected by the platform as `SUPABASE_SERVICE_ROLE_KEY`
and is never committed or shipped to a browser.

### Identity model

Every player — guest or signed-in — is a real Supabase Auth user created via
**anonymous sign-in**. There is no separate guest-id system. Every foreign key
references `auth.users(id)` / `auth.uid()`, so a guest can later upgrade to an
email account without any foreign key changing.

### Room model

Rooms are joined by a short, human-readable **invite code**. A not-yet-member
finds a room via the `get_room_by_code()` security-definer function (there is no
open `SELECT` on `rooms`). Quick-match/random matchmaking is a later feature and
nothing here blocks it — it would just be "find or create a room with an open
slot."

## Environment variables

The app reads these at build/run time. Put them in **`.env.local`** at the repo
root — it is gitignored (`*.local`) and must never be committed. Only the names
are documented here; get the values from the Supabase dashboard under
**Project Settings → API**.

| Variable                 | Where to find it                     | Committed? |
| ------------------------ | ------------------------------------ | ---------- |
| `VITE_SUPABASE_URL`      | Project Settings → API → Project URL | **Never**  |
| `VITE_SUPABASE_ANON_KEY` | Project Settings → API → `anon` public key | **Never** |

The `anon` key is safe to ship in a client bundle *only because* RLS (in
`0002_rls.sql`) gates every table. Never put the `service_role` key in the
frontend or in any committed file — it bypasses RLS and belongs only in
edge-function secrets (Session 9).

Example `.env.local` (values redacted):

```
VITE_SUPABASE_URL=https://<project-ref>.supabase.co
VITE_SUPABASE_ANON_KEY=<anon-public-key>
```

## One-time project setup

1. Create a project at <https://supabase.com/dashboard> (or reuse an existing
   one — confirm which before running migrations against it).
2. **Enable anonymous sign-ins:** Dashboard → **Authentication → Sign In / Providers**
   → toggle **Allow anonymous sign-ins** on. This is required by the identity
   model above; without it every sign-in fails.
3. Copy the Project URL and `anon` key into `.env.local` as above.

## Running the migrations

Migrations are plain SQL and are applied **in filename order**:
`0001` → `0002` → `0003`. Pick either path.

### Option A — Supabase CLI (recommended, reproducible)

```bash
# from the repo root; installs nothing globally
npx supabase login                       # opens browser for an access token
npx supabase link --project-ref <ref>    # <ref> = the subdomain of your project URL
npx supabase db push                      # applies everything in migrations/ in order
```

### Option B — SQL editor (no CLI)

Open **Dashboard → SQL Editor** and run the three files **in order**, pasting the
full contents of each and executing before moving to the next:

1. `migrations/0001_schema.sql`
2. `migrations/0002_rls.sql`
3. `migrations/0003_seed_words.sql`

## Regenerating the word seed

`0003_seed_words.sql` is generated from `src/data/words.ts` so the two never
drift. If the word bank changes, regenerate (never hand-edit `0003`):

```bash
node supabase/scripts/gen_seed.mjs src/data/words.ts supabase/migrations/0003_seed_words.sql
```

The script aborts unless it parses exactly 120 words, and the insert is
idempotent (`on conflict (id) do update`), so it is safe to re-run.

## Verifying a fresh apply

Run these in the SQL editor (or `psql`) after migrating:

```sql
-- 120 words, 30 per tier
select tier, count(*) from public.words group by tier order by tier;

-- RLS is on for every table
select relname, relrowsecurity
from pg_class
where relnamespace = 'public'::regnamespace
  and relname in ('words','rooms','room_players','round_results');
```

Client-side checks (must be run as an anonymous-signed-in user, e.g. from the
app or a small script using the `anon` key — never the `service_role` key):

- **Anonymous sign-in works:** `supabase.auth.signInAnonymously()` returns a
  session with a `user.id`.
- **Client cannot change `rooms.status`:** an `update({ status: 'active' })` on
  `rooms` is rejected (no update policy/grant).
- **Client cannot change `room_players.score`:** an `update({ score: 999 })` is
  rejected with a column-permission error (only `display_name` is grantable).
