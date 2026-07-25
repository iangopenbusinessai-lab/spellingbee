// verify_sweeper_race.mjs — proves the pg_cron sweeper and a client's
// advance-round call cannot double-advance the same room (Session 10).
//
//   node supabase/scripts/verify_sweeper_race.mjs
//
// The sweeper ticks every 5s and calls advance_round_tx; a client calls the
// same function through the advance-round edge function. Both racing on one
// room is the exact scenario this checks, so the test deliberately fires a
// burst of concurrent client calls across each round's deadline, guaranteeing
// overlap with at least one sweeper tick.
//
// The invariant: advance_round_tx opens with `select ... for update` on the
// room and rejects any call whose expected round no longer matches
// rooms.current_round. So for any given round, AT MOST ONE caller may advance
// it — whoever takes the row lock first. Everyone else must come back with
// advanced:false / already_advanced, never an error and never a second
// advance.
//
// Failure would show up as: two callers both reporting advanced:true for the
// same expected round, a gap in the round numbers (a round skipped by a double
// advance), or a primary-key error surfacing from a duplicate insert.

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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const randCode = () =>
  Array.from({ length: 6 }, () => "ABCDEFGHJKMNPQRSTUVWXYZ23456789"[Math.floor(Math.random() * 31)]).join("");

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
  return { id: s.user.id, headers: { apikey: ANON, Authorization: `Bearer ${s.access_token}`, "Content-Type": "application/json" } };
}

const callFn = async (u, name, body) => {
  const res = await fetch(`${URL}/functions/v1/${name}`, { method: "POST", headers: u.headers, body: JSON.stringify(body) });
  const t = await res.text();
  try { return { status: res.status, body: JSON.parse(t) }; } catch { return { status: res.status, body: t }; }
};
const rest = async (u, path, init = {}) => {
  const res = await fetch(`${URL}/rest/v1/${path}`, { ...init, headers: { ...u.headers, ...(init.headers ?? {}) } });
  const t = await res.text();
  try { return { status: res.status, body: JSON.parse(t) }; } catch { return { status: res.status, body: t }; }
};

async function main() {
  line("=== setup: 2 players, room, start ===");
  const a = await signUpAnon();
  const b = await signUpAnon();
  const roomId = crypto.randomUUID();
  const code = randCode();
  await rest(a, "rooms", { method: "POST", body: JSON.stringify({ id: roomId, code, tier: "medium", host_id: a.id }) });
  await rest(a, "room_players", { method: "POST", body: JSON.stringify({ room_id: roomId, player_id: a.id, display_name: "A" }) });
  await rest(b, "room_players", { method: "POST", body: JSON.stringify({ room_id: roomId, player_id: b.id, display_name: "B" }) });
  const started = await callFn(a, "start-game", { room_id: roomId });
  expect("game started", started.status === 200 && started.body?.ok === true, JSON.stringify(started.body));
  line(`room=${roomId} code=${code}`);

  // Hammer advance-round from both players for a while. The sweeper is
  // independently hitting the same room every 5s throughout.
  line("\n=== hammering advance-round from 2 clients while the 5s sweeper runs ===");
  const advancedBy = new Map();   // expected round -> [callers that got advanced:true]
  const errors = [];
  const deadline = Date.now() + 75000;   // ~4 rounds at 20s each

  while (Date.now() < deadline) {
    const rm = (await rest(a, `rooms?id=eq.${roomId}&select=current_round,status`)).body?.[0];
    if (!rm || rm.status !== "active") break;
    const round = rm.current_round;

    // 6 concurrent calls (3 per player) on the same expected round.
    const burst = await Promise.all([
      callFn(a, "advance-round", { room_id: roomId, round_num: round }),
      callFn(b, "advance-round", { room_id: roomId, round_num: round }),
      callFn(a, "advance-round", { room_id: roomId, round_num: round }),
      callFn(b, "advance-round", { room_id: roomId, round_num: round }),
      callFn(a, "advance-round", { room_id: roomId, round_num: round }),
      callFn(b, "advance-round", { room_id: roomId, round_num: round }),
    ]);

    for (const r of burst) {
      const ok = r.status === 200;
      const expectedErr = r.body?.error === "round_in_progress" || r.body?.error === "room_not_active";
      if (!ok && !expectedErr) errors.push({ status: r.status, body: r.body });
      if (r.body?.advanced === true) {
        advancedBy.set(round, (advancedBy.get(round) ?? 0) + 1);
      }
    }
    await sleep(400);
  }

  line(`client bursts done. rounds a client advanced: ${JSON.stringify([...advancedBy.entries()])}`);
  line(`unexpected errors: ${errors.length ? JSON.stringify(errors.slice(0, 5)) : "none"}`);

  expect("no unexpected errors from concurrent advance calls", errors.length === 0,
    JSON.stringify(errors.slice(0, 3)));

  const multi = [...advancedBy.entries()].filter(([, n]) => n > 1);
  expect("no round was advanced by more than one concurrent client call",
    multi.length === 0, JSON.stringify(multi));

  // Structural check: rounds must be contiguous. A double advance would skip a
  // number or collide on the (room_id, round_num) primary key.
  line("\n=== structural check: round numbering ===");
  const rr = (await rest(a, `round_results?room_id=eq.${roomId}&select=round_num,ended_at&order=round_num.asc`)).body;
  const nums = rr.map((r) => r.round_num);
  const contiguous = nums.every((n, i) => n === i + 1);
  line(`rounds recorded: ${JSON.stringify(nums)}`);
  expect("round numbers are contiguous 1..N (no round skipped by a double advance)",
    contiguous, JSON.stringify(nums));

  const ends = rr.filter((r) => r.ended_at).map((r) => new Date(r.ended_at).getTime());
  const monotonic = ends.every((t, i) => i === 0 || t >= ends[i - 1]);
  expect("round end times are monotonically increasing", monotonic);

  const rmFinal = (await rest(a, `rooms?id=eq.${roomId}&select=current_round,status`)).body?.[0];
  line(`final room state: ${JSON.stringify(rmFinal)}`);

  line(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
