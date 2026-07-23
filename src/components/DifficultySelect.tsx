import type { DifficultyTier } from "../types";

const TIERS: { id: DifficultyTier; label: string; blurb: string }[] = [
  { id: "easy", label: "Easy", blurb: "Common everyday words" },
  { id: "medium", label: "Medium", blurb: "Trickier spellings" },
  { id: "hard", label: "Hard", blurb: "Multi-syllable words" },
  { id: "expert", label: "Expert", blurb: "Competition-level" },
];

export function DifficultySelect({ onSelect }: { onSelect: (tier: DifficultyTier) => void }) {
  return (
    <div className="tier-select">
      <h1>Spelling race</h1>
      <p className="subtitle">Hear it. Spell it. Beat the clock.</p>
      <div className="tier-grid">
        {TIERS.map((t) => (
          <button key={t.id} className="tier-card" onClick={() => onSelect(t.id)}>
            <span className="tier-label">{t.label}</span>
            <span className="tier-blurb">{t.blurb}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
