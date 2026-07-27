import {
  Bug,
  Clover,
  Crown,
  Droplet,
  Feather,
  Flower2,
  Hexagon,
  Zap,
  type LucideIcon,
} from "lucide-react";

// The avatar preset set — the ONE place the client writes this list down.
//
// It mirrors `public.avatar_keys()` from migration 0012, which the
// `room_players.avatar` CHECK constraint validates against. The database is the
// authority: an off-list key is refused at INSERT and UPDATE time regardless of
// what this file says. This exists so the client can render a picker and so it
// never *attempts* a key the constraint would reject.
//
// The two lists are therefore coupled and must be changed together. That
// coupling is asserted, not just asserted-in-a-comment:
// supabase/scripts/verify_elimination_client.mjs reads avatar_keys() off the
// live database and fails if it disagrees with AVATAR_KEYS below. Same
// discipline as Session 15's tier de-duplication — one list, and a check that
// nothing has drifted from it.
//
// Icons are flat lucide glyphs, matching Session 12's visual language (no
// emoji, no photos, no uploads). Each is a bee-yard object so the set reads as
// one family rather than eight unrelated pictograms.

export type AvatarKey =
  | "bee"
  | "queen"
  | "drone"
  | "hive"
  | "honey"
  | "blossom"
  | "clover"
  | "wasp";

/** Must equal public.avatar_keys(), in the same order. */
export const AVATAR_KEYS: readonly AvatarKey[] = [
  "bee",
  "queen",
  "drone",
  "hive",
  "honey",
  "blossom",
  "clover",
  "wasp",
] as const;

/** Matches the column default in 0012, so an un-picked avatar agrees with the DB. */
export const DEFAULT_AVATAR: AvatarKey = "bee";

export const AVATAR_META: Record<AvatarKey, { label: string; Icon: LucideIcon }> = {
  bee: { label: "Bee", Icon: Bug },
  queen: { label: "Queen", Icon: Crown },
  drone: { label: "Drone", Icon: Feather },
  hive: { label: "Hive", Icon: Hexagon },
  honey: { label: "Honey", Icon: Droplet },
  blossom: { label: "Blossom", Icon: Flower2 },
  clover: { label: "Clover", Icon: Clover },
  wasp: { label: "Wasp", Icon: Zap },
};

export const AVATARS = AVATAR_KEYS.map((id) => ({ id, ...AVATAR_META[id] }));

export function isAvatarKey(value: unknown): value is AvatarKey {
  return typeof value === "string" && (AVATAR_KEYS as readonly string[]).includes(value);
}

/**
 * Narrow an unknown value (a database row, a localStorage string) to a usable
 * key. Falls back to the default rather than throwing: a row written by a
 * future version of the app with a key this build doesn't know about should
 * render as a bee, not crash the scoreboard.
 */
export function coerceAvatar(value: unknown): AvatarKey {
  return isAvatarKey(value) ? value : DEFAULT_AVATAR;
}
