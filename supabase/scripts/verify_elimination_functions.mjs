// verify_elimination_functions.mjs — Session 19's elimination edge functions,
// the sweeper extension and the widened get_room_by_code(), against the LIVE
// project.
//
//   node supabase/scripts/verify_elimination_functions.mjs
//
// Needs only VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY in .env.local. That is
// the point: every call below goes through the real HTTP surface as a real
// signed-in anonymous user holding nothing but an anon key, exactly as a browser
// would. The service_role key lives only in the edge functions' own runtime, so
// if these scripts could reach the transition functions without it, the security
// boundary would be broken. Section 1 checks that they cannot.
//
// Zero dependencies, matching every other verify script here.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

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

// --- the player pool --------------------------------------------------------
//
// Supabase rate-limits anonymous sign-ups per IP per hour, and a naive script
// that signs up fresh users per section burns through that allowance and then
// fails halfway with a 429 — which looks like a verification failure but is
// only a test-harness problem. Two fixes, both worth keeping:
//
//   1. A POOL of identities is created once and reused across every section.
//      Nothing here needs globally unique users, only users that are distinct
//      WITHIN a room, and rooms are independent (room_players is keyed on
//      (room_id, player_id)). Peak demand is 4 players + 1 outsider.
//   2. The pool is cached in the OS temp dir between runs, so re-running this
//      script costs zero sign-ups while the tokens are still valid. Anonymous
//      users are permanent rows in auth.users; only their access token expires,
//      and the cached refresh token renews it.
//
// Nothing about the verification depends on the users being fresh.

// The true minimum: section 4 seats four players, and one more identity has to
// exist outside every room to test non-members and off-preset joins. Kept at the
// minimum precisely because sign-ups are the scarce resource.
const POOL_SIZE = 5;
const CACHE = join(tmpdir(), `spellingbee-verify-pool-${(URL ?? "").replace(/\W+/g, "")}.json`);

const mkUser = (tag, id, accessToken, refreshToken) => ({
  tag, id, accessToken, refreshToken,
  headers: { apikey: ANON, Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
});

async function tokenStillValid(accessToken) {
  const r = await fetch(`${URL}/auth/v1/user`, {
    headers: { apikey: ANON, Authorization: `Bearer ${accessToken}` },
  });
  return r.ok;
}

async function refreshUser(u, tag) {
  if (!u?.refreshToken) return null;
  const r = await fetch(`${URL}/auth/v1/token?grant_type=refresh_token`, {
    method: "POST",
    headers: { apikey: ANON, "Content-Type": "application/json" },
    body: JSON.stringify({ refresh_token: u.refreshToken }),
  });
  if (!r.ok) return null;
  const s = await r.json();
  if (!s.access_token) return null;
  return mkUser(tag, s.user.id, s.access_token, s.refresh_token);
}

async function signUpAnonRaw(tag) {
  // Back off on 429 rather than dying: the limit is per hour, so this only
  // rescues a run that is a couple of sign-ups over the edge. If it cannot
  // recover it says so plainly instead of reporting a bogus FAIL.
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(`${URL}/auth/v1/signup`, {
      method: "POST",
      headers: { apikey: ANON, "Content-Type": "application/json" },
      body: JSON.stringify({ data: {} }),
    });
    const s = await res.json();
    if (s.access_token) return mkUser(tag, s.user.id, s.access_token, s.refresh_token);
    if (res.status !== 429) {
      line(`sign-in failed for ${tag}: ${JSON.stringify(s)}`);
      process.exit(1);
    }
    const wait = 5000 * (attempt + 1);
    line(`  (anon sign-up rate-limited; retrying ${tag} in ${wait / 1000}s)`);
    await sleep(wait);
  }
  line(`\nAnonymous sign-up is rate limited for this IP and the cached pool is`);
  line(`unusable. Wait for the hourly window to roll over and re-run, or raise`);
  line(`the anonymous sign-in rate limit in Auth settings. This is a harness`);
  line(`limit, not a verification failure.`);
  process.exit(2);
}

let POOL = [];

