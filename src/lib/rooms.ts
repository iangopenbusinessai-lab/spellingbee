import type { RealtimeChannel } from "@supabase/supabase-js";
import type { DifficultyTier } from "../types";
import { supabase } from "./supabaseClient";

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
  const { data } = await supabase.auth.getUser();
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

    const { error } = await supabase.from("rooms").insert({ id, code, tier, host_id: uid });
    if (error) {
      if (error.code === "23505") continue; // code/id collision — retry a new code
      throw error;
    }

    const { error: joinErr } = await supabase
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

  const { data, error } = await supabase.rpc("get_room_by_code", { p_code: code });
  if (error) throw error;
  const room = Array.isArray(data) ? data[0] : data;
  if (!room) throw new Error("No open room with that code.");
  if (room.status !== "lobby") throw new Error("That room's game has already started.");

  const { error: joinErr } = await supabase
    .from("room_players")
    .insert({ room_id: room.id, player_id: uid, display_name: displayName });
  // 23505 = we already have a row in this room (re-join) — that's fine.
  if (joinErr && joinErr.code !== "23505") throw joinErr;

  // Best-effort capacity: we can only count once we're a member, so join first
  // then back out (self-leave delete) if we pushed the room past the cap.
  const { count } = await supabase
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
  const { data } = await supabase.auth.getUser();
  const uid = data.user?.id;
  if (!uid) return;
  const { error } = await supabase
    .from("room_players")
    .delete()
    .eq("room_id", roomId)
    .eq("player_id", uid);
  if (error) throw error;
}

export async function fetchPlayers(roomId: string): Promise<PlayerRow[]> {
  const { data, error } = await supabase
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
  const { data, error } = await supabase
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
  return supabase
    .channel(`room_players:${roomId}`)
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "room_players", filter: `room_id=eq.${roomId}` },
      () => onChange()
    )
    .subscribe();
}

// TODO(session-9): advancing a room to 'active' is a server-authoritative
// action. Direct client writes to rooms.status are blocked by RLS (verified in
// Session 7b) and MUST stay blocked — the real implementation will call a
// Supabase edge function ('start-game') that flips status and seeds round 1 with
// the service role. Until that exists this is a STUB: it attempts the write so
// the RLS block is surfaced to the user rather than silently no-oping, and never
// pretends the game started.
export async function startGame(roomId: string): Promise<{ started: boolean; blockedError: string | null }> {
  const { error } = await supabase.from("rooms").update({ status: "active" }).eq("id", roomId);
  if (error) {
    return { started: false, blockedError: `${error.code ?? ""} ${error.message}`.trim() };
  }
  // Unreachable while RLS blocks the write; guard against a future policy change
  // masking the missing edge function.
  return { started: false, blockedError: "Direct write unexpectedly succeeded; edge function still not implemented." };
}
