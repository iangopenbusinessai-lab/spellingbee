import { useEffect, useState } from "react";
import { ArrowLeft } from "lucide-react";
import { getSupabase } from "../lib/supabaseClient";
import {
  fetchPlayers,
  fetchRoomHostId,
  startEliminationGame,
  startGame,
  subscribePlayers,
  updateAvatar,
  livesLabel,
  type PlayerRow,
  type RoomInfo,
} from "../lib/rooms";
import { coerceAvatar, type AvatarKey } from "../lib/avatars";
import { setAvatar as persistAvatar } from "../lib/storage";
import { AvatarBadge, AvatarPicker } from "./AvatarPicker";

import { TIER_META } from "../lib/tiers";

export function WaitingRoom({
  room,
  currentUserId,
  isHost,
  onLeave,
}: {
  room: RoomInfo;
  currentUserId: string;
  isHost: boolean;
  onLeave: () => void;
}) {
  const [players, setPlayers] = useState<PlayerRow[]>([]);
  const [hostId, setHostId] = useState<string | null>(isHost ? currentUserId : null);
  const [startMsg, setStartMsg] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    let active = true;
    const refresh = () => {
      fetchPlayers(room.id)
        .then((rows) => active && setPlayers(rows))
        .catch(() => {});
    };

    refresh();
    fetchRoomHostId(room.id)
      .then((id) => active && id && setHostId(id))
      .catch(() => {});

    // Live updates: any insert/delete/update on this room's players re-fetches
    // the list, so everyone sees people join and leave in real time.
    const channel = subscribePlayers(room.id, refresh);

    return () => {
      active = false;
      getSupabase().removeChannel(channel);
    };
  }, [room.id]);

  const canStart = isHost && players.length >= 2;
  const isElimination = room.mode === "elimination";

  // My current avatar comes from the roster rather than from local state, so it
  // reflects what the SERVER has — including a change made from another device.
  const myAvatar: AvatarKey = coerceAvatar(
    players.find((p) => p.player_id === currentUserId)?.avatar
  );

  async function handleAvatarChange(next: AvatarKey) {
    if (next === myAvatar) return;
    // Optimistic only for MY OWN row and only cosmetically: the authoritative
    // value still arrives via the realtime re-fetch below, and an off-list key
    // would be refused by the CHECK constraint before it ever got here.
    setPlayers((prev) =>
      prev.map((p) => (p.player_id === currentUserId ? { ...p, avatar: next } : p))
    );
    persistAvatar(next); // so the next room I join starts from this choice
    try {
      await updateAvatar(room.id, next);
    } catch {
      // Put the server's value back rather than leaving a lie on screen.
      fetchPlayers(room.id).then(setPlayers).catch(() => {});
    }
  }

  // Friendly text for the named errors either start endpoint can return.
  // Anything else is surfaced raw rather than swallowed.
  const START_ERRORS: Record<string, string> = {
    not_host: "Only the host can start the game.",
    not_enough_players: "You need at least 2 players to start.",
    already_started: "This game has already started.",
    no_words_for_tier: "No words available for this difficulty.",
    // Since 0015 each engine refuses the other's rooms. Reaching this would
    // mean the client picked the wrong endpoint for the room's mode.
    wrong_mode: "This room is set up for a different game mode.",
  };

  async function handleStart() {
    setStarting(true);
    setStartMsg(null);
    // The room's own mode chooses the endpoint — never a local toggle.
    const res = isElimination ? await startEliminationGame(room.id) : await startGame(room.id);
    setStarting(false);
    if (!res.ok) {
      setStartMsg(START_ERRORS[res.error ?? ""] ?? `Couldn't start the game: ${res.error}`);
    }
    // On success nothing happens here on purpose: the server flips the room to
    // 'active' and every client (including this one) is moved into round 1 by
    // the realtime subscription in useMultiplayerGame.
  }

  return (
    <div className="waiting-room">
      <button className="back-link" onClick={onLeave}>
        <ArrowLeft size={15} aria-hidden />
        Leave room
      </button>

      <h2>Waiting room</h2>

      <div className="room-code-block">
        <span className="room-code-label">Room code — share to invite</span>
        <span className="room-code">{room.code}</span>
        <span className="room-tier">{TIER_META[room.tier].label} words</span>
        {/* Both facts come off the room row, so everyone in the lobby — host
            and joiners alike — is looking at the same truth rather than at
            whatever each client happened to pick. */}
        <span className={`room-mode ${room.mode}`}>
          {isElimination ? `Elimination · ${livesLabel(room.livesSetting)} each` : "Race"}
        </span>
      </div>

      {isElimination && (
        <p className="hint">
          One player spells at a time. A miss or a timeout costs a life — last speller
          standing wins.
        </p>
      )}

      {/* Change your avatar without leaving the room. Same preset set as the
          lobby (lib/avatars.ts), same component — no second list, no new art.
          Everyone else sees the change over the existing room_players realtime
          subscription, which already re-fetches on any UPDATE. */}
      <AvatarPicker value={myAvatar} onChange={handleAvatarChange} label="Your avatar" />

      <div className="player-list">
        <span className="player-list-label">
          Players ({players.length})
        </span>
        <ul>
          {players.map((p) => {
            const isYou = p.player_id === currentUserId;
            const isRoomHost = hostId != null && p.player_id === hostId;
            return (
              <li key={p.player_id} className="player-row">
                <AvatarBadge avatar={coerceAvatar(p.avatar)} size={16} />
                <span className="player-name">{p.display_name}</span>
                <span className="player-tags">
                  {isRoomHost && <span className="tag tag-host">host</span>}
                  {isYou && <span className="tag tag-you">you</span>}
                </span>
              </li>
            );
          })}
          {players.length === 0 && <li className="player-empty">No one here yet…</li>}
        </ul>
      </div>

      {isHost && (
        <div className="host-controls">
          <button className="primary-btn" onClick={handleStart} disabled={!canStart || starting}>
            {starting ? "Starting…" : "Start game"}
          </button>
          {!canStart && (
            <p className="hint">Waiting for at least 2 players to start.</p>
          )}
          {startMsg && <p className="start-msg">{startMsg}</p>}
        </div>
      )}

      {!isHost && (
        <p className="hint">Waiting for the host to start the game…</p>
      )}
    </div>
  );
}
