import { useEffect, useState } from "react";
import { ArrowLeft } from "lucide-react";
import { getSupabase } from "../lib/supabaseClient";
import {
  fetchPlayers,
  fetchRoomHostId,
  startGame,
  subscribePlayers,
  type PlayerRow,
  type RoomInfo,
} from "../lib/rooms";

const TIER_LABEL: Record<RoomInfo["tier"], string> = {
  easy: "Easy",
  medium: "Medium",
  hard: "Hard",
  expert: "Expert",
};

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

  // Friendly text for the named errors start-game can return. Anything else is
  // surfaced raw rather than swallowed.
  const START_ERRORS: Record<string, string> = {
    not_host: "Only the host can start the game.",
    not_enough_players: "You need at least 2 players to start.",
    already_started: "This game has already started.",
    no_words_for_tier: "No words available for this difficulty.",
  };

  async function handleStart() {
    setStarting(true);
    setStartMsg(null);
    const res = await startGame(room.id);
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
        <span className="room-tier">{TIER_LABEL[room.tier]} words</span>
      </div>

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
