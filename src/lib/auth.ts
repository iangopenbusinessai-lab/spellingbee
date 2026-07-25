import { getSupabase } from "./supabaseClient";

// Ensures exactly one anonymous sign-in per page load. Guards against React
// StrictMode's double-invoke and any concurrent callers: the first caller that
// finds no session starts the sign-in and every other caller awaits the same
// promise instead of creating a second anonymous user.
let signInPromise: Promise<void> | null = null;

export async function ensureAnonymousSession(): Promise<void> {
  const { data } = await getSupabase().auth.getSession();
  if (data.session) return;

  if (!signInPromise) {
    signInPromise = getSupabase().auth.signInAnonymously().then(({ error }) => {
      if (error) {
        signInPromise = null; // allow a later retry if this attempt failed
        throw error;
      }
    });
  }
  return signInPromise;
}
