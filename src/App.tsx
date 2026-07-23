import { useEffect, useState } from "react";
import "./App.css";
import { DifficultySelect } from "./components/DifficultySelect";
import { RoundScreen } from "./components/RoundScreen";
import { ResultsScreen } from "./components/ResultsScreen";
import { useGameEngine } from "./hooks/useGameEngine";
import type { DifficultyTier } from "./types";
import { getAllBests, setBest } from "./lib/storage";

function App() {
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

  return (
    <div className="app-shell">
      {state.status === "idle" && <DifficultySelect bests={bests} onSelect={startGame} />}

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
