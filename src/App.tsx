import { useEffect, useState, type ReactNode } from "react";
import { ArrowLeft } from "lucide-react";
import "./App.css";
import { ModeSelect } from "./components/ModeSelect";
import { SettingsPanel } from "./components/SettingsPanel";
import { DifficultySelect } from "./components/DifficultySelect";
import { RoundScreen } from "./components/RoundScreen";
import { ResultsScreen } from "./components/ResultsScreen";
import { LobbyScreen } from "./components/LobbyScreen";
import { WaitingRoom } from "./components/WaitingRoom";
import { TurnScreen } from "./components/TurnScreen";
import { EliminationResults } from "./components/EliminationResults";
import { useGameEngine } from "./hooks/useGameEngine";
import { useMultiplayerGame } from "./hooks/useMultiplayerGame";
import type { DifficultyTier } from "./types";
import { getAllBests, setBest } from "./lib/storage";
import { leaveRoom, type RoomInfo } from "./lib/rooms";

// Top-level mode: null = pick a mode; "single" = the existing singleplayer flow
// (untouched); "multi" = the new lobby. Additive — singleplayer's idle/playing/
// finished states are unchanged.
type Mode = "single" | "multi" | null;

// Presentational wrapper around what used to be a bare <div className="app-shell">.
// It exists so the settings panel is mounted once for every screen — mode select,
// lobby, waiting room, round and results — instead of being pasted into each of
// App's four return branches and drifting apart later.
function Shell({ children, onBestsReset }: { children: ReactNode; onBestsReset?: () => void }) {
  return (
    <div className="app-shell">
      <SettingsPanel onBestsReset={onBestsReset} />
      {children}
    </div>
  );
}

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
    // Practice runs don't set best scores. Scoring is `10 + timeLeft` per word
    // and untimed holds timeLeft at 0, so a practice score isn't on the same
    // scale as a timed one — recording it would let an untimed run occupy the
    // best slot for a tier the player has never actually beaten under a clock.
    // hide-definition runs DO count: that mode is harder, not easier.
    if (state.untimed) return;
    const tier = state.tier;
    if (state.score > bests[tier]) {
      setBest(tier, state.score);
      setBests((prev) => ({ ...prev, [tier]: state.score }));
    }
  }, [state.status, state.tier, state.score, state.untimed, bests]);

  if (mode === null) {
    return (
      <Shell onBestsReset={() => setBests(getAllBests())}>
        <ModeSelect onSingle={() => setMode("single")} onMulti={() => setMode("multi")} />
      </Shell>
    );
  }

  if (mode === "multi") {
    // Not in a room yet -> the lobby.
    if (!mpRoom) {
      return (
        <Shell onBestsReset={() => setBests(getAllBests())}>
          <LobbyScreen
            onExitToModes={() => setMode(null)}
            onEnterRoom={(room, isHost) => setMpRoom({ room, isHost })}
          />
        </Shell>
      );
    }

    // In a room. Which screen is decided entirely by the server-driven
    // GameState, exactly as the singleplayer branch below does.
    return (
      <Shell onBestsReset={() => setBests(getAllBests())}>
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

        {/* Which round screen is decided by the ROOM's mode, read from the
            server row via extras — not by anything this client chose. The two
            modes are different enough in shape that they get different screens
            (see TurnScreen's header); what they share, they share as
            components. */}
        {(mp.state.status === "playing" ||
          mp.state.status === "correct" ||
          mp.state.status === "incorrect") &&
          (mp.extras.mode === "elimination" ? (
            <TurnScreen
              state={mp.state}
              extras={mp.extras}
              onSubmit={mp.submitGuess}
              onLeave={handleLeaveRoom}
            />
          ) : (
            <RoundScreen
              state={mp.state}
              onSubmit={mp.submitGuess}
              onSkip={mp.skipWord}
              awaitingOthers={mp.extras.awaitingOthers}
              resultNote={mp.extras.resultNote}
              canSkip={false}
            />
          ))}

        {mp.state.status === "finished" &&
          (mp.extras.mode === "elimination" ? (
            <EliminationResults extras={mp.extras} onLeave={handleLeaveRoom} />
          ) : (
            <ResultsScreen
              score={mp.state.score}
              bestStreak={mp.state.bestStreak}
              best={mp.state.score}
              onReplay={handleLeaveRoom}
              onMenu={handleLeaveRoom}
            />
          ))}

        {mp.extras.error && <p className="lobby-error">{mp.extras.error}</p>}
      </Shell>
    );
  }

  // Singleplayer — existing flow, unchanged. A "Modes" back link at the
  // difficulty screen is the only addition, so players can get back to the mode
  // picker.
  return (
    <Shell onBestsReset={() => setBests(getAllBests())}>
      {state.status === "idle" && (
        <div className="sp-home">
          <button className="back-link" onClick={() => setMode(null)}>
            <ArrowLeft size={15} aria-hidden />
            Modes
          </button>
          <DifficultySelect bests={bests} onSelect={startGame} />
        </div>
      )}

      {(state.status === "playing" || state.status === "correct" || state.status === "incorrect") && (
        <RoundScreen
          state={state}
          onSubmit={submitGuess}
          onSkip={skipWord}
          // Singleplayer only. resetToMenu drops straight back to idle, so the
          // run is discarded rather than finished — no best score is recorded,
          // which is the point of quitting.
          onExit={resetToMenu}
        />
      )}

      {state.status === "finished" && state.tier && (
        <ResultsScreen
          score={state.score}
          bestStreak={state.bestStreak}
          best={bests[state.tier]}
          // Replay keeps the modifiers the finished game was played with, so
          // "Play again" repeats the same game rather than silently dropping
          // back to timed-with-definition.
          onReplay={() =>
            state.tier &&
            startGame(state.tier, {
              untimed: state.untimed,
              hideDefinition: state.hideDefinition,
            })
          }
          onMenu={resetToMenu}
        />
      )}
    </Shell>
  );
}

export default App;
