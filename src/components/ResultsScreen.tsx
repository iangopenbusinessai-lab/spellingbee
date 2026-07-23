export function ResultsScreen({
  score,
  bestStreak,
  best,
  onReplay,
  onMenu,
}: {
  score: number;
  bestStreak: number;
  best: number;
  onReplay: () => void;
  onMenu: () => void;
}) {
  const isNewBest = score >= best && score > 0;
  return (
    <div className="results-screen">
      <h2>Round complete</h2>
      <div className="results-stats">
        <div className="stat">
          <span className="stat-value">{score}</span>
          <span className="stat-label">final score</span>
        </div>
        <div className="stat">
          <span className="stat-value">{bestStreak}</span>
          <span className="stat-label">best streak</span>
        </div>
      </div>
      <p className="results-best">
        Best: {best}
        {isNewBest && " — new best!"}
      </p>
      <div className="results-actions">
        <button className="primary-btn" onClick={onReplay}>
          Play again
        </button>
        <button className="ghost-btn" onClick={onMenu}>
          Change difficulty
        </button>
      </div>
    </div>
  );
}
