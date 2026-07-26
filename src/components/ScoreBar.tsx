import { useEffect, useRef, useState } from "react";

export function ScoreBar({
  score,
  streak,
  timeLeft,
  wordsRemaining,
  untimed = false,
}: {
  score: number;
  streak: number;
  timeLeft: number;
  wordsRemaining: number;
  /** Practice mode: there is no clock, so show the mode instead of a dead 0. */
  untimed?: boolean;
}) {
  // Presentational only: notice when the streak goes UP so the counter can be
  // given a beat of visual weight. Derived entirely from the streak prop — no
  // game state is introduced, and a streak RESET deliberately doesn't animate.
  //
  // The counter doubles as the animation key: bumping it remounts the span,
  // which is what restarts a CSS animation that has already played once.
  const [pulseKey, setPulseKey] = useState(0);
  const prevStreak = useRef(streak);

  useEffect(() => {
    if (streak > prevStreak.current) setPulseKey((n) => n + 1);
    prevStreak.current = streak;
  }, [streak]);

  return (
    <div className="score-bar">
      <div className="stat">
        <span className="stat-value">{score}</span>
        <span className="stat-label">score</span>
      </div>
      <div className="stat">
        <span key={pulseKey} className={`stat-value${pulseKey > 0 ? " pulse" : ""}`}>
          {streak}
        </span>
        <span className="stat-label">streak</span>
      </div>
      {untimed ? (
        // Replaces the countdown rather than leaving a frozen "0s left", which
        // would read as a bug.
        <div className="stat">
          <span className="stat-value">∞</span>
          <span className="stat-label">practice</span>
        </div>
      ) : (
        <div className="stat timer" data-low={timeLeft <= 5}>
          <span className="stat-value">{timeLeft}s</span>
          <span className="stat-label">left</span>
        </div>
      )}
      <div className="stat">
        <span className="stat-value">{wordsRemaining}</span>
        <span className="stat-label">to go</span>
      </div>
    </div>
  );
}
