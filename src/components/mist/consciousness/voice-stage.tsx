'use client'

// M.I.S.T. — VoiceStage: the Consciousness view as a voice-first immersive
// stage. A giant NeuralCore fills the screen (tap to talk, hands-free loop),
// live captions roll beneath it, and while the in-app browser window is open
// the orb politely docks into the top-right corner instead of blocking
// content. Every voice exchange is persisted to the active thread — the
// transcript itself lives in the Chat tab (wave-2 shell renders this stage
// edge-to-edge; we only assume the parent provides height).
//
// Task 12-b · voice-first sprint v6

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { motion } from 'framer-motion'
import { ArrowRight, BrainCircuit, CircuitBoard, CloudRain, Mic, MicOff, Moon, PenLine, Radar, ScanFace, Sparkles, X } from 'lucide-react'
import { toast } from 'sonner'
import { useMistStore } from '@/lib/store'
import { useNeural } from '@/hooks/use-neural'
import { useVoiceSession, useWakeWord, micDeniedGuidance } from '@/hooks/use-voice'
import { mistSpeech, subtitleBus } from '@/lib/speech'
import { stripEmotionMarkers } from '@/lib/voice-emotion'
import { mistApi } from '@/lib/mist-api'
import { createMicRecorder, type MicRecorder } from '@/lib/audio-utils'
import { STATE_COLORS, STATE_LABELS } from '@/lib/mist-constants'
import type { ConsciousnessFace } from '@/lib/types'
import { NeuralCore } from './neural-core'
import { FaceStage } from './face-stage'
// w3-activity — the live activity line while she processes
import { ActivityLine } from '@/components/mist/shared/activity-line'
import { cn } from '@/lib/utils'

/** Hint copy per session phase (idle covers everything else). */
const HINTS: Record<'idle' | 'listening' | 'thinking' | 'speaking', string> = {
  idle: "Tap the orb and speak — or say 'Hey Mist'",
  listening: "I'm listening — speak freely",
  thinking: 'thinking…',
  speaking: 'speaking — tap the orb to interrupt',
}

/** The consciousness face picker — Mist's own orb plus the four adapted
 *  ai-visualizer canvas faces (and w3's clean-room Visage, the mouth-tracking
 *  face), all fed live by her voice state. */
const FACES: { id: ConsciousnessFace; label: string; icon: typeof Sparkles }[] = [
  { id: 'orb', label: 'Orb', icon: Sparkles },
  { id: 'board', label: 'Circuit', icon: CircuitBoard },
  { id: 'radial', label: 'Radial', icon: Radar },
  { id: 'rain', label: 'Rain', icon: CloudRain },
  { id: 'neural', label: 'Neural', icon: BrainCircuit },
  { id: 'visage', label: 'Visage', icon: ScanFace },
]

