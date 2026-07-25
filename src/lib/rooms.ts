import type { RealtimeChannel } from "@supabase/supabase-js";
import type { DifficultyTier } from "../types";
import { getSupabase } from "./supabaseClient";

// --- shapes (kept out of src/types.ts so the core GameState contract is
// untouched; these describe backend rows, not singleplayer game state) --------
export type RoomStatus = "lobby" | "active" | "finished";

export interface RoomInfo {
  id: string;
  code: string;
  tier: DifficultyTier;
  status: RoomStatus;
}

export interface PlayerRow {
  room_id: string;
  player_id: string;
  display_name: string;
  score: number;
  streak: number;
  connected_at: string;
}

// Best-effort lobby cap. Hard, race-free enforcement belongs in the Session 9
// edge function (a client can't atomically reserve a slot); here we join then
// back out if our join tipped the room over this number.
export const PLAYER_CAP = 8;

// Unambiguous charset (no 0/O/1/I/L) so codes are easy to read aloud/share.
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 6;

function generateCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(CODE_LENGTH));
  let out = "";
  for (const b of bytes) out += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return out;
}

async function requireUid(): Promise<string> {
  const { data } = await getSupabase().auth.getUser();
  const uid = data.user?.id;
  if (!uid) throw new Error("You're not signed in yet — try again in a moment.");
  return uid;
}

// Create a room I host and join it as the first player. We generate the room id
// client-side because the member-only SELECT policy on rooms blocks reading the
// row back before we've joined (confirmed in Session 7b), so insert uses
// return=minimal and we trust the ids we made.
export async function createRoom(tier: DifficultyTier, displayName: string): Promise<RoomInfo> {
  const uid = await requireUid();

  for (let attempt = 0; attempt < 5; attempt++) {
    const id = crypto.randomUUID();
    const code = generateCode();

    const { error } = await getSupabase().from("rooms").insert({ id, code, tier, host_id: uid });
    if (error) {
      if (error.code === "23505") continue; // code/id collision — retry a new code
      throw error;
    }

    const { error: joinErr } = await getSupabase()
      .from("room_players")
      .insert({ room_id: id, player_id: uid, display_name: displayName });
    if (joinErr) throw joinErr;

    return { id, code, tier, status: "lobby" };
  }
  throw new Error("Couldn't generate a free room code — please try again.");
}

// Join an existing room by its short code. Non-members can't SELECT rooms, so we
// resolve the code through the get_room_by_code() security-definer RPC (which
// returns only lobby/active rooms and never leaks host_id), then insert our own
// membership row.
export async function joinRoomByCode(rawCode: string, displayName: string): Promise<RoomInfo> {
  const code = rawCode.trim().toUpperCase();
  if (!code) throw new Error("Enter a room code.");
  const uid = await requireUid();

  const { data, error } = await getSupabase().rpc("get_room_by_code", { p_code: code });
  if (error) throw error;
  const room = Array.isArray(data) ? data[0] : data;
  if (!room) throw new Error("No open room with that code.");
  if (room.status !== "lobby") throw new Error("That room's game has already started.");

  const { error: joinErr } = await getSupabase()
    .from("room_players")
    .insert({ room_id: room.id, player_id: uid, display_name: displayName });
  // 23505 = we already have a row in this room (re-join) — that's fine.
  if (joinErr && joinErr.code !== "23505") throw joinErr;

  // Best-effort capacity: we can only count once we're a member, so join first
  // then back out (self-leave delete) if we pushed the room past the cap.
  const { count } = await getSupabase()
    .from("room_players")
    .select("*", { count: "exact", head: true })
    .eq("room_id", room.id);
  if ((count ?? 0) > PLAYER_CAP) {
    await leaveRoom(room.id);
    throw new Error(`That room is full (max ${PLAYER_CAP} players).`);
  }

  return { id: room.id, code, tier: room.tier as DifficultyTier, status: room.status };
}

// Leave a lobby by deleting our own room_players row. Allowed by the narrow
// self-leave policy (0005) only while the room is in 'lobby' status.
export async function leaveRoom(roomId: string): Promise<void> {
  const { data } = await getSupabase().auth.getUser();
  const uid = data.user?.id;
  if (!uid) return;
  const { error } = await getSupabase()
    .from("room_players")
    .delete()
    .eq("room_id", roomId)
    .eq("player_id", uid);
  if (error) throw error;
}

export async function fetchPlayers(roomId: string): Promise<PlayerRow[]> {
  const { data, error } = await getSupabase()
    .from("room_players")
    .select("room_id,player_id,display_name,score,streak,connected_at")
    .eq("room_id", roomId)
    .order("connected_at", { ascending: true });
  if (error) throw error;
  return (data ?? []) as PlayerRow[];
}

