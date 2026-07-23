import { useEffect, useRef, useState } from "react";
import type { GameState } from "../types";
import { speakWord } from "../lib/tts";
import { ScoreBar } from "./ScoreBar";

export function RoundScreen({
  state,
  onSubmit,
  onSkip,
}: {
  state: GameState;
  onSubmit: (guess: string) => void;
  onSkip: () => void;
}) {
  const [guess, setGuess] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setGuess("");
    inputRef.current?.focus();
  }, [state.currentWord?.id]);

  const scrollInputIntoView = () => {
    inputRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
  };

  if (!state.currentWord) return null;

  const feedback =
    state.status === "correct" ? "correct" : state.status === "incorrect" ? "incorrect" : null;

  return (
    <div className="round-screen">
      <ScoreBar
        score={state.score}
        streak={state.streak}
        timeLeft={state.timeLeft}
        wordsRemaining={state.wordsRemaining}
      />

      <div className="prompt-card">
        <p className="definition">"{state.currentWord.definition}"</p>
        <button className="replay-btn" onClick={() => speakWord(state.currentWord!.word)}>
          🔊 Hear it again
        </button>
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (state.status !== "playing") return;
          onSubmit(guess);
        }}
      >
        <input
          ref={inputRef}
          className={`guess-input ${feedback ?? ""}`}
          value={guess}
          onChange={(e) => setGuess(e.target.value)}
          onFocus={scrollInputIntoView}
          disabled={state.status !== "playing"}
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          placeholder="Type the word you hear"
        />
      </form>

      {feedback === "correct" && <p className="feedback correct">Correct!</p>}
      {feedback === "incorrect" && (
        <p className="feedback incorrect">The word was "{state.currentWord.word}"</p>
      )}

      {state.status === "playing" && (
        <button className="skip-btn" onClick={onSkip}>
          Skip
        </button>
      )}
    </div>
  );
}
