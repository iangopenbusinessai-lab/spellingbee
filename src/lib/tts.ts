// The ONLY place in the app that touches window.speechSynthesis (CLAUDE.md).
// Everything else — components and hooks alike — goes through this surface.
//
// Zero cost, no API key, no audio files to host: the same narrator mechanic as
// the Roblox game, using whatever voices the browser already has.

import {
  getVoiceName,
  getVoiceRate,
  getVoiceVolume,
  setVoiceName,
  setVoiceRate,
  setVoiceVolume,
} from "./storage";

export const DEFAULT_RATE = 0.85;
const MIN_RATE = 0.5;
const MAX_RATE = 1.4;

export const DEFAULT_VOLUME = 1;

// Narrator lead-ins. Spoken as their own utterance before the word so there is
// a real pause between the two, the way a human announcer sounds — a single
// concatenated string runs them together and loses that beat.
const LEAD_INS = [
  "Try spelling this:",
  "Here's your word:",
  "Spell this word:",
  "Get ready:",
  "Your word is:",
  "Next word:",
];

function supported(): boolean {
  return typeof window !== "undefined" && "speechSynthesis" in window;
}

export function isSpeechSupported(): boolean {
  return supported();
}

// ---------------------------------------------------------------------------
// Voice loading
//
// getVoices() is empty on first call in most browsers and fills in later, when
// 'voiceschanged' fires. The previous implementation read it once at module
// load, so the very first word was usually spoken before any voice list
// existed — silently falling back to the browser default and ignoring the
// preferred-voice logic entirely.
//
// This resolves when voices actually exist, and is defensive in both
// directions: some browsers never fire 'voiceschanged' (hence the poll), and
// some genuinely expose no voices at all (hence the timeout, which resolves
// with whatever there is rather than hanging forever).
// ---------------------------------------------------------------------------
let voices: SpeechSynthesisVoice[] = [];
let voicesPromise: Promise<SpeechSynthesisVoice[]> | null = null;

const VOICE_WAIT_MS = 3000;

export function loadVoices(): Promise<SpeechSynthesisVoice[]> {
  if (!supported()) return Promise.resolve([]);
  if (voices.length > 0) return Promise.resolve(voices);
  if (voicesPromise) return voicesPromise;

  voicesPromise = new Promise<SpeechSynthesisVoice[]>((resolve) => {
    let settled = false;

    const finish = (list: SpeechSynthesisVoice[]) => {
      if (settled) return;
      settled = true;
      voices = list;
      window.speechSynthesis.removeEventListener("voiceschanged", onChanged);
      window.clearInterval(poll);
      window.clearTimeout(timeout);
      resolve(list);
    };

    const attempt = () => {
      const list = window.speechSynthesis.getVoices();
      if (list.length > 0) finish(list);
    };

    const onChanged = () => attempt();
    window.speechSynthesis.addEventListener("voiceschanged", onChanged);
    const poll = window.setInterval(attempt, 100);
    const timeout = window.setTimeout(
      () => finish(window.speechSynthesis.getVoices()),
      VOICE_WAIT_MS
    );

    attempt(); // in case they're already there
  });

  return voicesPromise;
}

/** Voices loaded so far. Empty until loadVoices() resolves. */
export function getLoadedVoices(): SpeechSynthesisVoice[] {
  return voices;
}

// ---------------------------------------------------------------------------
// Voice quality heuristic
//
// Voice naming is the only quality signal the Web Speech API exposes, and it
// varies wildly by browser and OS. Vendors label their better voices fairly
// consistently though ("Natural", "Neural", "Enhanced", "Premium"), and the
// low-footprint ones are usually marked "Compact" or are eSpeak.
//
// Scores are advisory: if nothing matches, the highest-scoring English voice
// still wins, and if there are no English voices at all we return whatever
// exists rather than nothing.
// ---------------------------------------------------------------------------
const NAME_BONUSES: { re: RegExp; points: number }[] = [
  { re: /neural/i, points: 60 },
  { re: /natural/i, points: 55 },
  { re: /premium/i, points: 50 },
  { re: /enhanced/i, points: 45 },
  { re: /\bgoogle\b/i, points: 40 },
  { re: /siri/i, points: 30 },
  { re: /\bmicrosoft\b/i, points: 15 },
];

