import { useEffect, useState } from "react";
import { supabase } from "../lib/supabaseClient";
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

    ensureAnonymousSession()
      .then(async () => {
        const { data } = await supabase.auth.getUser();
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
    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      if (active) setState((s) => ({ ...s, userId: session?.user?.id ?? s.userId }));
    });

    return () => {
      active = false;
      sub.subscription.unsubscribe();
    };
  }, []);

  return state;
}
