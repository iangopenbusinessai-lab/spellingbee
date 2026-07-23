// verify.mjs — proves the Session 7 schema + RLS behave, using ONLY the anon
// key exactly as an untrusted client would. Zero dependencies (Node 18+ fetch).
//
//   node supabase/scripts/verify.mjs
//
// Reads VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY from .env.local at the
// repo root (gitignored). Requires "Allow anonymous sign-ins" enabled in the
// Supabase dashboard, and the three migrations applied.
//
// It exercises, and prints real output for:
//   1. anonymous sign-in returns a session
//   2. words table has 120 rows, 30 per tier (real query via PostgREST)
//   3. creating a room you host + joining it (positive: insert policies work)
//   4. client CANNOT update rooms.status        (expect permission denied)
//   5. client CANNOT update room_players.score  (expect permission denied)

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function loadEnv() {
  const txt = readFileSync(join(repoRoot, ".env.local"), "utf8");
  const env = {};
  for (const line of txt.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return env;
}

const env = loadEnv();
const URL = env.VITE_SUPABASE_URL;
const ANON = env.VITE_SUPABASE_ANON_KEY;
if (!URL || !ANON) {
  console.error("Missing VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY in .env.local");
  process.exit(1);
}

const line = (s = "") => console.log(s);
const CODE = Array.from({ length: 6 }, () =>
  "ABCDEFGHJKMNPQRSTUVWXYZ23456789"[Math.floor(Math.random() * 31)]
).join("");

async function main() {
  // ---- 1. anonymous sign-in -------------------------------------------------
  line("=== 1. anonymous sign-in ===");
  const signInRes = await fetch(`${URL}/auth/v1/signup`, {
    method: "POST",
    headers: { apikey: ANON, "Content-Type": "application/json" },
    body: JSON.stringify({ data: {} }),
  });
  const session = await signInRes.json();
  const token = session.access_token;
  const userId = session.user?.id;
  line(`HTTP ${signInRes.status}`);
  line(JSON.stringify({
    has_access_token: Boolean(token),
    user_id: userId,
    is_anonymous: session.user?.is_anonymous,
    token_type: session.token_type,
    expires_in: session.expires_in,
  }, null, 2));
  if (!token) { line("No session — is 'Allow anonymous sign-ins' enabled?"); process.exit(1); }

  const authed = {
    apikey: ANON,
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };

  // ---- 2. words: 120 rows, 30 per tier -------------------------------------
  line("\n=== 2. words table row count (real query) ===");
  const wordsRes = await fetch(`${URL}/rest/v1/words?select=tier`, { headers: authed });
  const words = await wordsRes.json();
  const byTier = words.reduce((a, w) => ((a[w.tier] = (a[w.tier] ?? 0) + 1), a), {});
  line(`HTTP ${wordsRes.status}  total=${words.length}`);
  line(JSON.stringify(byTier, null, 2));

  // ---- 3. create a room I host + join it (positive path) -------------------
  line("\n=== 3. create room + join (insert policies) ===");
  const roomRes = await fetch(`${URL}/rest/v1/rooms`, {
    method: "POST",
    headers: { ...authed, Prefer: "return=representation" },
    body: JSON.stringify({ code: CODE, tier: "easy", host_id: userId }),
  });
  const room = await roomRes.json();
  const roomId = Array.isArray(room) ? room[0]?.id : room?.id;
  line(`create room  HTTP ${roomRes.status}  code=${CODE}  room_id=${roomId ?? JSON.stringify(room)}`);
  if (!roomId) { line("Room creation failed; cannot run write-rejection tests."); process.exit(1); }

  const joinRes = await fetch(`${URL}/rest/v1/room_players`, {
    method: "POST",
    headers: { ...authed, Prefer: "return=representation" },
    body: JSON.stringify({ room_id: roomId, player_id: userId, display_name: "verify-bot" }),
  });
  line(`join room    HTTP ${joinRes.status}  ${await joinRes.text()}`);

  // ---- 4. rooms.status update must be REJECTED -----------------------------
  line("\n=== 4. client update rooms.status (must be rejected) ===");
  const badStatus = await fetch(`${URL}/rest/v1/rooms?id=eq.${roomId}`, {
    method: "PATCH",
    headers: { ...authed, Prefer: "return=representation" },
    body: JSON.stringify({ status: "active" }),
  });
  line(`HTTP ${badStatus.status}  ${await badStatus.text()}`);
  line(badStatus.status >= 400 ? "REJECTED (expected)" : "!!! NOT REJECTED — policy bug");

  // ---- 5. room_players.score update must be REJECTED -----------------------
  line("\n=== 5. client update room_players.score (must be rejected) ===");
  const badScore = await fetch(
    `${URL}/rest/v1/room_players?room_id=eq.${roomId}&player_id=eq.${userId}`,
    {
      method: "PATCH",
      headers: { ...authed, Prefer: "return=representation" },
      body: JSON.stringify({ score: 999 }),
    }
  );
  line(`HTTP ${badScore.status}  ${await badScore.text()}`);
  line(badScore.status >= 400 ? "REJECTED (expected)" : "!!! NOT REJECTED — policy bug");

  // ---- sanity: the ALLOWED update (display_name) should succeed -------------
  line("\n=== 6. sanity: display_name update (allowed) ===");
  const okName = await fetch(
    `${URL}/rest/v1/room_players?room_id=eq.${roomId}&player_id=eq.${userId}`,
    {
      method: "PATCH",
      headers: { ...authed, Prefer: "return=representation" },
      body: JSON.stringify({ display_name: "renamed-ok" }),
    }
  );
  line(`HTTP ${okName.status}  ${await okName.text()}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
