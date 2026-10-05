// M.I.S.T. face bus (v7) — the live state feed for the embedded
// ai-visualizer faces AND the outbound signal bus for the OWNER's machine.
//
// Two consumers, one source of truth:
//  1. EMBEDDED FACES: the iframes under /av/faces/* poll window.__mistBus
//     (same-origin parent) — their core.js fetch("/state") is intercepted by
//     the shim we injected into each face and answered from this module, so
//     the circuit board / radial / rain / neural core perform Mist's REAL
//     voice state with her REAL audio waveform (tapped from the shared
//     analyser in audio-bus.ts).
//  2. THE OWNER'S MACHINE: the same state changes are POSTed (throttled) to
//     /api/mist/bridge/signal → the Mist Bridge v2 daemon writes the
//     backtalk/ai-visualizer ".voice_*" file contract, so every standalone
//     companion face on the user's PC animates to Mist too. Zero-cost no-op
//     when the bridge is offline.
//
// The response shape mirrors the ai-visualizer server's /state exactly:
//   {state, level, samples, alert, loading, rate_limits}
// level semantics copied faithfully from the reference server:
//   level = mean(|samples|)/3000, and 0 when the waveform is stale (>0.6s).
'use client'

import type { ConsciousnessState } from './types'
import { mistAudioWaveform, mistAudioFormants } from './audio-bus'

/** The four states of the backtalk/ai-visualizer bus contract. */
export type BusState = 'idle' | 'listening' | 'thinking' | 'speaking'

/** Map a Mist consciousness state onto the bus contract. */
export function toBusState(s: ConsciousnessState): BusState {
  switch (s) {
    case 'listening':
      return 'listening'
    case 'processing':
      return 'thinking'
    case 'speaking':
      return 'speaking'
    case 'dreaming':
    case 'awakening':
    case 'dormant':
    default:
      return 'idle'
  }
}

/** Shape returned to the embedded faces (byte-compatible with their server). */
export interface FaceBusState {
  state: BusState
  level: number
  samples: number[]
  alert: boolean
  loading: boolean
  rate_limits: Record<string, never>
  /** LIVE mouth-tracking frame (w3-mouth, additive — existing faces ignore it).
   *  Present only while speaking: formant openness/width + the closure flag
   *  (a bilabial/stopped frame — the lips must press). Absent otherwise, so
   *  faces animate back to their rest pose on their own. */
  mouth?: { openness: number; width: number; closure: boolean }
}

/** Shape returned for /config (name/badge/thinking_sound come from here). */
export interface FaceBusConfig {
  name: string
  badge: string
  face: string
  thinking_sound: boolean
  faces: { id: string; title: string; tagline: string }[]
}

// ---------------- module singleton ----------------

interface FaceBusGlobal {
  state: BusState
  /** Last written waveform + when (seconds). Stale ⇒ level 0 (server parity). */
  samples: number[]
  samplesAt: number
  alert: boolean
  name: string
  badge: string
}

declare global {
  interface Window {
    /** Read by the shim injected into /av/faces/* (same-origin iframes). */
    __mistBus?: {
      state: () => FaceBusState
      config: () => FaceBusConfig
    }
  }
}

const g: FaceBusGlobal = {
  state: 'idle',
  samples: new Array(64).fill(0),
  samplesAt: 0,
  alert: false,
  name: 'MIST',
  badge: 'CONSCIOUSNESS',
}

/** Fresh enough? (the reference server treats >0.6s waveforms as stale). */
function waveformFresh(): boolean {
  return Date.now() / 1000 - g.samplesAt < 0.6
}

/** The live /state answer for embedded faces. */
function busState(): FaceBusState {
  const fresh = waveformFresh()
  let level = 0
  if (fresh) {
    let sum = 0
    for (const v of g.samples) sum += Math.abs(v)
    level = Math.min(1, sum / g.samples.length / 3000)
  }
  const state = fresh && g.state !== 'listening' ? 'speaking' : g.state
  const resp: FaceBusState = {
    state,
    level,
    samples: fresh ? g.samples : g.samples.map(() => 0),
    alert: g.alert,
    loading: false,
    rate_limits: {},
  }
  // While she is speaking, ship the LIVE formant mouth frame (w3-mouth) —
  // the visage face polls this at animation rate and runs the tau physics
  // on it. Computed per poll so the mouth tracks the audio in real time.
  if (state === 'speaking') {
    const f = mistAudioFormants()
    if (f) resp.mouth = { openness: f.openness, width: f.width, closure: f.closure }
  }
  return resp
}

/** The /config answer for embedded faces (sound off — Mist owns her sounds). */
function busConfig(): FaceBusConfig {
  return {
    name: g.name,
    badge: g.badge,
    face: 'mist',
    thinking_sound: false,
    faces: [
      // w3-mouth — M.I.S.T.'s own clean-room face (the four adapted
      // ai-visualizer faces predate this list; they never rendered it)
      {
        id: 'visage',
        title: 'M.I.S.T. — Visage (mouth-tracking face)',
        tagline: 'her own face — lips that follow her real voice',
      },
    ],
  }
}

/** Install window.__mistBus (idempotent) — called once by the voice stage. */
export function installFaceBus(): void {
  if (typeof window === 'undefined') return
  if (!window.__mistBus) {
    window.__mistBus = { state: busState, config: busConfig }
  }
}

/** Update the name/badge shown on the faces (identity v2 aware). */
export function setFaceIdentity(name: string, badge: string): void {
  g.name = (name || 'MIST').slice(0, 24)
  g.badge = (badge || '').slice(0, 32)
}

// ---------------- outbound bridge emission ----------------

/** In-flight guard so overlapping POSTs never queue up. */
let emitting = false
/** Last state we emitted (skip redundant posts). */
let lastEmittedState: BusState | null = null
/** Throttle for waveform posts (the daemon reference writes at ≤15Hz; we're gentler). */
const WAVEFORM_POST_MS = 250
let lastWaveformPost = 0

function postSignal(body: Record<string, unknown>): void {
  if (emitting) return
  emitting = true
  fetch('/api/mist/bridge/signal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
    .catch(() => {})
    .finally(() => {
      emitting = false
    })
}

/**
 * Push a consciousness-state change into the face bus + (if the bridge is up)
 * out to the OWNER's machine. Cheap; called on every orb state transition.
 */
export function emitFaceState(state: ConsciousnessState): void {
  const bus = toBusState(state)
  g.state = bus
  if (bus !== lastEmittedState) {
    lastEmittedState = bus
    postSignal({ state: bus })
  }
}

/**
 * Push a live waveform (tapped from the shared audio analyser) into the face
 * bus + throttled out to the OWNER's machine. Call from a rAF/interval only
 * while Mist is actually speaking.
 */
export function emitFaceWaveform(): void {
  const samples = mistAudioWaveform(64)
  if (!samples) return
  g.samples = samples
  g.samplesAt = Date.now() / 1000
  const now = Date.now()
  if (now - lastWaveformPost >= WAVEFORM_POST_MS) {
    lastWaveformPost = now
    postSignal({ state: 'speaking', samples })
  }
}

/** Raise/clear the red alert on every face (embedded + companion). */
export function emitFaceAlert(alert: boolean): void {
  g.alert = alert
  postSignal({ alert })
}
