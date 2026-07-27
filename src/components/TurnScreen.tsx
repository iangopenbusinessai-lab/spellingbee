import { useEffect, useRef, useState } from "react";
import { ArrowLeft, Eye, Heart, Volume2 } from "lucide-react";
import type { GameState } from "../types";
import type { MultiplayerExtras } from "../hooks/useMultiplayerGame";
import { repeatWord, stopSpeaking } from "../lib/tts";
import { useAnnouncedWord } from "../hooks/useAnnouncedWord";
import { AvatarBadge } from "./AvatarPicker";
import { TimerBar } from "./TimerBar";

// TurnScreen — the elimination round UI.
//
// WHY THIS IS NOT RoundScreen.
// RoundScreen is built around one premise: the word is yours and you are typing
// it. Elimination inverts that — at any moment exactly ONE player is answering
// and everyone else is watching, and after a while some of the watchers can
// never answer again. Forcing that into RoundScreen would have meant a disabled
// input on most screens most of the time, which reads as a broken page rather
// than as somebody else's turn.
//
// What IS shared, because it genuinely fits, is shared as components rather
// than copied: TimerBar (Session 17's draining bar, which needs no changes
// because its scale comes from the state) and useAnnouncedWord (so the spoken
// and displayed lead-in come from one implementation, as they always have).
// The definition card and the correct/incorrect vocabulary are deliberately
// echoed so the two modes still feel like one game.
//
// THREE ROLES, one screen:
//   holder    — it is my turn: the guess input exists and is focused.
//   waiting   — someone else's turn, I am still alive: NO input is rendered.
//   spectator — I am out: same as waiting, plus a standing banner saying so.
//
// The distinction between "no input" and "a disabled input" is the whole point
// of the brief's requirement, and it is structural here: for a non-holder the
// <form> is not in the tree at all, so there is nothing to re-enable from
// devtools and nothing to submit. The server would refuse anyway
// (not_your_turn), which is the actual guarantee; this just stops the UI from
// lying about what you can do.

/** How long the elimination moment holds the screen before spectating begins. */
const KNOCKOUT_MS = 4200;

const OUTCOME_LABEL: Record<string, string> = {
  correct: "Correct",
  wrong: "Missed",
  timeout: "Out of time",
};

