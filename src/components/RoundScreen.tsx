import { useEffect, useRef, useState } from "react";
import { ArrowLeft, Volume2 } from "lucide-react";
import type { GameState } from "../types";
import { announceWord, repeatWord, stopSpeaking } from "../lib/tts";
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

  // Full scale for the draining timer bar, in seconds.
  //
  // Taken from the largest timeLeft this word has been seen with, NOT from a
  // round-length constant. That is what lets one bar serve both engines: the
  // singleplayer round length (ROUND_SECONDS) and the multiplayer one
  // (round_seconds() by RPC, on the server clock) both reach this component as
  // the opening value of state.timeLeft, so reading the state gets whichever
  // engine is driving without importing either constant — CLAUDE.md forbids the
  // multiplayer path from ever seeing the client-side one.
  //
  // No new timing lives here: this is arithmetic on state that already ticks. A
  // client that joins a round late simply scales to the time it actually had,
  // so the bar still empties exactly when the countdown does.
  const spanRef = useRef<{ id: string | undefined; seconds: number }>({
    id: undefined,
    seconds: 0,
  });
  if (spanRef.current.id !== wordId) {
    spanRef.current = { id: wordId, seconds: state.timeLeft };
  } else if (state.timeLeft > spanRef.current.seconds) {
    spanRef.current.seconds = state.timeLeft;
  }

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

  const roundSpan = spanRef.current.seconds;
  const remaining = roundSpan > 0 ? Math.max(0, Math.min(1, state.timeLeft / roundSpan)) : 0;
  // Colour is a third state, not a gradient: two thresholds keep the bar
  // readable in both themes and mean the shift is a transition between two
  // tokens rather than a computed colour nobody can theme.
  const urgency = remaining <= 0.2 ? " critical" : remaining <= 0.45 ? " low" : "";

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
        {/* Replay speaks the WORD only — repeatWord, not announceWord. The
            lead-in introduces a word you haven't heard; on a replay it's just a
            delay in front of the thing you asked for. The lead-in line above
            stays on screen, because it still describes the announcement that
            introduced this word. */}
        <button className="replay-btn" onClick={() => repeatWord(state.currentWord!.word)}>
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

      {/* Draining timer bar. Practice mode has no clock at all, so it renders
          nothing rather than an empty track.

          aria-hidden: ScoreBar already exposes the same countdown as text
          ("13s left"), and a second announcement of it would be noise.

          The width is a plain read of state.timeLeft; the one-second linear
          transition in App.css is what turns the engines' whole-second ticks
          into a continuous drain, so there is no second timer anywhere. Keyed
          by word so a new round snaps back to full instead of animating up. */}
      {!state.untimed && (
        <div className="timer-track" aria-hidden>
          <div
            key={wordId}
            className={`timer-fill${urgency}`}
            style={{ width: `${remaining * 100}%` }}
          />
        </div>
      )}

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
