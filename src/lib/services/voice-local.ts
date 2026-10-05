// M.I.S.T. local voice (v3) — the client half of the OFFLINE voice pipeline.
//
// whisper.cpp (hearing) and Piper (speaking) run on the user's own machine,
// spawned by their mist-bridge.js daemon. This module:
//   - checkLocalVoice(force?)   → probes /voice/local/status, mirrors the
//     compact ready-state into the store (30s cache) and keeps the rich
//     detail for the Settings card (getLastLocalVoiceDetail).
//   - resolveVoiceMode(mode)    → 'local' | 'cloud' | 'browser' with a sane
//     fallback chain (never dead-ends; SSR-safe).
//   - createWavRecorder()       → a 16kHz mono 16-bit WAV recorder (no ffmpeg
//     anywhere: AudioContext + ScriptProcessorNode + a hand-written RIFF
//     header) that yields base64 for /voice/local/transcribe.
'use client'

import { mistApi } from '@/lib/mist-api'
import { useMistStore, type LocalVoiceState, type VoiceMode } from '@/lib/store'
import { mistAudioResume } from '@/lib/audio-bus'

// ---------------------------------------------------------------------------
// Status probe + mode resolution
// ---------------------------------------------------------------------------

/** Rich, defensively-typed mirror of the bridge's voice_status payload. */
export interface LocalVoiceDetail {
  stt?: {
    installed?: boolean
    binary?: string | null
    model?: string | null
    modelMb?: number | null
    version?: string
  }
  tts?: {
    installed?: boolean
    binary?: string | null
    voice?: string | null
    voiceName?: string | null
  }
  dir?: string
  tier?: string
  hardware?: {
    cpus?: number
    memGb?: number
    /** GPU names (bridge v3.1 probe — shared with system_watch). */
    gpus?: string[]
    /** v3.1: {tier, reason} — explains itself. String = older bridge. */
    recommended?: { tier?: string; reason?: string } | string
  }
  busy?: boolean
}

/** The effective pipeline after preferences + reality are combined. */
export type ResolvedVoiceMode = 'local' | 'cloud' | 'browser'

const CHECK_TTL_MS = 30_000

/** Last rich detail fetched alongside the store mirror (settings card reads it). */
let lastDetail: LocalVoiceDetail | null = null

export function getLastLocalVoiceDetail(): LocalVoiceDetail | null {
  return lastDetail
}

/** One fresh probe: writes the store mirror, remembers the rich detail. */
async function fetchLocalVoice(): Promise<LocalVoiceState> {
  if (typeof window === 'undefined') return { available: false, checkedAt: 0 }
  try {
    const res = await mistApi.voice.localStatus()
    lastDetail = res.voice ?? null
    const v = res.voice ?? {}
    const state: LocalVoiceState = {
      available: res.bridgeConnected && res.ok,
      checkedAt: Date.now(),
      tier: typeof v.tier === 'string' ? v.tier : undefined,
      sttReady: Boolean(v.stt?.installed),
      ttsReady: Boolean(v.tts?.installed),
    }
    useMistStore.getState().setLocalVoice(state)
    return state
  } catch {
    // 503 bridge-disconnected (or any failure) → offline, cached briefly
    lastDetail = null
    const state: LocalVoiceState = { available: false, checkedAt: Date.now() }
    useMistStore.getState().setLocalVoice(state)
    return state
  }
}

/**
 * Probe the local offline engines. Cached 30s in the store; `force` refetches.
 * NEVER throws — an unreachable bridge simply reports `available: false`.
 */
export async function checkLocalVoice(force = false): Promise<LocalVoiceState> {
  if (typeof window === 'undefined') return { available: false, checkedAt: 0 }
  const cur = useMistStore.getState().localVoice
  if (!force && cur && Date.now() - cur.checkedAt < CHECK_TTL_MS) return cur
  return fetchLocalVoice()
}

const localReady = (s: LocalVoiceState) => s.available && s.sttReady === true && s.ttsReady === true

/**
 * Resolve the voice pipeline for this utterance/session.
 *  - explicit 'local' is honored only when both engines are actually ready
 *    (otherwise a console warning + cloud fallback — never a dead mic)
 *  - 'auto' → local when the bridge says both engines are installed
 *  - SSR (no window) → 'cloud'
 */
export async function resolveVoiceMode(mode: VoiceMode): Promise<ResolvedVoiceMode> {
  if (typeof window === 'undefined') return 'cloud'
  if (mode === 'cloud' || mode === 'browser') return mode
  const state = await checkLocalVoice()
  if (mode === 'local') {
    if (localReady(state)) return 'local'
    console.warn(
      '[mist-voice] local voice mode is set but the offline engines are not ready — falling back to the cloud voice for now'
    )
    return 'cloud'
  }
  // auto
  return localReady(state) ? 'local' : 'cloud'
}

// ---------------------------------------------------------------------------
// 16kHz mono WAV recorder — base64 out, zero dependencies
// ---------------------------------------------------------------------------

export interface WavRecording {
  wavB64: string
  durationSec: number
}

