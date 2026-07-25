import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

// Whether multiplayer can work at all in this build. The env vars are inlined at
// build time, so a deploy built without them (e.g. CI missing its secrets) has
// no way to reach Supabase.
export const isSupabaseConfigured = Boolean(url && anonKey);

// IMPORTANT: creating the client — and complaining about missing config — must
// stay lazy. This module used to build the client and `throw` at module scope,
// which ran during initial module evaluation, before React ever mounted. Because
// App -> LobbyScreen -> rooms.ts imports this eagerly, a build without the env
// vars took down the ENTIRE app (blank page), including singleplayer, which
// doesn't use Supabase at all. Multiplayer config problems must degrade to "the
// multiplayer screen shows an error", never a blank site.
let client: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient {
  if (!isSupabaseConfigured) {
    throw new Error(
      "Multiplayer isn't configured for this build. Set VITE_SUPABASE_URL and " +
        "VITE_SUPABASE_ANON_KEY (see supabase/README.md) — locally in .env.local, " +
        "and in the GitHub Actions workflow for the deployed site."
    );
  }
  // Single shared client for the whole app. Default auth config persists and
  // restores the session in localStorage and auto-refreshes tokens — we
  // deliberately do not roll our own token storage. supabase-js also keeps the
  // Realtime socket's auth in sync with this session automatically.
  client ??= createClient(url, anonKey);
  return client;
}
