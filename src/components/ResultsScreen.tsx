export function ResultsScreen({
  score,
  bestStreak,
  onReplay,
  onMenu,
}: {
  score: number;
  bestStreak: number;
  onReplay: () => void;
  onMenu: () => void;
}) {
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
