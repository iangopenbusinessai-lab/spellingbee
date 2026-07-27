import { useRef } from "react";

/**
 * The draining timer bar (Session 17), extracted in Session 20 so the
 * elimination turn screen gets the identical bar rather than a second copy of
 * this arithmetic.
 *
 * Every rule from Session 17 is preserved verbatim, because they are the whole
 * reason one bar can serve three different engines:
 *
 *  - It is a pure VIEW of `timeLeft`. No timer, interval, animation clock or
 *    round-length constant lives here. Adding one would put a second source of
 *    truth next to the engine that already owns the countdown.
 *  - Its full scale comes from the largest `timeLeft` seen for the current word,
 *    NOT from a constant. That is what lets it serve singleplayer's
 *    ROUND_SECONDS, race mode's server-derived round_seconds(), AND elimination's
 *    per-turn DECAYED duration — each simply arrives as the opening value of
 *    timeLeft. Never "improve" this by importing a constant: CLAUDE.md forbids
 *    the multiplayer path from seeing the client-side one, and in elimination
 *    there is no constant to import at all, since every turn can be a different
 *    length.
 *  - The smooth drain is a 1s linear CSS transition on width, nothing else.
 *  - The fill is keyed by word id so a new round SNAPS back to full instead of
 *    animating upward.
 *  - Urgency is two threshold classes, not a computed gradient, so both themes
 *    stay readable and the colours stay tokens.
 *  - aria-hidden, because the countdown is already exposed as text next to it.
 */
export function TimerBar({
  wordId,
  timeLeft,
  untimed = false,
}: {
  /** Resets the scale and snaps the fill when the word changes. */
  wordId: string | undefined;
  timeLeft: number;
  /** Practice mode has no clock, so render nothing rather than an empty track. */
  untimed?: boolean;
}) {
  const spanRef = useRef<{ id: string | undefined; seconds: number }>({
    id: undefined,
    seconds: 0,
  });

  if (spanRef.current.id !== wordId) {
    spanRef.current = { id: wordId, seconds: timeLeft };
  } else if (timeLeft > spanRef.current.seconds) {
    spanRef.current.seconds = timeLeft;
  }

  if (untimed) return null;

  const span = spanRef.current.seconds;
  const remaining = span > 0 ? Math.max(0, Math.min(1, timeLeft / span)) : 0;
  const urgency = remaining <= 0.2 ? " critical" : remaining <= 0.45 ? " low" : "";

  return (
    <div className="timer-track" aria-hidden>
      <div key={wordId} className={`timer-fill${urgency}`} style={{ width: `${remaining * 100}%` }} />
    </div>
  );
}
