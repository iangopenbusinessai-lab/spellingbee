import type { DifficultyTier } from "../types";

const KEY_PREFIX = "spellingbee:best:";

export function getBest(tier: DifficultyTier): number {
  const raw = localStorage.getItem(KEY_PREFIX + tier);
  const n = raw ? Number(raw) : 0;
  return Number.isFinite(n) ? n : 0;
}

export function setBest(tier: DifficultyTier, score: number): void {
  localStorage.setItem(KEY_PREFIX + tier, String(score));
}

export function getAllBests(): Record<DifficultyTier, number> {
  return {
    easy: getBest("easy"),
    medium: getBest("medium"),
    hard: getBest("hard"),
    expert: getBest("expert"),
  };
}
