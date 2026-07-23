import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!url || !anonKey) {
  throw new Error(
    "Missing Supabase config. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY " +
      "in .env.local (see supabase/README.md)."
  );
}

// Single shared client for the whole app. Default auth config persists and
// restores the session in localStorage and auto-refreshes tokens — we
// deliberately do not roll our own token storage. supabase-js also keeps the
// Realtime socket's auth in sync with this session automatically.
export const supabase = createClient(url, anonKey);
