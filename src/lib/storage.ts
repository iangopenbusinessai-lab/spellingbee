import { TIER_ORDER, type DifficultyTier } from "../types";
import { coerceAvatar, type AvatarKey } from "./avatars";

const KEY_PREFIX = "spellingbee:best:";

export function getBest(tier: DifficultyTier): number {
  const raw = localStorage.getItem(KEY_PREFIX + tier);
  const n = raw ? Number(raw) : 0;
  return Number.isFinite(n) ? n : 0;
}

export function setBest(tier: DifficultyTier, score: number): void {
  localStorage.setItem(KEY_PREFIX + tier, String(score));
}

// Built from TIER_ORDER rather than a second hand-written list, so adding a
// tier can't leave a gap here. Existing keys are untouched by the Session 15
// expansion: the four original tiers kept their exact string values.
export function getAllBests(): Record<DifficultyTier, number> {
  return Object.fromEntries(TIER_ORDER.map((t) => [t, getBest(t)])) as Record<
    DifficultyTier,
    number
  >;
}

/**
 * Wipe every stored best score. Destructive to local data and irreversible —
 * the settings panel gates it behind an in-panel confirm step.
 */
export function resetBests(): void {
  for (const tier of TIER_ORDER) localStorage.removeItem(KEY_PREFIX + tier);
}

// Remembered display name for multiplayer, so returning players don't retype it.
// Stored as room_players.display_name when they create/join a room.
const DISPLAY_NAME_KEY = "spellingbee:displayName";

export function getDisplayName(): string {
  return localStorage.getItem(DISPLAY_NAME_KEY) ?? "";
}

export function setDisplayName(name: string): void {
  localStorage.setItem(DISPLAY_NAME_KEY, name);
}

// Remembered avatar, persisted exactly like the display name above and for the
// same reason — it is the other half of "who you are" in a room, and retyping
// your identity every session is friction. Stored as room_players.avatar.
//
// Read back through coerceAvatar so a stale or hand-edited value can never
// reach the database and trip the 0012 CHECK constraint.
const AVATAR_KEY = "spellingbee:avatar";

export function getAvatar(): AvatarKey {
  return coerceAvatar(localStorage.getItem(AVATAR_KEY));
}

export function setAvatar(avatar: AvatarKey): void {
  localStorage.setItem(AVATAR_KEY, avatar);
}

// --- voice preferences -----------------------------------------------------
// Same "spellingbee:" prefix convention as the best scores above. Both are
// optional: with no saved voice, tts.ts falls back to its automatic pick, and
// with no saved rate it uses DEFAULT_RATE.

const VOICE_NAME_KEY = "spellingbee:voice:name";
const VOICE_RATE_KEY = "spellingbee:voice:rate";

/** Explicitly chosen voice name, or null to let the heuristic decide. */
export function getVoiceName(): string | null {
  return localStorage.getItem(VOICE_NAME_KEY);
}

export function setVoiceName(name: string | null): void {
  if (name) localStorage.setItem(VOICE_NAME_KEY, name);
  else localStorage.removeItem(VOICE_NAME_KEY);
}

export function getVoiceRate(): number | null {
  const raw = localStorage.getItem(VOICE_RATE_KEY);
  if (raw === null) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

export function setVoiceRate(rate: number): void {
  localStorage.setItem(VOICE_RATE_KEY, String(rate));
}

// Same voice: prefix as the name and rate above.
const VOICE_VOLUME_KEY = "spellingbee:voice:volume";

export function getVoiceVolume(): number | null {
  const raw = localStorage.getItem(VOICE_VOLUME_KEY);
  if (raw === null) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

export function setVoiceVolume(volume: number): void {
  localStorage.setItem(VOICE_VOLUME_KEY, String(volume));
}

// --- motion ----------------------------------------------------------------
// An in-app override that is INDEPENDENT of the OS prefers-reduced-motion the
// stylesheet already honours. It can only ever add suppression: with this off,
// a player whose OS asks for reduced motion still gets reduced motion.

const REDUCE_MOTION_KEY = "spellingbee:reduceMotion";

export function getReduceMotion(): boolean {
  return localStorage.getItem(REDUCE_MOTION_KEY) === "true";
}

export function setReduceMotion(on: boolean): void {
  if (on) localStorage.setItem(REDUCE_MOTION_KEY, "true");
  else localStorage.removeItem(REDUCE_MOTION_KEY);
}
