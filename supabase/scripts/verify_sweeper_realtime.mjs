// verify_sweeper_realtime.mjs — proves clients learn about SWEEPER-driven round
// advancement over the same Realtime subscription they already use (Session 10).
//
//   node supabase/scripts/verify_sweeper_realtime.mjs
//
// This should hold by construction: the sweeper calls advance_round_tx, the
// same function a client's advance-round call reaches, so the underlying writes
// to rooms and round_results are identical and logical replication doesn't care
// which backend produced them. But "should hold" isn't verification — a cron
// background worker is a different execution context, so this subscribes with a
// real anonymous user's session and watches.
//
// The critical part: this script NEVER calls advance-round. Every event it
// receives was therefore triggered by the pg_cron sweeper alone.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createClient } from "@supabase/supabase-js";

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

async function main() {
  // Two members: the host client (which subscribes) and a second player so the
  // game is startable.
  const host = createClient(URL, ANON);
  const guest = createClient(URL, ANON);
  const { data: h } = await host.auth.signInAnonymously();
  const { data: g } = await guest.auth.signInAnonymously();
  if (!h?.user || !g?.user) { line("anon sign-in failed"); process.exit(1); }

  const roomId = crypto.randomUUID();
  const code = randCode();
  line(`=== setup: room ${code} (${roomId}) ===`);

  await host.from("rooms").insert({ id: roomId, code, tier: "medium", host_id: h.user.id });
  await host.from("room_players").insert({ room_id: roomId, player_id: h.user.id, display_name: "host" });
  await guest.from("room_players").insert({ room_id: roomId, player_id: g.user.id, display_name: "guest" });

  // Subscribe exactly the way useMultiplayerGame does (migrations 0004/0007).
  const events = [];
  const channel = host
    .channel(`mp-verify:${roomId}`)
    .on("postgres_changes", { event: "*", schema: "public", table: "rooms", filter: `id=eq.${roomId}` },
      (p) => events.push({ at: new Date().toISOString().slice(11, 23), table: "rooms", type: p.eventType, current_round: p.new?.current_round, status: p.new?.status }))
    .on("postgres_changes", { event: "*", schema: "public", table: "round_results", filter: `room_id=eq.${roomId}` },
      (p) => events.push({ at: new Date().toISOString().slice(11, 23), table: "round_results", type: p.eventType, round_num: p.new?.round_num, word_id: p.new?.word_id }));

  await new Promise((resolve, reject) => {
    channel.subscribe((status) => {
      line(`realtime channel: ${status}`);
      if (status === "SUBSCRIBED") resolve();
      if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") reject(new Error(status));
    });
    setTimeout(() => reject(new Error("subscribe timeout")), 15000);
  });

  // Start the game via the edge function (this is the ONLY game action taken).
  const { data: sess } = await host.auth.getSession();
  const startRes = await fetch(`${URL}/functions/v1/start-game`, {
    method: "POST",
    headers: { apikey: ANON, Authorization: `Bearer ${sess.session.access_token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ room_id: roomId }),
  });
  const started = await startRes.json();
  line(`start-game HTTP ${startRes.status} round=${started.round_num} word=${started.word}`);
  const startedEventCount = events.length;

  line("\n=== now idle for 50s — NO advance-round is ever called from here ===");
  line("(any further events must come from the pg_cron sweeper)");
  await sleep(50000);

  await host.removeChannel(channel);

  const afterStart = events.slice(startedEventCount);
  line(`\nevents received after start-game (${afterStart.length}):`);
  for (const e of afterStart) line(`  ${JSON.stringify(e)}`);

  const roomAdvances = afterStart.filter((e) => e.table === "rooms" && e.current_round > 1);
  const newRounds = afterStart.filter((e) => e.table === "round_results" && e.type === "INSERT" && e.round_num > 1);

  expect("client received rooms updates for sweeper-driven advancement", roomAdvances.length > 0,
    `got ${roomAdvances.length}`);
  expect("client received round_results INSERTs (the next word) from the sweeper", newRounds.length > 0,
    `got ${newRounds.length}`);

  // Cross-check the stream against the table: whatever the DB says the round is,
  // the subscriber should have seen it.
  const { data: rm } = await host.from("rooms").select("current_round,status").eq("id", roomId).maybeSingle();
  const maxSeen = Math.max(0, ...afterStart.filter((e) => e.table === "rooms").map((e) => e.current_round ?? 0));
  line(`\ndb says current_round=${rm?.current_round} status=${rm?.status}; highest round seen over realtime=${maxSeen}`);
  expect("realtime kept up with the database (no missed advancement)", maxSeen === rm?.current_round,
    `seen=${maxSeen} db=${rm?.current_round}`);

  line(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
