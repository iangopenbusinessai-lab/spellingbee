import { useEffect, useState } from "react";
import { Moon, Play, RotateCcw, Settings, Sun, X } from "lucide-react";
import {
  DEFAULT_RATE,
  DEFAULT_VOLUME,
  getRate,
  getVoiceOverride,
  getVolume,
  isSpeechSupported,
  loadVoices,
  pickAutoVoice,
  setRate,
  setVoiceOverride,
  setVolume,
  speakSample,
} from "../lib/tts";
import {
  applyTheme,
  getStoredTheme,
  onSystemThemeChange,
  resolveTheme,
  setStoredTheme,
  type Theme,
} from "../lib/theme";
import { isReduceMotionOn, setReduceMotionPreference } from "../lib/motion";
import { getDisplayName, resetBests, setDisplayName } from "../lib/storage";

// The one place for genuinely global, cross-cutting preferences. It absorbed
// Session 11's standalone VoiceSettings and Session 12's floating ThemeToggle,
// which is why neither of those components exists any more.
//
// Per-GAME modifiers (practice mode, hide definition) deliberately do NOT live
// here — they're chosen per run on the difficulty screen and are part of
// GameState, not a stored preference.
export function SettingsPanel({ onBestsReset }: { onBestsReset?: () => void }) {
  const [open, setOpen] = useState(false);

  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [voicesLoading, setVoicesLoading] = useState(true);
  const [selectedVoice, setSelectedVoice] = useState(""); // "" = automatic
  const [rate, setRateState] = useState(DEFAULT_RATE);
  const [volume, setVolumeState] = useState(DEFAULT_VOLUME);

  const [theme, setTheme] = useState<Theme>(() => resolveTheme());
  const [reduceMotion, setReduceMotionState] = useState(() => isReduceMotionOn());
  const [name, setName] = useState(() => getDisplayName());

  // Two-step confirm instead of window.confirm: a native dialog blocks the page
  // and reads as a browser artefact rather than part of the app.
  const [confirmingReset, setConfirmingReset] = useState(false);
  const [resetDone, setResetDone] = useState(false);

  useEffect(() => {
    setSelectedVoice(getVoiceOverride() ?? "");
    setRateState(getRate());
    setVolumeState(getVolume());
  }, []);

  // Voices are only needed once the panel is actually opened.
  useEffect(() => {
    if (!open) return;
    let active = true;
    void loadVoices().then((list) => {
      if (!active) return;
      setVoices(list);
      setVoicesLoading(false);
      // Re-read: with no saved rate the default depends on which voice won, and
      // that isn't known until the list exists. Without this the slider would
      // sit at the generic default while a different rate was actually in use.
      setRateState(getRate());
    });
    return () => {
      active = false;
    };
  }, [open]);

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  // Follow the OS only while the player hasn't made an explicit choice.
  useEffect(
    () => onSystemThemeChange((next) => getStoredTheme() === null && setTheme(next)),
    []
  );

  // Close on Escape, the behaviour any dialog is expected to have.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  function close() {
    setOpen(false);
    setConfirmingReset(false);
    setResetDone(false);
  }

  function chooseTheme(next: Theme) {
    setStoredTheme(next); // an explicit pick opts out of following the OS
    setTheme(next);
  }

  function chooseVoice(voiceName: string) {
    setSelectedVoice(voiceName);
    setVoiceOverride(voiceName === "" ? null : voiceName);
    speakSample();
  }

  function changeRate(next: number) {
    setRateState(next);
    setRate(next);
  }

  function changeVolume(next: number) {
    setVolumeState(next);
    setVolume(next);
  }

  function changeName(next: string) {
    setName(next);
    setDisplayName(next); // the lobby reads this same key when creating/joining
  }

  function toggleReduceMotion() {
    const next = !reduceMotion;
    setReduceMotionState(next);
    setReduceMotionPreference(next);
  }

  function doReset() {
    resetBests();
    setConfirmingReset(false);
    setResetDone(true);
    onBestsReset?.();
  }

  const auto = pickAutoVoice(voices);

  if (!open) {
    return (
      <button className="settings-toggle" onClick={() => setOpen(true)} aria-label="Settings">
        <Settings size={18} aria-hidden />
      </button>
    );
  }

  return (
    <div className="settings-scrim" onClick={close}>
      <div
        className="settings-drawer"
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="settings-head">
          <h2 className="settings-title">Settings</h2>
          <button className="settings-close" onClick={close} aria-label="Close settings">
            <X size={18} aria-hidden />
          </button>
        </div>

        <section className="settings-section">
          <h3 className="settings-section-title">Player</h3>
          <label className="field">
            <span className="field-label">Display name</span>
            <input
              className="text-input"
              value={name}
              onChange={(e) => changeName(e.target.value)}
              maxLength={24}
              placeholder="e.g. Alex"
              autoComplete="off"
            />
          </label>
          <p className="settings-note">Used when you create or join a multiplayer room.</p>
        </section>

        <section className="settings-section">
          <h3 className="settings-section-title">Voice</h3>

          {!isSpeechSupported() && (
            <p className="settings-note">This browser doesn't support speech synthesis.</p>
          )}

          {isSpeechSupported() && (
            <>
              {voicesLoading && <p className="settings-note">Loading voices…</p>}

              {!voicesLoading && voices.length === 0 && (
                <p className="settings-note">
                  No voices are exposed by this browser. Words are still spoken with the
                  system default.
                </p>
              )}

              {!voicesLoading && voices.length > 0 && (
                <label className="field">
                  <span className="field-label">
                    Voice {selectedVoice === "" && auto ? `(auto: ${auto.name})` : ""}
                  </span>
                  <select
                    className="text-input"
                    value={selectedVoice}
                    onChange={(e) => chooseVoice(e.target.value)}
                  >
                    <option value="">Automatic — best available</option>
                    {voices.map((v) => (
                      <option key={`${v.name}|${v.lang}`} value={v.name}>
                        {v.name} ({v.lang}){v.localService ? "" : " · online"}
                      </option>
                    ))}
                  </select>
                </label>
              )}

              <label className="field">
                <span className="field-label">Speaking rate — {rate.toFixed(2)}×</span>
                <input
                  className="settings-range"
                  type="range"
                  min={0.5}
                  max={1.4}
                  step={0.05}
                  value={rate}
                  onChange={(e) => changeRate(Number(e.target.value))}
                />
              </label>

              <label className="field">
                <span className="field-label">Volume — {Math.round(volume * 100)}%</span>
                <input
                  className="settings-range"
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={volume}
                  onChange={(e) => changeVolume(Number(e.target.value))}
                />
              </label>

              <button className="secondary-btn" onClick={() => speakSample()}>
                <Play size={14} aria-hidden />
                Test voice
              </button>

              {selectedVoice !== "" && (
                <button
                  className="secondary-btn"
                  onClick={() => {
                    setSelectedVoice("");
                    setVoiceOverride(null);
                  }}
                >
                  <RotateCcw size={14} aria-hidden />
                  Reset to automatic
                </button>
              )}
            </>
          )}
        </section>

        <section className="settings-section">
          <h3 className="settings-section-title">Appearance</h3>

          <div className="field">
            <span className="field-label">Theme</span>
            <div className="segmented">
              <button
                className={`segment${theme === "light" ? " active" : ""}`}
                onClick={() => chooseTheme("light")}
                aria-pressed={theme === "light"}
              >
                <Sun size={15} aria-hidden />
                Light
              </button>
              <button
                className={`segment${theme === "dark" ? " active" : ""}`}
                onClick={() => chooseTheme("dark")}
                aria-pressed={theme === "dark"}
              >
                <Moon size={15} aria-hidden />
                Dark
              </button>
            </div>
          </div>

          <button
            className="switch-row"
            role="switch"
            aria-checked={reduceMotion}
            onClick={toggleReduceMotion}
          >
            <span className="switch-text">
              <span className="switch-label">Reduce motion</span>
              <span className="switch-hint">Turn off the pop, shake and streak animations.</span>
            </span>
            <span className={`switch-track${reduceMotion ? " on" : ""}`} aria-hidden>
              <span className="switch-thumb" />
            </span>
          </button>
        </section>

        <section className="settings-section">
          <h3 className="settings-section-title">Data</h3>

          {!confirmingReset && !resetDone && (
            <button className="danger-btn" onClick={() => setConfirmingReset(true)}>
              Reset best scores
            </button>
          )}

          {confirmingReset && (
            <div className="confirm-block">
              <p className="settings-note">
                This clears your best score for all four difficulties. It can't be undone.
              </p>
              <div className="confirm-actions">
                <button className="danger-btn" onClick={doReset}>
                  Yes, reset them
                </button>
                <button className="secondary-btn" onClick={() => setConfirmingReset(false)}>
                  Cancel
                </button>
              </div>
            </div>
          )}

          {resetDone && <p className="settings-note">Best scores cleared.</p>}
        </section>
      </div>
    </div>
  );
}
