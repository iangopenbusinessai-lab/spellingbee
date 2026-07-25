// Theme resolution and persistence. Purely presentational — no game state.
//
// Three-way model on purpose: the stored preference is "light" | "dark" | null,
// where null means "follow the OS". Only an explicit pick by the player is
// written, so someone who never touches the toggle keeps tracking their system
// setting forever rather than being frozen into whatever it happened to be on
// their first visit.

export type Theme = "light" | "dark";

// Same "spellingbee:" convention as the best scores and voice prefs.
const THEME_KEY = "spellingbee:theme";

const MEDIA = "(prefers-color-scheme: light)";

export function getStoredTheme(): Theme | null {
  const raw = localStorage.getItem(THEME_KEY);
  return raw === "light" || raw === "dark" ? raw : null;
}

export function setStoredTheme(theme: Theme | null): void {
  if (theme) localStorage.setItem(THEME_KEY, theme);
  else localStorage.removeItem(THEME_KEY);
}

export function getSystemTheme(): Theme {
  if (typeof window === "undefined" || !window.matchMedia) return "dark";
  return window.matchMedia(MEDIA).matches ? "light" : "dark";
}

/** What the app should actually render: an explicit pick wins, else the OS. */
export function resolveTheme(): Theme {
  return getStoredTheme() ?? getSystemTheme();
}

// The stylesheet keys off data-theme on <html>. index.css ALSO carries a
// prefers-color-scheme fallback for :root:not([data-theme]), so the first paint
// is already correct in the instant before this runs.
export function applyTheme(theme: Theme): void {
  document.documentElement.setAttribute("data-theme", theme);
}

/**
 * Call back when the OS theme changes. The caller is responsible for ignoring
 * this while an explicit override is set — the listener itself stays dumb.
 */
export function onSystemThemeChange(fn: (theme: Theme) => void): () => void {
  if (typeof window === "undefined" || !window.matchMedia) return () => {};
  const mq = window.matchMedia(MEDIA);
  const handler = (e: MediaQueryListEvent) => fn(e.matches ? "light" : "dark");
  mq.addEventListener("change", handler);
  return () => mq.removeEventListener("change", handler);
}
