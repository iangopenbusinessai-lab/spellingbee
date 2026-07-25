// verify_functions.mjs — proves the Session 9a edge functions enforce server
// authority, against the LIVE project. Zero dependencies (Node 18+ fetch).
//
//   node supabase/scripts/verify_functions.mjs
//
// Uses ONLY the anon key plus real anonymous-user tokens, exactly as an
// untrusted client would. The service_role key is never used here — if any of
// these checks could be passed with the anon key alone, that would itself be
// the bug.
//
// Covers:
//   1. three real anonymous users; host creates a room, guest joins
//   2. word secrecy — no round_results row exists before the game starts
//   3. start-game rejects a NON-HOST caller
//   4. start-game rejects a room with only ONE player
//   5. start-game succeeds for the host with 2 players
//   6. submit-answer rejects a NON-MEMBER
//   7. submit-answer rejects a STALE round_num
//   8. submit-answer rejects a DUPLICATE submission from the same player/round
//   9. advance-round rejects an EARLY advance (round still in progress)
//  10. two concurrent CORRECT submissions -> exactly one winner
//  11. response_time_ms is server-measured and ignores a client-supplied value
//  12. the SQL functions are NOT directly callable with a client token

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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const randCode = () =>
  Array.from({ length: 6 }, () => "ABCDEFGHJKMNPQRSTUVWXYZ23456789"[Math.floor(Math.random() * 31)]).join("");

let failures = 0;
function expect(label, cond, detail = "") {
  if (cond) {
    line(`   PASS  ${label}`);
  } else {
    failures++;
    line(`   FAIL  ${label}  ${detail}`);
  }
}

async function signUpAnon(tag) {
  const res = await fetch(`${URL}/auth/v1/signup`, {
    method: "POST",
    headers: { apikey: ANON, "Content-Type": "application/json" },
    body: JSON.stringify({ data: {} }),
  });
  const s = await res.json();
  if (!s.access_token) {
    line(`sign-in failed for ${tag}: ${JSON.stringify(s)}`);
    process.exit(1);
  }
  return {
    tag,
    id: s.user.id,
    headers: { apikey: ANON, Authorization: `Bearer ${s.access_token}`, "Content-Type": "application/json" },
  };
}

async function callFn(user, name, body) {
  const res = await fetch(`${URL}/functions/v1/${name}`, {
    method: "POST",
    headers: user.headers,
    body: JSON.stringify(body),
  });
  let parsed = null;
  const text = await res.text();
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: res.status, body: parsed };
}

async function rest(user, path, init = {}) {
  const res = await fetch(`${URL}/rest/v1/${path}`, { ...init, headers: { ...user.headers, ...(init.headers ?? {}) } });
  const text = await res.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: res.status, body: parsed };
}

