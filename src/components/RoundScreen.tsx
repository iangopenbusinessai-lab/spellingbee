import { useEffect, useRef, useState } from "react";
import { ArrowLeft, Volume2 } from "lucide-react";
import type { GameState } from "../types";
import { repeatWord, stopSpeaking } from "../lib/tts";
import { playSubmit } from "../lib/sfx";
import { formatResponseDetail } from "../lib/wpm";
import { useAnnouncedWord } from "../hooks/useAnnouncedWord";
import { useSfxForOutcome } from "../hooks/useSfxForOutcome";
import { ScoreBar } from "./ScoreBar";
import { TimerBar } from "./TimerBar";

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

  // Announcement moved to a shared hook in Session 20 so the elimination turn
  // screen uses the same implementation rather than a copy. The engine hooks
  // still never speak — see useAnnouncedWord for the full reasoning.
  const leadIn = useAnnouncedWord(wordId, wordText);

  // Sound effects fire off the SAME status transition the feedback text reads,
  // so what you hear and what you see can never disagree. Keyed on the word id
  // as well as the status so a re-render never replays a chime, and so two
  // consecutive words with the same outcome still each get one.
  //
  // Must sit ABOVE the `!state.currentWord` early return below — a hook after a
  // conditional return changes hook order between renders.
  useSfxForOutcome(wordId, state.status);

  const scrollInputIntoView = () => {
    inputRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
  };

  if (!state.currentWord) return null;

  const feedback =
    state.status === "correct" ? "correct" : state.status === "incorrect" ? "incorrect" : null;

  const responseDetail = formatResponseDetail(state.currentWord?.word, state.lastResponseMs);

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
          playSubmit();
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

      {/* Draining timer bar — extracted to TimerBar in Session 20 and shared
          with the elimination turn screen. Same component, same rules; see
          TimerBar for why its scale comes from the state rather than a
          constant. */}
      <TimerBar wordId={wordId} timeLeft={state.timeLeft} untimed={state.untimed} />

      {/* Answered, round still live: no reveal — others are still racing. */}
      {awaitingOthers && (
        <p className="feedback waiting">Answer locked in — waiting for the other players…</p>
      )}

      {/* Session 23: the response detail EXTENDS this line rather than adding a
          second feedback element, and it is omitted entirely when there is no
          measured time (a timeout, a skip, or a mode that can't supply one). */}
      {!awaitingOthers && feedback === "correct" && (
        <p className="feedback correct">
          Correct!
          {responseDetail && <span className="feedback-detail"> — {responseDetail}</span>}
        </p>
      )}
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
