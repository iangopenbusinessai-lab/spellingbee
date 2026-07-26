// verify_elimination.mjs — Session 18's turn-based elimination engine (0012),
// against the LIVE project.
//
//   node supabase/scripts/verify_elimination.mjs
//
// Section A (the decay curve) needs only the anon key, because
// decayed_round_seconds/decay_params are granted to `authenticated` on purpose —
// a client has to be able to ask how long a turn is without ever computing it.
//
// Sections B onward drive real games, and the three transition functions are
// service_role only (0006's boundary, kept). They need SUPABASE_SERVICE_ROLE_KEY
// in .env.local — the same credential the edge functions are handed by the
// platform, so this exercises production's authorization path rather than a
// side door. .env.local is gitignored and the name has no VITE_ prefix, so it
// never reaches a browser bundle.
//
// Zero dependencies, matching the other verify scripts.

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
const SERVICE = env.SUPABASE_SERVICE_ROLE_KEY;

const line = (s = "") => console.log(s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const randCode = () =>
  Array.from({ length: 6 }, () => "ABCDEFGHJKMNPQRSTUVWXYZ23456789"[Math.floor(Math.random() * 31)]).join("");

let failures = 0;
const expect = (label, cond, detail = "") => {
  if (cond) line(`   PASS  ${label}`);
  else { failures++; line(`   FAIL  ${label}  ${detail}`); }
};

// --- transport --------------------------------------------------------------

async function signUpAnon() {
  const res = await fetch(`${URL}/auth/v1/signup`, {
    method: "POST",
    headers: { apikey: ANON, "Content-Type": "application/json" },
    body: JSON.stringify({ data: {} }),
  });
  const s = await res.json();
  if (!s.access_token) { line(`sign-in failed: ${JSON.stringify(s)}`); process.exit(1); }
  return {
    id: s.user.id,
    headers: { apikey: ANON, Authorization: `Bearer ${s.access_token}`, "Content-Type": "application/json" },
  };
}

const serviceHeaders = () => ({
  apikey: SERVICE,
  Authorization: `Bearer ${SERVICE}`,
  "Content-Type": "application/json",
});

async function rest(headers, path, init = {}) {
  const res = await fetch(`${URL}/rest/v1/${path}`, { ...init, headers: { ...headers, ...(init.headers ?? {}) } });
  const t = await res.text();
  try { return { status: res.status, body: t ? JSON.parse(t) : null }; }
  catch { return { status: res.status, body: t }; }
}

// RPC as service_role — the path an edge function takes.
const rpc = (fn, args) =>
  rest(serviceHeaders(), `rpc/${fn}`, { method: "POST", body: JSON.stringify(args) });

// RPC as a signed-in player — used to prove clients are refused.
const rpcAsPlayer = (user, fn, args) =>
  rest(user.headers, `rpc/${fn}`, { method: "POST", body: JSON.stringify(args) });

// --- room setup -------------------------------------------------------------

async function buildRoom({ tier, players: n, lives, mode = "elimination" }) {
  const players = [];
  for (let i = 0; i < n; i++) players.push(await signUpAnon());
  const host = players[0];
  const roomId = crypto.randomUUID();
  const r = await rest(host.headers, "rooms", {
    method: "POST",
    body: JSON.stringify({
      id: roomId, code: randCode(), tier, host_id: host.id,
      mode, lives_setting: lives,
    }),
  });
  if (r.status >= 400) { line(`room create failed ${JSON.stringify(r.body)}`); process.exit(1); }
  for (let i = 0; i < players.length; i++) {
    const j = await rest(players[i].headers, "room_players", {
      method: "POST",
      body: JSON.stringify({ room_id: roomId, player_id: players[i].id, display_name: `p${i}` }),
    });
    if (j.status >= 400) { line(`join failed ${JSON.stringify(j.body)}`); process.exit(1); }
  }
  const name = (id) => `p${players.findIndex((p) => p.id === id)}`;
  return { roomId, players, host, name };
}

const roster = async (roomId) =>
  (await rest(serviceHeaders(),
    `room_players?room_id=eq.${roomId}&select=player_id,display_name,lives,is_eliminated,turn_order,score&order=turn_order`)).body;

const roomRow = async (roomId) =>
  (await rest(serviceHeaders(),
    `rooms?id=eq.${roomId}&select=status,current_round,current_turn_player_id,table_streak,starting_players,winner_id,round_started_at`)).body[0];

const turnRow = async (roomId, n) =>
  (await rest(serviceHeaders(),
    `round_results?room_id=eq.${roomId}&round_num=eq.${n}&select=round_num,word_id,turn_player_id,turn_started_at,round_seconds,outcome,winner_id,ended_at`)).body[0];

const wordFor = async (wordId) =>
  (await rest(serviceHeaders(), `words?id=eq.${wordId}&select=word`)).body[0].word;

// ===========================================================================

async function sectionA() {
  line("=== A. decay curve — three triggers, independently and combined ===");
  const u = await signUpAnon();

  const params = await rpcAsPlayer(u, "decay_params", {});
  line(`decay_params(): ${JSON.stringify(params.body)}`);

  const d = async (tier, start, remaining, streak) => {
    const r = await rpcAsPlayer(u, "decayed_round_seconds", {
      p_tier: tier, p_starting_players: start, p_remaining_players: remaining, p_streak: streak,
    });
    return r.body;
  };

  const base = await rpcAsPlayer(u, "round_seconds", { p_tier: "easy" });
  line(`\nbase round_seconds('easy') = ${base.body}s   (all cases below are 'easy')`);
  expect("base easy tier is 20s", base.body === 20, String(base.body));

  line("\n-- no trigger active --");
  const none = await d("easy", 8, 8, 0);
  line(`  N=8 remaining=8 streak=0            -> ${none}s`);
  expect("undecayed turn equals the base", none === 20, String(none));

  line("\n-- trigger 1 only: player count (streak 0 throughout) --");
  const p8_5 = await d("easy", 8, 5, 0);
  const p8_4 = await d("easy", 8, 4, 0);
  const p8_3 = await d("easy", 8, 3, 0);
  const p8_2 = await d("easy", 8, 2, 0);
  line(`  N=8 remaining=5 (above threshold 4) -> ${p8_5}s`);
  line(`  N=8 remaining=4 (AT threshold)      -> ${p8_4}s`);
  line(`  N=8 remaining=3                     -> ${p8_3}s`);
  line(`  N=8 remaining=2                     -> ${p8_2}s`);
  expect("inactive above the ceil(N/2) threshold", p8_5 === 20, String(p8_5));
  expect("engages at the threshold (10% off)", p8_4 === 18, String(p8_4));
  expect("deepens past the threshold, not one flat cut", p8_3 === 17 && p8_2 === 16, `${p8_3},${p8_2}`);
  expect("strictly monotonic as the field thins", p8_5 > p8_4 && p8_4 > p8_3 && p8_3 > p8_2);

  const duel = await d("easy", 2, 1, 0);
  line(`  N=2 remaining=1 (the 1v1 exception)  -> ${duel}s`);
  expect("N=2 is exempt from trigger 1 entirely", duel === 20, String(duel));

  line("\n-- trigger 2 only: streak stage 1 (N=2, so trigger 1 cannot interfere) --");
  const s4 = await d("easy", 2, 2, 4);
  const s5 = await d("easy", 2, 2, 5);
  const s8 = await d("easy", 2, 2, 8);
  line(`  streak=4 (below stage 1)            -> ${s4}s`);
  line(`  streak=5 (stage 1 threshold)        -> ${s5}s`);
  line(`  streak=8 (still stage 1)            -> ${s8}s`);
  expect("below the stage-1 threshold nothing happens", s4 === 20, String(s4));
  expect("stage 1 takes 10% off at streak 5", s5 === 18, String(s5));
  expect("stage 1 holds until stage 2", s8 === 18, String(s8));

  line("\n-- trigger 3 only: streak stage 2, ADDITIVE on top of stage 1 --");
  const s9 = await d("easy", 2, 2, 9);
  const s12 = await d("easy", 2, 2, 12);
  line(`  streak=9 (stage 2 threshold)        -> ${s9}s`);
  line(`  streak=12                           -> ${s12}s`);
  expect("stage 2 is 0.10+0.15 = 25% off", s9 === 15, String(s9));
  expect("stage 2 is STRICTLY harsher than stage 1, not equal to it",
    s9 < s5, `stage2=${s9}s vs stage1=${s5}s`);
  line(`  -> streak 9 costs ${s5 - s9}s more than streak 5 (${s5}s -> ${s9}s)`);

  line("\n-- triggers 1 and 3 together --");
  const both = await d("easy", 8, 2, 9);
  line(`  N=8 remaining=2 AND streak=9        -> ${both}s`);
  expect("combined multiplicatively: 20 * 0.80 * 0.75 = 12", both === 12, String(both));
  expect("combined is harsher than either alone",
    both < p8_2 && both < s9, `${both} vs ${p8_2}/${s9}`);
  line(`  -> player-count alone ${p8_2}s, streak alone ${s9}s, together ${both}s`);

  line("\n-- hardest tier, cap, and floor --");
  const master = await d("master", 8, 2, 9);
  line(`  master (base 13) N=8 rem=2 streak=9 -> ${master}s   <- deepest REACHABLE decay today`);
  expect("hardest tier under maximum reachable decay: 13 * 0.80 * 0.75 = 8s",
    master === 8, String(master));
  expect("still comfortably above the 6s floor", master > 6, String(master));

  // player_cut_max cannot be reached at the current lobby cap of 8, so it is
  // exercised here with a hypothetical larger field — the function is a pure
  // calculation and is callable with any inputs precisely so this is testable.
  const capped = await d("easy", 14, 2, 0);
  const uncapped = await d("easy", 10, 2, 0);
  line(`  N=14 remaining=2 streak=0           -> ${capped}s  (raw cut would be 0.35, capped at 0.30)`);
  line(`  N=10 remaining=2 streak=0           -> ${uncapped}s  (cut 0.25, under the cap)`);
  expect("player_cut_max caps trigger 1 at 30%", capped === 14, String(capped));
  expect("below the cap the curve is still linear", uncapped === 15, String(uncapped));

  line("\n-- malformed inputs are rejected, not smoothed over --");
  const bad1 = await rpcAsPlayer(u, "decayed_round_seconds", {
    p_tier: "easy", p_starting_players: 1, p_remaining_players: 1, p_streak: 0 });
  line(`  starting_players=1 -> HTTP ${bad1.status} ${JSON.stringify(bad1.body?.message ?? bad1.body)}`);
  expect("starting_players < 2 raises", bad1.status >= 400, JSON.stringify(bad1.body));

  const bad2 = await rpcAsPlayer(u, "decayed_round_seconds", {
    p_tier: "easy", p_starting_players: 4, p_remaining_players: 9, p_streak: 0 });
  line(`  remaining > starting -> HTTP ${bad2.status} ${JSON.stringify(bad2.body?.message ?? bad2.body)}`);
  expect("remaining > starting raises", bad2.status >= 400, JSON.stringify(bad2.body));

  const bad3 = await rpcAsPlayer(u, "decayed_round_seconds", {
    p_tier: "easy", p_starting_players: 4, p_remaining_players: 2, p_streak: -1 });
  line(`  streak=-1 -> HTTP ${bad3.status} ${JSON.stringify(bad3.body?.message ?? bad3.body)}`);
  expect("negative streak raises", bad3.status >= 400, JSON.stringify(bad3.body));

  line("\n-- avatar preset set --");
  const av = await rpcAsPlayer(u, "avatar_keys", {});
  line(`  avatar_keys(): ${JSON.stringify(av.body)}`);
  expect("avatar_keys() returns the fixed preset set",
    Array.isArray(av.body) && av.body.length === 8 && av.body[0] === "bee", JSON.stringify(av.body));
}

async function sectionB() {
  line("\n=== B. clients cannot reach the transition functions ===");
  const u = await signUpAnon();
  for (const [fn, args] of [
    ["start_elimination_game_tx", { p_room_id: crypto.randomUUID(), p_caller: u.id }],
    ["submit_turn_answer_tx", { p_room_id: crypto.randomUUID(), p_round_num: 1, p_player: u.id, p_guess: "x" }],
    ["timeout_turn_tx", { p_room_id: crypto.randomUUID(), p_expected_round: 1 }],
    ["apply_turn_outcome", { p_room_id: crypto.randomUUID(), p_round_num: 1, p_player: u.id, p_correct: true, p_outcome: "correct", p_elapsed_ms: 0, p_now: new Date().toISOString() }],
  ]) {
    const r = await rpcAsPlayer(u, fn, args);
    line(`  ${fn.padEnd(28)} -> HTTP ${r.status} ${r.body?.code ?? ""} ${r.body?.message ?? ""}`);
    expect(`${fn} refused to a signed-in client`, r.status === 404 || r.status === 403,
      JSON.stringify(r.body));
  }
}

async function sectionC() {
  line("\n=== C. avatar column: fixed preset set, client-settable ===");
  const { roomId, players } = await buildRoom({ tier: "novice", players: 2, lives: 3 });
  const me = players[0];

  const ok = await rest(me.headers, `room_players?room_id=eq.${roomId}&player_id=eq.${me.id}`, {
    method: "PATCH", body: JSON.stringify({ avatar: "queen" }),
  });
  line(`  set avatar='queen'   -> HTTP ${ok.status}`);
  expect("a player may set their own avatar to a preset key", ok.status < 300, JSON.stringify(ok.body));

  const bad = await rest(me.headers, `room_players?room_id=eq.${roomId}&player_id=eq.${me.id}`, {
    method: "PATCH", body: JSON.stringify({ avatar: "dragon" }),
  });
  line(`  set avatar='dragon'  -> HTTP ${bad.status} ${bad.body?.message ?? ""}`);
  expect("an off-list avatar is rejected by the CHECK", bad.status >= 400, JSON.stringify(bad.body));

  const lives = await rest(me.headers, `room_players?room_id=eq.${roomId}&player_id=eq.${me.id}`, {
    method: "PATCH", body: JSON.stringify({ lives: 99 }),
  });
  line(`  set lives=99         -> HTTP ${lives.status} ${lives.body?.message ?? ""}`);
  expect("a client cannot grant itself lives", lives.status >= 400, JSON.stringify(lives.body));

  const r = await roster(roomId);
  line(`  roster: ${JSON.stringify(r.map(({ display_name, avatar_ignored, lives, is_eliminated, turn_order }) => ({ display_name, lives, is_eliminated, turn_order })))}`);
  expect("lives default to the room's setting before the game starts",
    r.every((p) => p.lives === 3), JSON.stringify(r));
  expect("turn_order is NULL until the game starts",
    r.every((p) => p.turn_order === null), JSON.stringify(r));
}

// Play one turn as whoever currently holds it. `answer` is 'correct' | 'wrong'.
async function playTurn(roomId, answer, note = "") {
  const room = await roomRow(roomId);
  const t = await turnRow(roomId, room.current_round);
  const word = await wordFor(t.word_id);
  const guess = answer === "correct" ? word : "definitely-not-the-word";
  const res = await rpc("submit_turn_answer_tx", {
    p_room_id: roomId, p_round_num: room.current_round,
    p_player: room.current_turn_player_id, p_guess: guess,
  });
  return { room, turn: t, word, res: res.body, note };
}

async function sectionD() {
  line("\n=== D. out-of-turn submissions are rejected ===");
  const { roomId, players, name } = await buildRoom({ tier: "novice", players: 4, lives: 3 });
  const start = await rpc("start_elimination_game_tx", { p_room_id: roomId, p_caller: players[0].id });
  line(`  start -> ${JSON.stringify(start.body)}`);
  expect("elimination game starts", start.body?.ok === true, JSON.stringify(start.body));

  const r0 = await roster(roomId);
  line(`  randomized rotation: ${JSON.stringify(r0.map((p) => `${p.turn_order}:${p.display_name}`))}`);
  expect("every player got a distinct 0..n-1 turn_order",
    new Set(r0.map((p) => p.turn_order)).size === 4 &&
    r0.every((p, i) => p.turn_order === i), JSON.stringify(r0));

  const room = await roomRow(roomId);
  line(`  turn holder: ${name(room.current_turn_player_id)}   round=${room.current_round}`);
  expect("rooms.round_started_at stays NULL (the 0009 sweeper interlock)",
    room.round_started_at === null, String(room.round_started_at));

  const t = await turnRow(roomId, 1);
  const word = await wordFor(t.word_id);

  // Everyone who is NOT the turn holder tries the correct answer.
  for (const p of players.filter((p) => p.id !== room.current_turn_player_id)) {
    const r = await rpc("submit_turn_answer_tx", {
      p_room_id: roomId, p_round_num: 1, p_player: p.id, p_guess: word,
    });
    line(`  ${name(p.id)} (not their turn) submits the CORRECT word -> ${JSON.stringify(r.body)}`);
    expect(`${name(p.id)} rejected with not_your_turn`,
      r.body?.ok === false && r.body?.error === "not_your_turn", JSON.stringify(r.body));
  }

  const after = await turnRow(roomId, 1);
  expect("the turn is untouched by out-of-turn attempts",
    after.ended_at === null && after.outcome === null, JSON.stringify(after));

  const outsider = await signUpAnon();
  const o = await rpc("submit_turn_answer_tx", {
    p_room_id: roomId, p_round_num: 1, p_player: outsider.id, p_guess: word });
  line(`  a non-member submits -> ${JSON.stringify(o.body)}`);
  expect("non-members rejected with not_a_member",
    o.body?.error === "not_a_member", JSON.stringify(o.body));

  const stale = await rpc("submit_turn_answer_tx", {
    p_room_id: roomId, p_round_num: 99, p_player: room.current_turn_player_id, p_guess: word });
  line(`  turn holder submits for round 99 -> ${JSON.stringify(stale.body)}`);
  expect("stale round rejected", stale.body?.error === "stale_round", JSON.stringify(stale.body));

  // The legitimate holder answers, then immediately tries the NEXT turn before
  // the feedback window has elapsed.
  const good = await rpc("submit_turn_answer_tx", {
    p_room_id: roomId, p_round_num: 1, p_player: room.current_turn_player_id, p_guess: word });
  line(`  turn holder answers correctly -> next=${name(good.body?.next_turn_player_id)} in ${good.body?.next_round_seconds}s`);
  expect("the turn holder's correct answer resolves", good.body?.ok === true && good.body?.correct === true,
    JSON.stringify(good.body));

  const early = await rpc("submit_turn_answer_tx", {
    p_room_id: roomId, p_round_num: good.body.next_round_num,
    p_player: good.body.next_turn_player_id, p_guess: "anything" });
  line(`  next player answers DURING the feedback window -> ${JSON.stringify(early.body)}`);
  expect("a submission before the turn's clock starts is refused",
    early.body?.error === "turn_not_started", JSON.stringify(early.body));

  return { roomId, players, name };
}

async function sectionE() {
  line("\n=== E. elimination: a player loses their 3rd life and leaves the rotation ===");
  const { roomId, players, name } = await buildRoom({ tier: "novice", players: 3, lives: 3 });
  const start = await rpc("start_elimination_game_tx", { p_room_id: roomId, p_caller: players[0].id });
  expect("game started with 3 lives each", start.body?.ok === true, JSON.stringify(start.body));

  const r0 = await roster(roomId);
  const victim = r0[0].player_id;                 // whoever drew turn_order 0
  line(`  rotation: ${JSON.stringify(r0.map((p) => `${p.turn_order}:${p.display_name}`))}`);
  line(`  target for elimination: ${name(victim)} (lives ${r0[0].lives})`);

  const seenHolders = [];
  for (let i = 0; i < 12; i++) {
    const room = await roomRow(roomId);
    if (room.status !== "active") break;
    seenHolders.push(name(room.current_turn_player_id));
    const isVictim = room.current_turn_player_id === victim;
    const { res } = await playTurn(roomId, isVictim ? "wrong" : "correct");
    const who = name(room.current_turn_player_id);
    line(`  round ${String(room.current_round).padStart(2)}  ${who} answers ${isVictim ? "WRONG " : "right "}` +
         `-> lives=${res.lives} eliminated=${res.eliminated} streak=${res.table_streak} ` +
         `remaining=${res.remaining_players}` +
         (res.finished ? `  FINISHED winner=${name(res.winner_id)}` : `  next=${name(res.next_turn_player_id)} in ${res.next_round_seconds}s`));
    if (res.eliminated) {
      const rr = await roster(roomId);
      const v = rr.find((p) => p.player_id === victim);
      line(`\n  -> ${name(victim)} row after the 3rd miss: ${JSON.stringify(v)}`);
      expect("is_eliminated flipped at 0 lives", v.lives === 0 && v.is_eliminated === true, JSON.stringify(v));
      expect("turn_order is NOT renumbered on elimination", v.turn_order === 0, JSON.stringify(v));
      break;
    }
    await sleep(1250);   // feedback window
  }

  // Now prove the eliminated player is skipped by the rotation from here on.
  line(`\n  -- rotation after elimination (${name(victim)} must never hold a turn again) --`);
  const holdersAfter = [];
  for (let i = 0; i < 6; i++) {
    const room = await roomRow(roomId);
    if (room.status !== "active") break;
    holdersAfter.push(name(room.current_turn_player_id));
    expect(`round ${room.current_round}: turn holder is not the eliminated player`,
      room.current_turn_player_id !== victim, name(room.current_turn_player_id));
    await sleep(1250);
    const { res } = await playTurn(roomId, "correct");
    if (res.finished) break;
  }
  line(`  holders after elimination: ${JSON.stringify(holdersAfter)}`);

  const blocked = await rpc("submit_turn_answer_tx", {
    p_room_id: roomId, p_round_num: (await roomRow(roomId)).current_round,
    p_player: victim, p_guess: "anything" });
  line(`  eliminated player tries to answer -> ${JSON.stringify(blocked.body)}`);
  expect("an eliminated player is refused",
    blocked.body?.error === "eliminated", JSON.stringify(blocked.body));

  return { roomId, players, name, victim };
}

async function sectionF(ctx) {
  line("\n=== F. win condition: play down to one survivor ===");
  const { roomId, name } = ctx;
  let room = await roomRow(roomId);
  const survivors = (await roster(roomId)).filter((p) => !p.is_eliminated);
  const nextVictim = survivors[0].player_id;
  line(`  survivors: ${JSON.stringify(survivors.map((p) => `${p.display_name}(${p.lives})`))}`);
  line(`  driving ${name(nextVictim)} to 0 lives`);

  for (let i = 0; i < 12; i++) {
    room = await roomRow(roomId);
    if (room.status !== "active") break;
    await sleep(1250);
    const isVictim = room.current_turn_player_id === nextVictim;
    const { res } = await playTurn(roomId, isVictim ? "wrong" : "correct");
    line(`  round ${String(room.current_round).padStart(2)}  ${name(room.current_turn_player_id)} ` +
         `${isVictim ? "WRONG " : "right "} -> lives=${res.lives} remaining=${res.remaining_players}` +
         (res.finished ? `  FINISHED reason=${res.reason} winner=${name(res.winner_id)}` : ""));
    if (res.finished) break;
  }

  const final = await roomRow(roomId);
  const finalRoster = await roster(roomId);
  line(`\n  final room:   ${JSON.stringify(final)}`);
  line(`  final roster: ${JSON.stringify(finalRoster.map((p) => ({ n: p.display_name, lives: p.lives, out: p.is_eliminated, score: p.score })))}`);

  const alive = finalRoster.filter((p) => !p.is_eliminated);
  expect("room status is finished", final.status === "finished", final.status);
  expect("exactly one player remains", alive.length === 1, JSON.stringify(alive));
  expect("winner_id is the last player standing",
    final.winner_id === alive[0]?.player_id, `${final.winner_id} vs ${alive[0]?.player_id}`);
  expect("no turn holder once the game is over",
    final.current_turn_player_id === null, String(final.current_turn_player_id));

  const late = await rpc("submit_turn_answer_tx", {
    p_room_id: roomId, p_round_num: final.current_round, p_player: alive[0].player_id, p_guess: "x" });
  line(`  submitting into a finished game -> ${JSON.stringify(late.body)}`);
  expect("a finished room refuses submissions",
    late.body?.error === "room_not_active", JSON.stringify(late.body));
}

async function sectionG() {
  line("\n=== G. race safety: concurrent turn-advance attempts ===");
  const { roomId, players, name } = await buildRoom({ tier: "novice", players: 4, lives: 3 });
  await rpc("start_elimination_game_tx", { p_room_id: roomId, p_caller: players[0].id });

  let contested = 0;
  for (let round = 1; round <= 5; round++) {
    const room = await roomRow(roomId);
    if (room.status !== "active") break;
    const t = await turnRow(roomId, room.current_round);
    const word = await wordFor(t.word_id);
    const holder = room.current_turn_player_id;

    // Six simultaneous calls: three duplicates from the real turn holder (a
    // retried HTTP call), the other three players answering out of turn, plus a
    // timeout sweep racing all of them.
    const calls = [
      ...[0, 1, 2].map(() => rpc("submit_turn_answer_tx", {
        p_room_id: roomId, p_round_num: room.current_round, p_player: holder, p_guess: word })),
      ...players.filter((p) => p.id !== holder).map((p) => rpc("submit_turn_answer_tx", {
        p_room_id: roomId, p_round_num: room.current_round, p_player: p.id, p_guess: word })),
      rpc("timeout_turn_tx", { p_room_id: roomId, p_expected_round: room.current_round }),
    ];
    const out = (await Promise.all(calls)).map((r) => r.body);
    contested++;

    const resolved = out.filter((b) => b?.ok === true && b?.outcome === "correct");
    const tally = {};
    for (const b of out) {
      const k = b?.ok === true ? (b.outcome ?? (b.note ?? "ok")) : b?.error;
      tally[k] = (tally[k] ?? 0) + 1;
    }
    line(`  round ${room.current_round}  holder=${name(holder)}  7 concurrent calls -> ${JSON.stringify(tally)}`);
    expect(`round ${room.current_round}: exactly one call resolved the turn`,
      resolved.length === 1, `got ${resolved.length}`);

    const after = await roomRow(roomId);
    expect(`round ${room.current_round}: the room advanced by exactly one`,
      after.current_round === room.current_round + 1 || after.status === "finished",
      `${room.current_round} -> ${after.current_round}`);

    const rowCount = (await rest(serviceHeaders(),
      `round_results?room_id=eq.${roomId}&select=round_num`)).body.length;
    expect(`round ${room.current_round}: no duplicate/skipped turn rows`,
      rowCount === room.current_round + 1 || after.status === "finished",
      `${rowCount} rows at round ${room.current_round}`);

    await sleep(1250);
  }
  line(`  -> ${contested} contended turns, each resolved exactly once`);

  const rows = (await rest(serviceHeaders(),
    `round_results?room_id=eq.${roomId}&select=round_num,outcome,round_seconds&order=round_num`)).body;
  line(`  turn rows: ${JSON.stringify(rows)}`);
  const nums = rows.map((r) => r.round_num);
  expect("round numbers are contiguous with no gaps",
    nums.every((n, i) => n === i + 1), JSON.stringify(nums));
}

async function sectionH() {
  line("\n=== H. timeout path: a turn nobody answers ===");
  const { roomId, players, name } = await buildRoom({ tier: "expert", players: 3, lives: 3 });
  const start = await rpc("start_elimination_game_tx", { p_room_id: roomId, p_caller: players[0].id });
  const secs = start.body.round_seconds;
  line(`  turn 1 holder=${name(start.body.turn_player_id)}  limit=${secs}s (nobody will answer)`);

  const early = await rpc("timeout_turn_tx", { p_room_id: roomId, p_expected_round: 1 });
  line(`  timeout at ~0s -> ${JSON.stringify(early.body)}`);
  expect("an early timeout claim is refused (time_remaining)",
    early.body?.ok === false && early.body?.reason === "time_remaining", JSON.stringify(early.body));

  const waitMs = secs * 1000 + 1500;
  line(`  waiting ${waitMs}ms for the real server-side deadline ...`);
  await sleep(waitMs);

  const t = await rpc("timeout_turn_tx", { p_room_id: roomId, p_expected_round: 1 });
  line(`  timeout after the deadline -> ${JSON.stringify(t.body)}`);
  expect("a timeout costs exactly one life, same as a wrong answer",
    t.body?.ok === true && t.body?.outcome === "timeout" && t.body?.lives === 2,
    JSON.stringify(t.body));
  expect("a timeout resets the table streak", t.body?.table_streak === 0, JSON.stringify(t.body));

  const row = await turnRow(roomId, 1);
  line(`  timed-out turn row: ${JSON.stringify(row)}`);
  expect("turn closed as outcome='timeout' with no winner",
    row.outcome === "timeout" && row.winner_id === null && !!row.ended_at, JSON.stringify(row));

  const again = await rpc("timeout_turn_tx", { p_room_id: roomId, p_expected_round: 1 });
  line(`  timing out the same turn again -> ${JSON.stringify(again.body)}`);
  expect("a repeated timeout is idempotent, not a second life lost",
    again.body?.ok === true && again.body?.resolved === false, JSON.stringify(again.body));

  const nonElim = await buildRoom({ tier: "novice", players: 2, lives: 3, mode: "race" });
  const wrong = await rpc("start_elimination_game_tx", { p_room_id: nonElim.roomId, p_caller: nonElim.players[0].id });
  line(`  starting an elimination game on a mode='race' room -> ${JSON.stringify(wrong.body)}`);
  expect("the mode interlock rejects a race room",
    wrong.body?.error === "wrong_mode", JSON.stringify(wrong.body));
}

// A game in progress must not be joinable. Before the fix, one uninvited insert
// made the survivor count exceed starting_players, decayed_round_seconds raised
// 22023, and every later answer and timeout in that room aborted — a permanent
// wedge available to any signed-in stranger. Both halves of the fix are checked:
// the insert is refused, and the game still reaches a winner afterwards.
async function sectionI() {
  line("\n=== I. a game in progress cannot be joined (wedge defence) ===");

  const { roomId, players, name } = await buildRoom({ tier: "novice", players: 2, lives: 1 });
  await rpc("start_elimination_game_tx", { p_room_id: roomId, p_caller: players[0].id });
  line(`  2-player game started, 1 life each`);

  const intruder = await signUpAnon();
  const j = await rest(intruder.headers, "room_players", {
    method: "POST",
    body: JSON.stringify({ room_id: roomId, player_id: intruder.id, display_name: "intruder" }),
  });
  line(`  stranger inserts into an ACTIVE elimination room -> HTTP ${j.status} ${j.body?.message ?? ""}`);
  expect("the restrictive policy refuses a mid-game join", j.status >= 400, JSON.stringify(j.body));

  const rows = await roster(roomId);
  expect("no spectator row landed on the roster", rows.length === 2, JSON.stringify(rows.map((p) => p.display_name)));

  // And a lobby join is still perfectly legal — the policy must only subtract
  // permission from elimination games already under way.
  const lobby = await buildRoom({ tier: "novice", players: 2, lives: 3 });
  const latecomer = await signUpAnon();
  const lj = await rest(latecomer.headers, "room_players", {
    method: "POST",
    body: JSON.stringify({ room_id: lobby.roomId, player_id: latecomer.id, display_name: "late" }),
  });
  line(`  joining an elimination room still in LOBBY -> HTTP ${lj.status}`);
  expect("lobby joins are unaffected", lj.status < 300, JSON.stringify(lj.body));

  // Race rooms must keep 0002's behaviour exactly, including the mid-game join
  // that has always been permitted there.
  const race = await buildRoom({ tier: "novice", players: 2, lives: 3, mode: "race" });
  await rpc("start_game_tx", { p_room_id: race.roomId, p_caller: race.players[0].id });
  const rjoin = await signUpAnon();
  const rj = await rest(rjoin.headers, "room_players", {
    method: "POST",
    body: JSON.stringify({ room_id: race.roomId, player_id: rjoin.id, display_name: "racer" }),
  });
  line(`  joining an ACTIVE race room (0006 behaviour, must be unchanged) -> HTTP ${rj.status}`);
  expect("the guard is scoped to elimination and leaves race rooms alone",
    rj.status < 300, JSON.stringify(rj.body));

  // Finally: the elimination game still terminates. With 1 life each, the first
  // miss ends it.
  await sleep(1250);
  const { res } = await playTurn(roomId, "wrong");
  line(`  turn holder misses on their last life -> ${JSON.stringify(res)}`);
  expect("the game still reaches a winner after the attempted intrusion",
    res?.finished === true && !!res?.winner_id, JSON.stringify(res));
  const fin = await roomRow(roomId);
  line(`  final room: ${JSON.stringify(fin)}`);
  expect("winner recorded and status finished",
    fin.status === "finished" && fin.winner_id !== null, JSON.stringify(fin));
  line(`  winner: ${name(fin.winner_id)}`);
}

async function main() {
  if (!URL || !ANON) { line("missing VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY in .env.local"); process.exit(1); }

  await sectionA();

  if (!SERVICE) {
    line("\nSUPABASE_SERVICE_ROLE_KEY is not in .env.local — sections B-H (which drive");
    line("real games through the service_role-only transition functions) were skipped.");
    process.exit(failures === 0 ? 0 : 1);
  }

  await sectionB();
  await sectionC();
  await sectionD();
  const ctx = await sectionE();
  await sectionF(ctx);
  await sectionG();
  await sectionH();
  await sectionI();

  line(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