export interface WavRecorder {
  /** Must be called inside a user gesture. Resolves when the mic is live. */
  start: () => Promise<void>
  /** Stop + encode; null when cancelled or nothing was captured. */
  stop: () => Promise<WavRecording | null>
  /** Discard the recording immediately. */
  cancel: () => void
  isRecording: () => boolean
}

/** Hard cap: auto-stop a run-away recording at 30s (whisper input budget). */
const MAX_RECORD_SEC = 30

let warnedSampleRate = false

function bytesToBase64(bytes: Uint8Array): string {
  let bin = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(bin)
}

/**
 * A recorder that produces a canonical 44-byte-header RIFF WAV (mono, 16-bit,
 * nominally 16kHz — whisper-cli accepts 16k/22.05k/44.1k input, so browsers
 * that refuse a 16k AudioContext still work; the actual rate is written into
 * the header and logged once).
 */
export function createWavRecorder(opts?: { onAutoStop?: () => void }): WavRecorder {
  let ctx: AudioContext | null = null
  let stream: MediaStream | null = null
  let processor: ScriptProcessorNode | null = null
  let source: MediaStreamAudioSourceNode | null = null
  let sink: GainNode | null = null
  let chunks: Int16Array[] = []
  let samples = 0
  let sampleRate = 16000
  let recording = false
  let cancelled = false
  let autoStopTimer: number | null = null

  const teardown = () => {
    recording = false
    if (autoStopTimer !== null) {
      window.clearTimeout(autoStopTimer)
      autoStopTimer = null
    }
    try {
      processor?.disconnect()
    } catch {
      /* already gone */
    }
    try {
      source?.disconnect()
    } catch {
      /* already gone */
    }
    try {
      sink?.disconnect()
    } catch {
      /* already gone */
    }
    try {
      stream?.getTracks().forEach((t) => t.stop())
    } catch {
      /* already gone */
    }
    try {
      ctx?.close()
    } catch {
      /* already gone */
    }
    processor = null
    source = null
    sink = null
    stream = null
    ctx = null
  }

  return {
    start: async () => {
      cancelled = false
      chunks = []
      samples = 0
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 },
      })
      const Ctor =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
      if (!Ctor) throw new Error('AudioContext unavailable in this browser')
      ctx = new Ctor({ sampleRate: 16000 })
      sampleRate = ctx.sampleRate
      if (sampleRate !== 16000 && !warnedSampleRate) {
        warnedSampleRate = true
        console.warn(
          `[mist-voice] browser forced a ${sampleRate}Hz sample rate (16k unavailable) — recording continues, whisper handles it`
        )
      }
      source = ctx.createMediaStreamSource(stream)
      processor = ctx.createScriptProcessor(4096, 1, 1)
      processor.onaudioprocess = (e) => {
        if (!recording) return
        const input = e.inputBuffer.getChannelData(0)
        const out = new Int16Array(input.length)
        for (let i = 0; i < input.length; i++) {
          const s = Math.max(-1, Math.min(1, input[i]))
          out[i] = s < 0 ? s * 0x8000 : s * 0x7fff
        }
        chunks.push(out)
        samples += out.length
      }
      source.connect(processor)
      // ScriptProcessor only pumps while connected to a destination — route it
      // through a muted gain node so nothing the user hears leaks back.
      sink = ctx.createGain()
      sink.gain.value = 0
      processor.connect(sink)
      sink.connect(ctx.destination)
      recording = true
      // unlock the shared audio bus in this gesture so the spoken reply later
      // can play through it (the orb reacts to real amplitude)
      void mistAudioResume()
      autoStopTimer = window.setTimeout(() => {
        autoStopTimer = null
        if (recording) opts?.onAutoStop?.()
      }, MAX_RECORD_SEC * 1000)
    },

    stop: () =>
      new Promise<WavRecording | null>((resolve) => {
        if (!recording) {
          teardown()
          resolve(null)
          return
        }
        recording = false
        const rate = sampleRate
        const total = samples
        const parts = chunks
        chunks = []
        teardown()
        if (cancelled || total === 0) {
          resolve(null)
          return
        }
        const data = new Uint8Array(44 + total * 2)
        const view = new DataView(data.buffer)
        const writeStr = (offset: number, s: string) => {
          for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i))
        }
        writeStr(0, 'RIFF')
        view.setUint32(4, 36 + total * 2, true)
        writeStr(8, 'WAVE')
        writeStr(12, 'fmt ')
        view.setUint32(16, 16, true)
        view.setUint16(20, 1, true) // PCM
        view.setUint16(22, 1, true) // mono
        view.setUint32(24, rate, true)
        view.setUint32(28, rate * 2, true)
        view.setUint16(32, 2, true)
        view.setUint16(34, 16, true)
        writeStr(36, 'data')
        view.setUint32(40, total * 2, true)
        let off = 44
        for (const part of parts) {
          for (let i = 0; i < part.length; i++, off += 2) view.setInt16(off, part[i], true)
        }
        resolve({ wavB64: bytesToBase64(data), durationSec: total / rate })
      }),

    cancel: () => {
      cancelled = true
      teardown()
    },

    isRecording: () => recording,
  }
}
