// M.I.S.T. voice hooks (v6) — the hands-free conversation loop + "Hey Mist".
//
// useVoiceSession: the tap-to-talk loop — SpeechRecognition (Web Speech API)
// captures an utterance, the neural socket thinks about it, mistSpeech speaks
// the reply, then listening re-arms. Where the API is missing (Firefox, the
// agent-browser sandbox) the session still runs and the stage renders a
// hold-to-talk fallback that feeds transcripts back in via `submit()`.
//
// useWakeWord: a module-singleton background recognizer listening for
// "hey mist" whenever the mic is free. Multiple mounts share ONE recognizer
// (refcounted engine), so the stage and a future app-wide shell mount can
// coexist without mic contention. While a voice session is active the engine
// pauses — the session owns the mic.
//
// Zero new dependencies. Every entry point is SSR/sandbox-safe: no
// SpeechRecognition → graceful `supported: false`, never a crash.

'use client'

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { toast } from 'sonner'
import { useMistStore } from '@/lib/store'
import { mistSpeech, getVoiceMode } from '@/lib/speech'
import { useNeural, type ThoughtPayload } from '@/hooks/use-neural'
import { mistApi, ApiError } from '@/lib/mist-api'
import { createWavRecorder, type WavRecorder } from '@/lib/services/voice-local'
import type { ConsciousnessResponseMsg, HistoryMessage } from '@/lib/types'

// ---------------------------------------------------------------------------
// Web Speech API — minimal local surface (lib.dom has no webkit-prefixed ctor)
// ---------------------------------------------------------------------------

interface SpeechRecognitionAlt {
  transcript: string
  confidence: number
}
interface SpeechRecognitionResultLike {
  isFinal: boolean
  length: number
  [index: number]: SpeechRecognitionAlt
}
interface SpeechRecognitionResultListLike {
  length: number
  [index: number]: SpeechRecognitionResultLike
}
interface SpeechRecognitionEventLike extends Event {
  resultIndex: number
  results: SpeechRecognitionResultListLike
}
interface SpeechRecognitionErrorEventLike extends Event {
  error: string
  message?: string
}
interface SpeechRecognitionLike {
  continuous: boolean
  interimResults: boolean
  lang: string
  start(): void
  stop(): void
  abort(): void
  onresult: ((e: SpeechRecognitionEventLike) => void) | null
  onerror: ((e: SpeechRecognitionErrorEventLike) => void) | null
  onend: (() => void) | null
}
type SpeechRecognitionCtor = new () => SpeechRecognitionLike

function getRecognitionCtor(): SpeechRecognitionCtor | null {
  if (typeof window === 'undefined') return null
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor
    webkitSpeechRecognition?: SpeechRecognitionCtor
  }
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null
}

function recognitionSupported(): boolean {
  return getRecognitionCtor() !== null
}

/**
 * True when the app is embedded in an iframe (the sandbox preview panel).
 * Browsers refuse to show mic-permission prompts inside cross-origin iframes,
 * so 'Hey Mist' and every other mic feature silently fail there — the user
 * must open the app in a real tab. Detected instead of assumed so a real
 * fullscreen deployment never shows the preview advice.
 */
export function inEmbeddedFrame(): boolean {
  if (typeof window === 'undefined') return false
  try {
    return window.self !== window.top
  } catch {
    return true // cross-origin access threw — definitely framed
  }
}

/** Actionable mic-denied guidance: preview iframe vs normal browser tab. */
export function micDeniedGuidance(): string {
  return inEmbeddedFrame()
    ? "Microphone is blocked inside the preview panel — click 'Open in New Tab' (↗ above the preview), then re-arm 'Hey Mist' in Settings."
    : "Microphone permission was denied. Enable the mic in your browser, then re-arm 'Hey Mist'."
}

// ---------------------------------------------------------------------------
// Shared session/wake coordination (module scope)
// ---------------------------------------------------------------------------

/** True while a hands-free voice session owns the mic (wake word pauses). */
let voiceSessionActiveFlag = false

