import { useEffect, useState } from "react";
import { announceWord } from "../lib/tts";

/**
 * Announce each new word once, and hand back the lead-in phrase that was
 * spoken so the screen can display the same words the narrator used.
 *
 * WHY THIS IS A HOOK (Session 20).
 * CLAUDE.md's rule through Session 17 was "RoundScreen is the ONLY place that
 * speaks a word". The intent behind it was never the file name — it was that
 * the engine hooks must not speak (both modes render the same screen, so a
 * speak call in an engine would double every word), and that there must be
 * exactly ONE implementation of the announcement so the spoken and displayed
 * lead-in can never disagree.
 *
 * Elimination needs a genuinely different screen: a turn belongs to one player
 * while everyone else watches, which is not RoundScreen's shape. Rather than
 * copy the announcement into TurnScreen — which is what would actually have
 * broken the rule — the announcement moved here. Both screens call this, so
 * there is still one implementation and still exactly one call per word.
 *
 * The engine hooks still do not speak. That half of the rule is unchanged.
 *
 * Spectators announce too, deliberately: an eliminated player watching the rest
 * of the match should hear the words being read out, or they are looking at a
 * silent transcript of a spelling bee.
 *
 * Keyed on the word ID rather than the text so two rounds that happen to draw
 * the same word still announce, and so a re-render never re-announces.
 */
export function useAnnouncedWord(
  wordId: string | undefined,
  wordText: string | undefined
): string | null {
  const [leadIn, setLeadIn] = useState<string | null>(null);

  useEffect(() => {
    if (!wordText) return;
    // Small beat so the new word paints before audio starts.
    const t = window.setTimeout(() => setLeadIn(announceWord(wordText)), 200);
    return () => window.clearTimeout(t);
  }, [wordId, wordText]);

  return leadIn;
}
