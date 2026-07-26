// In-app "reduce motion" override.
//
// Deliberately additive to the OS-level prefers-reduced-motion that index.css
// has honoured since Session 12: this can only ever ADD suppression. With the
// override off, a player whose system asks for reduced motion still gets it.
// There is no way to use this to force animation back on, which is the point —
// an accessibility preference the OS states should not be overridable by a game.
//
// Only the flag lives here; the suppression itself is the same CSS block the
// media query uses, so both paths switch off exactly the same animations.

import { getReduceMotion, setReduceMotion } from "./storage";

export function isReduceMotionOn(): boolean {
  return getReduceMotion();
}

export function setReduceMotionPreference(on: boolean): void {
  setReduceMotion(on);
  applyReduceMotion(on);
}

/** Mirror the flag onto <html>, where the stylesheet can see it. */
export function applyReduceMotion(on: boolean): void {
  if (on) document.documentElement.setAttribute("data-reduce-motion", "true");
  else document.documentElement.removeAttribute("data-reduce-motion");
}