export function TurnScreen({
  state,
  extras,
  onSubmit,
  onLeave,
}: {
  state: GameState;
  extras: MultiplayerExtras;
  onSubmit: (guess: string) => void;
  /** Leave mid-game. Confirmed in-panel, because it forfeits. */
  onLeave: () => void;
}) {
  const [guess, setGuess] = useState("");
  const [confirmingExit, setConfirmingExit] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const wordId = state.currentWord?.id;
  const wordText = state.currentWord?.word;

  const {
    players,
    currentUserId,
    currentTurnPlayerId,
    isMyTurn,
    amEliminated,
    myLives,
    survivors,
    tableStreak,
    turnOutcome,
    lastResolvedTurn,
    resultNote,
  } = extras;

  // Everyone announces, including spectators: an eliminated player watching the
  // rest of the match should hear the words read out, not watch a silent bee.
  const leadIn = useAnnouncedWord(wordId, wordText);

  useEffect(() => {
    setGuess("");
  }, [wordId]);

  // Focus only when the turn is actually mine, and only once it opens. Focusing
  // an input that has just appeared mid-feedback would scroll a watching
  // player's page for no reason.
  useEffect(() => {
    if (isMyTurn) inputRef.current?.focus();
  }, [isMyTurn, wordId]);

  // --- the elimination moment ----------------------------------------------
  //
  // Latched rather than derived, on purpose. `amEliminated` is true forever
  // afterwards, but the MOMENT is a single event and deserves its own beat
  // before the spectator view takes over. Capturing the word at the transition
  // also means it survives the next turn arriving underneath.
  const [knockout, setKnockout] = useState<{ word: string | null; until: number } | null>(null);
  const wasEliminated = useRef(amEliminated);

  useEffect(() => {
    if (amEliminated && !wasEliminated.current) {
      setKnockout({ word: lastResolvedTurn?.word ?? null, until: Date.now() + KNOCKOUT_MS });
    }
    wasEliminated.current = amEliminated;
  }, [amEliminated, lastResolvedTurn]);

  // Dismissal is driven by an ELAPSED-TIME CHECK, not purely by a timer.
  //
  // A bare setTimeout was the first version and it was wrong for the same
  // reason the countdown is only ever advisory: browsers throttle timers in
  // hidden tabs, and a throttled timer held this full-screen overlay up for 24s
  // in testing — long enough to hide the entire rest of the match from the
  // player it had just knocked out. The overlay is the one thing that must not
  // outstay its welcome, because everything behind it is the spectator view.
  //
  // So: a timer for the ordinary case, plus a deadline that any later render
  // re-checks. The component re-renders on every Realtime change, which during
  // a live game is far more often than once every four seconds, so the overlay
  // clears promptly even where the timer does not fire.
  useEffect(() => {
    if (!knockout) return;
    const remaining = knockout.until - Date.now();
    if (remaining <= 0) {
      setKnockout(null);
      return;
    }
    const t = window.setTimeout(() => setKnockout(null), remaining);
    return () => window.clearTimeout(t);
  });

  const holder = players.find((p) => p.player_id === currentTurnPlayerId) ?? null;
  const holderName = holder
    ? holder.player_id === currentUserId
      ? "Your turn"
      : `${holder.display_name}'s turn`
    : "…";

  function handleLeave() {
    stopSpeaking();
    onLeave();
  }

  if (knockout) {
    return (
      <div className="turn-screen">
        <div className="knockout" role="alert">
          <span className="knockout-kicker">You're out</span>
          {knockout.word ? (
            <>
              <span className="knockout-label">The word was</span>
              <span className="knockout-word">{knockout.word}</span>
            </>
          ) : (
            <span className="knockout-label">That was your last life.</span>
          )}
          <span className="knockout-note">
            {survivors} player{survivors === 1 ? "" : "s"} still standing — stay and watch.
          </span>
        </div>
      </div>
    );
  }

  const feedback =
    turnOutcome === "correct" ? "correct" : turnOutcome ? "incorrect" : null;

  return (
    <div className="turn-screen">
      <div className="round-exit">
        {confirmingExit ? (
          <div className="exit-confirm">
            <span className="exit-confirm-text">
              Leave? You forfeit — your turns will time out and cost a life each.
            </span>
            <div className="exit-confirm-actions">
              <button className="danger-btn" onClick={handleLeave}>
                Leave game
              </button>
              <button className="secondary-btn" onClick={() => setConfirmingExit(false)}>
                Keep playing
              </button>
            </div>
          </div>
        ) : (
          <button className="back-link" onClick={() => setConfirmingExit(true)}>
            <ArrowLeft size={15} aria-hidden />
            Leave
          </button>
        )}
      </div>

      {/* Elimination's own header, and deliberately NOT a relabelled ScoreBar.
          ScoreBar's "to go" counts down a round budget this mode does not have,
          and three further things were wrong when this was first written:

          - SCORE is gone. Points do accrue here (apply_turn_outcome awards
            10 + seconds left, and EliminationResults still shows the totals),
            but placement in this mode is how long you SURVIVED, not points.
            A running total is not a number anyone acts on mid-turn, so it does
            not deserve the most prominent slot.
          - No two labels repeat. "3 LEFT" (players) sat beside "12s LEFT"
            (seconds) reading the same word twice, at the exact moment — mid-turn,
            under a clock — when a glance has to be unambiguous.
          - STREAK is the table-wide run of correct answers and is the most
            game-relevant number on the bar, because it is what shortens the
            next turn. It now sits immediately beside the clock it acts on, and
            carries a plain-language sub-label saying so.

          The sub-label names no thresholds on purpose. The numbers that trigger
          the decay live in decay_params() on the server; stating them here would
          put a copy of the decay contract in a file that cannot see it change.
          It says what the streak DOES, not when it fires. */}
      <div className="score-bar turn-stats">
        <div className="stat">
          <span className="stat-value">{amEliminated ? "—" : myLives ?? "—"}</span>
          <span className="stat-label">your lives</span>
        </div>
        <div className="stat">
          <span className="stat-value">{survivors}</span>
          <span className="stat-label">survivors</span>
        </div>
        <div className="stat">
          <span className="stat-value">{tableStreak}</span>
          <span className="stat-label">streak</span>
          <span className="stat-hint">speeds the clock up</span>
        </div>
        <div className="stat timer" data-low={state.timeLeft <= 5}>
          <span className="stat-value">{state.timeLeft}s</span>
          <span className="stat-label">time left</span>
        </div>
      </div>

      {/* Who is up. The single most important thing on this screen for the
          players who are not answering. */}
      <div className={`turn-banner${isMyTurn ? " mine" : ""}`}>
        {holder && <AvatarBadge avatar={holder.avatar} size={20} />}
        <span className="turn-banner-name">{holderName}</span>
      </div>

      {/* The roster, always visible: lives are the currency of this mode, so
          everyone's should be legible at a glance rather than on a results
          screen afterwards. */}
      <ul className="lives-roster">
        {players
          .filter((p) => p.turn_order !== null)
          .sort((a, b) => (a.turn_order ?? 0) - (b.turn_order ?? 0))
          .map((p) => {
            const isTurn = p.player_id === currentTurnPlayerId;
            const isYou = p.player_id === currentUserId;
            return (
              <li
                key={p.player_id}
                className={
                  "lives-row" +
                  (p.is_eliminated ? " out" : "") +
                  (isTurn ? " active" : "")
                }
              >
                <AvatarBadge avatar={p.avatar} size={16} dimmed={p.is_eliminated} />
                <span className="lives-name">
                  {p.display_name}
                  {isYou && <span className="tag tag-you">you</span>}
                </span>
                <span className="lives-hearts" aria-label={`${p.lives} lives`}>
                  {p.is_eliminated ? (
                    <span className="lives-out">out</span>
                  ) : (
                    Array.from({ length: p.lives }, (_, i) => (
                      <Heart key={i} size={13} aria-hidden className="life" />
                    ))
                  )}
                </span>
              </li>
            );
          })}
      </ul>

      {leadIn && <p className="lead-in">{leadIn}</p>}

      {state.currentWord && (
        <div className="prompt-card">
          <p className="definition">"{state.currentWord.definition}"</p>
          <button className="replay-btn" onClick={() => repeatWord(state.currentWord!.word)}>
            <Volume2 size={16} aria-hidden />
            Hear it again
          </button>
        </div>
      )}

      {/* THE INPUT EXISTS ONLY FOR THE TURN HOLDER. Not disabled — absent. */}
      {isMyTurn ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            onSubmit(guess);
          }}
        >
          <input
            ref={inputRef}
            className="guess-input"
            value={guess}
            onChange={(e) => setGuess(e.target.value)}
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            placeholder="Your turn — type the word"
          />
        </form>
      ) : amEliminated ? (
        <div className="spectating" role="status">
          <Eye size={16} aria-hidden />
          <span>
            You're out — watching {holder ? holder.display_name : "the table"} play it out.
          </span>
        </div>
      ) : (
        <div className="waiting-turn" role="status">
          <span className="waiting-dots" aria-hidden>
            <i />
            <i />
            <i />
          </span>
          <span>
            {holder ? `${holder.display_name} is spelling…` : "Waiting for the next turn…"}
          </span>
        </div>
      )}

      <TimerBar wordId={wordId} timeLeft={state.timeLeft} />

      {feedback === "correct" && <p className="feedback correct">{OUTCOME_LABEL.correct}!</p>}
      {feedback === "incorrect" && (
        <p className="feedback incorrect">
          {OUTCOME_LABEL[turnOutcome ?? "wrong"]}
          {lastResolvedTurn?.word ? ` — the word was "${lastResolvedTurn.word}"` : ""}
        </p>
      )}
      {resultNote && <p className="result-note">{resultNote}</p>}
    </div>
  );
}
