import { useEffect, useRef, useState } from "react";
import { ArrowLeft, Eye, Ghost, Heart, Loader2, Volume2 } from "lucide-react";
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
    submitting,
  } = extras;

  // --- life-loss beat (Session 22) -------------------------------------------
  //
  // Fires whenever ANY player's `lives` drops, which is a different and much
  // more frequent event than Session 20's knockout overlay: a knockout happens
  // once per player per game, this happens on every miss and every timeout.
  //
  // Driven off the server's `lives` column, so it fires for the timeout path too
  // — no client-side notion of "what just happened" is involved, only a diff of
  // two server values.
  //
  // The struck set is held by a JS timer rather than by the CSS animation's own
  // duration. That is deliberate and is what makes the reduce-motion story work:
  // the class stays applied for the full window either way, so the STATIC part of
  // the cue (a red rim, see .ptoken.struck in App.css) is visible for the same
  // time whether or not the animation ran.
  const [struck, setStruck] = useState<Record<string, number>>({});
  const prevLives = useRef<Map<string, number> | null>(null);

  useEffect(() => {
    const next = new Map<string, number>();
    const hit: string[] = [];
    for (const p of players) {
      if (p.turn_order === null) continue;
      const before = prevLives.current?.get(p.player_id);
      if (before !== undefined && p.lives < before) hit.push(p.player_id);
      next.set(p.player_id, p.lives);
    }
    // First observation only seeds the baseline — joining a game already in
    // progress must not flash every token at once.
    const seeded = prevLives.current !== null;
    prevLives.current = next;
    if (!seeded || hit.length === 0) return;

    setStruck((s) => {
      const n = { ...s };
      for (const id of hit) n[id] = (n[id] ?? 0) + 1;
      return n;
    });
    const t = window.setTimeout(() => {
      setStruck((s) => {
        const n = { ...s };
        for (const id of hit) delete n[id];
        return n;
      });
    }, 700);
    return () => window.clearTimeout(t);
  }, [players]);

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

  // Everyone dealt into the rotation, in rotation order. A row without a
  // turn_order is a spectator who was never dealt in (0012's rule), so they are
  // not part of the table and get no token.
  const roster = players
    .filter((p) => p.turn_order !== null)
    .sort((a, b) => (a.turn_order ?? 0) - (b.turn_order ?? 0));

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
            /* Disabled only while MY OWN answer is in flight, and only ever for
               the turn holder. This is the one place a disabled input is honest:
               you did something, it is being checked, and a second submission
               would be refused anyway (already_submitted). It never disables a
               non-holder — those get no input at all. */
            disabled={submitting}
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            placeholder={submitting ? "" : "Your turn — type the word"}
          />
          {/* Acknowledges the keypress during the round trip. Says only that the
              answer was SENT — never guesses whether it was right. */}
          {submitting && (
            <p className="submit-pending" role="status">
              <Loader2 size={14} aria-hidden className="spin" />
              Checking…
            </p>
          )}
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

      {/* Reserved slot, not a conditional gap.
          Feedback appears for the ~1.1s server feedback window and then goes
          again. Letting it insert and remove itself would shove the token row
          (and, before the reorder, the input) up and down every single turn.
          A fixed min-height means the turn ends with text APPEARING rather than
          with the page jumping. It sits directly above the tokens on purpose:
          "Missed — the word was X" reads straight into the token that just lost
          a heart. */}
      <div className="turn-feedback" aria-live="polite">
        {feedback === "correct" && <p className="feedback correct">{OUTCOME_LABEL.correct}!</p>}
        {feedback === "incorrect" && (
          <p className="feedback incorrect">
            {OUTCOME_LABEL[turnOutcome ?? "wrong"]}
            {lastResolvedTurn?.word ? ` — the word was "${lastResolvedTurn.word}"` : ""}
          </p>
        )}
        {resultNote && <p className="result-note">{resultNote}</p>}
      </div>

      {/* THE TABLE.
          Replaces the old vertical name+hearts list. That list was fine at three
          players and became the tallest thing on the screen at eight, pushing the
          word itself below the fold — and it sat ABOVE the input, so the thing
          you act on kept moving as the roster changed.

          These are PURELY INFORMATIONAL: no button, no link, no click handler,
          nothing focusable. So there is no tap target to measure — the row is
          read, not touched.

          Ghost state is driven by `p.is_eliminated`, which is a server column
          arriving over Realtime. It reads identically on every client, including
          the ghosted player's own screen; nothing here branches on who is
          looking, so being out is a fact about the game rather than a private
          notification. */}
      <ul className="player-tokens" aria-label="Players at the table">
        {roster.map((p, i) => {
          const isTurn = p.player_id === currentTurnPlayerId;
          const isYou = p.player_id === currentUserId;
          const label = isYou ? "You" : p.display_name;
          return (
            <li
              key={p.player_id}
              className={
                "ptoken" +
                (p.is_eliminated ? " ghost" : "") +
                (isTurn ? " active" : "") +
                (isYou ? " you" : "") +
                (struck[p.player_id] ? " struck" : "")
              }
              aria-label={
                p.is_eliminated
                  ? `${label} — out`
                  : `${label} — ${p.lives} ${p.lives === 1 ? "life" : "lives"}${
                      isTurn ? (isYou ? ", your turn" : ", their turn") : ""
                    }`
              }
            >
              <span
                className="ptoken-disc"
                /* Staggered so ghosts drift out of phase instead of bobbing in
                   unison like one object. Index-based, so it is stable across
                   re-renders and identical on every client. */
                style={p.is_eliminated ? { animationDelay: `${(i % 4) * 0.55}s` } : undefined}
              >
                {p.is_eliminated ? (
                  /* A ghost MOTIF, not a ninth avatar. AVATAR_KEYS is untouched
                     and still the one preset list — this is a state a player is
                     in, never something anyone can pick. */
                  <Ghost size={24} aria-hidden className="ptoken-ghost-icon" />
                ) : (
                  <AvatarBadge avatar={p.avatar} size={24} />
                )}

                {/* The ripple. Remounted by a changing key, because a CSS
                    animation replays on mount, not on re-render (the Session 12
                    streak-pulse rule). Purely decorative — the red rim on
                    .ptoken.struck is the part that carries the meaning. */}
                {struck[p.player_id] && (
                  <span key={struck[p.player_id]} className="ptoken-hit" aria-hidden />
                )}

                {!p.is_eliminated && (
                  <span className="ptoken-lives" aria-hidden>
                    <Heart size={9} className="life" />
                    {p.lives}
                  </span>
                )}
              </span>
              <span className="ptoken-name">{label}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
