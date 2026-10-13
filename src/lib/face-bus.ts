// M.I.S.T. face bus (v8) — the live state feed for the embedded
// ai-visualizer faces AND the outbound signal bus for the OWNER's machine.
//
// Two consumers, one source of truth:
//  1. EMBEDDED FACES: the iframes under /av/faces/* ride a postMessage
//     protocol (Phase 6-b sandbox migration — face-stage.tsx now mounts them
//     with sandbox="allow-scripts" and NO allow-same-origin, so they are
//     OPAQUE-ORIGIN documents that cannot touch this window, its DOM, its
//     cookies or its storage; the v7 window.__mistBus same-origin global is
//     gone). Each face's core.js (or the visage's own inline transport) asks
//     for /state + /config via window.parent.postMessage and this module
//     answers LIVE over a private MessagePort the face handed us at hello —
//     so the circuit board / radial / rain / neural core / visage perform
//     Mist's REAL voice state with her REAL audio waveform (tapped from the
//     shared analyser in audio-bus.ts). The v7 contract is preserved
//     exactly: every /state request is answered with a FRESH busState() —
//     same shape, same freshness semantics, same per-poll mouth frames.
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

// ---------------- postMessage face bridge (Phase 6-b) ----------------
// The sandboxed face frames are opaque-origin documents, so the bus rides a
// strict postMessage protocol instead of the old window.__mistBus global:
//
//   iframe → parent : window.parent.postMessage({__mistFace, type, seq},
//                      APP_ORIGIN)  — STRICT targetOrigin. The face derives
//                      APP_ORIGIN from its own URL (its files are served
//                      same-app), so a hostile embedder that happens to host
//                      these faces never receives a word.
//   parent → iframe : MessagePort.postMessage({...}) — a PRIVATE channel.
//
// Why a MessagePort for the return direction (and never window.postMessage
// with a wildcard): the sandbox makes each frame's origin opaque, and the
// postMessage spec REFUSES delivery to an opaque-origin window unless
// targetOrigin is '*' — a wildcard we refuse to ever ship. Instead the face
// creates a MessageChannel at hello and transfers us port2; the entangled
// port pair is private by construction (only the twin's holder can read or
// write it), so it needs no origin check at all and no '*' exists anywhere
// in this protocol.

/** Protocol marker shared with public/av/core.js + the visage face
 *  (tests/security/facebus.test.ts pins the two sides together). */
const FACE_MARKER = '__mistFace'

/** The contentWindows of the mounted face frames (attached by face-stage
 *  BEFORE the face document can load — the window proxy is stable across
 *  the frame's navigations). This is the source-of-truth allowlist: only
 *  messages from these exact windows are even considered. */
const faceFrames = new Set<Window>()

/** The answer port each frame handed us at hello (one per frame; a new
 *  hello replaces + closes the previous port — face swaps, strict-mode
 *  remounts and HMR all land here). */
const framePorts = new Map<Window, MessagePort>()

/** Structural validation of an inbound frame message. Never trust the
 *  shape blindly: the marker must be exactly true, the type must be one of
 *  the three protocol verbs, and seq (when present) must be a number. */
function isFaceFrameMessage(d: unknown): d is { type: string; seq?: unknown } {
  if (typeof d !== 'object' || d === null) return false
  const m = d as Record<string, unknown>
  if (m[FACE_MARKER] !== true) return false
  if (m.type !== 'hello' && m.type !== 'state' && m.type !== 'config') return false
  if (m.seq !== undefined && typeof m.seq !== 'number') return false
  return true
}

function onFaceFrameMessage(ev: MessageEvent): void {
  // SOURCE GATE — only our own face frames, by exact window identity.
  // event.source cannot be spoofed by script; anything else (other windows,
  // foreign embedders, our own window) is ignored before we look at data.
  const src = ev.source
  if (!src || typeof src !== 'object' || !faceFrames.has(src as Window)) return
  // ORIGIN GATE — our sandboxed faces serialize as the opaque origin "null";
  // an unsandboxed same-origin embed would send our own origin. Any other
  // origin is foreign EVEN IF it reached us from one of our frames (e.g. a
  // frame navigated elsewhere — defense in depth on top of frame-src 'self').
  if (ev.origin !== 'null' && ev.origin !== window.location.origin) return
  if (!isFaceFrameMessage(ev.data)) return
  const msg = ev.data
  const win = src as Window

  if (msg.type === 'hello') {
    // A MessagePort transferred from the frame's realm materializes in ours;
    // duck-type it rather than cross-realm instanceof.
    const port = ev.ports && ev.ports[0]
    if (!port || typeof port.postMessage !== 'function' || typeof port.close !== 'function') return
    const old = framePorts.get(win)
    if (old && old !== port) old.close()
    framePorts.set(win, port)
    // Ready signal — the frame starts asking only after this arrives.
    port.postMessage({ [FACE_MARKER]: true, type: 'hello-ack' })
    return
  }

  // state / config request → answer on that frame's private port. The
  // payload is computed per request, exactly like the v7 synchronous bus.
  const port = framePorts.get(win)
  if (!port) return
  const payload = msg.type === 'state' ? busState() : busConfig()
  port.postMessage({ [FACE_MARKER]: true, type: msg.type, seq: typeof msg.seq === 'number' ? msg.seq : -1, payload })
}

let bridgeInstalled = false
function ensureFaceBridge(): void {
  if (typeof window === 'undefined' || bridgeInstalled) return
  bridgeInstalled = true
  window.addEventListener('message', onFaceFrameMessage)
}

/** Register a face frame's contentWindow with the bus (idempotent). Called
 *  by face-stage on mount/face-change; must run before the frame's document
 *  boots so its hello is never dropped. */
export function attachFaceFrame(win: Window): void {
  if (typeof window === 'undefined') return
  ensureFaceBridge()
  faceFrames.add(win)
}

/** Unregister a face frame (unmount / face swap) and close its port. */
export function detachFaceFrame(win: Window): void {
  if (typeof window === 'undefined') return
  faceFrames.delete(win)
  const port = framePorts.get(win)
  if (port) {
    port.close()
    framePorts.delete(win)
  }
}

/** Install the postMessage face bridge (idempotent) — called once by the
 *  app shell. Replaces the v7 window.__mistBus global, which no longer
 *  exists: sandboxed frames cannot read it and nothing else ever did. */
export function installFaceBus(): void {
  if (typeof window === 'undefined') return
  ensureFaceBridge()
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
