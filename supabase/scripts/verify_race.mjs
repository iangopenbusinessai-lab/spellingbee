// verify_race.mjs — hammers the two Session 9a paths that a single happy-path
// run cannot prove: the atomic winner claim under real contention, and the
// timed-out (no winner) round.
//
//   node supabase/scripts/verify_race.mjs
//
// Why this exists separately from verify_functions.mjs: that script races two
// submissions once. Once is luck, not evidence. Here EIGHT players fire the
// correct answer simultaneously, every round, for the whole game — and the
// invariant checked each time is "exactly one winner", never zero and never two.
//
// Also covers the timeout branch of advance_round_tx (expert tier, 11s limit):
// a round nobody answers must stay un-advanceable until the server clock says
// the limit has passed, then close with winner_id = null.

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

async function callFn(user, name, body) {
  const res = await fetch(`${URL}/functions/v1/${name}`, { method: "POST", headers: user.headers, body: JSON.stringify(body) });
  const t = await res.text();
  try { return { status: res.status, body: JSON.parse(t) }; } catch { return { status: res.status, body: t }; }
}

async function rest(user, path, init = {}) {
  const res = await fetch(`${URL}/rest/v1/${path}`, { ...init, headers: { ...user.headers, ...(init.headers ?? {}) } });
  const t = await res.text();
  try { return { status: res.status, body: JSON.parse(t) }; } catch { return { status: res.status, body: t }; }
}

async function buildRoom(tier, playerCount) {
  const players = [];
  for (let i = 0; i < playerCount; i++) players.push(await signUpAnon());
  const host = players[0];
  const roomId = crypto.randomUUID();
  const code = randCode();
  const r = await rest(host, "rooms", {
    method: "POST",
    body: JSON.stringify({ id: roomId, code, tier, host_id: host.id }),
  });
  if (r.status >= 400) { line(`room create failed ${JSON.stringify(r.body)}`); process.exit(1); }
  for (let i = 0; i < players.length; i++) {
    await rest(players[i], "room_players", {
      method: "POST",
      body: JSON.stringify({ room_id: roomId, player_id: players[i].id, display_name: `p${i}` }),
    });
  }
  return { roomId, code, players, host };
}

