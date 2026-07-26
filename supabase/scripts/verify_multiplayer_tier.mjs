// verify_multiplayer_tier.mjs — plays a REAL multiplayer game end to end against
// the live project, on whichever tier you name, and asserts it reaches game-over
// after a full rounds_per_game() rather than exhausting the tier's words early.
//
//   node supabase/scripts/verify_multiplayer_tier.mjs master
//
// Written in Session 16 because Session 15's sparse placeholder tiers finished
// at 8 of 10 rounds when pick_unused_word ran dry. With ~150 words per tier that
// must no longer happen.
//
// Anon key only, two real anonymous users, the same edge functions a browser
// calls. Deliberately server-side: it verifies the round engine, not the UI, and
// so is unaffected by browser tab throttling.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const tier = process.argv[2] ?? "master";

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const randCode = () =>
  Array.from({ length: 6 }, () => "ABCDEFGHJKMNPQRSTUVWXYZ23456789"[Math.floor(Math.random() * 31)]).join("");

async function signUpAnon(tag) {
  const s = await fetch(`${URL_}/auth/v1/signup`, {
    method: "POST",
    headers: { apikey: ANON, "Content-Type": "application/json" },
    body: JSON.stringify({ data: {} }),
  }).then((r) => r.json());
  if (!s.access_token) { console.error(`sign-in failed for ${tag}`); process.exit(1); }
  return { tag, id: s.user.id, headers: { apikey: ANON, Authorization: `Bearer ${s.access_token}`, "Content-Type": "application/json" } };
}
const rest = async (u, path, init = {}) => {
  const res = await fetch(`${URL_}/rest/v1/${path}`, { ...init, headers: { ...u.headers, ...(init.headers ?? {}) } });
  const text = await res.text();
  let body = null; try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body };
};
const callFn = async (u, name, payload) => {
  const res = await fetch(`${URL_}/functions/v1/${name}`, { method: "POST", headers: u.headers, body: JSON.stringify(payload) });
  const text = await res.text();
  let body = null; try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body };
};

let failures = 0;
const expect = (label, cond, detail = "") => {
  if (cond) console.log(`   PASS  ${label}`);
  else { failures++; console.log(`   FAIL  ${label}  ${detail}`); }
};

console.log(`=== multiplayer end-to-end on tier "${tier}" ===\n`);

const host = await signUpAnon("host");
const guest = await signUpAnon("guest");
const roomId = crypto.randomUUID();
const code = randCode();

await rest(host, "rooms", {
  method: "POST", headers: { Prefer: "return=minimal" },
  body: JSON.stringify({ id: roomId, code, tier, host_id: host.id }),
});
await rest(host, "room_players", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ room_id: roomId, player_id: host.id, display_name: "host" }) });
await rest(guest, "room_players", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ room_id: roomId, player_id: guest.id, display_name: "guest" }) });
console.log(`room ${code} (${roomId}) tier=${tier}`);

const perGame = (await rest(host, "rpc/rounds_per_game", { method: "POST", body: "{}" })).body;
console.log(`rounds_per_game() = ${perGame}\n`);

const start = await callFn(host, "start-game", { room_id: roomId });
expect("start-game accepted", start.status === 200, JSON.stringify(start.body));

const wordsSeen = [];
let lastRound = 0;
for (let i = 0; i < 240; i++) {
  const room = (await rest(host, `rooms?id=eq.${roomId}&select=status,current_round`)).body?.[0];
  if (!room) break;
  if (room.status === "finished") break;

  if (room.current_round > lastRound) {
    lastRound = room.current_round;
    // Read the round's word (members may read round_results) and answer it, so
    // the round ends on a winner instead of waiting out the server clock.
    const rr = (await rest(host, `round_results?room_id=eq.${roomId}&round_num=eq.${room.current_round}&select=word_id`)).body?.[0];
    if (rr?.word_id) {
      const w = (await rest(host, `words?id=eq.${rr.word_id}&select=word,tier`)).body?.[0];
      if (w) {
        wordsSeen.push(w.word);
        await callFn(host, "submit-answer", { room_id: roomId, round_num: room.current_round, guess: w.word });
      }
    }
  }
  await sleep(700);
}

const final = (await rest(host, `rooms?id=eq.${roomId}&select=status,current_round`)).body?.[0];
const rounds = (await rest(host, `round_results?room_id=eq.${roomId}&select=round_num,word_id`)).body ?? [];

console.log(`\nfinal room status = ${final?.status}, current_round = ${final?.current_round}`);
console.log(`round_results rows = ${rounds.length}`);
console.log(`words played (${wordsSeen.length}): ${wordsSeen.join(", ")}`);

expect("game reached 'finished'", final?.status === "finished", `status=${final?.status}`);
expect(
  `played a full ${perGame} rounds (Session 15's placeholder tiers stopped at 8)`,
  rounds.length >= perGame,
  `only ${rounds.length} rounds`
);
expect("every word was distinct", new Set(wordsSeen).size === wordsSeen.length);

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
