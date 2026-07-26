import { useState } from "react";
import { EyeOff, Timer } from "lucide-react";
import type { DifficultyTier, GameOptions } from "../types";

const TIERS: { id: DifficultyTier; label: string; blurb: string }[] = [
  { id: "easy", label: "Easy", blurb: "Common everyday words" },
  { id: "medium", label: "Medium", blurb: "Trickier spellings" },
  { id: "hard", label: "Hard", blurb: "Multi-syllable words" },
  { id: "expert", label: "Expert", blurb: "Competition-level" },
];

export function DifficultySelect({
  bests,
  onSelect,
}: {
  bests: Record<DifficultyTier, number>;
  onSelect: (tier: DifficultyTier, options?: GameOptions) => void;
}) {
  // Per-run modifiers, not stored preferences — they apply to whichever tier is
  // tapped next and are handed to startGame as GameOptions. Deliberately NOT in
  // the settings panel, which holds only global cross-cutting prefs.
  const [untimed, setUntimed] = useState(false);
  const [hideDefinition, setHideDefinition] = useState(false);

  return (
    <div className="tier-select">
      <h1>Spelling race</h1>
      <p className="subtitle">Hear it. Spell it. Beat the clock.</p>

      <div className="mode-toggles">
        <button
          className={`mode-chip${untimed ? " active" : ""}`}
          aria-pressed={untimed}
          onClick={() => setUntimed((v) => !v)}
        >
          <Timer size={15} aria-hidden />
          Practice mode
        </button>
        <button
          className={`mode-chip${hideDefinition ? " active" : ""}`}
          aria-pressed={hideDefinition}
          onClick={() => setHideDefinition((v) => !v)}
        >
          <EyeOff size={15} aria-hidden />
          Hide definition
        </button>
      </div>
      <p className="mode-hint">
        {untimed && hideDefinition
          ? "No clock, and no definition — audio only."
          : untimed
            ? "No clock. Take as long as you like on each word."
            : hideDefinition
              ? "No definition shown — spell from the audio alone."
              : "Timed, with a definition for every word."}
      </p>

      {/* Layered strata, easy at the top down to expert. */}
      <div className="tier-stack">
        {TIERS.map((t) => (
          <button
            key={t.id}
            className="tier-bar"
            data-tier={t.id}
            onClick={() => onSelect(t.id, { untimed, hideDefinition })}
          >
            <span className="tier-bar-main">
              <span className="tier-label">{t.label}</span>
              <span className="tier-blurb">{t.blurb}</span>
            </span>
            <span className="tier-best">Best {bests[t.id]}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
