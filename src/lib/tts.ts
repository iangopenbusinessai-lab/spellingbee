// Thin wrapper around the browser's built-in Web Speech API.
// Zero cost, no API key, no audio files to host — this is the same
// mechanic as the Roblox game's narrator, just free.

let voicesReady: SpeechSynthesisVoice[] = [];

if (typeof window !== "undefined" && "speechSynthesis" in window) {
  const loadVoices = () => {
    voicesReady = window.speechSynthesis.getVoices();
  };
  loadVoices();
  window.speechSynthesis.onvoiceschanged = loadVoices;
}

function speak(text: string, rate = 0.9) {
  if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
  window.speechSynthesis.cancel(); // stop anything mid-utterance first
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.rate = rate;
  const preferred = voicesReady.find((v) => v.lang.startsWith("en"));
  if (preferred) utterance.voice = preferred;
  window.speechSynthesis.speak(utterance);
}

export function speakWord(word: string) {
  speak(word, 0.8);
}

export function speakDefinition(definition: string) {
  speak(definition, 1);
}

export function isSpeechSupported(): boolean {
  return typeof window !== "undefined" && "speechSynthesis" in window;
}