const NAME_PENALTIES: { re: RegExp; points: number }[] = [
  { re: /compact/i, points: -40 },
  { re: /espeak/i, points: -50 },
  { re: /\bnovelty\b|\banimal\b|bells|bubbles|zarvox|trinoids/i, points: -80 },
];

export function scoreVoice(v: SpeechSynthesisVoice): number {
  let score = 0;
  for (const { re, points } of NAME_BONUSES) if (re.test(v.name)) score += points;
  for (const { re, points } of NAME_PENALTIES) if (re.test(v.name)) score += points;

  // Prefer the major English locales, which get the most vendor attention.
  if (/^en[-_]?(US|GB)/i.test(v.lang)) score += 12;
  else if (/^en/i.test(v.lang)) score += 6;

  // Cloud voices are usually the better-sounding ones; small nudge only,
  // because they also need a network round trip.
  if (!v.localService) score += 8;

  if (v.default) score += 2; // tie-break toward the platform's own choice
  return score;
}

// ---------------------------------------------------------------------------
// Hard default voice.
//
// A specific chosen-by-ear default, checked BEFORE the scoring heuristic rather
// than expressed as a big score bonus: a bonus would still lose to some future
// "Neural"/"Premium" voice on another platform, and the point here is that this
// exact voice wins wherever it exists.
//
// It sits BELOW a saved override in priority (resolveVoice checks localStorage
// first) and ABOVE the heuristic, which is untouched and still handles every
// browser that doesn't ship this voice.
// ---------------------------------------------------------------------------
export const DEFAULT_VOICE_NAME = "Google UK English Male";

/** Rate used when DEFAULT_VOICE_NAME is the voice actually in effect. */
export const DEFAULT_VOICE_RATE = 0.9;

/** Best available English voice, or null if there are none. */
export function pickAutoVoice(list: SpeechSynthesisVoice[] = voices): SpeechSynthesisVoice | null {
  if (list.length === 0) return null;
  const preferred = list.find((v) => v.name === DEFAULT_VOICE_NAME);
  if (preferred) return preferred;
  // Not available in this browser — the original heuristic, unchanged.
  const english = list.filter((v) => /^en/i.test(v.lang));
  const pool = english.length > 0 ? english : list; // degrade rather than give up
  return pool.reduce((best, v) => (scoreVoice(v) > scoreVoice(best) ? v : best), pool[0]);
}

/** The voice actually used right now: a saved override if valid, else the auto pick. */
export function resolveVoice(list: SpeechSynthesisVoice[] = voices): SpeechSynthesisVoice | null {
  const saved = getVoiceName();
  if (saved) {
    const match = list.find((v) => v.name === saved);
    if (match) return match;
    // Saved voice is gone (different browser/machine) — fall through to auto
    // rather than leaving the player with no voice at all.
  }
  return pickAutoVoice(list);
}

export function getRate(): number {
  const saved = getVoiceRate();
  if (saved !== null) return Math.min(MAX_RATE, Math.max(MIN_RATE, saved));
  // No saved rate: the default depends on which voice is actually in effect,
  // because DEFAULT_VOICE_NAME reads better slightly slower than the others.
  // Before voices have loaded this resolves to null and falls back to
  // DEFAULT_RATE; every speak path awaits loadVoices() first, so by the time an
  // utterance is built the right answer is available.
  return resolveVoice()?.name === DEFAULT_VOICE_NAME ? DEFAULT_VOICE_RATE : DEFAULT_RATE;
}

export function setRate(rate: number): void {
  setVoiceRate(Math.min(MAX_RATE, Math.max(MIN_RATE, rate)));
}

/** Utterance volume, 0-1. Clamped on both read and write. */
export function getVolume(): number {
  const saved = getVoiceVolume();
  if (saved === null) return DEFAULT_VOLUME;
  return Math.min(1, Math.max(0, saved));
}

export function setVolume(volume: number): void {
  setVoiceVolume(Math.min(1, Math.max(0, volume)));
}

export function setVoiceOverride(name: string | null): void {
  setVoiceName(name);
}

export function getVoiceOverride(): string | null {
  return getVoiceName();
}

// Name of the voice attached to the most recent utterance. Exposed so the
// settings UI (and verification) can confirm what is actually being spoken
// rather than what was merely requested.
let lastUsedVoiceName: string | null = null;
export function getLastUsedVoiceName(): string | null {
  return lastUsedVoiceName;
}

