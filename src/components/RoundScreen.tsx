import { useEffect, useRef, useState } from "react";
import type { GameState } from "../types";
import { speakWord } from "../lib/tts";
import { ScoreBar } from "./ScoreBar";

export function RoundScreen({
  state,
  onSubmit,
  onSkip,
  awaitingOthers = false,
  resultNote = null,
  canSkip = true,
}: {
  state: GameState;
  onSubmit: (guess: string) => void;
  onSkip: () => void;
  // --- multiplayer-only, all optional so singleplayer is unchanged ----------
  /** I've answered but the round is still live: lock the input WITHOUT
   *  revealing the word, which others are still racing to spell. */
  awaitingOthers?: boolean;
  /** How the round ended, e.g. "Alex won this round" / "Time's up". */
  resultNote?: string | null;
  /** Multiplayer has no skip (see useMultiplayerGame.skipWord) — hide it
   *  rather than render a button that does nothing. */
  canSkip?: boolean;
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

      {/* Answered, round still live: no reveal — others are still racing. */}
      {awaitingOthers && (
        <p className="feedback waiting">Answer locked in — waiting for the other players…</p>
      )}

      {!awaitingOthers && feedback === "correct" && <p className="feedback correct">Correct!</p>}
      {!awaitingOthers && feedback === "incorrect" && (
        <p className="feedback incorrect">The word was "{state.currentWord.word}"</p>
      )}
      {!awaitingOthers && resultNote && <p className="result-note">{resultNote}</p>}

      {state.status === "playing" && canSkip && (
        <button className="skip-btn" onClick={onSkip}>
          Skip
        </button>
      )}
    </div>
  );
}