// The host_id, readable by room members (unlike via get_room_by_code), so the
// waiting room can mark who the host is.
export async function fetchRoomHostId(roomId: string): Promise<string | null> {
  const { data, error } = await getSupabase()
    .from("rooms")
    .select("host_id")
    .eq("id", roomId)
    .maybeSingle();
  if (error) throw error;
  return data?.host_id ?? null;
}

// Live player-list subscription. RLS scopes the stream to this room (members
// only). Caller re-fetches the list on each change and unsubscribes on unmount.
export function subscribePlayers(roomId: string, onChange: () => void): RealtimeChannel {
  return getSupabase()
    .channel(`room_players:${roomId}`)
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "room_players", filter: `room_id=eq.${roomId}` },
      () => onChange()
    )
    .subscribe();
}

// --- edge-function calls (server-authoritative round engine, Session 9a) -----
//
// rooms.status, room_players.score and round_results are all edge-function-only
// writes; RLS blocks the client from touching them directly and MUST keep doing
// so. Everything below goes through an edge function, which verifies the
// caller's token and then runs one of the atomic plpgsql transitions in
// migration 0006.

export interface EdgeResult<T = Record<string, unknown>> {
  ok: boolean;
  /** Named error from the function (e.g. "not_host", "stale_round"), if it failed. */
  error: string | null;
  status: number;
  data: T | null;
}

async function callEdge<T = Record<string, unknown>>(
  name: string,
  body: Record<string, unknown>
): Promise<EdgeResult<T>> {
  const supabase = getSupabase();
  const { data: sessionData } = await supabase.auth.getSession();
  const token = sessionData.session?.access_token;
  if (!token) {
    return { ok: false, error: "not_signed_in", status: 401, data: null };
  }

  const url = import.meta.env.VITE_SUPABASE_URL;
  const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

  const res = await fetch(`${url}/functions/v1/${name}`, {
    method: "POST",
    headers: {
      apikey: anonKey,
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = (await res.json()) as Record<string, unknown>;
  } catch {
    parsed = null;
  }

  if (!res.ok) {
    const err = typeof parsed?.error === "string" ? parsed.error : `http_${res.status}`;
    return { ok: false, error: err, status: res.status, data: parsed as T | null };
  }
  return { ok: true, error: null, status: res.status, data: parsed as T | null };
}

export interface RoundStartPayload {
  round_num: number;
  word: string;
  round_started_at: string;
  round_seconds: number;
  tier: DifficultyTier;
}

/**
 * Host-only: begin the game.
 *
 * Was a stub through Session 8 because rooms.status is not client-writable.
 * The 'start-game' edge function (Session 9a) is the real path: it verifies
 * from the caller's token that they are the room's host, requires 2+ players,
 * picks round 1's word server-side and starts the server clock.
 */
export async function startGame(roomId: string): Promise<EdgeResult<RoundStartPayload>> {
  return callEdge<RoundStartPayload>("start-game", { room_id: roomId });
}

export interface SubmitAnswerPayload {
  correct: boolean;
  won: boolean;
  points?: number;
  streak?: number;
  response_time_ms: number;
}

/**
 * Submit an answer for the current round.
 *
 * Deliberately sends only the raw guess: correctness is decided server-side
 * against the round's word, and the response time is measured from the server's
 * own round start to its receipt of this call. The client never computes or
 * reports either.
 */
export async function submitAnswer(
  roomId: string,
  roundNum: number,
  guess: string
): Promise<EdgeResult<SubmitAnswerPayload>> {
  return callEdge<SubmitAnswerPayload>("submit-answer", {
    room_id: roomId,
    round_num: roundNum,
    guess,
  });
}

export interface AdvanceRoundPayload {
  advanced: boolean;
  finished: boolean;
  round_num?: number;
  word?: string;
  round_started_at?: string;
  round_seconds?: number;
  previous_winner_id?: string | null;
}

/**
 * Ask the server to move past the current round.
 *
 * Callable by any member; the server ignores the caller's opinion about whether
 * the round is over and re-derives it from its own clock, so an early call is
 * rejected with 409 round_in_progress. Expected-and-harmless failures
 * ("round_in_progress", "already_advanced") are normal in a room where several
 * clients ask at once.
 */
export async function advanceRound(
  roomId: string,
  roundNum: number
): Promise<EdgeResult<AdvanceRoundPayload>> {
  return callEdge<AdvanceRoundPayload>("advance-round", {
    room_id: roomId,
    round_num: roundNum,
  });
}
