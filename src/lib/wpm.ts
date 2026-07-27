/**
 * Response-time / WPM formatting, in one place so RoundScreen and TurnScreen
 * cannot drift on either the arithmetic or the wording.
 *
 * WPM uses the standard single-word typing convention: a "word" is five
 * characters regardless of the actual word, so
 *
 *     wpm = (word.length / 5) / (seconds / 60)
 *
 * That is the same normalisation typing tests use, which is what makes a 4-letter
 * and a 12-letter word comparable at all. Reporting raw words-per-minute on a
 * one-word sample would just be 60/seconds and would say nothing about the word.
 */
export function wpmFor(wordLength: number, responseMs: number): number {
  const minutes = responseMs / 1000 / 60;
  if (minutes <= 0) return 0;
  return (wordLength / 5) / minutes;
}

/**
 * The detail appended to a correct answer, e.g. "2.1s, 61 WPM".
 *
 * Returns null when there is no honest number to show — no measured time, a
 * non-positive one, or no word — so callers render their existing feedback text
 * unchanged rather than printing "0.0s, Infinity WPM".
 */
export function formatResponseDetail(
  word: string | null | undefined,
  responseMs: number | null | undefined
): string | null {
  if (!word || responseMs == null || !Number.isFinite(responseMs) || responseMs <= 0) return null;
  const seconds = responseMs / 1000;
  const wpm = Math.round(wpmFor(word.length, responseMs));
  if (!Number.isFinite(wpm) || wpm <= 0) return null;
  return `${seconds.toFixed(1)}s, ${wpm} WPM`;
}
