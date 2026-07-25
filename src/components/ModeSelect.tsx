import { Users, User } from "lucide-react";

export function ModeSelect({
  onSingle,
  onMulti,
}: {
  onSingle: () => void;
  onMulti: () => void;
}) {
  return (
    <div className="mode-select">
      <h1>Spelling race</h1>
      <p className="subtitle">Hear it. Spell it. Beat the clock.</p>
      <div className="mode-grid">
        <button className="mode-card" onClick={onSingle}>
          <User className="mode-card-icon" size={22} aria-hidden />
          <span className="mode-title">Singleplayer</span>
          <span className="mode-blurb">Practice solo against the clock</span>
        </button>
        <button className="mode-card" onClick={onMulti}>
          <Users className="mode-card-icon" size={22} aria-hidden />
          <span className="mode-title">Multiplayer</span>
          <span className="mode-blurb">Race friends in a shared room</span>
        </button>
      </div>
    </div>
  );
}