/** Utterances that politely end a hands-free session. */
const STOP_PHRASE = /\b(stop|goodbye|that's all|thank you mist|sleep)\b/i

const FAREWELL = "Until next time — I'll be right here."

// (NO_RECOGNITION_MSG retired 2026-09-27: with the server-STT fallback a
// missing SpeechRecognition no longer pre-fails the session — Firefox talks
// through /api/mist/voice/stt on a working mic.)

// ---------------------------------------------------------------------------
// Wake-word engine — ONE recognizer shared by every useWakeWord mount
// ---------------------------------------------------------------------------

export interface WakeWordState {
  supported: boolean
  listening: boolean
  error: string | null
}

const WAKE_SERVER: WakeWordState = { supported: false, listening: false, error: null }
let wakeState: WakeWordState = {
  supported: recognitionSupported(),
  listening: false,
  error: null,
}
const wakeSubs = new Set<() => void>()

function setWakeState(patch: Partial<WakeWordState>) {
  wakeState = { ...wakeState, ...patch }
  wakeSubs.forEach((fn) => fn())
}

function wakeSubscribe(fn: () => void): () => void {
  wakeSubs.add(fn)
  return () => {
    wakeSubs.delete(fn)
  }
}
function wakeGetSnapshot(): WakeWordState {
  return wakeState
}
function wakeGetServerSnapshot(): WakeWordState {
  return WAKE_SERVER
}

let wakeRec: SpeechRecognitionLike | null = null
/** Refcount of mounted+enabled hook instances that want the listener. */
let wakeWant = 0
let wakeRestartTimer: number | null = null

function wakeEngineShouldRun(): boolean {
  return wakeWant > 0 && !voiceSessionActiveFlag && recognitionSupported()
}

function wakeEngineStop() {
  if (wakeRestartTimer !== null) {
    window.clearTimeout(wakeRestartTimer)
    wakeRestartTimer = null
  }
  const rec = wakeRec
  wakeRec = null
  if (rec) {
    rec.onresult = null
    rec.onerror = null
    rec.onend = null
    try {
      rec.abort()
    } catch {
      /* already stopped */
    }
  }
  if (wakeState.listening) setWakeState({ listening: false })
}

function wakeEngineStart() {
  const Ctor = getRecognitionCtor()
  if (!Ctor || wakeRec) return
  const rec = new Ctor()
  rec.continuous = true
  rec.interimResults = false
  rec.lang = (typeof navigator !== 'undefined' && navigator.language) || 'en-US'
  rec.onresult = (e) => {
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i]
      for (let j = 0; j < r.length; j++) {
        if (/\b(hey\s+)?mist\b/i.test(r[j]?.transcript ?? '')) {
          wakeHit()
          return
        }
      }
    }
  }
  rec.onerror = (e) => {
    if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
      setWakeState({
        listening: false,
        error: inEmbeddedFrame()
          ? 'Microphone is blocked inside the preview panel — open the app in a real browser tab to use the wake word'
          : 'Microphone permission denied — enable it in your browser to use the wake word',
      })
      try {
        useMistStore.getState().setWakeWordEnabled(false)
      } catch {
        /* store unavailable (SSR) — nothing to disable */
      }
      toast.error('Wake word paused', {
        description: micDeniedGuidance(),
        duration: 5000,
      })
      wakeEngineStop()
    }
    // every other error (no-speech / aborted / network blips) — onend restarts
  }
  rec.onend = () => {
    if (wakeRec === rec) wakeRec = null
    if (wakeEngineShouldRun()) {
      if (wakeRestartTimer !== null) window.clearTimeout(wakeRestartTimer)
      // small delay so a failing recognizer can never tight-loop
      wakeRestartTimer = window.setTimeout(() => {
        wakeRestartTimer = null
        if (wakeEngineShouldRun()) wakeEngineStart()
      }, 500)
    } else if (wakeState.listening) {
      setWakeState({ listening: false })
    }
  }
  wakeRec = rec
  try {
    rec.start()
    setWakeState({ listening: true, error: null })
  } catch {
    wakeRec = null
  }
}

function wakeEngineSync() {
  if (wakeEngineShouldRun()) wakeEngineStart()
  else wakeEngineStop()
}

/** "Hey Mist" heard: stop any playback, jump to the voice stage, arm it. */
function wakeHit() {
  mistSpeech.stop()
  const store = useMistStore.getState()
  store.setView('consciousness')
  store.requestVoiceSession()
  toast.success('Mist heard you — listening', { duration: 4000 })
}

