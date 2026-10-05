'use client'

// VoiceTab — voice pipeline status, TTS test bench (SDK voices) and a
// push-to-talk STT test with live recording state.

import { useEffect, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import { Loader2, Mic, Volume2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import { mistApi } from '@/lib/mist-api'
import { createMicRecorder, type MicRecorder } from '@/lib/audio-utils'
import { useMistStore } from '@/lib/store'
import { TTS_VOICES, GEMINI_DIRECT_VOICES } from '@/lib/mist-constants'
import { googleTtsAvailable, googleTtsSynthesize, resolveGeminiVoice, type GoogleTtsProbe } from '@/lib/google-direct'
import { cn } from '@/lib/utils'
import { SectionLabel, StatusDot } from './shared'
import type { VoiceStatus } from '@/lib/types'

export function VoiceTab() {
  const voice = useMistStore((s) => s.voice)
  const setVoice = useMistStore((s) => s.setVoice)
  const voiceEngine = useMistStore((s) => s.voiceEngine)

  const [status, setStatus] = useState<VoiceStatus | null>(null)
  const [statusError, setStatusError] = useState<string | null>(null)

  // Gemini-direct availability (Mark-LV wave-2) — honest one-shot probe of
  // whether THIS browser can reach Google TTS; blocked/error falls back to
  // the server chain when speaking
  const [geminiProbe, setGeminiProbe] = useState<GoogleTtsProbe>('unknown')
  useEffect(() => {
    if (voiceEngine !== 'gemini') return
    let alive = true
    setGeminiProbe('unknown')
    googleTtsAvailable().then((s) => {
      if (alive) setGeminiProbe(s)
    })
    return () => {
      alive = false
    }
  }, [voiceEngine])

  const [ttsText, setTtsText] = useState('')
  const [speaking, setSpeaking] = useState(false)
  const [audioUrl, setAudioUrl] = useState<string | null>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)

  const [sttState, setSttState] = useState<'idle' | 'recording' | 'transcribing'>('idle')
  const [transcription, setTranscription] = useState<string | null>(null)
  const recorderRef = useRef<MicRecorder | null>(null)
  const stoppingRef = useRef(false)

  useEffect(() => {
    let alive = true
    mistApi
      .voice.status()
      .then((s) => {
        if (alive) setStatus(s)
      })
      .catch((e) => {
        if (alive) setStatusError(e instanceof Error ? e.message : 'voice status unavailable')
      })
    return () => {
      alive = false
    }
  }, [])

  // Release the object URL when it is replaced / unmounted.
  useEffect(() => {
    return () => {
      if (audioUrl) URL.revokeObjectURL(audioUrl)
    }
  }, [audioUrl])

  const speak = async () => {
    const text = ttsText.trim()
    if (!text) {
      toast.error('Type something for M.I.S.T. to say')
      return
    }
    setSpeaking(true)
    try {
      let blob: Blob
      if (voiceEngine === 'gemini') {
        // exercise the browser-direct path this settings page promises —
        // on failure fall back to the server chain and say so honestly
        try {
          blob = await googleTtsSynthesize(text, resolveGeminiVoice(voice))
        } catch (err) {
          const reason = err instanceof Error ? err.message : 'Gemini direct unavailable'
          toast.error(`Gemini direct failed (${reason.slice(0, 140)}) — serving on the GLM chain instead`)
          blob = await mistApi.voice.tts(text, undefined, 1.0)
        }
      } else {
        blob = await mistApi.voice.tts(text, voice, 1.0)
      }
      if (audioUrl) URL.revokeObjectURL(audioUrl)
      const url = URL.createObjectURL(blob)
      setAudioUrl(url)
      const el = new Audio(url)
      audioRef.current = el
      await el.play()
      toast.success('Speaking…')
    } catch {
      toast.error('TTS unavailable')
    } finally {
      setSpeaking(false)
    }
  }

  const startRecording = async () => {
    if (sttState !== 'idle' || recorderRef.current) return
    setTranscription(null)
    try {
      const rec = createMicRecorder()
      recorderRef.current = rec
      stoppingRef.current = false
      await rec.start()
      setSttState('recording')
    } catch {
      recorderRef.current = null
      toast.error('Microphone unavailable')
    }
  }

  const stopRecording = async () => {
    const rec = recorderRef.current
    if (!rec || stoppingRef.current) return
    stoppingRef.current = true
    setSttState('transcribing')
    const blob = await rec.stop()
    recorderRef.current = null
    if (!blob) {
      setSttState('idle')
      return
    }
    try {
      const res = await mistApi.voice.stt(blob)
      setTranscription(res.transcription?.length > 0 ? res.transcription : '(silence detected)')
    } catch {
      toast.error('STT unavailable')
    } finally {
      setSttState('idle')
    }
  }

  const sttReady = status ? status.sdk_voice || status.whisper_loaded : false
  const ttsReady = status ? status.sdk_voice || status.kokoro_loaded : false
  const localModels = status ? status.whisper_loaded || status.kokoro_loaded : false

  return (
    <div className="flex min-w-0 flex-col gap-4">
      {/* ---- pipeline status ---- */}
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.25 }}
        className="mist-glass-soft p-4"
      >
        <SectionLabel>voice pipeline</SectionLabel>
        <div className="mt-3 space-y-2">
          {status === null && statusError === null ? (
            Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-5 w-full max-w-72 bg-white/5" />)
          ) : statusError !== null ? (
            <p className="font-mono text-[11px] text-rose-300/90">voice status unavailable — {statusError}</p>
          ) : (
            <>
              <StatusRow
                ok={sttReady}
                label="STT"
                detail={sttReady ? (status?.sdk_voice ? 'sdk voice ready' : 'whisper local') : 'unavailable'}
              />
              <StatusRow
                ok={ttsReady}
                label="TTS"
                detail={ttsReady ? (status?.sdk_voice ? 'sdk voice ready' : 'kokoro local') : 'unavailable'}
              />
              <StatusRow
                ok={false}
                neutral
                label="LOCAL MODELS"
                detail={localModels ? 'installed' : 'not installed (optional ~3GB)'}
              />
            </>
          )}
          {status && status.voices.length > 0 ? (
            <div className="flex flex-wrap gap-1.5 pt-1">
              {status.voices.slice(0, 8).map((v) => (
                <span
                  key={v}
                  className={cn(
                    'rounded-full border px-2 py-0.5 font-mono text-[10px]',
                    v === status.default_voice
                      ? 'border-teal-300/30 bg-teal-300/10 text-teal-200'
                      : 'border-white/10 text-slate-500'
                  )}
                >
                  {v}
                </span>
              ))}
            </div>
          ) : null}
        </div>
      </motion.div>

      {/* ---- tts test ---- */}
      <div className="mist-glass-soft p-4">
        <SectionLabel>tts test bench</SectionLabel>
        <div className="mt-3 space-y-2">
          <Textarea
            value={ttsText}
            onChange={(e) => setTtsText(e.target.value)}
            placeholder="Type something for M.I.S.T. to say…"
            aria-label="Text to speak"
            className="min-h-16 min-w-0 resize-none border-white/10 bg-white/5 text-sm text-slate-200 placeholder:text-slate-500"
            maxLength={500}
          />
          <div className="flex flex-wrap items-center gap-2">
            <Select value={voice} onValueChange={(v) => setVoice(v)}>
              <SelectTrigger
                aria-label="TTS voice"
                className="h-9 w-48 min-w-0 border-white/10 bg-white/5 font-mono text-xs text-slate-200"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="max-h-72 border-white/10 bg-slate-950/95 backdrop-blur-xl">
                {/* engine-aware catalog — gemini lists the real Google prebuilt voices */}
                {(voiceEngine === 'gemini' ? GEMINI_DIRECT_VOICES : TTS_VOICES).map((v) => (
                  <SelectItem key={v.id} value={v.id} className="font-mono text-xs text-slate-200">
                    {v.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              type="button"
              size="sm"
              onClick={() => void speak()}
              disabled={speaking}
              className="h-9 gap-1.5 bg-teal-300/90 font-mono text-[11px] text-slate-950 hover:bg-teal-200"
            >
              {speaking ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
              ) : (
                <Volume2 className="h-3.5 w-3.5" aria-hidden="true" />
              )}
              Speak
            </Button>
          </div>
          {voiceEngine === 'gemini' ? (
            <p
              className={cn(
                'w-full font-mono text-[10px] leading-relaxed',
                geminiProbe === 'available'
                  ? 'text-emerald-300/80'
                  : geminiProbe === 'blocked'
                    ? 'text-amber-300/80'
                    : geminiProbe === 'error'
                      ? 'text-rose-300/80'
                      : 'text-slate-500'
              )}
            >
              {geminiProbe === 'available'
                ? 'Gemini direct: reachable from this browser'
                : geminiProbe === 'blocked'
                  ? 'Gemini direct: Google blocks this browser\u2019s region — speaking falls back to the GLM chain'
                  : geminiProbe === 'error'
                    ? 'Gemini direct: unreachable — speaking falls back to the GLM chain'
                    : 'Gemini direct: probing this browser\u2026'}
            </p>
          ) : null}
          {audioUrl ? (
            <div className="space-y-1">
              <audio ref={audioRef} controls src={audioUrl} className="h-8 w-full" preload="none">
                Your browser does not support the audio element.
              </audio>
              <p className="font-mono text-[10px] text-slate-500">rendered via the audio element — replay above</p>
            </div>
          ) : (
            <p className="font-mono text-[10px] text-slate-500">spoken replies play through a generated audio element</p>
          )}
        </div>
      </div>

      {/* ---- stt test ---- */}
      <div className="mist-glass-soft p-4">
        <SectionLabel>stt test bench</SectionLabel>
        <div className="mt-3 flex flex-col items-start gap-3">
          <button
            type="button"
            onPointerDown={() => void startRecording()}
            onPointerUp={() => void stopRecording()}
            onPointerLeave={() => void stopRecording()}
            onPointerCancel={() => void stopRecording()}
            onContextMenu={(e) => e.preventDefault()}
            disabled={sttState === 'transcribing'}
            aria-label={sttState === 'recording' ? 'Release to stop recording' : 'Hold to record speech'}
            className={cn(
              'flex h-11 min-w-44 items-center justify-center gap-2 rounded-xl border px-4 font-mono text-xs transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-400/60 disabled:opacity-60',
              sttState === 'recording'
                ? 'border-rose-400/60 bg-rose-400/15 text-rose-200 animate-mist-pulse-glow'
                : 'border-teal-300/25 bg-teal-300/10 text-teal-200 hover:border-teal-300/40 hover:bg-teal-300/15'
            )}
          >
            {sttState === 'transcribing' ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            ) : (
              <Mic className="h-4 w-4" aria-hidden="true" />
            )}
            {sttState === 'recording' ? 'RELEASE TO TRANSCRIBE…' : sttState === 'transcribing' ? 'TRANSCRIBING…' : 'HOLD TO TALK'}
          </button>
          {transcription != null ? (
            <p className="min-w-0 break-words rounded-lg border border-emerald-400/20 bg-emerald-400/[0.03] p-3 font-mono text-sm text-emerald-300">
              “{transcription}”
            </p>
          ) : null}
          <p className="text-[11px] leading-relaxed text-slate-500">
            Tip: hold the mic in Consciousness (or Alt+V) to speak to the core directly.
          </p>
        </div>
      </div>
    </div>
  )
}

function StatusRow({ ok, neutral, label, detail }: { ok: boolean; neutral?: boolean; label: string; detail: string }) {
  return (
    <div className="flex items-center gap-2.5">
      <StatusDot pulse={false} className={ok ? 'bg-emerald-400' : neutral ? 'bg-slate-600' : 'bg-rose-400'} />
      <span className="font-mono text-[10px] tracking-widest text-slate-400">{label}</span>
      <span className="min-w-0 flex-1 truncate text-right font-mono text-[10px] text-slate-500">· {detail}</span>
    </div>
  )
}