async function initPool() {
  let cached = [];
  try { cached = JSON.parse(readFileSync(CACHE, "utf8")); } catch { cached = []; }

  // Persist after EVERY acquisition, not at the end. A sign-up that succeeds and
  // is then thrown away because a later one hit the rate limit has spent part of
  // an hourly allowance for nothing, and the next run starts from zero again —
  // which is exactly how a rate-limited run becomes an unrecoverable one.
  const save = () => writeFileSync(CACHE, JSON.stringify(
    POOL.map((u) => ({ id: u.id, accessToken: u.accessToken, refreshToken: u.refreshToken })), null, 2));

  let reused = 0, refreshed = 0, created = 0;
  for (let i = 0; i < POOL_SIZE; i++) {
    const tag = `u${i}`;
    const c = cached[i];
    if (c?.accessToken && await tokenStillValid(c.accessToken)) {
      POOL.push(mkUser(tag, c.id, c.accessToken, c.refreshToken));
      reused++;
      save();
      continue;
    }
    const r = await refreshUser(c, tag);
    if (r) { POOL.push(r); refreshed++; save(); continue; }
    POOL.push(await signUpAnonRaw(tag));
    created++;
    save();
  }

  save();
  line(`pool of ${POOL_SIZE} anonymous users: ${reused} reused, ${refreshed} refreshed, ${created} newly signed up`);
}

// Distinct identities for one room, plus an outsider who is in none of them.
const takePlayers = (n) => POOL.slice(0, n);
const outsider = () => POOL[POOL_SIZE - 1];