/**
 * Background "Hey Mist" listener. Runs its own continuous recognizer while
 * `wakeWordEnabled` is on and no voice session holds the mic. Mounting it in
 * more than one component is safe — the engine is a module-level singleton.
 */
export function useWakeWord(): WakeWordState {
  const enabled = useMistStore((s) => s.wakeWordEnabled)
  useEffect(() => {
    if (!enabled || !recognitionSupported()) return
    wakeWant += 1
    wakeEngineSync()
    return () => {
      wakeWant = Math.max(0, wakeWant - 1)
      wakeEngineSync()
    }
  }, [enabled])
  return useSyncExternalStore(wakeSubscribe, wakeGetSnapshot, wakeGetServerSnapshot)
}

// ---------------------------------------------------------------------------
// useVoiceSession — the hands-free loop
// ---------------------------------------------------------------------------

export type VoicePhase = 'idle' | 'listening' | 'thinking' | 'speaking' | 'error'

export interface VoiceSessionState {
  /** Session running (listening, thinking or speaking). */
  active: boolean
  phase: VoicePhase
  /** Live partial transcript while listening. */
  interim: string
  /** Last final user utterance. */
  lastHeard: string
  /** Last spoken reply text (pre-strip markdown source). */
  lastReply: string
  error: string | null
  /** True when THIS session captures audio with the local offline recorder
   *  (whisper.cpp via the bridge) instead of SpeechRecognition. */
  localMode: boolean
}

/** A quiet floor of mic "activity" keeps the neural service in `listening`
 *  (its 950ms dormant pulses would otherwise flatten the orb while the
 *  SpeechRecognition owns the mic and no real energy flows). */
const KEEPALIVE_MS = 600

