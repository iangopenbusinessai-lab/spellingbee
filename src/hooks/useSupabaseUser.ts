import { useEffect, useState } from "react";
import { getSupabase, isSupabaseConfigured } from "../lib/supabaseClient";
import { ensureAnonymousSession } from "../lib/auth";

export interface SupabaseUserState {
  userId: string | null;
  ready: boolean;
  error: string | null;
}

// Signs the visitor in anonymously (once) and tracks their auth user id.
// Keeps the singleplayer path completely independent — nothing here runs unless
// this hook is mounted, which only happens on the multiplayer path.
export function useSupabaseUser(): SupabaseUserState {
  const [state, setState] = useState<SupabaseUserState>({
    userId: null,
    ready: false,
    error: null,
  });

  useEffect(() => {
    let active = true;

    // No Supabase config in this build: report it as a normal auth error so the
    // lobby renders a message with a way back, instead of throwing.
    if (!isSupabaseConfigured) {
      setState({
        userId: null,
        ready: true,
        error:
          "Multiplayer isn't configured for this build (missing Supabase env vars). " +
          "Singleplayer still works.",
      });
      return;
    }

    ensureAnonymousSession()
      .then(async () => {
        const { data } = await getSupabase().auth.getUser();
        if (active) setState({ userId: data.user?.id ?? null, ready: true, error: null });
      })
      .catch((e: unknown) => {
        if (active) {
          setState({
            userId: null,
            ready: true,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      });

    // Keep the id fresh across token refreshes / future account upgrades.
    const { data: sub } = getSupabase().auth.onAuthStateChange((_event, session) => {
      if (active) setState((s) => ({ ...s, userId: session?.user?.id ?? s.userId }));
    });

    return () => {
      active = false;
      sub.subscription.unsubscribe();
    };
  }, []);

  return state;
}
