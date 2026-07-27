import { useEffect, useRef } from "react";
import type { RoundStatus } from "../types";
import { playCorrect, playIncorrect } from "../lib/sfx";

/**
 * Play the outcome chime when a word resolves.
 *
 * ONE implementation for both screens, the same reasoning that put word
 * announcement in useAnnouncedWord: RoundScreen (singleplayer + race) and
 * TurnScreen (elimination) both need this, and a copy in each would eventually
 * drift on when it fires. The sounds themselves still live only in sfx.ts —
 * this decides WHEN, never HOW.
 *
 * Fires on the TRANSITION into a resolved status, keyed by word, so that:
 *   - a re-render during feedback does not replay the chime;
 *   - two consecutive words with the same outcome each still get one;
 *   - a word that never resolves (the player leaves) makes no sound.
 */
export function useSfxForOutcome(wordId: string | undefined, status: RoundStatus): void {
  // What we last played FOR, as a word+status pair.
  const playedFor = useRef<string | null>(null);

  useEffect(() => {
    if (status !== "correct" && status !== "incorrect") return;
    const key = `${wordId ?? "?"}:${status}`;
    if (playedFor.current === key) return;
    playedFor.current = key;
    if (status === "correct") playCorrect();
    else playIncorrect();
  }, [wordId, status]);
}