export function useVoiceSession(): VoiceSessionState & {
  start: () => void
  stop: () => void
  /** Feed a transcript from an external capture path (hold-to-talk fallback). */
  submit: (text: string) => void
  supportsRecognition: boolean
  /** Bumped on every final user utterance — lets the stage persist repeats. */
  heardSeq: number
  /** Local mode: stop the recorder and send the buffered utterance to
   *  whisper.cpp (the orb tap while listening calls this). */
  finishCapture: () => void
} {
  const { sendThought, sendVoiceEnergy, onResponse } = useNeural()

  const [supportsRecognition] = useState(() => recognitionSupported())
  const [state, setState] = useState<VoiceSessionState>({
    active: false,
    phase: 'idle',
    interim: '',
    lastHeard: '',
    lastReply: '',
    error: null,
    localMode: false,
  })
  const [heardSeq, setHeardSeq] = useState(0)

  // ---- refs (handler-safe mirrors; never read during render) ----
  const sessionRef = useRef<{ active: boolean; phase: VoicePhase }>({
    active: false,
    phase: 'idle',
  })
  const historyRef = useRef<HistoryMessage[]>([])
  const recRef = useRef<SpeechRecognitionLike | null>(null)
  const beginRef = useRef<() => void>(() => {})
  const restartTimerRef = useRef<number | null>(null)
  const keepaliveTimerRef = useRef<number | null>(null)
  const netRetryRef = useRef(false)

  // ---- local offline capture (whisper.cpp via the bridge) ----
  const localModeRef = useRef(false)
  const localRecorderRef = useRef<WavRecorder | null>(null)
  const localBusyRef = useRef(false)
  const beginLocalRef = useRef<() => void>(() => {})
  const finishLocalRef = useRef<() => void>(() => {})

  // ---- server-STT capture (Drill #10, builder-landed 2026-09-27) ----
  // When the browser's SpeechRecognition cannot reach Google's cloud (the
  // laptop/iframe 'network' error) or does not exist at all (Firefox), this
  // session switches to OUR OWN hearing: createWavRecorder captures a WAV and
  // /api/mist/voice/stt (z-ai ASR, same-origin) transcribes it. Same loop
  // shape as the local whisper path — only the transcription endpoint differs.
  const serverModeRef = useRef(false)
  const serverRecorderRef = useRef<WavRecorder | null>(null)
  const serverBusyRef = useRef(false)
  const beginServerRef = useRef<() => void>(() => {})
  const finishServerRef = useRef<() => void>(() => {})

  const applySession = useCallback((patch: Partial<VoiceSessionState>) => {
    if (patch.active !== undefined || patch.phase !== undefined) {
      sessionRef.current = {
        active: patch.active ?? sessionRef.current.active,
        phase: patch.phase ?? sessionRef.current.phase,
      }
    }
    setState((s) => ({ ...s, ...patch }))
  }, [])

  // ---- keep-alive: synthetic listening energy for the neural service ----
  const keepaliveStop = useCallback(() => {
    if (keepaliveTimerRef.current !== null) {
      window.clearInterval(keepaliveTimerRef.current)
      keepaliveTimerRef.current = null
    }
  }, [])

  const keepaliveStart = useCallback(() => {
    keepaliveStop()
    keepaliveTimerRef.current = window.setInterval(() => {
      sendVoiceEnergy(0.05 + 0.02 * Math.sin(Date.now() / 700))
    }, KEEPALIVE_MS)
  }, [sendVoiceEnergy, keepaliveStop])

  // ---- recognition lifecycle ----
  const scheduleRestart = useCallback(() => {
    if (restartTimerRef.current !== null) window.clearTimeout(restartTimerRef.current)
    restartTimerRef.current = window.setTimeout(() => {
      restartTimerRef.current = null
      if (sessionRef.current.active && sessionRef.current.phase === 'listening') {
        beginRef.current()
      }
    }, 260)
  }, [])

  const endSession = useCallback(
    (opts?: { farewell?: string; error?: string }) => {
      if (!sessionRef.current.active) return
      // tear the session down — recognition, recorder, timers, service state, mic flag
      const rec = recRef.current
      recRef.current = null
      if (rec) {
        rec.onresult = null
        rec.onerror = null
        rec.onend = null
        try {
          rec.abort()
        } catch {
          /* already stopped */
        }
      }
      const wavRec = localRecorderRef.current
      localRecorderRef.current = null
      if (wavRec) {
        try {
          wavRec.cancel()
        } catch {
          /* already stopped */
        }
      }
      localModeRef.current = false
      localBusyRef.current = false
      const srvRec = serverRecorderRef.current
      serverRecorderRef.current = null
      if (srvRec) {
        try {
          srvRec.cancel()
        } catch {
          /* already stopped */
        }
      }
      serverModeRef.current = false
      serverBusyRef.current = false
      if (restartTimerRef.current !== null) {
        window.clearTimeout(restartTimerRef.current)
        restartTimerRef.current = null
      }
      keepaliveStop()
      mistSpeech.stop()
      sendVoiceEnergy(0) // settle the service's listening state → dormant
      useMistStore.getState().setAudioEnergy(0)
      voiceSessionActiveFlag = false
      wakeEngineSync() // hand the mic back to the wake listener if armed
      applySession({
        active: false,
        phase: opts?.error ? 'error' : 'idle',
        interim: '',
        error: opts?.error ?? null,
        localMode: false,
      })
      useMistStore.getState().setNeuralState('dormant')
      // respects the ttsEnabled preference like every other utterance
      if (opts?.farewell) void mistSpeech.speak(opts.farewell)
    },
    [applySession, keepaliveStop, sendVoiceEnergy]
  )

  const failSession = useCallback(
    (message: string) => {
      toast.error('Voice session ended', { description: message })
      endSession({ error: message })
    },
    [endSession]
  )

  /** A final utterance: stop-phrase check → thinking → send the thought. */
  const handleUtterance = useCallback(
    (text: string) => {
      const clean = text.trim()
      if (!clean) {
        scheduleRestart()
        return
      }
      applySession({ lastHeard: clean })
      setHeardSeq((n) => n + 1)
      if (STOP_PHRASE.test(clean)) {
        endSession({ farewell: FAREWELL })
        return
      }
      if (restartTimerRef.current !== null) {
        window.clearTimeout(restartTimerRef.current)
        restartTimerRef.current = null
      }
      keepaliveStop()
      historyRef.current.push({ role: 'user', content: clean })
      const history = historyRef.current.slice(-8)
      const store = useMistStore.getState()
      applySession({ phase: 'thinking', interim: '' })
      store.setNeuralState('processing')
      sendThought({
        content: clean,
        provider: store.provider,
        conversation_id: store.threads.activeId ?? undefined,
        history,
        mode: 'voice',
      } as ThoughtPayload)
    },
    [applySession, endSession, keepaliveStop, scheduleRestart, sendThought]
  )

  const handleRecError = useCallback(
    (code: string) => {
      if (code === 'aborted') return // our own stop()
      if (code === 'no-speech') {
        scheduleRestart()
        return
      }
      if (code === 'network') {
        if (!netRetryRef.current) {
          netRetryRef.current = true
          scheduleRestart()
          return
        }
        // Second 'network' failure — Google's speech service is unreachable
        // (iframe / network policy), NOT our connection. Switch THIS session
        // to our own hearing: /api/mist/voice/stt is same-origin and alive.
        if (!serverModeRef.current) {
          serverModeRef.current = true
          netRetryRef.current = false
          toast.info('Speech service unreachable — switched to my own hearing', {
            description: 'Keep talking — audio now transcribes through my server connection.',
          })
          applySession({ phase: 'listening', interim: '', error: null })
          beginServerRef.current()
          return
        }
        failSession('Speech recognition unavailable — the fallback could not start. Check the microphone and try again.')
        return
      }
      if (code === 'not-allowed' || code === 'service-not-allowed') {
        failSession(micDeniedGuidance())
        return
      }
      if (code === 'audio-capture') {
        failSession('No microphone detected — connect one and try again')
        return
      }
      failSession(`Speech recognition error (${code})`)
    },
    [failSession, scheduleRestart]
  )

  /** Start one short listening segment (continuous=false → ends per utterance). */
  const beginRecognition = useCallback(() => {
    const Ctor = getRecognitionCtor()
    if (!Ctor) return
    if (!sessionRef.current.active || sessionRef.current.phase !== 'listening') return
    const prev = recRef.current
    recRef.current = null
    if (prev) {
      prev.onresult = null
      prev.onerror = null
      prev.onend = null
      try {
        prev.abort()
      } catch {
        /* already stopped */
      }
    }
    const rec = new Ctor()
    rec.continuous = false
    rec.interimResults = true
    rec.lang = navigator.language || 'en-US'
    rec.onresult = (e) => {
      let interim = ''
      let final = ''
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i]
        const alt = r[0]
        if (!alt) continue
        if (r.isFinal) final += alt.transcript
        else interim += alt.transcript
      }
      if (interim) applySession({ interim })
      const text = final.trim()
      if (text) {
        try {
          rec.stop()
        } catch {
          /* already stopping */
        }
        handleUtterance(text)
      }
    }
    rec.onerror = (e) => handleRecError(e.error)
    rec.onend = () => {
      if (recRef.current === rec) recRef.current = null
      // continuous=false ends after a final result or silence — keep looping
      scheduleRestart()
    }
    recRef.current = rec
    try {
      rec.start()
    } catch {
      // InvalidStateError — a start is already pending; onend will re-arm
    }
  }, [applySession, handleRecError, handleUtterance, scheduleRestart])

  useEffect(() => {
    beginRef.current = beginRecognition
  }, [beginRecognition])

  // ---- local offline capture: arm the WAV recorder for one utterance ----
  const beginLocalSegment = useCallback(async () => {
    if (!sessionRef.current.active || sessionRef.current.phase !== 'listening') return
    if (localRecorderRef.current || localBusyRef.current) return
    try {
      const rec = createWavRecorder({
        onAutoStop: () => finishLocalRef.current(), // 30s cap → same send path
      })
      localRecorderRef.current = rec
      await rec.start()
    } catch {
      localRecorderRef.current = null
      failSession('Microphone unavailable — check permission and try again')
    }
  }, [failSession])

  useEffect(() => {
    beginLocalRef.current = () => void beginLocalSegment()
  }, [beginLocalSegment])

  // ---- server-STT capture: arm the WAV recorder for one utterance, ----
  // transcribe through OUR endpoint instead of Google's cloud.
  const beginServerSegment = useCallback(async () => {
    if (!sessionRef.current.active || sessionRef.current.phase !== 'listening') return
    if (serverRecorderRef.current || serverBusyRef.current) return
    try {
      const rec = createWavRecorder({
        onAutoStop: () => finishServerRef.current(), // 30s cap → same send path
      })
      serverRecorderRef.current = rec
      await rec.start()
    } catch {
      serverRecorderRef.current = null
      failSession(
        inEmbeddedFrame()
          ? micDeniedGuidance()
          : 'Microphone unavailable — check permission and try again'
      )
    }
  }, [failSession])

  useEffect(() => {
    beginServerRef.current = () => void beginServerSegment()
  }, [beginServerSegment])

  /** Server mode's "stop talking": stop the recorder, transcribe through
   *  /api/mist/voice/stt (z-ai ASR, same-origin), feed the transcript into
   *  the SAME handler every other capture path uses (handleUtterance). */
  const finishServerCapture = useCallback(async () => {
    const rec = serverRecorderRef.current
    if (!rec || serverBusyRef.current) return
    if (!rec.isRecording()) return
    serverBusyRef.current = true
    applySession({ interim: '' })
    const captured = await rec.stop()
    serverRecorderRef.current = null
    if (!sessionRef.current.active) {
      serverBusyRef.current = false
      return
    }
    // nothing (or a sub-quarter-second blip) heard — quietly re-arm
    if (!captured || captured.durationSec < 0.25) {
      serverBusyRef.current = false
      if (sessionRef.current.phase === 'listening') beginServerRef.current()
      return
    }
    applySession({ phase: 'thinking', interim: '' })
    try {
      // wavB64 (base64 string) → Blob for the FormData upload — zero deps
      const blob = await (await fetch(`data:audio/wav;base64,${captured.wavB64}`)).blob()
      const res = await mistApi.voice.stt(blob)
      serverBusyRef.current = false
      if (!sessionRef.current.active) return
      const text = (res.transcription ?? '').trim()
      if (text) {
        handleUtterance(text)
      } else {
        applySession({ phase: 'listening', interim: '' })
        beginServerRef.current()
      }
    } catch {
      serverBusyRef.current = false
      if (!sessionRef.current.active) return
      failSession('My own hearing is unreachable right now — try again in a moment.')
    }
  }, [applySession, handleUtterance, failSession])

  useEffect(() => {
    finishServerRef.current = () => void finishServerCapture()
  }, [finishServerCapture])

  /** Local mode's "stop talking": stop the recorder, transcribe offline with
   *  whisper.cpp, then feed the transcript into the SAME handler the
   *  SpeechRecognition path uses (handleUtterance). */
  const finishLocalCapture = useCallback(async () => {
    const rec = localRecorderRef.current
    if (!rec || localBusyRef.current) return
    if (!rec.isRecording()) return
    localBusyRef.current = true
    applySession({ interim: '' })
    const captured = await rec.stop()
    localRecorderRef.current = null
    if (!sessionRef.current.active) {
      localBusyRef.current = false
      return
    }
    // nothing (or a sub-quarter-second blip) heard — quietly re-arm
    if (!captured || captured.durationSec < 0.25) {
      localBusyRef.current = false
      if (sessionRef.current.phase === 'listening') beginLocalRef.current()
      return
    }
    // transcribing locally — hold the thinking shimmer while whisper runs
    applySession({ phase: 'thinking', interim: '' })
    try {
      const res = await mistApi.voice.localTranscribe(captured.wavB64)
      localBusyRef.current = false
      if (!sessionRef.current.active) return
      const text = (res.transcription ?? '').trim()
      if (text) {
        handleUtterance(text)
      } else {
        applySession({ phase: 'listening', interim: '' })
        beginLocalRef.current()
      }
    } catch (err) {
      localBusyRef.current = false
      if (!sessionRef.current.active) return
      // engines missing / bridge dropped mid-session → cloud for THIS session
      const notInstalled = err instanceof ApiError && err.status === 503 && /not-installed/.test(err.message)
      toast.error(notInstalled ? 'Local hearing is not installed' : 'Local hearing is unavailable', {
        description: notInstalled
          ? 'Install it from Settings → Local voice — using the cloud voice for this session.'
          : 'Falling back to the cloud voice for this session.',
      })
      localModeRef.current = false
      applySession({ localMode: false, phase: 'listening', interim: '' })
      if (recognitionSupported()) beginRef.current()
      // (no SpeechRecognition → the stage's hold-to-talk fallback takes over)
    }
  }, [applySession, handleUtterance])

  useEffect(() => {
    finishLocalRef.current = () => void finishLocalCapture()
  }, [finishLocalCapture])

  /** The reply lands: caption it, speak it, then re-arm listening. */
  const handleResponse = useCallback(
    (m: ConsciousnessResponseMsg) => {
      if (!sessionRef.current.active || sessionRef.current.phase !== 'thinking') return
      const text = (m.text ?? '').trim()
      netRetryRef.current = false
      if (text) historyRef.current.push({ role: 'assistant', content: text })
      applySession({ phase: 'speaking', interim: '', lastReply: m.text ?? '', error: null })
      useMistStore.getState().setNeuralState('speaking')
      void mistSpeech.speak(text, {
        // honest voice-failure caption: without this the orb danced through a
        // 'speaking' state while every engine was down — silence looked like
        // speaking (live case 2026-09-28)
        onError: (reason) => {
          if (!sessionRef.current.active) return
          applySession({ error: `voice unavailable — ${reason.slice(0, 120)}` })
        },
        onEnd: () => {
          if (!sessionRef.current.active) return
          applySession({ phase: 'listening', interim: '' })
          useMistStore.getState().setNeuralState('listening')
          keepaliveStart()
          // re-arm whichever capture path this session uses
          if (localModeRef.current) beginLocalRef.current()
          else if (serverModeRef.current) beginServerRef.current()
          else if (recognitionSupported()) scheduleRestart()
        },
      })
    },
    [applySession, keepaliveStart, scheduleRestart]
  )

  const start = useCallback(() => {
    if (sessionRef.current.active) return // double-start guard
    historyRef.current = []
    netRetryRef.current = false
    localModeRef.current = false
    localBusyRef.current = false
    voiceSessionActiveFlag = true
    wakeEngineSync() // pause the wake listener — the session owns the mic now
    const store = useMistStore.getState()
    store.setAudioEnergy(0)
    applySession({
      active: true,
      phase: 'listening',
      interim: '',
      lastHeard: '',
      lastReply: '',
      localMode: false,
      // no premature error when SpeechRecognition is missing — the server-STT
      // path (Firefox, Drill #10) may still carry the session on a working mic;
      // if it cannot start, ITS failure message (mic guidance) is the honest one.
      error: null,
    })
    store.setNeuralState('listening')
    keepaliveStart()
    // Resolve the capture path for THIS session: the local offline recorder
    // (whisper.cpp via the bridge) or the browser's SpeechRecognition. The
    // probe is cached 30s, so this normally resolves without a round-trip.
    void (async () => {
      let mode: 'local' | 'cloud' | 'browser' = 'cloud'
      try {
        mode = await getVoiceMode()
      } catch {
        mode = 'cloud'
      }
      if (!sessionRef.current.active) return // session already ended
      if (mode === 'local') {
        localModeRef.current = true
        applySession({ localMode: true, interim: '', error: null })
        beginLocalRef.current()
      } else if (recognitionSupported()) {
        beginRef.current()
      } else {
        // No SpeechRecognition (Firefox / stripped browsers) but a working
        // mic — OUR OWN hearing carries the session (Drill #10).
        serverModeRef.current = true
        applySession({ interim: '', error: null })
        beginServerRef.current()
      }
    })()
  }, [applySession, keepaliveStart])

  const stop = useCallback(() => {
    endSession()
  }, [endSession])

  const submit = useCallback(
    (text: string) => {
      const clean = text.trim()
      if (!clean || !sessionRef.current.active) return
      handleUtterance(clean)
    },
    [handleUtterance]
  )

  // Register ONCE per active session — handler is ref-stable.
  useEffect(() => {
    if (!state.active) return
    const unsub = onResponse(handleResponse)
    return unsub
  }, [state.active, onResponse, handleResponse])

  // Full teardown on unmount (never leaves a recognizer or timer behind).
  useEffect(() => () => endSession(), [endSession])

  /** Stable wrapper so the stage can wire it into orb-tap handlers. */
  const finishCapture = useCallback(() => {
    if (serverModeRef.current) finishServerRef.current()
    else finishLocalRef.current()
  }, [])

  return {
    ...state,
    heardSeq,
    supportsRecognition,
    start,
    stop,
    submit,
    finishCapture,
  }
}