async function callFn(user, name, body, method = "POST") {
  const res = await fetch(`${URL}/functions/v1/${name}`, {
    method,
    headers: user ? user.headers : { apikey: ANON, "Content-Type": "application/json" },
    body: method === "POST" ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed = null;
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

// --- room setup, done exactly the way a browser does it ---------------------
// Rooms and memberships are plain client INSERTs (0002 grants them); only the
// transitions go through edge functions. So this mirrors src/lib/rooms.ts.
async function buildRoom({ tier, players: n, lives, mode, avatars = [] }) {
  const players = takePlayers(n);
  const host = players[0];
  const roomId = crypto.randomUUID();
  const code = randCode();

  const payload = { id: roomId, code, tier, host_id: host.id, mode };
  if (lives !== undefined) payload.lives_setting = lives;

  const r = await rest(host, "rooms", { method: "POST", body: JSON.stringify(payload) });
  if (r.status >= 400) { line(`room create failed: ${JSON.stringify(r.body)}`); process.exit(1); }

  for (let i = 0; i < players.length; i++) {
    const row = { room_id: roomId, player_id: players[i].id, display_name: `p${i}` };
    if (avatars[i] !== undefined) row.avatar = avatars[i];
    const j = await rest(players[i], "room_players", { method: "POST", body: JSON.stringify(row) });
    if (j.status >= 400) { line(`join failed for p${i}: ${JSON.stringify(j.body)}`); process.exit(1); }
  }

  const name = (id) => { const i = players.findIndex((p) => p.id === id); return i < 0 ? String(id).slice(0, 8) : `p${i}`; };
  const byId = (id) => players.find((p) => p.id === id);
  return { roomId, code, players, host, name, byId };
}

// Reads below use a MEMBER's own token, never a service key — RLS lets a member
// read their own room's rows (0002), which is all a real client ever gets.
const roomRow = async (u, roomId) =>
  (await rest(u, `rooms?id=eq.${roomId}&select=status,mode,current_round,current_turn_player_id,table_streak,starting_players,winner_id,round_started_at,lives_setting`)).body[0];
const roster = async (u, roomId) =>
  (await rest(u, `room_players?room_id=eq.${roomId}&select=player_id,display_name,lives,is_eliminated,turn_order,score,avatar&order=turn_order`)).body;
const turnRow = async (u, roomId, n) =>
  (await rest(u, `round_results?room_id=eq.${roomId}&round_num=eq.${n}&select=round_num,word_id,turn_player_id,turn_started_at,round_seconds,outcome,winner_id,ended_at`)).body[0];
const wordFor = async (u, wordId) =>
  (await rest(u, `words?id=eq.${wordId}&select=word`)).body[0].word;

// ===========================================================================

async function section1() {
  line("=== 1. the new functions exist, authenticate, and validate their input ===");
  const u = POOL[0];

  const noAuth = await fetch(`${URL}/functions/v1/submit-turn`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
  });
  line(`  submit-turn with no Authorization header      -> HTTP ${noAuth.status}`);
  expect("an unauthenticated call is refused", noAuth.status === 401, String(noAuth.status));

  for (const fn of ["start-elimination-game", "submit-turn"]) {
    const g = await callFn(u, fn, null, "GET");
    line(`  ${fn.padEnd(24)} GET             -> HTTP ${g.status} ${g.body?.error ?? ""}`);
    expect(`${fn} is POST-only`, g.status === 405, JSON.stringify(g.body));

    const empty = await callFn(u, fn, {});
    line(`  ${fn.padEnd(24)} {}              -> HTTP ${empty.status} ${empty.body?.error ?? ""}`);
    expect(`${fn} rejects a missing room_id`, empty.status === 400 && empty.body?.error === "missing_room_id",
      JSON.stringify(empty.body));

    const ghost = await callFn(u, fn, { room_id: crypto.randomUUID(), round_num: 1, guess: "x" });
    line(`  ${fn.padEnd(24)} unknown room    -> HTTP ${ghost.status} ${ghost.body?.error ?? ""}`);
    expect(`${fn} maps room_not_found to 404`, ghost.status === 404 && ghost.body?.error === "room_not_found",
      JSON.stringify(ghost.body));
  }

  const badNum = await callFn(u, "submit-turn", { room_id: crypto.randomUUID(), guess: "x" });
  line(`  submit-turn missing round_num                 -> HTTP ${badNum.status} ${badNum.body?.error ?? ""}`);
  expect("submit-turn rejects a missing round_num",
    badNum.status === 400 && badNum.body?.error === "missing_round_num", JSON.stringify(badNum.body));

  // The whole security model: the SQL transitions are service_role only, so a
  // client holding an anon key must be unable to reach them except through the
  // functions above.
  line("\n  -- the underlying SQL functions stay unreachable to a client --");
  for (const [fn, args] of [
    ["start_elimination_game_tx", { p_room_id: crypto.randomUUID(), p_caller: u.id }],
    ["submit_turn_answer_tx", { p_room_id: crypto.randomUUID(), p_round_num: 1, p_player: u.id, p_guess: "x" }],
    ["timeout_turn_tx", { p_room_id: crypto.randomUUID(), p_expected_round: 1 }],
    ["sweep_expired_turns", {}],
  ]) {
    const r = await rest(u, `rpc/${fn}`, { method: "POST", body: JSON.stringify(args) });
    line(`  direct RPC ${fn.padEnd(26)} -> HTTP ${r.status} ${r.body?.code ?? ""}`);
    expect(`${fn} is not client-callable`, r.status === 403 || r.status === 404, JSON.stringify(r.body));
  }
}

async function section2() {
  line("\n=== 2. get_room_by_code() now reports mode and lives_setting ===");
  const elim = await buildRoom({ tier: "novice", players: 1, lives: 5, mode: "elimination" });
  const race = await buildRoom({ tier: "medium", players: 1, mode: "race" });

  // A NON-member resolves the code — the whole reason this function exists.
  const stranger = outsider();
  for (const [label, room, wantMode, wantLives] of [
    ["elimination", elim, "elimination", 5],
    ["race", race, "race", 3],
  ]) {
    const r = await rest(stranger, "rpc/get_room_by_code", {
      method: "POST", body: JSON.stringify({ p_code: room.code }),
    });
    const got = Array.isArray(r.body) ? r.body[0] : r.body;
    line(`  ${label.padEnd(12)} code ${room.code} -> ${JSON.stringify(got)}`);
    expect(`${label}: mode is reported`, got?.mode === wantMode, JSON.stringify(got));
    expect(`${label}: lives_setting is reported`, got?.lives_setting === wantLives, JSON.stringify(got));
    expect(`${label}: the original four columns still come back`,
      got?.id === room.roomId && typeof got?.status === "string" &&
      typeof got?.tier === "string" && Number.isInteger(got?.current_round), JSON.stringify(got));
    expect(`${label}: still leaks no host_id`, got?.host_id === undefined, JSON.stringify(got));
  }

  const miss = await rest(stranger, "rpc/get_room_by_code", {
    method: "POST", body: JSON.stringify({ p_code: "ZZZZZZ" }),
  });
  line(`  unknown code -> ${JSON.stringify(miss.body)}`);
  expect("an unknown code still returns nothing", Array.isArray(miss.body) && miss.body.length === 0,
    JSON.stringify(miss.body));
}

async function section3() {
  line("\n=== 3. avatars: preset set enforced, default applied, on the real join path ===");

  // Defaulted, explicitly chosen, and rejected — all through a plain client
  // INSERT, which is how a player actually joins (there is no join endpoint).
  const r = await buildRoom({
    tier: "novice", players: 2, lives: 3, mode: "elimination",
    avatars: [undefined, "queen"],
  });
  const rows = await roster(r.players[0], r.roomId);
  line(`  roster avatars: ${JSON.stringify(rows.map((p) => [p.display_name, p.avatar]))}`);
  expect("a joiner who chooses nothing gets the default 'bee'",
    rows.find((p) => p.display_name === "p0")?.avatar === "bee", JSON.stringify(rows));
  expect("a joiner may choose a preset key",
    rows.find((p) => p.display_name === "p1")?.avatar === "queen", JSON.stringify(rows));

  const intruder = outsider();
  const bad = await rest(intruder, "room_players", {
    method: "POST",
    body: JSON.stringify({ room_id: r.roomId, player_id: intruder.id, display_name: "x", avatar: "dragon" }),
  });
  line(`  joining with avatar='dragon' -> HTTP ${bad.status} ${bad.body?.message ?? ""}`);
  expect("an off-preset avatar is refused at insert time", bad.status >= 400, JSON.stringify(bad.body));

  const keys = await rest(r.players[0], "rpc/avatar_keys", { method: "POST", body: "{}" });
  line(`  avatar_keys() readable by a client: ${JSON.stringify(keys.body)}`);
  expect("the preset list has one definition, readable by the future picker",
    Array.isArray(keys.body) && keys.body.includes("bee") && keys.body.includes("queen"), JSON.stringify(keys.body));

  // The CHECK is the enforcement, so it holds on UPDATE too, not just INSERT.
  const upd = await rest(r.players[0], `room_players?room_id=eq.${r.roomId}&player_id=eq.${r.players[0].id}`, {
    method: "PATCH", body: JSON.stringify({ avatar: "wasp" }),
  });
  const updBad = await rest(r.players[0], `room_players?room_id=eq.${r.roomId}&player_id=eq.${r.players[0].id}`, {
    method: "PATCH", body: JSON.stringify({ avatar: "" }),
  });
  line(`  changing avatar to 'wasp' -> HTTP ${upd.status};  to '' -> HTTP ${updBad.status}`);
  expect("a player may change their own avatar to a preset key", upd.status < 300, JSON.stringify(upd.body));
  expect("an empty avatar is refused", updBad.status >= 400, JSON.stringify(updBad.body));
}

// Play one turn through the submit-turn EDGE FUNCTION as the real turn holder.
async function playTurn(ctx, answer) {
  const { roomId, players, byId, name } = ctx;
  const reader = players[0];
  const room = await roomRow(reader, roomId);
  const t = await turnRow(reader, roomId, room.current_round);
  const word = await wordFor(reader, t.word_id);
  const holder = byId(room.current_turn_player_id);
  const guess = answer === "correct" ? word : "not-the-word-at-all";

  const res = await callFn(holder, "submit-turn", {
    room_id: roomId, round_num: room.current_round, guess,
  });
  return { room, turn: t, word, holder: name(room.current_turn_player_id), status: res.status, res: res.body };
}

async function section4() {
  line("\n=== 4. a full elimination game, end to end, through the edge functions ===");
  const ctx = await buildRoom({ tier: "novice", players: 4, lives: 2, mode: "elimination" });
  const { roomId, players, name } = ctx;

  // Only the host may start, and only through the function.
  const notHost = await callFn(players[1], "start-elimination-game", { room_id: roomId });
  line(`  a non-host calls start-elimination-game -> HTTP ${notHost.status} ${notHost.body?.error ?? ""}`);
  expect("only the host may start", notHost.status === 403 && notHost.body?.error === "not_host",
    JSON.stringify(notHost.body));

  const start = await callFn(players[0], "start-elimination-game", { room_id: roomId });
  line(`  host starts -> HTTP ${start.status} ${JSON.stringify(start.body)}`);
  expect("the game starts through the edge function", start.status === 200 && start.body?.ok === true,
    JSON.stringify(start.body));
  expect("the opening turn's duration comes from the server", start.body?.round_seconds === 22,
    String(start.body?.round_seconds));
  expect("lives are dealt from lives_setting", start.body?.lives === 2, String(start.body?.lives));
  expect("starting_players is captured", start.body?.starting_players === 4, String(start.body?.starting_players));

  const again = await callFn(players[0], "start-elimination-game", { room_id: roomId });
  line(`  host starts a second time -> HTTP ${again.status} ${again.body?.error ?? ""}`);
  expect("starting twice is refused", again.status === 409 && again.body?.error === "already_started",
    JSON.stringify(again.body));

  const r0 = await roster(players[0], roomId);
  const rotation = r0.map((p) => `${p.turn_order}:${p.display_name}`);
  line(`  randomized rotation: ${JSON.stringify(rotation)}`);
  expect("all four players hold a distinct 0..3 slot",
    r0.every((p, i) => p.turn_order === i) && new Set(r0.map((p) => p.turn_order)).size === 4,
    JSON.stringify(r0));

  const room1 = await roomRow(players[0], roomId);
  expect("round_started_at stays NULL (the race-sweeper interlock)",
    room1.round_started_at === null, String(room1.round_started_at));

  // Out of turn, through the HTTP layer this time.
  const nonHolder = players.find((p) => p.id !== room1.current_turn_player_id);
  const t1 = await turnRow(players[0], roomId, 1);
  const oot = await callFn(nonHolder, "submit-turn", {
    room_id: roomId, round_num: 1, guess: await wordFor(players[0], t1.word_id),
  });
  line(`  ${name(nonHolder.id)} answers out of turn (with the CORRECT word) -> HTTP ${oot.status} ${oot.body?.error ?? ""}`);
  expect("out-of-turn is refused over HTTP too",
    oot.status === 409 && oot.body?.error === "not_your_turn", JSON.stringify(oot.body));

  // --- drive the game -------------------------------------------------------
  // Phase 1: correct answers until the table streak crosses BOTH decay stages,
  // so the decayed duration is observable coming back over HTTP.
  line("\n  -- phase 1: build the table streak and watch the turn shorten --");
  const seenDurations = [];
  for (let i = 0; i < 10; i++) {
    await sleep(1250);                       // the server-enforced feedback window
    const { holder, res, status } = await playTurn(ctx, "correct");
    if (status !== 200 || res?.ok !== true) { line(`  unexpected: HTTP ${status} ${JSON.stringify(res)}`); break; }
    seenDurations.push({ streak: res.table_streak, next: res.next_round_seconds });
    line(`  turn ${String(i + 1).padStart(2)}  ${holder} right  -> streak=${res.table_streak}` +
         `  next turn = ${res.next_round_seconds}s  (next: ${name(res.next_turn_player_id)})`);
    if (res.table_streak >= 9) break;
  }

  const atStreak4 = seenDurations.find((d) => d.streak === 4)?.next;
  const atStreak5 = seenDurations.find((d) => d.streak === 5)?.next;
  const atStreak9 = seenDurations.find((d) => d.streak === 9)?.next;
  line(`  durations by streak: streak 4 -> ${atStreak4}s, streak 5 -> ${atStreak5}s, streak 9 -> ${atStreak9}s`);
  expect("below stage 1 the turn is the full 22s", atStreak4 === 22, String(atStreak4));
  expect("streak stage 1 shortens it to 20s (22 x 0.90)", atStreak5 === 20, String(atStreak5));
  expect("streak stage 2 shortens it further to 17s (22 x 0.75)", atStreak9 === 17, String(atStreak9));
  expect("stage 2 is strictly harsher than stage 1, over HTTP", atStreak9 < atStreak5,
    `${atStreak9} vs ${atStreak5}`);

  // Phase 2: miss on purpose until only one player is left standing.
  line("\n  -- phase 2: miss until one player remains --");
  let finished = null;
  for (let i = 0; i < 40; i++) {
    await sleep(1250);
    const room = await roomRow(players[0], roomId);
    if (room.status !== "active") break;

    // Always let the CURRENT holder miss, so the field thins as fast as possible.
    const { holder, res, status } = await playTurn(ctx, "wrong");
    if (status !== 200) { line(`  unexpected: HTTP ${status} ${JSON.stringify(res)}`); break; }
    line(`  turn ${String(room.current_round).padStart(2)}  ${holder} WRONG  -> lives=${res.lives}` +
         ` eliminated=${res.eliminated} remaining=${res.remaining_players}` +
         (res.finished ? `  GAME OVER winner=${name(res.winner_id)} reason=${res.reason}`
                       : `  next turn = ${res.next_round_seconds}s (${name(res.next_turn_player_id)})`));
    if (res.finished) { finished = res; break; }
  }

  expect("the game finished through the edge functions", finished?.finished === true, JSON.stringify(finished));

  const finalRoom = await roomRow(players[0], roomId);
  const finalRoster = await roster(players[0], roomId);
  line(`\n  final room:   ${JSON.stringify(finalRoom)}`);
  line(`  final roster: ${JSON.stringify(finalRoster.map((p) => ({ n: p.display_name, lives: p.lives, out: p.is_eliminated, score: p.score })))}`);

  const alive = finalRoster.filter((p) => !p.is_eliminated);
  expect("room status is finished", finalRoom.status === "finished", finalRoom.status);
  expect("exactly one player survived", alive.length === 1, JSON.stringify(alive));
  expect("winner_id is that survivor", finalRoom.winner_id === alive[0]?.player_id,
    `${finalRoom.winner_id} vs ${alive[0]?.player_id}`);
  expect("no turn holder once it is over", finalRoom.current_turn_player_id === null,
    String(finalRoom.current_turn_player_id));
  expect("every eliminated player is at 0 lives",
    finalRoster.filter((p) => p.is_eliminated).every((p) => p.lives === 0), JSON.stringify(finalRoster));

  const late = await callFn(players[0], "submit-turn", { room_id: roomId, round_num: finalRoom.current_round, guess: "x" });
  line(`  submitting into the finished game -> HTTP ${late.status} ${late.body?.error ?? ""}`);
  expect("a finished game refuses submissions", late.status === 409 && late.body?.error === "room_not_active",
    JSON.stringify(late.body));
}

async function section5() {
  line("\n=== 5. the sweeper resolves an abandoned turn with NO client calling ===");
  // 'expert' has the shortest base (13s), so this is the quickest honest test.
  const ctx = await buildRoom({ tier: "expert", players: 3, lives: 3, mode: "elimination" });
  const { roomId, players, name } = ctx;

  const start = await callFn(players[0], "start-elimination-game", { room_id: roomId });
  const secs = start.body.round_seconds;
  const t0 = await turnRow(players[0], roomId, 1);
  line(`  turn 1 holder=${name(start.body.turn_player_id)}  round_seconds=${secs}s`);
  line(`  turn_started_at = ${t0.turn_started_at}`);
  line(`  NOBODY will call submit-turn. Only pg_cron can end this turn.`);

  const deadline = new Date(new Date(t0.turn_started_at).getTime() + secs * 1000);
  line(`  turn deadline   = ${deadline.toISOString()}  (+ late_grace_ms 750ms)`);

  const started = Date.now();
  let resolvedRow = null;
  // Budget: the turn itself, the 750ms grace, the 5s sweep tick, and slack.
  while (Date.now() - started < (secs + 15) * 1000) {
    await sleep(1000);
    const row = await turnRow(players[0], roomId, 1);
    if (row.ended_at) { resolvedRow = row; break; }
  }

  line(`\n  resolved turn row: ${JSON.stringify(resolvedRow)}`);
  expect("the abandoned turn was resolved by the sweeper", resolvedRow !== null, "still open after the budget");

  if (resolvedRow) {
    const startedAt = new Date(resolvedRow.turn_started_at).getTime();
    const endedAt = new Date(resolvedRow.ended_at).getTime();
    const elapsed = (endedAt - startedAt) / 1000;
    line(`  turn_started_at -> ended_at = ${elapsed.toFixed(2)}s  (limit ${secs}s + 0.75s grace, then a <=5s sweep tick)`);
    expect("it was recorded as a timeout, not a wrong answer",
      resolvedRow.outcome === "timeout", String(resolvedRow.outcome));
    expect("no winner on a timed-out turn", resolvedRow.winner_id === null, String(resolvedRow.winner_id));
    expect("the sweeper did not fire EARLY (deadline was genuinely respected)",
      elapsed >= secs, `${elapsed}s < ${secs}s`);
    expect("and it fired within one sweep tick of the deadline + grace",
      elapsed <= secs + 0.75 + 5 + 2.5, `${elapsed}s`);

    const rosterAfter = await roster(players[0], roomId);
    const victim = rosterAfter.find((p) => p.player_id === resolvedRow.turn_player_id);
    line(`  the abandoning player: ${JSON.stringify({ n: victim.display_name, lives: victim.lives, out: victim.is_eliminated })}`);
    expect("a swept timeout costs exactly one life, like a wrong answer",
      victim.lives === 2, String(victim.lives));

    const room = await roomRow(players[0], roomId);
    line(`  room advanced to round ${room.current_round}, holder now ${name(room.current_turn_player_id)}`);
    expect("the turn passed to the next player", room.current_round === 2, String(room.current_round));
    expect("the game is still running", room.status === "active", room.status);
    expect("round_started_at is STILL null after a sweep", room.round_started_at === null,
      String(room.round_started_at));
  }
}

async function section6() {
  line("\n=== 6. race mode (0006/9a) is completely unaffected ===");
  const ctx = await buildRoom({ tier: "easy", players: 2, mode: "race" });
  const { roomId, players } = ctx;

  const room0 = await roomRow(players[0], roomId);
  line(`  a room created with no mode specified defaults to '${room0.mode}'`);
  expect("mode still defaults to race", room0.mode === "race", room0.mode);

  const start = await callFn(players[0], "start-game", { room_id: roomId });
  line(`  start-game -> HTTP ${start.status} round=${start.body?.round_num} secs=${start.body?.round_seconds}s word='${start.body?.word}'`);
  expect("the 9a start-game function still works", start.status === 200 && start.body?.ok === true,
    JSON.stringify(start.body));
  expect("race rounds still use round_seconds(tier) = 20s for easy",
    start.body?.round_seconds === 20, String(start.body?.round_seconds));

  const roomAfter = await roomRow(players[0], roomId);
  line(`  race room writes round_started_at = ${roomAfter.round_started_at}`);
  expect("a race room DOES set round_started_at (unchanged 0006 behaviour)",
    roomAfter.round_started_at !== null, String(roomAfter.round_started_at));
  expect("and it has no turn holder", roomAfter.current_turn_player_id === null,
    String(roomAfter.current_turn_player_id));

  // Play the race game out through the 9a functions only.
  let rounds = 0, wins = 0, finishedRace = false;
  for (let i = 0; i < 12; i++) {
    const room = await roomRow(players[0], roomId);
    if (room.status !== "active") { finishedRace = true; break; }
    const rr = await turnRow(players[0], roomId, room.current_round);
    const word = await wordFor(players[0], rr.word_id);

    // Both players race; the faster correct answer takes the round.
    const [a, b] = await Promise.all([
      callFn(players[0], "submit-answer", { room_id: roomId, round_num: room.current_round, guess: word }),
      callFn(players[1], "submit-answer", { room_id: roomId, round_num: room.current_round, guess: word }),
    ]);
    const winners = [a, b].filter((r) => r.body?.won === true);
    rounds++;
    if (winners.length === 1) wins++;
    if (i === 0) line(`  round ${room.current_round}: two simultaneous correct answers -> exactly ${winners.length} winner`);

    await sleep(1200);
    const adv = await callFn(players[0], "advance-round", { room_id: roomId, round_num: room.current_round });
    if (adv.body?.finished) { finishedRace = true; break; }
  }
  line(`  played ${rounds} race rounds; exactly one winner in ${wins} of them; finished=${finishedRace}`);
  expect("every contested race round still had exactly one winner", wins === rounds, `${wins}/${rounds}`);
  expect("the race game still reaches a finish", finishedRace, "did not finish");

  const finalRace = await roomRow(players[0], roomId);
  line(`  final race room: ${JSON.stringify(finalRace)}`);
  expect("race game ends at rounds_per_game()=10", finalRace.status === "finished" && finalRace.current_round === 10,
    JSON.stringify(finalRace));
  expect("race mode never touches the elimination columns",
    finalRace.current_turn_player_id === null && finalRace.starting_players === null &&
    finalRace.table_streak === 0 && finalRace.winner_id === null, JSON.stringify(finalRace));

  // And the elimination entry point must refuse a race room outright.
  const cross = await callFn(players[0], "start-elimination-game", { room_id: roomId });
  line(`  start-elimination-game against a race room -> HTTP ${cross.status} ${cross.body?.error ?? ""}`);
  expect("the mode interlock holds at the HTTP layer",
    cross.status === 409 && cross.body?.error === "wrong_mode", JSON.stringify(cross.body));

  // --- the reverse direction, closed by 0015 -------------------------------
  // 0006 predated rooms.mode and checked nothing, so all three race endpoints
  // could be aimed at an elimination room. The worst was advance-round: its
  // "is the round over?" guard compares now() against round_started_at + limit,
  // which is NULL in an elimination room, so the guard failed OPEN and any
  // MEMBER could advance somebody else's turn. All three now refuse.
  line("\n  -- and the race endpoints refuse an ELIMINATION room (0015) --");
  const elimRoom = await buildRoom({ tier: "easy", players: 2, lives: 3, mode: "elimination" });

  const crossStart = await callFn(elimRoom.players[0], "start-game", { room_id: elimRoom.roomId });
  line(`  start-game    on an elimination room -> HTTP ${crossStart.status} ${crossStart.body?.error ?? ""}`);
  expect("start-game refuses an elimination room",
    crossStart.status === 409 && crossStart.body?.error === "wrong_mode", JSON.stringify(crossStart.body));

  // Start it properly, then aim the other two race endpoints at a live turn.
  const properStart = await callFn(elimRoom.players[0], "start-elimination-game", { room_id: elimRoom.roomId });
  expect("the elimination room still starts through its own endpoint",
    properStart.status === 200 && properStart.body?.ok === true, JSON.stringify(properStart.body));

  const crossSubmit = await callFn(elimRoom.players[0], "submit-answer", {
    room_id: elimRoom.roomId, round_num: 1, guess: properStart.body.word,
  });
  line(`  submit-answer on an elimination room -> HTTP ${crossSubmit.status} ${crossSubmit.body?.error ?? ""}`);
  expect("submit-answer refuses an elimination room (was a 500 NOT NULL abort)",
    crossSubmit.status === 409 && crossSubmit.body?.error === "wrong_mode", JSON.stringify(crossSubmit.body));

  // The non-host member tries it, since that was the actual exposure.
  const crossAdvance = await callFn(elimRoom.players[1], "advance-round", {
    room_id: elimRoom.roomId, round_num: 1,
  });
  line(`  advance-round on an elimination room, called by a NON-HOST member -> HTTP ${crossAdvance.status} ${crossAdvance.body?.error ?? ""}`);
  expect("advance-round refuses an elimination room (the fail-open guard)",
    crossAdvance.status === 409 && crossAdvance.body?.error === "wrong_mode", JSON.stringify(crossAdvance.body));

  const untouched = await roomRow(elimRoom.players[0], elimRoom.roomId);
  const turnStill = await turnRow(elimRoom.players[0], elimRoom.roomId, 1);
  line(`  elimination room after all three attempts: round=${untouched.current_round} holder=${elimRoom.name(untouched.current_turn_player_id)} round_started_at=${untouched.round_started_at} turn ended_at=${turnStill.ended_at}`);
  expect("the turn was not advanced by any of them",
    untouched.current_round === 1 && turnStill.ended_at === null, JSON.stringify(untouched));
  expect("and round_started_at was never written, so the room stays out of the race sweeper",
    untouched.round_started_at === null, String(untouched.round_started_at));
}

async function section7() {
  line("\n=== 7. the two sweepers are scheduled and cannot collide ===");

  // cron.job is not client-readable, so prove the property that matters instead:
  // the candidate sets are disjoint by construction. A race room always has
  // round_started_at set and mode='race'; an elimination room always has
  // round_started_at NULL and mode='elimination'.
  // 'expert' (13s) rather than 'easy' (20s) purely to keep the unattended wait
  // below short — the sweeper's behaviour does not depend on the tier.
  const race = await buildRoom({ tier: "expert", players: 2, mode: "race" });
  const raceStart = await callFn(race.players[0], "start-game", { room_id: race.roomId });
  const elim = await buildRoom({ tier: "expert", players: 2, lives: 3, mode: "elimination" });
  await callFn(elim.players[0], "start-elimination-game", { room_id: elim.roomId });

  const rRace = await roomRow(race.players[0], race.roomId);
  const rElim = await roomRow(elim.players[0], elim.roomId);
  line(`  race room:        mode=${rRace.mode}  round_started_at=${rRace.round_started_at !== null}`);
  line(`  elimination room: mode=${rElim.mode}  round_started_at=${rElim.round_started_at !== null}`);
  expect("0009 sweeps on round_started_at IS NOT NULL — only the race room qualifies",
    rRace.round_started_at !== null && rElim.round_started_at === null,
    `${rRace.round_started_at} / ${rElim.round_started_at}`);
  expect("0014 sweeps on mode='elimination' — only the elimination room qualifies",
    rRace.mode === "race" && rElim.mode === "elimination", `${rRace.mode} / ${rElim.mode}`);
  line("  -> no room can satisfy both predicates, so the two jobs never contend.");

  // Section 5 already proved the elimination sweeper actually fires; this just
  // confirms the race sweeper is still doing its own job unattended.
  line("\n  -- the 0009 race sweeper is still running (no client will advance this) --");
  const before = await roomRow(race.players[0], race.roomId);
  line(`  race room at round ${before.current_round}, waiting out its ${raceStart.body?.round_seconds}s round with no client...`);
  const t0 = Date.now();
  let advanced = false;
  while (Date.now() - t0 < 32000) {
    await sleep(1500);
    const now = await roomRow(race.players[0], race.roomId);
    if (now.current_round > before.current_round || now.status === "finished") { advanced = true; break; }
  }
  line(`  advanced unattended after ${((Date.now() - t0) / 1000).toFixed(1)}s: ${advanced}`);
  expect("the Session 10 race sweeper still advances rounds with nobody watching", advanced, "did not advance");
}

async function main() {
  if (!URL || !ANON) { line("missing VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY in .env.local"); process.exit(1); }

  await initPool();

  await section1();
  await section2();
  await section3();
  await section4();
  await section5();
  await section6();
  await section7();

  line(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
