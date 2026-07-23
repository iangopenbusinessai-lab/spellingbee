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
  scripts/
    gen_seed.mjs           regenerates 0003 from src/data/words.ts
  README.md
```

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