/** Captions never grow past this — longer replies offer the Chat tab. */
const REPLY_CAP = 600
const INTERIM_CAP = 240

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max).trimEnd()}…` : text
}

export function VoiceStage({ className }: { className?: string }) {
  const browserOpen = useMistStore((s) => s.browser.open)
  const setView = useMistStore((s) => s.setView)
  const setNeuralState = useMistStore((s) => s.setNeuralState)
  const neuralState = useMistStore((s) => s.neural.state)
  const voiceArmedSeq = useMistStore((s) => s.voiceArmedSeq)
  const reduced = useMistStore((s) => s.reducedMotion)
  const face = useMistStore((s) => s.consciousnessFace)
  const setFace = useMistStore((s) => s.setConsciousnessFace)

  // the hands-free loop + the background "Hey Mist" listener (the wake engine
  // is a module singleton — mounting it here is safe even when the shell
  // mounts it app-wide later)
  const voice = useVoiceSession()
  useWakeWord()

  // w5 voice-speed — the live subtitles: her sentence chunks + the one that
  // is audible RIGHT NOW (bold). Renders during the speaking phase; the
  // thinking phase shows the raw streaming text (below) so the stage is
  // never blank while she generates.
  const subs = useSyncExternalStore(subtitleBus.subscribe, subtitleBus.getSnapshot, subtitleBus.getServerSnapshot)
  const subsScrollRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    // keep the active sentence in view — nearest, smooth, minimal
    const el = subsScrollRef.current
    if (!el) return
    const active = el.querySelector<HTMLElement>('[data-active="true"]')
    active?.scrollIntoView({ block: 'nearest', behavior: reduced ? 'auto' : 'smooth' })
  }, [subs.activeIndex, subs.chunks.length, reduced])

  const { onResponse, sendVoiceEnergy } = useNeural()

  const { active: voiceActive, phase: voicePhase, localMode: voiceLocalMode } = voice
  const { start: voiceStart, stop: voiceStop, submit: voiceSubmit, finishCapture: voiceFinishCapture } = voice

  // ---- mirrors for event handlers (refs are never read during render) ----
  const voiceActiveRef = useRef(false)
  useEffect(() => {
    voiceActiveRef.current = voiceActive
  }, [voiceActive])

  // ---- hold-to-talk fallback (mirrors chat-panel's push-to-talk) ----
  const [holding, setHolding] = useState(false)
  const recorderRef = useRef<MicRecorder | null>(null)
  const holdingRef = useRef(false)
  const energyIntervalRef = useRef<number | null>(null)

  const startHold = useCallback(async () => {
    if (holdingRef.current || !voiceActiveRef.current) return
    try {
      const rec = createMicRecorder()
      recorderRef.current = rec
      await rec.start()
      holdingRef.current = true
      setHolding(true)
      useMistStore.getState().setNeuralState('listening')
      energyIntervalRef.current = window.setInterval(() => {
        const energy = rec.getEnergy()
        useMistStore.getState().setAudioEnergy(energy)
        sendVoiceEnergy(energy)
      }, 120)
    } catch {
      recorderRef.current = null
      toast.error('Microphone unavailable', { description: micDeniedGuidance(), duration: 5000 })
    }
  }, [sendVoiceEnergy])

  const cancelHold = useCallback(() => {
    if (!holdingRef.current) return
    holdingRef.current = false
    setHolding(false)
    if (energyIntervalRef.current !== null) {
      window.clearInterval(energyIntervalRef.current)
      energyIntervalRef.current = null
    }
    recorderRef.current?.cancel()
    recorderRef.current = null
    const store = useMistStore.getState()
    store.setAudioEnergy(0)
    // the session keeps waiting for the next hold
    if (store.neural.state !== 'listening') store.setNeuralState('listening')
    sendVoiceEnergy(0.05)
  }, [sendVoiceEnergy])

  const finishHold = useCallback(async () => {
    if (!holdingRef.current) return
    holdingRef.current = false
    setHolding(false)
    if (energyIntervalRef.current !== null) {
      window.clearInterval(energyIntervalRef.current)
      energyIntervalRef.current = null
    }
    const rec = recorderRef.current
    recorderRef.current = null
    if (!rec) return
    const wav = await rec.stop()
    useMistStore.getState().setAudioEnergy(0)
    if (!wav) {
      toast("I couldn't hear anything")
      useMistStore.getState().setNeuralState('listening')
      sendVoiceEnergy(0.05)
      return
    }
    try {
      const { transcription } = await mistApi.voice.stt(wav)
      const text = transcription?.trim()
      if (text) {
        voiceSubmit(text)
      } else {
        toast("I couldn't hear anything")
        useMistStore.getState().setNeuralState('listening')
        sendVoiceEnergy(0.05)
      }
    } catch {
      toast.error('Speech recognition unavailable')
      useMistStore.getState().setNeuralState('listening')
      sendVoiceEnergy(0.05)
    }
  }, [sendVoiceEnergy, voiceSubmit])

  // Global pointerup / Escape safety nets (recorder must never run away).
  useEffect(() => {
    const onUp = () => {
      if (holdingRef.current) void finishHold()
    }
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape' && holdingRef.current) cancelHold()
    }
    window.addEventListener('pointerup', onUp)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('keydown', onKey)
    }
  }, [finishHold, cancelHold])

  // ---- orb activation: idle → start · active → interrupt + stop ----
  // (local mode while listening: the tap SENDS the buffered utterance to
  //  whisper.cpp instead of ending the session)
  const handleOrbActivate = useCallback(() => {
    if (voiceActiveRef.current) {
      if (holdingRef.current) {
        cancelHold()
        mistSpeech.stop()
        voiceStop()
        return
      }
      if (voiceLocalMode && voicePhase === 'listening') {
        voiceFinishCapture()
        return
      }
      mistSpeech.stop()
      voiceStop()
    } else {
      voiceStart()
    }
  }, [cancelHold, voiceStart, voiceStop, voiceLocalMode, voicePhase, voiceFinishCapture])

  const endSessionClick = useCallback(() => {
    if (holdingRef.current) cancelHold()
    mistSpeech.stop()
    voiceStop()
  }, [cancelHold, voiceStop])

  const toggleDream = useCallback(() => {
    const cur = useMistStore.getState().neural.state
    setNeuralState(cur === 'dreaming' ? 'dormant' : 'dreaming')
  }, [setNeuralState])

  // ---- voiceArmedSeq watcher: orb clicks, "Hey Mist" and the floating
  // mini-orb all ask the stage to start the hands-free loop. Deferred to a
  // macrotask so the effect body stays free of synchronous setState.
  const armedRef = useRef(0)
  useEffect(() => {
    if (voiceArmedSeq <= 0 || voiceArmedSeq === armedRef.current) return
    armedRef.current = voiceArmedSeq
    const id = window.setTimeout(() => {
      if (!voiceActiveRef.current) voiceStart()
    }, 0)
    return () => window.clearTimeout(id)
  }, [voiceArmedSeq, voiceStart])

  // ---- persistence: every voice exchange lands in the active thread.
  // User utterances: ensure a thread exists (titled by the first 40 chars),
  // then append fire-and-forget. The transcript lives in the Chat tab.
  const threadIdRef = useRef<string | null>(null)
  useEffect(() => {
    if (voice.heardSeq <= 0) return
    const text = voice.lastHeard
    if (!text.trim()) return
    void (async () => {
      const store = useMistStore.getState()
      let threadId = threadIdRef.current ?? store.threads.activeId
      if (!threadId) {
        try {
          const conv = await mistApi.conversations.create(text.slice(0, 40) || 'Voice thread')
          threadId = conv.id
          threadIdRef.current = threadId
          store.setActiveThread(threadId)
          store.bumpThreadsRefresh()
        } catch {
          toast.error('Could not create thread — voice exchange not persisted')
          return
        }
      }
      threadIdRef.current = threadId
      mistApi.conversations.appendMessage(threadId, 'user', text).catch(() => {})
    })()
  }, [voice.heardSeq, voice.lastHeard])

  // Assistant replies: registered only while a session is live; persisted
  // with the same meta shape chat-panel uses.
  useEffect(() => {
    if (!voiceActive) return
    const unsub = onResponse((m) => {
      const text = (m.text ?? '').trim()
      if (!text) return
      const threadId = threadIdRef.current ?? useMistStore.getState().threads.activeId
      if (!threadId) return
      const store = useMistStore.getState()
      mistApi.conversations
        .appendMessage(threadId, 'assistant', m.text, {
          provider: m.provider,
          model: m.model,
          fallback: m.fallback,
          meta: {
            emotion: m.emotion,
            tools_used: m.tools_used ?? [],
            skills_used: m.skills_used ?? [],
            ...(Array.isArray(m.suggestions) ? { suggestions: m.suggestions } : {}),
          },
        })
        .catch(() => {})
      store.bumpThreadsRefresh()
    })
    return unsub
  }, [voiceActive, onResponse])

  // ---- derived caption content ----
  const reply = voice.lastReply
  const replyTruncated = reply.length > REPLY_CAP
  const replyShown = replyTruncated ? `${reply.slice(0, REPLY_CAP).trimEnd()}…` : reply
  const localListening = voiceActive && voice.localMode && voicePhase === 'listening'
  const hint = localListening
    ? 'speak, then tap the orb to send'
    : voiceActive && voicePhase in HINTS
      ? HINTS[voicePhase as keyof typeof HINTS]
      : HINTS.idle
  const orbLabel = voiceActive
    ? localListening
      ? 'Done speaking'
      : voicePhase === 'speaking'
        ? 'Stop speaking'
        : 'End session'
    : 'Talk with Mist'

  return (
    <section
      aria-label="M.I.S.T. voice stage"
      className={cn('relative flex h-full min-h-[60vh] w-full min-w-0 flex-col items-center', className)}
    >
      {/* ------------------------------------------------ FACE LAYER ----------
          Centered giant orb (default) or one of the adapted ai-visualizer
          canvas faces — the circuit board, the radial, the rain or the
          neural core — fed live by Mist's voice state through the face bus.
          While the in-app browser window is open the face docks top-right. */}
      <div className="relative flex min-h-0 w-full flex-1 items-center justify-center">
        {face === 'orb' ? (
          <motion.div
            layout={reduced ? false : true}
            animate={{ opacity: browserOpen ? 0.8 : 1 }}
            transition={
              reduced
                ? { duration: 0 }
                : { type: 'spring', stiffness: 150, damping: 20 }
            }
            className={cn(
              browserOpen
                ? 'absolute right-4 top-4 z-30 sm:right-6 sm:top-6'
                : 'relative'
            )}
          >
            <NeuralCore
              immersive
              docked={browserOpen}
              onActivate={handleOrbActivate}
              activateLabel={orbLabel}
            />
          </motion.div>
        ) : (
          <FaceStage face={face} docked={browserOpen} className={browserOpen ? '' : 'h-full w-full'} />
        )}
      </div>

      {/* ------------------------------------------------ CAPTIONS ---------- */}
      <div className="z-10 w-full shrink-0 px-4 pb-3">
        <div
          role="status"
          aria-live="polite"
          aria-label="Mist voice captions"
          className={cn(
            'min-h-24',
            browserOpen
              ? 'ml-0 mr-auto max-w-sm pl-1 text-left sm:pl-2'
              : 'mx-auto max-w-2xl text-center'
          )}
        >
          {/* listening — live interim transcript with a pulsing mic dot */}
          {voiceActive && voicePhase === 'listening' && (
            <p className="flex items-start gap-2.5 px-2 text-balance text-[15px] leading-relaxed">
              <span
                aria-hidden
                className="mt-2 h-2 w-2 shrink-0 animate-mist-pulse-glow rounded-full bg-emerald-400 shadow-[0_0_12px_rgba(52,211,153,0.8)]"
              />
              {voice.localMode ? (
                /* local offline capture — no interim transcript from whisper */
                <span className="line-clamp-3 italic text-slate-300">Listening…</span>
              ) : voice.supportsRecognition ? (
                <span className="line-clamp-3 italic text-slate-300">
                  {voice.interim ? truncate(voice.interim, INTERIM_CAP) : 'Listening…'}
                </span>
              ) : (
                <span className="text-amber-300/90">
                  {holding ? 'Release to send' : (voice.error ?? 'Hold the mic button to talk')}
                </span>
              )}
            </p>
          )}

          {/* thinking — the live activity line (w3-activity): what she is
              doing RIGHT NOW, one honest mono line under the orb ("thinking",
              "reading package.json", "searching the web — …"). Shown while a
              voice turn thinks, and while a chat turn processes in the
              background — the creator may be watching the orb from here.
              w5: once her reply starts STREAMING, the text itself shows here
              too — text first, voice seconds later, never a blank stage. */}
          {(voicePhase === 'thinking' || (!voiceActive && neuralState === 'processing')) && (
            <div className="px-2">
              <p className="min-h-6 pt-2">
                <ActivityLine active className="text-[11px]" />
              </p>
              {voiceActive && voicePhase === 'thinking' && voice.streamingReply && (
                <p className="mist-scroll mt-1 max-h-40 animate-mist-fade-in overflow-y-auto text-balance text-[15px] leading-relaxed text-slate-300/90">
                  {/* w8: markers are for her voice, never for the reader */}
                  {truncate(stripEmotionMarkers(voice.streamingReply), REPLY_CAP)}
                </p>
              )}
            </div>
          )}

          {/* speaking — the live subtitles (w5): the sentence being spoken is
              BOLD and bright, the ones already spoken fade back, the ones
              still queued wait dim — a slick minimal karaoke-style caption
              that tracks her actual voice. Falls back to the plain reply
              text when the utterance didn't stream (whole-text speak path). */}
          {voicePhase === 'speaking' && subs.chunks.length > 0 && (
            <div
              ref={subsScrollRef}
              className="mist-scroll max-h-44 overflow-y-auto px-2 text-balance text-[15px] leading-relaxed"
              aria-label="Mist speaking — live captions"
            >
              {subs.chunks.map((c, i) => (
                <span
                  key={i}
                  data-active={i === subs.activeIndex}
                  className={cn(
                    'transition-colors duration-500',
                    reduced && 'transition-none',
                    i === subs.activeIndex
                      ? 'font-semibold text-slate-50 [text-shadow:0_0_12px_rgba(148,163,184,0.25)]'
                      : i < subs.activeIndex
                        ? 'text-slate-500'
                        : 'text-slate-400'
                  )}
                >
                  {c}{' '}
                </span>
              ))}
            </div>
          )}

          {/* speaking (non-streamed utterance) — Mist's reply, fading in */}
          {voicePhase === 'speaking' && subs.chunks.length === 0 && replyShown && (
            <div className="px-2">
              <p className="mist-scroll max-h-40 animate-mist-fade-in overflow-y-auto text-balance text-[15px] leading-relaxed text-slate-100">
                {replyShown}
              </p>
              {replyTruncated && (
                <button
                  type="button"
                  onClick={() => setView('chat')}
                  className="mt-1.5 font-mono text-[10px] uppercase tracking-widest text-teal-300/80 underline-offset-4 transition-colors hover:text-teal-200 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-400/60"
                >
                  …full reply in Chat
                </button>
              )}
            </div>
          )}

          {/* a session that died on an error keeps its explanation visible */}
          {!voiceActive && voicePhase === 'error' && voice.error && (
            <p className="px-2 pt-2 text-[13px] leading-relaxed text-rose-300/90">{voice.error}</p>
          )}
        </div>
      </div>

      {/* ---------------------------------------- SESSION CONTROLS ---------- */}
      {voiceActive && (
        <div className="z-10 flex w-full shrink-0 flex-col items-center justify-center gap-3 px-4 pb-3 sm:flex-row">
          {!voice.supportsRecognition && !voice.localMode && (
            <motion.button
              type="button"
              aria-label={holding ? 'Release to send' : 'Hold to talk'}
              onPointerDown={(e) => {
                e.preventDefault()
                void startHold()
              }}
              onPointerUp={() => void finishHold()}
              onPointerLeave={() => {
                if (holdingRef.current) void finishHold()
              }}
              onKeyDown={(e) => {
                if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) {
                  e.preventDefault()
                  void startHold()
                }
              }}
              onKeyUp={(e) => {
                if (e.key === ' ' || e.key === 'Enter') {
                  e.preventDefault()
                  void finishHold()
                }
              }}
              whileHover={reduced ? undefined : { scale: 1.05 }}
              whileTap={reduced ? undefined : { scale: 0.96 }}
              className={cn(
                'relative flex h-16 w-16 shrink-0 select-none touch-none items-center justify-center rounded-full border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-400/60',
                holding
                  ? 'border-rose-400/50 bg-rose-400/20 text-rose-300'
                  : 'mist-glass-soft text-slate-200 hover:text-emerald-300'
              )}
            >
              {holding && (
                <span
                  aria-hidden
                  className="absolute inset-0 animate-mist-pulse-glow rounded-full border-2 border-rose-400/40"
                />
              )}
              {holding ? (
                <MicOff aria-hidden className="h-6 w-6" />
              ) : (
                <Mic aria-hidden className="h-6 w-6" />
              )}
            </motion.button>
          )}
          <button
            type="button"
            onClick={endSessionClick}
            className="flex items-center gap-1.5 rounded-full border border-white/10 px-4 py-2 font-mono text-[11px] uppercase tracking-widest text-slate-400 transition-colors hover:border-rose-400/40 hover:text-rose-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-400/60"
          >
            <X aria-hidden className="h-3.5 w-3.5" />
            End session
          </button>
        </div>
      )}

      {/* ---------------------------------------- STATE + HINT ROW ---------- */}
      <div
        className={cn(
          'z-10 flex w-full shrink-0 flex-wrap items-center gap-x-4 gap-y-2 pb-4 font-mono text-[10px] uppercase tracking-[0.22em] sm:text-[11px]',
          browserOpen ? 'justify-start pl-5 sm:pl-7' : 'justify-center px-4'
        )}
      >
        <span
          className="flex items-center gap-2 transition-colors duration-500"
          style={{ color: STATE_COLORS[neuralState] }}
        >
          <span
            aria-hidden
            className="h-1.5 w-1.5 rounded-full"
            style={{
              backgroundColor: STATE_COLORS[neuralState],
              boxShadow: `0 0 10px ${STATE_COLORS[neuralState]}`,
            }}
          />
          {STATE_LABELS[neuralState]}
        </span>
        <span className="normal-case tracking-[0.08em] text-slate-500">{hint}</span>
        <span className="flex items-center gap-2">
          {/* face picker — orb / circuit / radial / rain / neural */}
          <span
            role="group"
            aria-label="Consciousness face"
            className="flex items-center gap-1 rounded-full border border-white/10 p-0.5"
          >
            {FACES.map(({ id, label, icon: Icon }) => {
              const active = face === id
              return (
                <button
                  key={id}
                  type="button"
                  onClick={() => setFace(id)}
                  title={`${label} face`}
                  aria-label={`Switch consciousness face to ${label}`}
                  aria-pressed={active}
                  className={cn(
                    'flex h-6 w-6 items-center justify-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-400/60',
                    active
                      ? 'bg-teal-400/15 text-teal-300 shadow-[0_0_10px_rgba(45,212,191,0.25)]'
                      : 'text-slate-500 hover:text-slate-200'
                  )}
                >
                  <Icon aria-hidden className="h-3 w-3" />
                </button>
              )
            })}
          </span>
          <button
            type="button"
            onClick={() => setView('chat')}
            aria-label="Switch to the chat view and type instead"
            className="flex items-center gap-1.5 rounded-full border border-white/10 px-2.5 py-1 text-slate-400 transition-colors hover:border-purple-400/40 hover:text-purple-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-400/60"
          >
            <PenLine aria-hidden className="h-3 w-3" />
            Type instead
            <ArrowRight aria-hidden className="h-3 w-3" />
          </button>
          <button
            type="button"
            onClick={toggleDream}
            title="Dream state — memory consolidation"
            aria-label="Toggle dream state — memory consolidation"
            className={cn(
              'flex h-7 w-7 items-center justify-center rounded-full border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-400/60',
              neuralState === 'dreaming'
                ? 'border-fuchsia-400/50 bg-fuchsia-400/15 text-fuchsia-300'
                : 'border-white/10 text-slate-400 hover:border-fuchsia-400/40 hover:text-fuchsia-300'
            )}
          >
            <Moon aria-hidden className="h-3.5 w-3.5" />
          </button>
        </span>
      </div>
    </section>
  )
}

export default VoiceStage
