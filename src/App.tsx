import "./App.css";
import { DifficultySelect } from "./components/DifficultySelect";
import { RoundScreen } from "./components/RoundScreen";
import { ResultsScreen } from "./components/ResultsScreen";
import { useGameEngine } from "./hooks/useGameEngine";

function App() {
  const { state, startGame, submitGuess, skipWord, resetToMenu } = useGameEngine();

  return (
    <div className="app-shell">
      {state.status === "idle" && <DifficultySelect onSelect={startGame} />}

      {(state.status === "playing" || state.status === "correct" || state.status === "incorrect") && (
        <RoundScreen state={state} onSubmit={submitGuess} onSkip={skipWord} />
      )}

      {state.status === "finished" && (
        <ResultsScreen
          score={state.score}
          bestStreak={state.bestStreak}
          onReplay={() => state.tier && startGame(state.tier)}
          onMenu={resetToMenu}
        />
      )}
    </div>
  );
}

export default App;
