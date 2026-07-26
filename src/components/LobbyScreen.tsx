import { useState } from "react";
import { ArrowLeft } from "lucide-react";
import type { DifficultyTier } from "../types";
import { useSupabaseUser } from "../hooks/useSupabaseUser";
import { getDisplayName, setDisplayName as persistDisplayName } from "../lib/storage";
import { createRoom, joinRoomByCode, type RoomInfo } from "../lib/rooms";

import { TIERS } from "../lib/tiers";

// The lobby now only gets you INTO a room; the room itself (waiting room, then
// the game) is owned by App, which runs useMultiplayerGame for it. That keeps
// the game-state hook at the same level as useGameEngine rather than buried
// inside a screen component.
export function LobbyScreen({
  onExitToModes,
  onEnterRoom,
}: {
  onExitToModes: () => void;
  onEnterRoom: (room: RoomInfo, isHost: boolean) => void;
}) {
  const { userId, ready, error: authError } = useSupabaseUser();

  const [name, setName] = useState(() => getDisplayName());
  const [tier, setTier] = useState<DifficultyTier>("medium");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState<null | "create" | "join">(null);
  const [error, setError] = useState<string | null>(null);

  const trimmedName = name.trim();
  const nameOk = trimmedName.length > 0;

  async function handleCreate() {
    if (!nameOk || busy) return;
    setBusy("create");
    setError(null);
    try {
      persistDisplayName(trimmedName);
      const room = await createRoom(tier, trimmedName);
      onEnterRoom(room, true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function handleJoin() {
    if (!nameOk || busy) return;
    setBusy("join");
    setError(null);
    try {
      persistDisplayName(trimmedName);
      const room = await joinRoomByCode(code, trimmedName);
      onEnterRoom(room, false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  if (!ready) {
    return <div className="lobby"><p className="lobby-status">Connecting…</p></div>;
  }

  if (authError || !userId) {
    return (
      <div className="lobby">
        <button className="back-link" onClick={onExitToModes}>
          <ArrowLeft size={15} aria-hidden />
          Modes
        </button>
        <p className="lobby-error">Couldn't sign in: {authError ?? "unknown error"}</p>
      </div>
    );
  }

  return (
    <div className="lobby">
      <button className="back-link" onClick={onExitToModes}>
        <ArrowLeft size={15} aria-hidden />
        Modes
      </button>
      <h2>Multiplayer</h2>

      <label className="field">
        <span className="field-label">Your name</span>
        <input
          className="text-input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={24}
          placeholder="e.g. Alex"
          autoComplete="off"
        />
      </label>

      <div className="lobby-panel">
        <h3>Create a room</h3>
        <label className="field">
          <span className="field-label">Difficulty</span>
          <select
            className="text-input"
            value={tier}
            onChange={(e) => setTier(e.target.value as DifficultyTier)}
          >
            {TIERS.map((t) => (
              <option key={t.id} value={t.id}>{t.label}</option>
            ))}
          </select>
        </label>
        <button
          className="primary-btn"
          onClick={handleCreate}
          disabled={!nameOk || busy !== null}
        >
          {busy === "create" ? "Creating…" : "Create room"}
        </button>
      </div>

      <div className="lobby-divider">or</div>

      <div className="lobby-panel">
        <h3>Join a room</h3>
        <label className="field">
          <span className="field-label">Room code</span>
          <input
            className="text-input code-input"
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            maxLength={6}
            placeholder="ABC123"
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
          />
        </label>
        <button
          className="primary-btn"
          onClick={handleJoin}
          disabled={!nameOk || code.trim().length === 0 || busy !== null}
        >
          {busy === "join" ? "Joining…" : "Join room"}
        </button>
      </div>

      {!nameOk && <p className="hint">Enter a name to create or join a room.</p>}
      {error && <p className="lobby-error">{error}</p>}
    </div>
  );
}
