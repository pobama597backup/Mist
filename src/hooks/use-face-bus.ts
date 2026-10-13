'use client'

// M.I.S.T. face-bus emitter hook (v8) — mounted ONCE by the app shell.
//
// Bridges Mist's live consciousness state into two places at once:
//  · the EMBEDDED faces (sandboxed iframes under /av/faces/* ask over the
//    postMessage bridge — installFaceBus wires the listener; the answers
//    are computed fresh per request by face-bus.ts),
//  · the OWNER's machine (throttled POSTs → Mist Bridge v2 → ".voice_*" files
//    → every companion face on their PC performs Mist).
//
// Subscribes to the store's neural state (set from everywhere: the voice
// stage, chat read-alouds, research jobs…) and taps the REAL TTS waveform
// from the shared audio analyser while she speaks.

import { useEffect } from 'react'
import { useMistStore } from '@/lib/store'
import { emitFaceState, emitFaceWaveform, installFaceBus, setFaceIdentity } from '@/lib/face-bus'

export function useFaceBusEmitter(): void {
  const neuralState = useMistStore((s) => s.neural.state)

  useEffect(() => {
    installFaceBus()
    setFaceIdentity('MIST', 'CONSCIOUSNESS')
  }, [])

  // state transitions → both buses (the embedded faces ask the bridge and
  // get this answer computed fresh per request; the bridge POST is deduped
  // + fire-and-forget)
  useEffect(() => {
    emitFaceState(neuralState)
  }, [neuralState])

  // while speaking: tap the real waveform at ~12 Hz (the embedded faces
  // receive it on their next ask — core.js polls /state at 120ms, the
  // visage at animation rate) — the outbound POST is throttled to 4 Hz
  // inside emitFaceWaveform
  useEffect(() => {
    if (neuralState !== 'speaking') return
    const id = window.setInterval(() => emitFaceWaveform(), 80)
    return () => window.clearInterval(id)
  }, [neuralState])
}
