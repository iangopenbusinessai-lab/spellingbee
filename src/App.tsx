import { useEffect, useState } from "react";
import "./App.css";
import { ModeSelect } from "./components/ModeSelect";
import { DifficultySelect } from "./components/DifficultySelect";
import { RoundScreen } from "./components/RoundScreen";
import { ResultsScreen } from "./components/ResultsScreen";
import { LobbyScreen } from "./components/LobbyScreen";
import { WaitingRoom } from "./components/WaitingRoom";
import { useGameEngine } from "./hooks/useGameEngine";
import { useMultiplayerGame } from "./hooks/useMultiplayerGame";
import type { DifficultyTier } from "./types";
import { getAllBests, setBest } from "./lib/storage";
import { leaveRoom, type RoomInfo } from "./lib/rooms";

// Top-level mode: null = pick a mode; "single" = the existing singleplayer flow
// (untouched); "multi" = the new lobby. Additive — singleplayer's idle/playing/
// finished states are unchanged.
type Mode = "single" | "multi" | null;

function App() {
  const [mode, setMode] = useState<Mode>(null);
  const { state, startGame, submitGuess, skipWord, resetToMenu } = useGameEngine();
  const [bests, setBests] = useState<Record<DifficultyTier, number>>(() => getAllBests());

  // The multiplayer room we're in, if any. Held here rather than inside the
  // lobby so the multiplayer engine lives at the same level as the singleplayer
  // one — both satisfy GameEngineApi, and the screens below can't tell which
  // one produced the GameState they're handed.
  const [mpRoom, setMpRoom] = useState<{ room: RoomInfo; isHost: boolean } | null>(null);
  const mp = useMultiplayerGame(mpRoom?.room.id ?? null);

  async function handleLeaveRoom() {
    if (mpRoom) {
      try {
        await leaveRoom(mpRoom.room.id);
      } catch {
        // Leaving mid-game is blocked by RLS on purpose (migration 0005 permits
        // self-delete only while the room is still in 'lobby'), so the row stays
        // and the scoreboard keeps their final score. Either way we drop this
        // client back to the lobby rather than trapping them in the room.
      }
    }
    mp.resetToMenu();
    setMpRoom(null);
  }

  useEffect(() => {
    if (state.status !== "finished" || !state.tier) return;
    const tier = state.tier;
    if (state.score > bests[tier]) {
      setBest(tier, state.score);
      setBests((prev) => ({ ...prev, [tier]: state.score }));
    }
  }, [state.status, state.tier, state.score, bests]);

  if (mode === null) {
    return (
      <div className="app-shell">
        <ModeSelect onSingle={() => setMode("single")} onMulti={() => setMode("multi")} />
      </div>
    );
  }

  if (mode === "multi") {
    // Not in a room yet -> the lobby.
    if (!mpRoom) {
      return (
        <div className="app-shell">
          <LobbyScreen
            onExitToModes={() => setMode(null)}
            onEnterRoom={(room, isHost) => setMpRoom({ room, isHost })}
          />
        </div>
      );
    }

    // In a room. Which screen is decided entirely by the server-driven
    // GameState, exactly as the singleplayer branch below does.
    return (
      <div className="app-shell">
        {mp.state.status === "idle" && (
          <div className="lobby">
            <WaitingRoom
              room={mpRoom.room}
              currentUserId={mp.extras.currentUserId ?? ""}
              isHost={mpRoom.isHost}
              onLeave={handleLeaveRoom}
            />
          </div>
        )}

        {(mp.state.status === "playing" ||
          mp.state.status === "correct" ||
          mp.state.status === "incorrect") && (
          <RoundScreen
            state={mp.state}
            onSubmit={mp.submitGuess}
            onSkip={mp.skipWord}
            awaitingOthers={mp.extras.awaitingOthers}
            resultNote={mp.extras.resultNote}
            canSkip={false}
          />
        )}

        {mp.state.status === "finished" && (
          <ResultsScreen
            score={mp.state.score}
            bestStreak={mp.state.bestStreak}
            best={mp.state.score}
            onReplay={handleLeaveRoom}
            onMenu={handleLeaveRoom}
          />
        )}

        {mp.extras.error && <p className="lobby-error">{mp.extras.error}</p>}
      </div>
    );
  }

  // Singleplayer — existing flow, unchanged. A "← Modes" link at the difficulty
  // screen is the only addition, so players can get back to the mode picker.
  return (
    <div className="app-shell">
      {state.status === "idle" && (
        <div className="sp-home">
          <button className="back-link" onClick={() => setMode(null)}>← Modes</button>
          <DifficultySelect bests={bests} onSelect={startGame} />
        </div>
      )}

      {(state.status === "playing" || state.status === "correct" || state.status === "incorrect") && (
        <RoundScreen state={state} onSubmit={submitGuess} onSkip={skipWord} />
      )}

      {state.status === "finished" && state.tier && (
        <ResultsScreen
          score={state.score}
          bestStreak={state.bestStreak}
          best={bests[state.tier]}
          onReplay={() => state.tier && startGame(state.tier)}
          onMenu={resetToMenu}
        />
      )}
    </div>
  );
}

export default App;