async function main() {
  // =====================================================================
  // A. Eight-way contention, every round.
  // =====================================================================
  line("=== A. 8 players submit the CORRECT answer simultaneously, every round ===");
  const { roomId, players, host } = await buildRoom("easy", 8);
  line(`room=${roomId}  players=${players.length}`);

  const started = await callFn(host, "start-game", { room_id: roomId });
  expect("game started", started.status === 200 && started.body?.ok === true,
    JSON.stringify(started.body));

  let round = started.body.round_num;
  let word = started.body.word;
  let trials = 0;
  const winnerTally = {};

  while (word && round <= 10) {
    // All eight fire the same correct answer at once.
    const results = await Promise.all(
      players.map((p) => callFn(p, "submit-answer", { room_id: roomId, round_num: round, guess: word })),
    );

    const wins = results.filter((r) => r.body?.won === true);
    const corrects = results.filter((r) => r.body?.correct === true).length;
    const times = results.map((r) => r.body?.response_time_ms).filter((n) => typeof n === "number");
    trials++;
    const winnerId = wins[0]?.body ? results.findIndex((r) => r.body?.won === true) : -1;
    if (winnerId >= 0) winnerTally[`p${winnerId}`] = (winnerTally[`p${winnerId}`] ?? 0) + 1;

    line(`round ${String(round).padStart(2)}  word=${String(word).padEnd(14)} correct=${corrects}/8  winners=${wins.length}  times=[${Math.min(...times)}..${Math.max(...times)}]ms`);
    expect(`round ${round}: exactly one winner among 8 concurrent correct answers`,
      wins.length === 1, `got ${wins.length}`);

    // DB must agree with the API responses.
    const rr = await rest(host, `round_results?room_id=eq.${roomId}&round_num=eq.${round}&select=winner_id,response_time_ms`);
    expect(`round ${round}: exactly one winner row persisted`,
      Array.isArray(rr.body) && rr.body.length === 1 && !!rr.body[0].winner_id,
      JSON.stringify(rr.body));

    await sleep(1300); // feedback window
    const adv = await callFn(host, "advance-round", { room_id: roomId, round_num: round });
    if (adv.body?.finished) { line(`game finished after ${round} rounds`); break; }
    if (!adv.body?.advanced) { line(`advance stalled: ${JSON.stringify(adv.body)}`); break; }
    round = adv.body.round_num;
    word = adv.body.word;
  }

  line(`\n-> ${trials} contended rounds, every one resolved to exactly one winner`);
  line(`-> winners spread across players: ${JSON.stringify(winnerTally)}`);

  const board = await rest(host, `room_players?room_id=eq.${roomId}&select=display_name,score,streak&order=score.desc`);
  line(`final scoreboard: ${JSON.stringify(board.body)}`);
  const totalWins = Object.values(winnerTally).reduce((a, b) => a + b, 0);
  expect("one winner per round overall", totalWins === trials, `${totalWins} vs ${trials}`);

  // =====================================================================
  // B. Timed-out round (nobody answers) — the advance_round_tx else-branch.
  // =====================================================================
  line("\n=== B. a round NOBODY answers must time out on the server clock ===");
  const expert = await buildRoom("expert", 2); // expert = 11s limit
  const s2 = await callFn(expert.host, "start-game", { room_id: expert.roomId });
  expect("expert game started", s2.status === 200 && s2.body?.ok === true, JSON.stringify(s2.body));
  const limitMs = s2.body.round_seconds * 1000;
  line(`round 1 word=${s2.body.word}  limit=${s2.body.round_seconds}s (nobody will answer)`);

  // Early advance attempt must be refused — this is the anti-cheat check: a
  // client claiming "time's up" gets nothing until the server agrees.
  const tooEarly = await callFn(expert.players[1], "advance-round", { room_id: expert.roomId, round_num: 1 });
  line(`advance at ~0s:  HTTP ${tooEarly.status} ${JSON.stringify(tooEarly.body)}`);
  expect("early advance refused (time_remaining)",
    tooEarly.status === 409 && tooEarly.body?.reason === "time_remaining",
    JSON.stringify(tooEarly.body));

  const waitMs = limitMs + 1500;
  line(`waiting ${waitMs}ms for the real server-side timeout ...`);
  await sleep(waitMs);

  const afterTimeout = await callFn(expert.players[1], "advance-round", { room_id: expert.roomId, round_num: 1 });
  line(`advance after timeout: HTTP ${afterTimeout.status} advanced=${afterTimeout.body?.advanced} round=${afterTimeout.body?.round_num}`);
  expect("advance succeeds once the server clock passes the limit",
    afterTimeout.status === 200 && afterTimeout.body?.advanced === true,
    JSON.stringify(afterTimeout.body));

  const rr1 = await rest(expert.host, `round_results?room_id=eq.${expert.roomId}&round_num=eq.1&select=winner_id,response_time_ms,ended_at`);
  line(`timed-out round row: ${JSON.stringify(rr1.body)}`);
  expect("timed-out round closed with NO winner and no response time",
    rr1.body?.[0]?.winner_id === null && rr1.body?.[0]?.response_time_ms === null && !!rr1.body?.[0]?.ended_at,
    JSON.stringify(rr1.body));

  const noScores = await rest(expert.host, `room_players?room_id=eq.${expert.roomId}&select=display_name,score,streak`);
  line(`scores after a timed-out round: ${JSON.stringify(noScores.body)}`);
  expect("nobody scored on a round nobody won",
    Array.isArray(noScores.body) && noScores.body.every((p) => p.score === 0 && p.streak === 0),
    JSON.stringify(noScores.body));

  line(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
