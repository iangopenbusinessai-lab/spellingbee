import { useEffect, useRef, useState } from "react";

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

  // --- the one-tick lag, and why the target is timeLeft - 1 (Session 23) -----
  //
  // The bar drains via `transition: width 1s linear`, and the engines tick in
  // whole seconds. Setting the width to `timeLeft / span` therefore made the bar
  // TRAIL the numeral by a full tick: when the numeral changed to N the bar only
  // then began moving to N/span, arriving exactly as the numeral became N-1. At
  // the end of a round that showed up as the reported bug — the numeral hit 0
  // while the bar still had a second of travel left, so it emptied about when
  // the next word appeared and looked synced to the wrong word.
  //
  // The fix is to aim one step AHEAD instead of at the current value: during the
  // second in which the numeral reads N, the bar travels from N/span to
  // (N-1)/span. The transition's 1s duration is exactly the tick interval, so
  // the bar now arrives at each value at the instant the numeral displays it,
  // and reaches empty exactly as the numeral reaches 0.
  //
  // No second clock is introduced — this is still a pure function of `timeLeft`,
  // which is the Session 17 rule. The only addition is the priming frame below.
  //
  // PRIMING: the fill is remounted on a new word (`key={wordId}`) so it snaps to
  // full instead of animating up. A fresh element has no previous width to
  // transition FROM, so if it mounted already showing the look-ahead value it
  // would silently skip the first second of travel. It therefore mounts at the
  // true current value and is re-pointed at the look-ahead value one frame
  // later, which is what gives the first second its animation.
  const [primedFor, setPrimedFor] = useState<string | undefined>(undefined);
  useEffect(() => {
    if (wordId === undefined) return;
    const raf = requestAnimationFrame(() => setPrimedFor(wordId));
    return () => cancelAnimationFrame(raf);
  }, [wordId]);

  if (untimed) return null;

  const span = spanRef.current.seconds;
  const primed = primedFor === wordId && wordId !== undefined;
  const shown = primed ? Math.max(0, timeLeft - 1) : timeLeft;
  const remaining = span > 0 ? Math.max(0, Math.min(1, shown / span)) : 0;

  // Urgency still reads the DISPLAYED time, not the look-ahead width — the
  // colour should change when the player is actually at 20% of their time, not a
  // second early.
  const urgencyRatio = span > 0 ? Math.max(0, Math.min(1, timeLeft / span)) : 0;
  const urgency = urgencyRatio <= 0.2 ? " critical" : urgencyRatio <= 0.45 ? " low" : "";

  return (
    <div className="timer-track" aria-hidden>
      <div key={wordId} className={`timer-fill${urgency}`} style={{ width: `${remaining * 100}%` }} />
    </div>
  );
}
