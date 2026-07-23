export function ScoreBar({
  score,
  streak,
  timeLeft,
  wordsRemaining,
}: {
  score: number;
  streak: number;
  timeLeft: number;
  wordsRemaining: number;
}) {
  return (
    <div className="score-bar">
      <div className="stat">
        <span className="stat-value">{score}</span>
        <span className="stat-label">score</span>
      </div>
      <div className="stat">
        <span className="stat-value">{streak}</span>
        <span className="stat-label">streak</span>
      </div>
      <div className="stat timer" data-low={timeLeft <= 5}>
        <span className="stat-value">{timeLeft}s</span>
        <span className="stat-label">left</span>
      </div>
      <div className="stat">
        <span className="stat-value">{wordsRemaining}</span>
        <span className="stat-label">to go</span>
      </div>
    </div>
  );
}
