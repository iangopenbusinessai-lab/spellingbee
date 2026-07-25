import { useEffect, useState } from "react";
import { Play, RotateCcw, Volume2 } from "lucide-react";
import {
  DEFAULT_RATE,
  getRate,
  getVoiceOverride,
  isSpeechSupported,
  loadVoices,
  pickAutoVoice,
  setRate,
  setVoiceOverride,
  speakSample,
} from "../lib/tts";

// Self-contained voice panel: owns its own open/closed state and talks only to
// tts.ts. It holds no game state, so it can sit inside DifficultySelect without
// touching the GameState-as-props rule.
//
// Voice availability differs enormously by browser and OS, so the point of this
// panel is partly transparency — showing which voice was auto-selected and
// letting the player pick a different one when the heuristic guesses wrong.

export function VoiceSettings() {
  const [open, setOpen] = useState(false);
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [selected, setSelected] = useState<string>(""); // "" = automatic
  const [rate, setRateState] = useState<number>(DEFAULT_RATE);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    setSelected(getVoiceOverride() ?? "");
    setRateState(getRate());
    void loadVoices().then((list) => {
      if (!active) return;
      setVoices(list);
      setLoading(false);
    });
    return () => {
      active = false;
    };
  }, []);

  if (!isSpeechSupported()) {
    return <p className="voice-note">This browser doesn't support speech synthesis.</p>;
  }

  const auto = pickAutoVoice(voices);
  const activeName = selected || auto?.name || "browser default";

  function chooseVoice(name: string) {
    setSelected(name);
    setVoiceOverride(name === "" ? null : name);
    speakSample();
  }

  function changeRate(next: number) {
    setRateState(next);
    setRate(next);
  }

  if (!open) {
    return (
      <button className="voice-toggle" onClick={() => setOpen(true)}>
        <Volume2 size={15} aria-hidden />
        <span className="voice-toggle-label">Voice: {activeName}</span>
      </button>
    );
  }

  return (
    <div className="voice-panel">
      <div className="voice-panel-head">
        <span className="voice-panel-title">Voice settings</span>
        <button className="voice-close" onClick={() => setOpen(false)}>
          Done
        </button>
      </div>

      {loading && <p className="voice-note">Loading voices…</p>}

      {!loading && voices.length === 0 && (
        <p className="voice-note">
          No voices are exposed by this browser. The word will still be spoken with
          the system default.
        </p>
      )}

      {!loading && voices.length > 0 && (
        <>
          <label className="field">
            <span className="field-label">
              Voice {selected === "" && auto ? `(auto: ${auto.name})` : ""}
            </span>
            <select
              className="text-input"
              value={selected}
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

          <label className="field">
            <span className="field-label">Speaking rate — {rate.toFixed(2)}×</span>
            <input
              className="voice-rate"
              type="range"
              min={0.5}
              max={1.4}
              step={0.05}
              value={rate}
              onChange={(e) => changeRate(Number(e.target.value))}
            />
          </label>

          <div className="voice-actions">
            <button className="secondary-btn" onClick={() => speakSample()}>
              <Play size={14} aria-hidden />
              Test voice
            </button>
            {selected !== "" && (
              <button
                className="secondary-btn"
                onClick={() => {
                  setSelected("");
                  setVoiceOverride(null);
                }}
              >
                <RotateCcw size={14} aria-hidden />
                Reset to automatic
              </button>
            )}
          </div>

          <p className="voice-note">
            {voices.length} voice{voices.length === 1 ? "" : "s"} available · saved to
            this browser
          </p>
        </>
      )}
    </div>
  );
}
