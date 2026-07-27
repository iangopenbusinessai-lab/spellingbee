// verify_elimination_client.mjs — Session 20.
//
//   node supabase/scripts/verify_elimination_client.mjs
//
// Checks the couplings between src/ and the live database that a type checker
// cannot see. `npm run build` proves the client compiles; this proves it agrees
// with the server it will be talking to.
//
// Needs only VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY, like the app itself.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function loadEnv() {
  const txt = readFileSync(join(repoRoot, ".env.local"), "utf8");
  const env = {};
  for (const l of txt.split(/\r?\n/)) {
    const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return env;
}

const env = loadEnv();
const URL = env.VITE_SUPABASE_URL;
const ANON = env.VITE_SUPABASE_ANON_KEY;

const line = (s = "") => console.log(s);
let failures = 0;
const expect = (label, cond, detail = "") => {
  if (cond) line(`   PASS  ${label}`);
  else { failures++; line(`   FAIL  ${label}  ${detail}`); }
};

async function signUpAnon() {
  const res = await fetch(`${URL}/auth/v1/signup`, {
    method: "POST",
    headers: { apikey: ANON, "Content-Type": "application/json" },
    body: JSON.stringify({ data: {} }),
  });
  const s = await res.json();
  if (!s.access_token) { line(`sign-in failed: ${JSON.stringify(s)}`); process.exit(1); }
  return { apikey: ANON, Authorization: `Bearer ${s.access_token}`, "Content-Type": "application/json" };
}

/**
 * Read AVATAR_KEYS out of the source rather than importing it — this script is
 * plain Node with no bundler, and src/lib/avatars.ts imports lucide-react. The
 * point is to compare the list a human maintains against the database, and the
 * literal in the file IS that list.
 */
function clientAvatarKeys() {
  const src = readFileSync(join(repoRoot, "src", "lib", "avatars.ts"), "utf8");
  const block = src.match(/export const AVATAR_KEYS[^=]*=\s*\[([\s\S]*?)\]/);
  if (!block) { line("could not find AVATAR_KEYS in src/lib/avatars.ts"); process.exit(1); }
  return [...block[1].matchAll(/"([a-z]+)"/g)].map((m) => m[1]);
}

function clientDefaultAvatar() {
  const src = readFileSync(join(repoRoot, "src", "lib", "avatars.ts"), "utf8");
  return src.match(/DEFAULT_AVATAR:\s*AvatarKey\s*=\s*"([a-z]+)"/)?.[1] ?? null;
}

async function main() {
  if (!URL || !ANON) { line("missing VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY"); process.exit(1); }
  const h = await signUpAnon();

  line("=== 1. the client avatar list matches the database CHECK ===");
  const res = await fetch(`${URL}/rest/v1/rpc/avatar_keys`, { method: "POST", headers: h, body: "{}" });
  const server = await res.json();
  const client = clientAvatarKeys();
  line(`  server avatar_keys(): ${JSON.stringify(server)}`);
  line(`  client AVATAR_KEYS:   ${JSON.stringify(client)}`);
  expect(
    "the two lists are identical, in the same order",
    JSON.stringify(server) === JSON.stringify(client),
    "src/lib/avatars.ts has drifted from public.avatar_keys() — change both together"
  );

  const dflt = clientDefaultAvatar();
  line(`  client DEFAULT_AVATAR: ${dflt}`);
  expect("the client default is a member of the preset set", server.includes(dflt), String(dflt));

  // The column default in 0012 is 'bee'; a client default that disagreed would
  // silently mean "no avatar chosen" renders as one thing and stores another.
  expect("the client default matches the room_players.avatar column default", dflt === "bee", String(dflt));

  line("\n=== 2. get_room_by_code exposes what the join screen renders ===");
  const code = Array.from({ length: 6 }, () =>
    "ABCDEFGHJKMNPQRSTUVWXYZ23456789"[Math.floor(Math.random() * 31)]).join("");
  const me = await fetch(`${URL}/auth/v1/user`, { headers: h }).then((r) => r.json());
  const roomId = crypto.randomUUID();
  const mk = await fetch(`${URL}/rest/v1/rooms`, {
    method: "POST", headers: h,
    body: JSON.stringify({
      id: roomId, code, tier: "novice", host_id: me.id,
      mode: "elimination", lives_setting: 4,
    }),
  });
  expect("created an elimination room with 4 lives", mk.status < 300, String(mk.status));

  const look = await fetch(`${URL}/rest/v1/rpc/get_room_by_code`, {
    method: "POST", headers: h, body: JSON.stringify({ p_code: code }),
  }).then((r) => r.json());
  const room = Array.isArray(look) ? look[0] : look;
  line(`  get_room_by_code('${code}') -> ${JSON.stringify(room)}`);
  expect("mode is readable before joining", room?.mode === "elimination", JSON.stringify(room));
  expect("lives_setting is readable before joining", room?.lives_setting === 4, JSON.stringify(room));

  line("\n=== 3. every preset key is actually accepted by the CHECK ===");
  // The list agreeing is not the same as the list working: a key present in
  // avatar_keys() but rejected on insert would break exactly one avatar option.
  let allOk = true;
  for (const key of client) {
    const u = await signUpAnon();
    const uid = await fetch(`${URL}/auth/v1/user`, { headers: u }).then((r) => r.json());
    const j = await fetch(`${URL}/rest/v1/room_players`, {
      method: "POST", headers: u,
      body: JSON.stringify({ room_id: roomId, player_id: uid.id, display_name: key, avatar: key }),
    });
    if (j.status >= 300) { allOk = false; line(`   ${key} -> HTTP ${j.status} ${await j.text()}`); }
    else line(`   ${key.padEnd(8)} -> HTTP ${j.status}`);
  }
  expect("all preset keys insert cleanly", allOk);

  line(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
