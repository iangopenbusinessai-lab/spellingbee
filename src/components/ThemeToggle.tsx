import { useEffect, useState } from "react";
import { Moon, Sun } from "lucide-react";
import {
  applyTheme,
  getStoredTheme,
  onSystemThemeChange,
  resolveTheme,
  setStoredTheme,
  type Theme,
} from "../lib/theme";

// Rendered once inside the app shell, so it's reachable from every screen —
// mode select, lobby, waiting room, round and results — rather than only from
// the difficulty screen. Holds no game state.
export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(() => resolveTheme());

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  // Track the OS only while the player hasn't made an explicit choice.
  useEffect(
    () => onSystemThemeChange((next) => getStoredTheme() === null && setTheme(next)),
    []
  );

  function toggle() {
    const next: Theme = theme === "dark" ? "light" : "dark";
    setStoredTheme(next); // from here on this player has opted out of the OS
    setTheme(next);
  }

  const goingTo = theme === "dark" ? "light" : "dark";

  return (
    <button
      className="theme-toggle"
      onClick={toggle}
      aria-label={`Switch to ${goingTo} mode`}
      title={`Switch to ${goingTo} mode`}
    >
      {theme === "dark" ? <Moon size={18} aria-hidden /> : <Sun size={18} aria-hidden />}
    </button>
  );
}