async function main() {
  // ---- 1. users + room --------------------------------------------------
  line("=== 1. three anonymous users; host creates room, guest joins ===");
  const host = await signUpAnon("host");
  const guest = await signUpAnon("guest");
  const outsider = await signUpAnon("outsider");
  line(`host=${host.id}\nguest=${guest.id}\noutsider=${outsider.id}`);

  // The id is generated client-side and the insert uses return=minimal, exactly
  // as src/lib/rooms.ts does: the members-only SELECT policy on rooms blocks
  // reading the row back before the host has joined (confirmed in Session 7b).
  const code = randCode();
  const roomId = crypto.randomUUID();
  const roomRes = await rest(host, "rooms", {
    method: "POST",
    body: JSON.stringify({ id: roomId, code, tier: "easy", host_id: host.id }),
  });
  line(`create room HTTP ${roomRes.status} code=${code} room_id=${roomId}`);
  if (roomRes.status >= 400) { line(`cannot continue: ${JSON.stringify(roomRes.body)}`); process.exit(1); }

  await rest(host, "room_players", {
    method: "POST",
    body: JSON.stringify({ room_id: roomId, player_id: host.id, display_name: "host" }),
  });

  // ---- 2. word secrecy before start -------------------------------------
  line("\n=== 2. word secrecy: nothing readable before the game starts ===");
  const preRounds = await rest(host, `round_results?room_id=eq.${roomId}&select=round_num,word_id`);
  line(`round_results HTTP ${preRounds.status} body=${JSON.stringify(preRounds.body)}`);
  expect("no round row exists before start (no prefetchable word)",
    Array.isArray(preRounds.body) && preRounds.body.length === 0);

  // ---- 4. one-player room rejected (tested before guest joins) ----------
  line("\n=== 4. start-game with only ONE player must be rejected ===");
  const onePlayer = await callFn(host, "start-game", { room_id: roomId });
  line(`HTTP ${onePlayer.status}  ${JSON.stringify(onePlayer.body)}`);
  expect("1-player room rejected with not_enough_players",
    onePlayer.status === 409 && onePlayer.body?.error === "not_enough_players",
    `got ${onePlayer.status} ${JSON.stringify(onePlayer.body)}`);

  // guest joins
  await rest(guest, "room_players", {
    method: "POST",
    body: JSON.stringify({ room_id: roomId, player_id: guest.id, display_name: "guest" }),
  });
  line("guest joined (room now has 2 players)");

  // ---- 3. non-host rejected ---------------------------------------------
  line("\n=== 3. start-game called by a NON-HOST must be rejected ===");
  const nonHost = await callFn(guest, "start-game", { room_id: roomId });
  line(`HTTP ${nonHost.status}  ${JSON.stringify(nonHost.body)}`);
  expect("non-host rejected with not_host",
    nonHost.status === 403 && nonHost.body?.error === "not_host",
    `got ${nonHost.status} ${JSON.stringify(nonHost.body)}`);

  // ---- 5. host starts ----------------------------------------------------
  line("\n=== 5. start-game by the host with 2 players ===");
  const started = await callFn(host, "start-game", { room_id: roomId });
  line(`HTTP ${started.status}  ${JSON.stringify(started.body)}`);
  expect("game started, round 1 word issued",
    started.status === 200 && started.body?.ok === true && started.body?.round_num === 1 && !!started.body?.word);
  const word1 = started.body?.word;

  // ---- 6. non-member submit ---------------------------------------------
  line("\n=== 6. submit-answer from a NON-MEMBER must be rejected ===");
  const byOutsider = await callFn(outsider, "submit-answer", { room_id: roomId, round_num: 1, guess: word1 });
  line(`HTTP ${byOutsider.status}  ${JSON.stringify(byOutsider.body)}`);
  expect("non-member rejected with not_a_member",
    byOutsider.status === 403 && byOutsider.body?.error === "not_a_member",
    `got ${byOutsider.status} ${JSON.stringify(byOutsider.body)}`);

  // ---- 7. stale round ----------------------------------------------------
  line("\n=== 7. submit-answer with a STALE round_num must be rejected ===");
  const stale = await callFn(guest, "submit-answer", { room_id: roomId, round_num: 99, guess: word1 });
  line(`HTTP ${stale.status}  ${JSON.stringify(stale.body)}`);
  expect("stale round rejected with stale_round",
    stale.status === 409 && stale.body?.error === "stale_round",
    `got ${stale.status} ${JSON.stringify(stale.body)}`);

  // ---- 8. duplicate submission -------------------------------------------
  line("\n=== 8. duplicate submission from the same player/round ===");
  const first = await callFn(guest, "submit-answer", { room_id: roomId, round_num: 1, guess: "definitely-wrong" });
  line(`1st (wrong) HTTP ${first.status}  ${JSON.stringify(first.body)}`);
  expect("wrong answer accepted, no points, round continues",
    first.status === 200 && first.body?.correct === false && first.body?.won === false);

  const second = await callFn(guest, "submit-answer", { room_id: roomId, round_num: 1, guess: word1 });
  line(`2nd (retry)  HTTP ${second.status}  ${JSON.stringify(second.body)}`);
  expect("second submission rejected with already_submitted",
    second.status === 409 && second.body?.error === "already_submitted",
    `got ${second.status} ${JSON.stringify(second.body)}`);

  // ---- 9. early advance rejected -----------------------------------------
  line("\n=== 9. advance-round while the round is still live must be rejected ===");
  const early = await callFn(guest, "advance-round", { room_id: roomId, round_num: 1 });
  line(`HTTP ${early.status}  ${JSON.stringify(early.body)}`);
  expect("early advance rejected with round_in_progress",
    early.status === 409 && early.body?.error === "round_in_progress",
    `got ${early.status} ${JSON.stringify(early.body)}`);

  // host wins round 1, then advance to round 2
  const hostWin = await callFn(host, "submit-answer", { room_id: roomId, round_num: 1, guess: word1 });
  line(`host wins r1  HTTP ${hostWin.status}  ${JSON.stringify(hostWin.body)}`);
  await sleep(1300); // feedback window (feedback_ms = 1100)
  const toR2 = await callFn(host, "advance-round", { room_id: roomId, round_num: 1 });
  line(`advance to r2 HTTP ${toR2.status}  round_num=${toR2.body?.round_num} word=${toR2.body?.word}`);
  const word2 = toR2.body?.word;

  // ---- 10. concurrent correct submissions --------------------------------
  line("\n=== 10. TWO CONCURRENT correct submissions -> exactly one winner ===");
  const [a, b] = await Promise.all([
    callFn(host, "submit-answer", { room_id: roomId, round_num: 2, guess: word2 }),
    callFn(guest, "submit-answer", { room_id: roomId, round_num: 2, guess: word2 }),
  ]);
  line(`host  HTTP ${a.status}  ${JSON.stringify(a.body)}`);
  line(`guest HTTP ${b.status}  ${JSON.stringify(b.body)}`);
  const winners = [a, b].filter((r) => r.body?.won === true).length;
  const bothCorrect = a.body?.correct === true && b.body?.correct === true;
  line(`-> winners=${winners} (must be exactly 1), both marked correct=${bothCorrect}`);
  expect("exactly one winner among concurrent correct submissions", winners === 1, `winners=${winners}`);

  const rr2 = await rest(host, `round_results?room_id=eq.${roomId}&round_num=eq.2&select=round_num,winner_id,response_time_ms,ended_at`);
  line(`round_results r2: ${JSON.stringify(rr2.body)}`);
  expect("exactly one winner row recorded in round_results",
    Array.isArray(rr2.body) && rr2.body.length === 1 && !!rr2.body[0].winner_id);

  // ---- 11. server-measured response time ---------------------------------
  line("\n=== 11. response_time_ms is server-measured, client value ignored ===");
  await sleep(1300);
  const toR3 = await callFn(host, "advance-round", { room_id: roomId, round_num: 2 });
  const word3 = toR3.body?.word;
  line(`advance to r3 HTTP ${toR3.status}  round_num=${toR3.body?.round_num} word=${word3}`);

  const DELAY_MS = 2500;
  line(`waiting ${DELAY_MS}ms, then submitting with a bogus client-supplied response_time_ms: 1 ...`);
  await sleep(DELAY_MS);
  const timed = await callFn(host, "submit-answer", {
    room_id: roomId,
    round_num: 3,
    guess: word3,
    response_time_ms: 1,   // ignored: the function accepts no such field
    correct: true,          // ignored: correctness is decided server-side
  });
  line(`HTTP ${timed.status}  ${JSON.stringify(timed.body)}`);
  const measured = timed.body?.response_time_ms;
  line(`-> waited ~${DELAY_MS}ms, server recorded ${measured}ms (client claimed 1ms)`);
  expect("server-measured time reflects the real delay, not the client's 1ms",
    typeof measured === "number" && measured >= DELAY_MS && measured < DELAY_MS + 3000,
    `measured=${measured}`);

  const rr3 = await rest(host, `round_results?room_id=eq.${roomId}&round_num=eq.3&select=response_time_ms,winner_id`);
  line(`round_results r3 (persisted): ${JSON.stringify(rr3.body)}`);
  expect("persisted round_results row carries the server-measured time",
    Array.isArray(rr3.body) && rr3.body[0]?.response_time_ms >= DELAY_MS);

  // ---- 12. SQL functions not directly callable ---------------------------
  line("\n=== 12. the SQL transition functions must NOT be client-callable ===");
  for (const [fn, args] of [
    ["start_game_tx", { p_room_id: roomId, p_caller: guest.id }],
    ["submit_answer_tx", { p_room_id: roomId, p_round_num: 3, p_player: guest.id, p_guess: "x" }],
    ["advance_round_tx", { p_room_id: roomId, p_player: guest.id, p_expected_round: 3 }],
  ]) {
    const direct = await rest(guest, `rpc/${fn}`, { method: "POST", body: JSON.stringify(args) });
    line(`rpc ${fn} as client: HTTP ${direct.status} ${JSON.stringify(direct.body)}`);
    expect(`${fn} not callable with a client token`, direct.status >= 400, `got ${direct.status}`);
  }

  // ---- scoreboard --------------------------------------------------------
  line("\n=== final scoreboard (server-written scores) ===");
  const board = await rest(host, `room_players?room_id=eq.${roomId}&select=display_name,score,streak`);
  line(JSON.stringify(board.body, null, 2));

  line(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
