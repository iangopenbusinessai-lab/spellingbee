// verify_tiers.mjs — proves migration 0010 (Session 15) landed correctly on the
// LIVE project. Zero dependencies (Node 18+ fetch), anon key only.
//
//   node supabase/scripts/verify_tiers.mjs
//
// Covers:
//   1. round_seconds() returns the documented value for all 8 tiers
//   2. the words.tier CHECK accepts all 8 (via the seeded placeholder rows)
//   3. the rooms.tier CHECK accepts a brand-new tier value
//   4. the OLD four tier values still work unchanged (no data migration needed)

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
const URL_ = env.VITE_SUPABASE_URL;
const ANON = env.VITE_SUPABASE_ANON_KEY;

const TIER_ORDER = [
  "novice", "easy", "building", "medium", "advanced", "hard", "expert", "master",
];
// Must match ROUND_SECONDS in src/hooks/useGameEngine.ts and the case in 0010.
const EXPECTED_SECONDS = {
  novice: 22, easy: 20, building: 18, medium: 16,
  advanced: 14, hard: 13, expert: 13, master: 13,
};

let failures = 0;
const line = (s = "") => console.log(s);
function expect(label, cond, detail = "") {
  if (cond) line(`   PASS  ${label}`);
  else { failures++; line(`   FAIL  ${label}  ${detail}`); }
}

const signup = await fetch(`${URL_}/auth/v1/signup`, {
  method: "POST",
  headers: { apikey: ANON, "Content-Type": "application/json" },
  body: JSON.stringify({ data: {} }),
}).then((r) => r.json());
if (!signup.access_token) { console.error("anon sign-in failed"); process.exit(1); }

const headers = {
  apikey: ANON,
  Authorization: `Bearer ${signup.access_token}`,
  "Content-Type": "application/json",
};
const rest = async (path, init = {}) => {
  const res = await fetch(`${URL_}/rest/v1/${path}`, { ...init, headers: { ...headers, ...(init.headers ?? {}) } });
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body };
};

// ---- 1. round_seconds() for every tier -------------------------------------
line("=== 1. round_seconds() for all 8 tiers ===");
for (const tier of TIER_ORDER) {
  const r = await rest("rpc/round_seconds", {
    method: "POST",
    body: JSON.stringify({ p_tier: tier }),
  });
  const want = EXPECTED_SECONDS[tier];
  line(`   ${tier.padEnd(9)} -> ${JSON.stringify(r.body)}s (expected ${want})`);
  expect(`round_seconds('${tier}') = ${want}`, r.body === want, `got ${JSON.stringify(r.body)}`);
}

// ---- 2. words present for every tier ---------------------------------------
line("\n=== 2. words.tier accepts all 8 (row counts) ===");
for (const tier of TIER_ORDER) {
  const r = await fetch(`${URL_}/rest/v1/words?tier=eq.${tier}&select=id`, {
    headers: { ...headers, Prefer: "count=exact", Range: "0-0" },
  });
  const count = Number((r.headers.get("content-range") ?? "/0").split("/")[1]);
  line(`   ${tier.padEnd(9)} -> ${count} words`);
  expect(`${tier} has at least 1 word`, count > 0, `count=${count}`);
}

// ---- 3 & 4. rooms.tier accepts new AND old values ---------------------------
line("\n=== 3/4. rooms.tier CHECK accepts new and pre-existing tiers ===");
const randCode = () =>
  Array.from({ length: 6 }, () => "ABCDEFGHJKMNPQRSTUVWXYZ23456789"[Math.floor(Math.random() * 31)]).join("");

for (const tier of ["master", "novice", "expert", "easy"]) {
  const id = crypto.randomUUID();
  const r = await rest("rooms", {
    method: "POST",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ id, code: randCode(), tier, host_id: signup.user.id }),
  });
  line(`   create room tier=${tier.padEnd(8)} HTTP ${r.status}`);
  expect(`room accepted at tier '${tier}'`, r.status === 201, JSON.stringify(r.body));
}

// ---- 5. an invalid tier is still rejected ----------------------------------
line("\n=== 5. an unknown tier is still rejected ===");
const bad = await rest("rooms", {
  method: "POST",
  headers: { Prefer: "return=minimal" },
  body: JSON.stringify({ id: crypto.randomUUID(), code: randCode(), tier: "godlike", host_id: signup.user.id }),
});
line(`   create room tier=godlike HTTP ${bad.status}`);
expect("unknown tier rejected by CHECK", bad.status >= 400, `got ${bad.status}`);

line(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