// ---------------------------------------------------------------------------
// Speaking
// ---------------------------------------------------------------------------

// Bumped on every new announcement. A chained utterance checks it before
// speaking, so an announcement that has been superseded (new word, or the
// player hitting replay) can't fire its second half over the new one.
let generation = 0;

function makeUtterance(text: string, rate: number, voice: SpeechSynthesisVoice | null) {
  const u = new SpeechSynthesisUtterance(text);
  u.rate = rate;
  // Read per-utterance rather than captured once, so a volume change in the
  // settings panel applies to the very next thing spoken.
  u.volume = getVolume();
  if (voice) {
    u.voice = voice;
    u.lang = voice.lang;
    lastUsedVoiceName = voice.name;
  } else {
    lastUsedVoiceName = null;
  }
  return u;
}

/** Speak one phrase on its own, cancelling anything already in progress. */
async function speakAlone(text: string, rate: number): Promise<void> {
  if (!supported()) return;
  const list = await loadVoices();
  generation++;
  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(makeUtterance(text, rate, resolveVoice(list)));
}

/**
 * Speak the lead-in, wait for it to finish, then speak the word.
 *
 * The wait is a real chain on utterance.onend rather than a fixed delay, so the
 * pause tracks however long the chosen voice actually takes. onend is not
 * reliable everywhere though (it never fires if the utterance is cancelled, and
 * some engines drop it), so a timeout guard speaks the word anyway — the word
 * is the part that matters and must never be lost to a missing event.
 */
async function speakSequence(leadIn: string, word: string): Promise<void> {
  if (!supported()) return;
  const list = await loadVoices();

  const mine = ++generation;
  const voice = resolveVoice(list);
  const rate = getRate();
  const leadRate = Math.min(MAX_RATE, rate + 0.1); // intro a touch brisker

  window.speechSynthesis.cancel();

  let wordSpoken = false;
  const sayWord = () => {
    if (wordSpoken || mine !== generation) return;
    wordSpoken = true;
    window.clearTimeout(guard);
    window.speechSynthesis.speak(makeUtterance(word, rate, voice));
  };

  const intro = makeUtterance(leadIn, leadRate, voice);
  intro.onend = sayWord;

  // Fallback: rough spoken duration of the lead-in plus slack.
  const guard = window.setTimeout(sayWord, (leadIn.length / 10) * 1000 + 2500);

  window.speechSynthesis.speak(intro);
}

// Remembered so "hear it again" replays the SAME intro for the same word; a
// different word re-rolls.
let lastAnnouncedWord: string | null = null;
let lastLeadIn: string | null = null;

/**
 * Announce a word the way the narrator does: a random lead-in phrase, a
 * natural pause, then the word.
 *
 * Returns the lead-in it used (synchronously, before any audio starts) so the
 * caller can show the same words on screen that the player is about to hear.
 */
export function announceWord(word: string): string {
  const leadIn =
    word === lastAnnouncedWord && lastLeadIn
      ? lastLeadIn
      : LEAD_INS[Math.floor(Math.random() * LEAD_INS.length)];

  lastAnnouncedWord = word;
  lastLeadIn = leadIn;

  void speakSequence(leadIn, word);
  return leadIn;
}

/** The lead-in currently attached to a word, if it has been announced. */
export function getLeadInFor(word: string): string | null {
  return word === lastAnnouncedWord ? lastLeadIn : null;
}

/**
 * Stop anything currently being spoken and cancel a pending chained word.
 *
 * Bumping the generation matters as much as cancel() does: an announcement
 * whose lead-in is cut off mid-flight would otherwise still fire its queued
 * second half from the onend/timeout chain, and the word would be read out
 * after the player has already left the round.
 */
export function stopSpeaking(): void {
  if (!supported()) return;
  generation++;
  window.speechSynthesis.cancel();
}

/** Speak just the word, no intro. */
export function speakWord(word: string): void {
  void speakAlone(word, getRate());
}

export function speakDefinition(definition: string): void {
  void speakAlone(definition, Math.min(MAX_RATE, getRate() + 0.15));
}

/** Sample used by the voice settings "test" button. */
export function speakSample(text = "Here's your word: rhythm"): void {
  void speakAlone(text, getRate());
}
