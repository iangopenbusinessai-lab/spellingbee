import { useEffect, useState } from "react";
import "./App.css";
import { ModeSelect } from "./components/ModeSelect";
import { DifficultySelect } from "./components/DifficultySelect";
import { RoundScreen } from "./components/RoundScreen";
import { ResultsScreen } from "./components/ResultsScreen";
import { LobbyScreen } from "./components/LobbyScreen";
import { useGameEngine } from "./hooks/useGameEngine";
import type { DifficultyTier } from "./types";
import { getAllBests, setBest } from "./lib/storage";

// Top-level mode: null = pick a mode; "single" = the existing singleplayer flow
// (untouched); "multi" = the new lobby. Additive — singleplayer's idle/playing/
// finished states are unchanged.
type Mode = "single" | "multi" | null;

function App() {
  const [mode, setMode] = useState<Mode>(null);
  const { state, startGame, submitGuess, skipWord, resetToMenu } = useGameEngine();
  const [bests, setBests] = useState<Record<DifficultyTier, number>>(() => getAllBests());

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
    return (
      <div className="app-shell">
        <LobbyScreen onExitToModes={() => setMode(null)} />
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
