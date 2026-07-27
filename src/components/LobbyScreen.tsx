import { useEffect, useState } from "react";
import { ArrowLeft } from "lucide-react";
import type { DifficultyTier } from "../types";
import { useSupabaseUser } from "../hooks/useSupabaseUser";
import {
  getAvatar,
  getDisplayName,
  setAvatar as persistAvatar,
  setDisplayName as persistDisplayName,
} from "../lib/storage";
import {
  createRoom,
  joinRoomByCode,
  previewRoomByCode,
  DEFAULT_LIVES,
  MAX_LIVES,
  MIN_LIVES,
  type RoomInfo,
  type RoomMode,
  livesLabel,
  type RoomPreview,
} from "../lib/rooms";
import { AvatarPicker } from "./AvatarPicker";

import { TIERS, TIER_META } from "../lib/tiers";

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
  const [avatar, setAvatar] = useState(() => getAvatar());
  const [tier, setTier] = useState<DifficultyTier>("medium");
  const [mode, setMode] = useState<RoomMode>("race");
  const [lives, setLives] = useState(DEFAULT_LIVES);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState<null | "create" | "join">(null);
  const [error, setError] = useState<string | null>(null);

  // What kind of room the typed code actually points at. Read from the widened
  // get_room_by_code() (Session 19's 0013) rather than guessed — the whole
  // reason that migration exists is so a joiner isn't told after committing.
  const [preview, setPreview] = useState<RoomPreview | null>(null);
  const [previewing, setPreviewing] = useState(false);

  const trimmedName = name.trim();
  const nameOk = trimmedName.length > 0;
  const trimmedCode = code.trim();

  // Debounced so a 6-character code costs one lookup, not six. Cancels cleanly
  // so a slow response for an old code can never overwrite a newer one.
  useEffect(() => {
    if (trimmedCode.length < 4) {
      setPreview(null);
      setPreviewing(false);
      return;
    }
    let active = true;
    setPreviewing(true);
    const t = window.setTimeout(() => {
      previewRoomByCode(trimmedCode)
        .then((p) => {
          if (!active) return;
          setPreview(p);
          setPreviewing(false);
        })
        .catch(() => {
          if (!active) return;
          setPreview(null);
          setPreviewing(false);
        });
    }, 350);
    return () => {
      active = false;
      window.clearTimeout(t);
    };
  }, [trimmedCode]);

  async function handleCreate() {
    if (!nameOk || busy) return;
    setBusy("create");
    setError(null);
    try {
      persistDisplayName(trimmedName);
      persistAvatar(avatar);
      const room = await createRoom({
        tier,
        displayName: trimmedName,
        avatar,
        mode,
        livesSetting: lives,
      });
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
      persistAvatar(avatar);
      const room = await joinRoomByCode(code, trimmedName, avatar);
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

      <AvatarPicker value={avatar} onChange={setAvatar} />

      <div className="lobby-panel">
        <h3>Create a room</h3>

        {/* Mode is a two-way choice, so two buttons rather than a select: it
            changes what the room IS, and it decides whether the lives control
            below is even meaningful. */}
        <div className="field">
          <span className="field-label" id="mode-label">Game mode</span>
          <div className="mode-toggle" role="radiogroup" aria-labelledby="mode-label">
            <button
              type="button"
              role="radio"
              aria-checked={mode === "race"}
              className={`mode-option${mode === "race" ? " selected" : ""}`}
              onClick={() => setMode("race")}
            >
              <span className="mode-name">Race</span>
              <span className="mode-blurb">Everyone spells at once — fastest correct wins</span>
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={mode === "elimination"}
              className={`mode-option${mode === "elimination" ? " selected" : ""}`}
              onClick={() => setMode("elimination")}
            >
              <span className="mode-name">Elimination</span>
              <span className="mode-blurb">One at a time — miss and lose a life</span>
            </button>
          </div>
        </div>

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

        {/* Only for elimination: a race room has a lives_setting column but the
            engine never reads it, so showing the control there would imply a
            rule that does not exist. */}
        {mode === "elimination" && (
          <label className="field">
            <span className="field-label">Lives each</span>
            <select
              className="text-input"
              value={lives}
              onChange={(e) => setLives(Number(e.target.value))}
            >
              {Array.from({ length: MAX_LIVES - MIN_LIVES + 1 }, (_, i) => MIN_LIVES + i).map(
                (n) => (
                  <option key={n} value={n}>
                    {livesLabel(n)}
                    {n === DEFAULT_LIVES ? " (default)" : ""}
                  </option>
                )
              )}
            </select>
          </label>
        )}

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

        {/* Tell them what they're walking into BEFORE they commit. */}
        {previewing && trimmedCode.length >= 4 && (
          <p className="hint">Looking up {trimmedCode}…</p>
        )}
        {!previewing && preview && (
          <div className={`room-preview ${preview.mode}`}>
            <span className="room-preview-mode">
              {preview.mode === "elimination" ? "Elimination" : "Race"}
            </span>
            <span className="room-preview-detail">
              {TIER_META[preview.tier].label}
              {preview.mode === "elimination" && ` · ${livesLabel(preview.livesSetting)} each`}
            </span>
            {preview.status !== "lobby" && (
              <span className="room-preview-warn">Already started</span>
            )}
          </div>
        )}
        {!previewing && !preview && trimmedCode.length >= 4 && (
          <p className="hint">No open room with that code.</p>
        )}

        <button
          className="primary-btn"
          onClick={handleJoin}
          disabled={!nameOk || trimmedCode.length === 0 || busy !== null}
        >
          {busy === "join" ? "Joining…" : "Join room"}
        </button>
      </div>

      {!nameOk && <p className="hint">Enter a name to create or join a room.</p>}
      {error && <p className="lobby-error">{error}</p>}
    </div>
  );
}
