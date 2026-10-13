'use client'

// M.I.S.T. — mic-controller: the chat panel's push-to-talk half.
//
// Phase 4-a · chat-panel split: the mic arming/PTT/keepalive wiring extracted
// from the god-file one-to-one. Behavior is unchanged; the ONLY intentional
// delta is the Phase 4-a audio rule — the 120ms energy loop publishes to the
// shared audio bus (publishMicEnergy) instead of writing the zustand neural
// slice, so an energy tick costs ZERO React renders (the orb pulls
// micEnergy() inside its rAF tick; the socket still receives voice_chunk).
//
// Owns: recorder lifecycle, the energy interval, the window pointerup/Escape
// safety nets and the Alt+V mic-focus arming. Transcript delivery flows back
// through the injected `onTranscript` (the panel's send()).

import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { useMistStore } from '@/lib/store'
import { mistApi } from '@/lib/mist-api'
import { createMicRecorder, type MicRecorder } from '@/lib/audio-utils'
import { publishMicEnergy } from '@/lib/audio-bus'
import { micDeniedGuidance } from '@/hooks/use-voice'
import { useTabBoundary } from '@/hooks/use-tab-boundary'

export interface MicController {
  /** True while the PTT recorder is capturing. */
  recording: boolean
  /** Ref mirror for event handlers that must not re-register on state flips. */
  recordingRef: { current: boolean }
  startRecording: () => Promise<void>
  stopRecording: () => Promise<void>
  cancelRecording: () => void
}

export function useMicController(opts: {
  /** Socket emit for the service's listening state (unchanged cadence). */
  sendVoiceEnergy: (energy: number) => void
  /** The panel's send() — a captured transcript becomes a thought. */
  onTranscript: (text: string) => Promise<boolean>
  /** Escape while NOT recording runs the panel's interrupt superset. */
  onEscapeInterrupt: () => void
}): MicController {
  const { sendVoiceEnergy, onTranscript, onEscapeInterrupt } = opts

  // TabBoundary: hidden tab → the orb can't be seen; the bus publish and the
  // socket emit pause until the boundary reports visible again (the recorder
  // itself keeps capturing).
  const { visibleRef: tabVisibleRef } = useTabBoundary('chat-mic')

  const [recording, setRecording] = useState(false)
  const recorderRef = useRef<MicRecorder | null>(null)
  const recordingRef = useRef(false)
  const energyIntervalRef = useRef<number | null>(null)
  // Latest callbacks without re-registering the window listeners per render.
  const onTranscriptRef = useRef(onTranscript)
  useEffect(() => {
    onTranscriptRef.current = onTranscript
  }, [onTranscript])

  const startRecording = useCallback(async () => {
    if (recordingRef.current) return
    try {
      const rec = createMicRecorder()
      recorderRef.current = rec
      await rec.start()
      recordingRef.current = true
      setRecording(true)
      useMistStore.getState().setNeuralState('listening')
      energyIntervalRef.current = window.setInterval(() => {
        // TabBoundary: hidden tab → skip the publish + the socket emit.
        if (!tabVisibleRef.current) return
        const energy = rec.getEnergy()
        // Phase 4-a · P3: the energy rides the bus — no store write, no
        // re-render of StatusBar/ChatPanel per tick (the old setAudioEnergy
        // path rebuilt the whole neural slice every 120ms).
        publishMicEnergy(energy)
        sendVoiceEnergy(energy)
      }, 120)
    } catch {
      recorderRef.current = null
      toast.error('Microphone unavailable', { description: micDeniedGuidance(), duration: 5000 })
    }
  }, [sendVoiceEnergy, tabVisibleRef])

  const cancelRecording = useCallback(() => {
    if (!recordingRef.current) return
    recordingRef.current = false
    setRecording(false)
    if (energyIntervalRef.current !== null) {
      window.clearInterval(energyIntervalRef.current)
      energyIntervalRef.current = null
    }
    recorderRef.current?.cancel()
    recorderRef.current = null
    publishMicEnergy(0)
    useMistStore.getState().setNeuralState('dormant')
  }, [])

  const stopRecording = useCallback(async () => {
    if (!recordingRef.current) return
    recordingRef.current = false
    setRecording(false)
    if (energyIntervalRef.current !== null) {
      window.clearInterval(energyIntervalRef.current)
      energyIntervalRef.current = null
    }
    const rec = recorderRef.current
    recorderRef.current = null
    if (!rec) return
    const wav = await rec.stop()
    publishMicEnergy(0)
    if (!wav) {
      toast.error('No speech captured')
      useMistStore.getState().setNeuralState('dormant')
      return
    }
    try {
      const { transcription } = await mistApi.voice.stt(wav)
      const text = transcription?.trim()
      if (text) {
        const sent = await onTranscriptRef.current(text)
        if (!sent) toast('M.I.S.T. is still processing — try again in a moment')
      } else {
        toast("I couldn't hear anything")
        useMistStore.getState().setNeuralState('dormant')
      }
    } catch {
      toast.error('Speech recognition unavailable')
      useMistStore.getState().setNeuralState('dormant')
    }
  }, [])

  // Global pointerup / Escape safety nets (listener registration is stable —
  // the handlers read refs, so the panel's re-renders never re-bind them).
  useEffect(() => {
    const onUp = () => {
      if (recordingRef.current) void stopRecording()
    }
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (recordingRef.current) {
        cancelRecording()
      } else {
        // mlv-ux-2 — Escape while she thinks cancels the in-flight thought
        // (the panel's sequence guards itself: awaiting && !research).
        onEscapeInterrupt()
      }
    }
    window.addEventListener('pointerup', onUp)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('keydown', onKey)
    }
  }, [stopRecording, cancelRecording, onEscapeInterrupt])

  // Mic focus (Alt+V) — toggles push-to-talk while on the consciousness view.
  // Deferred to a macrotask so the effect body stays free of sync setState.
  const micFocus = useMistStore((s) => s.micFocus)
  useEffect(() => {
    if (micFocus === 0) return
    if (useMistStore.getState().view !== 'consciousness') return
    const id = window.setTimeout(() => {
      if (recordingRef.current) void stopRecording()
      else void startRecording()
    }, 0)
    return () => window.clearTimeout(id)
  }, [micFocus, startRecording, stopRecording])

  return { recording, recordingRef, startRecording, stopRecording, cancelRecording }
}
