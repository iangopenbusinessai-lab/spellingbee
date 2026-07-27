import { Trophy } from "lucide-react";
import type { MultiplayerExtras } from "../hooks/useMultiplayerGame";
import { AvatarBadge } from "./AvatarPicker";

/**
 * End of an elimination game.
 *
 * RANKING, and why it is this way.
 * There is no score-based placement here. The mode's whole proposition is
 * "survive", so the honest ordering is how long you survived:
 *
 *   1st           the last player standing (rooms.winner_id, set by the server)
 *   2nd .. Nth    everyone else in REVERSE elimination order — the player
 *                 knocked out last placed highest, the first one out placed last
 *
 * Elimination order comes from extras.eliminationOrder, which orders the players
 * the SERVER already flagged eliminated by the round of their final losing turn.
 * Reversing it gives placement directly. Score is still shown, because players
 * want to see it, but it is explicitly not what decides the order — and saying
 * so on screen is cheaper than letting someone infer a ranking rule that isn't
 * there.
 *
 * The degenerate case: apply_turn_outcome can finish a game with winner_id NULL
 * if the tier runs out of unused words and the survivors are exactly tied. It is
 * unreachable in practice (150 words a tier), but rendering "undefined wins" if
 * it ever happened would be worse than handling it, so a null winner shows an
 * honest draw.
 */
export function EliminationResults({
  extras,
  onLeave,
}: {
  extras: MultiplayerExtras;
  onLeave: () => void;
}) {
  const { players, winnerId, currentUserId, eliminationOrder } = extras;

  const winner = players.find((p) => p.player_id === winnerId) ?? null;
  const iWon = Boolean(winnerId && winnerId === currentUserId);

  // Reverse elimination order = placement, best-surviving first.
  const placed = [...eliminationOrder].reverse();
  const standings = [
    ...(winner ? [winner] : []),
    ...placed
      .map((id) => players.find((p) => p.player_id === id))
      .filter((p): p is (typeof players)[number] => Boolean(p)),
  ];

  // Anyone the server never dealt into the rotation, or who somehow isn't in
  // either bucket, is appended rather than silently dropped.
  for (const p of players) {
    if (!standings.some((s) => s.player_id === p.player_id)) standings.push(p);
  }

  return (
    <div className="elim-results">
      {winner ? (
        <div className={`champion${iWon ? " mine" : ""}`}>
          <Trophy size={40} aria-hidden className="champion-cup" />
          <span className="champion-kicker">{iWon ? "You win" : "Champion"}</span>
          <span className="champion-name">
            <AvatarBadge avatar={winner.avatar} size={24} />
            {winner.display_name}
          </span>
          <span className="champion-note">
            {iWon ? "Last speller standing." : `${winner.display_name} was the last one standing.`}
          </span>
        </div>
      ) : (
        <div className="champion">
          <span className="champion-kicker">Draw</span>
          <span className="champion-note">The words ran out with nobody ahead.</span>
        </div>
      )}

      <div className="standings">
        <span className="standings-label">Final standings — by how long you lasted</span>
        <ol>
          {standings.map((p, i) => (
            <li
              key={p.player_id}
              className={`standing-row${p.player_id === currentUserId ? " you" : ""}`}
            >
              <span className="standing-place">{i + 1}</span>
              <AvatarBadge avatar={p.avatar} size={16} dimmed={p.is_eliminated} />
              <span className="standing-name">{p.display_name}</span>
              <span className="standing-score">{p.score}</span>
            </li>
          ))}
        </ol>
      </div>

      <button className="primary-btn" onClick={onLeave}>
        Back to lobby
      </button>
    </div>
  );
}
