# Spelling Race — CLAUDE.md

## Project overview
Word-spelling race game, built singleplayer first, multiplayer planned.
Stack: Vite + React + TypeScript, deployed to GitHub Pages via GitHub Actions.
Repo: https://github.com/iangopenbusinessai-lab/spellingbee (confirm/update if different)
Live: https://iangopenbusinessai-lab.github.io/spellingbee/

## CRITICAL: vite.config.ts
`base` must always be `'/spellingbee/'` — never change this, never remove it,
never revert to `base: '/'`. If the repo name above is wrong, update both
this file and vite.config.ts together, never just one.

## Deploy
Deploys via `.github/workflows/deploy.yml` on every push to `main`
(GitHub Actions → Pages). Do NOT introduce the `gh-pages` npm package or a
`gh-pages` branch — this project deploys via Actions only.

## Architecture rules — never violate
- All game state flows through the `GameState` shape in `src/types.ts`.
  Components only ever receive `GameState` as a prop — never call
  `useGameEngine` (or any future game-state hook) directly from inside a
  presentational component like `RoundScreen` or `ScoreBar`.
- Answer checking lives behind a single function boundary inside the engine
  hook — never inline the string-comparison logic anywhere else. This is the
  seam where multiplayer later swaps local comparison for a server
  round-trip without touching the UI.
- `WordEntry`'s shape is stable: `id, word, tier, definition, partOfSpeech?`.
  Don't bolt ad-hoc fields onto individual words — extend the interface if a
  field is genuinely needed everywhere, and update this file when you do.
- All speech synthesis goes through `src/lib/tts.ts` — never call
  `window.speechSynthesis` directly from a component.
- No component may assume there is exactly one player in a way that's hard
  to reverse later (e.g. hardcoded "your score" logic that can't extend to
  multiple players' scores once multiplayer exists).

## Core types (do not change without updating this file)
```ts
type DifficultyTier = "easy" | "medium" | "hard" | "expert";

interface WordEntry {
  id: string;
  word: string;
  tier: DifficultyTier;
  definition: string;
  partOfSpeech?: string;
}

type RoundStatus = "idle" | "playing" | "correct" | "incorrect" | "finished";

interface GameState {
  tier: DifficultyTier | null;
  status: RoundStatus;
  currentWord: WordEntry | null;
  score: number;
  streak: number;
  bestStreak: number;
  timeLeft: number;
  wordsRemaining: number;
}
```

## Current state
Singleplayer is complete and deployed: difficulty select → timed word round
with spoken pronunciation → scoring/streak tracking → results screen. No
backend exists yet. Multiplayer (Supabase realtime + edge function answer
validation) is planned but not started — the roadmap for that is tracked
outside this file, not here.

## Naming note
Local dev folder/npm package name may still say "spelling-race" from
initial scaffolding — that's cosmetic and doesn't need to match the repo
name. The GitHub repo and deployed URL are "spellingbee". Use
"spellingbee" as the prefix for any localStorage keys going forward
(e.g. "spellingbee:best:easy"), not "spelling-race".

## Commands
- `npm run dev` — local dev server
- `npm run build` — production build (also runs `tsc -b`, must pass clean)
- Push to `main` — auto-deploys via GitHub Actions, no manual deploy step
