import { useEffect, useRef, useState } from "react";
import { ArrowLeft, Volume2 } from "lucide-react";
import type { GameState } from "../types";
import { announceWord, stopSpeaking } from "../lib/tts";
import { ScoreBar } from "./ScoreBar";

export function RoundScreen({
  state,
  onSubmit,
  onSkip,
  onExit,
  awaitingOthers = false,
  resultNote = null,
  canSkip = true,
}: {
  state: GameState;
  onSubmit: (guess: string) => void;
  onSkip: () => void;
  /** Abandon the game and go back. Optional: only rendered when a caller
   *  supplies it, so multiplayer — where leaving a room has its own rules —
   *  is unaffected. */
  onExit?: () => void;
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
  const [leadIn, setLeadIn] = useState<string | null>(null);
  // Two-step, matching the settings panel's reset: quitting throws away a run in
  // progress, and this control sits next to a timed round where a mis-tap is
  // easy. Same reason it isn't a window.confirm — that blocks the page.
  const [confirmingExit, setConfirmingExit] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const wordId = state.currentWord?.id;
  const wordText = state.currentWord?.word;

  useEffect(() => {
    setGuess("");
    inputRef.current?.focus();
  }, [wordId]);

  // Announcing from here — rather than from each engine hook — is what gives
  // singleplayer and multiplayer identical narration from one implementation:
  // both render this component, so both get the lead-in for free. It also keeps
  // the spoken phrase and the displayed phrase from ever disagreeing, since the
  // same call produces both.
  useEffect(() => {
    if (!wordText) return;
    // Small beat so the new word paints before audio starts.
    const t = window.setTimeout(() => setLeadIn(announceWord(wordText)), 200);
    return () => window.clearTimeout(t);
  }, [wordId, wordText]);

  const scrollInputIntoView = () => {
    inputRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
  };

  if (!state.currentWord) return null;

  const feedback =
    state.status === "correct" ? "correct" : state.status === "incorrect" ? "incorrect" : null;

  function handleExit() {
    // Leaving mid-announcement would otherwise keep the narrator talking over
    // the menu, and the queued word would still arrive a second later.
    stopSpeaking();
    onExit?.();
  }

  return (
    <div className="round-screen">
      {onExit && (
        <div className="round-exit">
          {confirmingExit ? (
            <div className="exit-confirm">
              <span className="exit-confirm-text">Quit? This game won't be scored.</span>
              <div className="exit-confirm-actions">
                <button className="danger-btn" onClick={handleExit}>
                  Quit game
                </button>
                <button className="secondary-btn" onClick={() => setConfirmingExit(false)}>
                  Keep playing
                </button>
              </div>
            </div>
          ) : (
            <button className="back-link" onClick={() => setConfirmingExit(true)}>
              <ArrowLeft size={15} aria-hidden />
              Quit
            </button>
          )}
        </div>
      )}

      <ScoreBar
        score={state.score}
        streak={state.streak}
        timeLeft={state.timeLeft}
        wordsRemaining={state.wordsRemaining}
        untimed={state.untimed}
      />

      {/* Mirrors what the narrator just said, so the audio and the screen agree. */}
      {leadIn && <p className="lead-in">{leadIn}</p>}

      <div className="prompt-card">
        {/* Hide-definition mode: the definition is simply not rendered, so the
            only clue is the audio. The replay button matters much more here,
            which is why the card keeps its shape rather than collapsing. */}
        {state.hideDefinition ? (
          <p className="definition-hidden">Listen carefully — no definition this round.</p>
        ) : (
          <p className="definition">"{state.currentWord.definition}"</p>
        )}
        {/* Replay re-announces: announceWord reuses the SAME lead-in for the
            same word, so hearing it again doesn't re-roll the phrase. */}
        <button
          className="replay-btn"
          onClick={() => setLeadIn(announceWord(state.currentWord!.word))}
        >
          <Volume2 size={16} aria-hidden />
          Hear it again
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
