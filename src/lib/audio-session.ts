// M.I.S.T. audio-session machine (Phase 3-b · Truth & lifecycle).
//
// ONE source of truth for "what is the audio session doing right now":
//   idle → listening (mic armed) → thinking (transcript final) → speaking
//   (TTS started) → barge-in (speech detected while speaking, w4) → listening
//   …and any → idle (cancel / stop / natural end).
//
// Before this module the audio truth was scattered across use-voice's
// recogniser phases, voice-stage's caption gates, chat-panel's awaiting flag
// and speech.ts's playback internals — four copies that could (and did) drift
// apart. The machine is NOT a rewrite of those pipelines: each existing code
// path calls transition() at the state change it already performs, and the
// surfaces (voice-stage captions/hints) read the store. Invalid transitions
// are REJECTED silently (lastRejected records them for diagnostics) — a
// pipeline bug can no longer teleport the audio state, only walk real edges.
//
// The table is the mandate's cycle PLUS the edges the real pipelines
// genuinely exercise (each addition is load-bearing; remove one and a
// legitimate path gets rejected):
//   idle→thinking     chat-panel send (typed message → LLM thinking, no mic)
//   idle→speaking     chat auto-speak / alerts / welcome (TTS without a mic)
//   speaking→listening  voice loop re-arms after the reply ends (onSpeakEnd)
//   thinking→listening  empty capture re-arm (whisper/server-STT heard nothing)
//   speaking→thinking   a new turn starts thinking while the previous reply's
//                       tail still plays (chat send mid-speech; the tail's
//                       natural end then no-ops instead of flattening to idle)
//
// Known honest reject: listening→speaking (an alert speaking while a mic
// session listens) is NOT an edge — the mic session keeps the truth and the
// consciousness-state store still shows 'speaking' on the orb. Rare by
// construction (alerts fire outside active listening turns).
'use client'

import { create } from 'zustand'

export type AudioSessionState = 'idle' | 'listening' | 'thinking' | 'speaking' | 'barge-in'

/** Valid edges per state ('idle' present in every row = any→idle cancel). */
const VALID: Record<AudioSessionState, ReadonlySet<AudioSessionState>> = {
  idle: new Set(['listening', 'thinking', 'speaking', 'idle']),
  listening: new Set(['thinking', 'idle', 'listening']),
  thinking: new Set(['speaking', 'listening', 'idle', 'thinking']),
  speaking: new Set(['barge-in', 'listening', 'thinking', 'idle', 'speaking']),
  'barge-in': new Set(['listening', 'idle', 'barge-in']),
}

export interface AudioSessionStore {
  phase: AudioSessionState
  /** The most recent rejected edge, if any — diagnostics only, never throws. */
  lastRejected: { from: AudioSessionState; to: AudioSessionState } | null
  /**
   * Walk one edge. Same-state calls are accepted no-ops (pipelines re-publish
   * their current phase legitimately). Returns false on an invalid edge —
   * the state is left untouched.
   */
  transition: (next: AudioSessionState) => boolean
}

export const useAudioSession = create<AudioSessionStore>((set, get) => ({
  phase: 'idle',
  lastRejected: null,
  transition: (next) => {
    const cur = get().phase
    if (next === cur) return true
    if (!VALID[cur].has(next)) {
      set({ lastRejected: { from: cur, to: next } })
      return false
    }
    set({ phase: next, lastRejected: null })
    return true
  },
}))

/** Non-React read (speech.ts / use-voice publish through this). */
export function audioSessionPhase(): AudioSessionState {
  return useAudioSession.getState().phase
}

/** Test seam: walk the machine back to idle without touching VALID. */
export function resetAudioSession(): void {
  useAudioSession.setState({ phase: 'idle', lastRejected: null })
}
