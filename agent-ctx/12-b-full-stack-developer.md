# Task 12-b — Voice-first Consciousness stage (agent record)

Agent: full-stack-developer (12-b)
See `/home/z/my-project/worklog.md` → Task ID 12-b for the full record. Quick integration map for wave-2 agents:

## Owned files
- `src/hooks/use-voice.ts` (NEW)
- `src/components/mist/consciousness/voice-stage.tsx` (NEW)
- `src/components/mist/consciousness/neural-core.tsx` (edited — props + sizing + wave clamp + readout gating)

## Exact exports

```ts
// src/hooks/use-voice.ts
export type VoicePhase = 'idle' | 'listening' | 'thinking' | 'speaking' | 'error'
export interface VoiceSessionState {
  active: boolean
  phase: VoicePhase
  interim: string
  lastHeard: string
  lastReply: string
  error: string | null
}
export function useVoiceSession(): VoiceSessionState & {
  start: () => void                 // begins the hands-free loop (or arms hold-to-talk)
  stop: () => void                  // full teardown (recognition, TTS, timers, orb → dormant)
  submit: (text: string) => void    // feed a transcript (hold-to-talk fallback) into the loop
  supportsRecognition: boolean      // Web Speech API present?
  heardSeq: number                  // bumps on every final utterance (persistence trigger)
}
export interface WakeWordState { supported: boolean; listening: boolean; error: string | null }
export function useWakeWord(): WakeWordState   // module-singleton engine, multi-mount safe
```

```tsx
// src/components/mist/consciousness/voice-stage.tsx
export function VoiceStage({ className }: { className?: string })   // also `export default`
// expects the parent to provide height (h-full); renders edge-to-edge
// mounts useVoiceSession + useWakeWord internally

// src/components/mist/consciousness/neural-core.tsx
export interface NeuralCoreProps {
  immersive?: boolean    // w-[min(560px,72vw,66vh)], hides bottom readouts
  docked?: boolean       // w-[min(150px,38vw)] corner-dock sizing
  onActivate?: () => void  // replaces the dream toggle when provided (ripple kept)
  activateLabel?: string   // contextual aria-label ('Talk with Mist' / 'Stop speaking' / 'End session')
}
```

## Wiring needed from the wave-2 shell (12-d1)
1. `view === 'consciousness'` → render `<VoiceStage className="h-full" />` (main gives it the full area below the navbar).
2. Mount `useWakeWord()` once app-wide (shell/navbar) for cross-view "Hey Mist" — the engine is a refcounted singleton, double-mounting with the stage is safe.
3. Floating mini-orb: `useMistStore.getState().requestVoiceSession()` (+ `setView('consciousness')`) — the stage watches `voiceArmedSeq` and auto-starts (mount-time seq > 0 is honored).
4. Backend (12-a): add `'voice'` to the neural service VALID_MODES — the hook already sends `mode: 'voice'`; until then the service falls back to 'consciousness' gracefully.

## Behavioral notes
- Orb click: idle → `voice.start()`; active → interrupt (`mistSpeech.stop()` + cancel hold + `voice.stop()`).
- Loop: listen (interim captions) → thought (mode 'voice', history = last 8 session turns, conversation_id from active thread) → response → `mistSpeech.speak` (interruptible, honors ttsEnabled) → re-arm listening. Stop phrases (`/stop|goodbye|that's all|thank you mist|sleep/i`) end the session with a spoken farewell.
- No SpeechRecognition (Firefox/sandbox): session still arms; caption shows the amber notice; big round hold-to-talk button (createMicRecorder → WAV → /voice/stt → `submit`) mirrors chat-panel's push-to-talk.
- Browser window open: orb layout-springs to `absolute right-4/6 top-4/6` at ~0.8 opacity (still clickable), captions shift bottom-left, hint row shifts left — nothing hides behind the 880px browser panel.
- Persistence: the stage appends user + assistant messages to the active thread (same meta shape as chat-panel + emotion/tools_used/skills_used); the transcript lives in the Chat tab.
- Session listening keeps the neural service in 'listening' via a quiet synthetic `voice_chunk` keep-alive every 600ms (the recognizer owns the mic, so no real energy flows — otherwise the service's 950ms dormant pulses flatten the orb).

## Verification (all green)
- `bunx eslint` on the 3 files → 0 errors · `bunx tsc --noEmit` → 0 · `bun run lint` → clean · dev.log: no compile failures.
