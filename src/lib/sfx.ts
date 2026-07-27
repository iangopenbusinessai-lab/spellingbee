// sfx.ts — the ONE place sound effects are produced.
//
// Same discipline tts.ts holds for speech: no component ever touches
// AudioContext directly, exactly as no component ever touches
// window.speechSynthesis. Everything below is synthesized from oscillators and
// gain envelopes — there are no audio files in this project and there should not
// be. A .mp3 would need hosting, a loading state, a decode step and a licence;
// three short UI sounds do not justify any of that.
//
// WHY THIS IS SEPARATE FROM THE VOICE SETTINGS (Session 13's volume/rate)
// ---------------------------------------------------------------------------
// Narration and UI feedback are different things to a player. Someone practising
// in a quiet room may want the word read aloud with no chime on every keystroke;
// someone who already knows the words may want the opposite. They therefore get
// their own toggle, their own volume and their own storage keys
// ("spellingbee:sfx:*"), and neither reads the other's value.
//
// AUTOPLAY POLICY
// ---------------------------------------------------------------------------
// Browsers refuse to start an AudioContext until the page has seen a user
// gesture. The context is therefore created lazily on first use and resumed if
// it comes back suspended. Every entry point is a no-op when sound is off, so
// nothing here can throw into a render path.

import { getSfxEnabled, getSfxVolume } from "./storage";

export const DEFAULT_SFX_VOLUME = 0.6;
export const DEFAULT_SFX_ENABLED = true;

const MIN_VOLUME = 0;
const MAX_VOLUME = 1;

let ctx: AudioContext | null = null;

/** Runtime cache of the persisted prefs, so a sound never costs a localStorage read. */
let enabled: boolean | null = null;
let volume: number | null = null;

export function isSfxSupported(): boolean {
  return typeof window !== "undefined" && "AudioContext" in window;
}

export function getEnabled(): boolean {
  if (enabled === null) enabled = getSfxEnabled() ?? DEFAULT_SFX_ENABLED;
  return enabled;
}

export function setEnabled(on: boolean): void {
  enabled = on;
}

export function getVolume(): number {
  if (volume === null) volume = getSfxVolume() ?? DEFAULT_SFX_VOLUME;
  return volume;
}

export function setVolume(v: number): void {
  volume = Math.min(MAX_VOLUME, Math.max(MIN_VOLUME, v));
}

function audio(): AudioContext | null {
  if (!isSfxSupported()) return null;
  try {
    if (!ctx) ctx = new AudioContext();
    // Suspended is the normal state before the page's first gesture, and also
    // after a tab is backgrounded on some platforms.
    if (ctx.state === "suspended") void ctx.resume();
    return ctx;
  } catch {
    return null;
  }
}

/**
 * One shaped tone. The envelope matters more than the waveform for how harsh a
 * sound reads: an instant attack clicks, so every tone below ramps up over a few
 * milliseconds and decays exponentially rather than cutting off.
 */
function tone(
  startAt: number,
  freq: number,
  durationSec: number,
  peak: number,
  type: OscillatorType = "sine",
  glideTo?: number
): void {
  const ac = audio();
  if (!ac) return;

  const osc = ac.createOscillator();
  const gain = ac.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, startAt);
  if (glideTo !== undefined) {
    osc.frequency.exponentialRampToValueAtTime(Math.max(1, glideTo), startAt + durationSec);
  }

  const level = Math.max(0.0001, peak * getVolume());
  gain.gain.setValueAtTime(0.0001, startAt);
  gain.gain.exponentialRampToValueAtTime(level, startAt + 0.012); // soft attack
  gain.gain.exponentialRampToValueAtTime(0.0001, startAt + durationSec);

  osc.connect(gain);
  gain.connect(ac.destination);
  osc.start(startAt);
  osc.stop(startAt + durationSec + 0.02);
}

/** Shared guard: every public sound goes through this. */
function play(fn: (ac: AudioContext, now: number) => void): void {
  if (!getEnabled()) return;
  const ac = audio();
  if (!ac) return;
  try {
    fn(ac, ac.currentTime);
  } catch {
    // A sound failing must never break a turn.
  }
}

/**
 * Answer sent. Deliberately the plainest of the three and the quietest: it fires
 * on every submission including wrong ones, so it must not colour the player's
 * expectation of the verdict. One short muted click, no pitch movement.
 */
export function playSubmit(): void {
  play((_ac, now) => {
    tone(now, 320, 0.07, 0.14, "triangle");
  });
}

/** Correct. A rising major third (A5 -> C#6), which reads as resolved/upward. */
export function playCorrect(): void {
  play((_ac, now) => {
    tone(now, 880, 0.13, 0.2, "sine");
    tone(now + 0.09, 1108.73, 0.22, 0.18, "sine");
  });
}

/**
 * Incorrect. A short descending pair, and deliberately NOT a buzzer: this fires
 * on a miss and on every timeout, several times a game, and a harsh sound there
 * is punishing rather than informative. Sine waves an octave below the correct
 * chime, gliding down — unmistakably "no" without being unpleasant.
 */
export function playIncorrect(): void {
  play((_ac, now) => {
    tone(now, 392, 0.16, 0.18, "sine", 349.23);
    tone(now + 0.12, 261.63, 0.26, 0.16, "sine", 233.08);
  });
}

/** Used by the settings panel so the player can hear a level while setting it. */
export function playPreview(): void {
  playCorrect();
}
