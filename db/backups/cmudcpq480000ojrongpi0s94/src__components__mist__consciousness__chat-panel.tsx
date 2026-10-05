'use client'

// M.I.S.T. — ChatPanel: the conversation surface.
// Owns message state locally (spec 4.7); talks to the neural socket via
// use-neural (single registered listener) and persists via mistApi.
// Full flows: text send → thread bootstrap → socket thought → response render
// → persistence → TTS; push-to-talk mic → WAV → STT → send.
// Task 3-b · frontend core

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import {
  BookmarkPlus,
  ExternalLink,
  FileText,
  GraduationCap,
  HelpCircle,
  Lightbulb,
  Mic,
  MicOff,
  Play,
  Plus,
  Send,
  Volume2,
  VolumeX,
} from 'lucide-react'
import { toast } from 'sonner'
import { useMistStore } from '@/lib/store'
import { useNeural } from '@/hooks/use-neural'
import { mistApi } from '@/lib/mist-api'
import { createMicRecorder, type MicRecorder } from '@/lib/audio-utils'
import { PROVIDER_LABELS, STATE_COLORS } from '@/lib/mist-constants'
import type {
  CapabilityRequest,
  Citation,
  ConsciousnessResponseMsg,
  MediaAttachment,
  ProviderId,
  SkillHint,
} from '@/lib/types'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'

// ---------------------------------------------------------------- utilities

interface LocalMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  provider?: string
  model?: string
  fallback?: boolean
  emotion?: string
  tools_used?: string[]
  skills_used?: string[]
  skill_hint?: SkillHint | null
  skillSaved?: boolean
  citations?: Citation[]
  attachments?: MediaAttachment[]
  suggestions?: string[]
  capability_request?: CapabilityRequest | null
  ts: Date
}

interface SkillDraft {
  msgId: string
  tool: string
  name: string
  trigger: string
  steps: string
}

const SUGGESTIONS = [
  'Research the latest in AI agents — with sources',
  'Open wikipedia.org in your browser and explore it',
  "Run a capability check: what can you actually do?",
  'Remember that I love emerald accents',
]

const COMPOSER_MAX_H = 144 // ~6 rows

function uid(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID()
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

function fmtTime(d: Date): string {
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function fmtSeek(seconds?: number): string {
  if (!seconds || seconds <= 0) return ''
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

function citationChipClass(quality?: string): string {
  if (quality === 'high') return 'border-emerald-300/25 bg-emerald-300/5 text-emerald-300/85'
  if (quality === 'low') return 'border-rose-300/25 bg-rose-300/5 text-rose-300/70'
  return 'border-amber-300/25 bg-amber-300/5 text-amber-300/85'
}

const KIND_BADGES: Record<string, string> = {
  alternative: 'border-emerald-300/25 bg-emerald-300/5 text-emerald-300/80',
  workaround: 'border-amber-300/25 bg-amber-300/5 text-amber-300/80',
  enable: 'border-purple-300/25 bg-purple-300/5 text-purple-300/80',
  clarify: 'border-teal-300/25 bg-teal-300/5 text-teal-300/80',
  later: 'border-slate-400/25 bg-slate-400/5 text-slate-400/80',
}

// ---------------------------------------------------------------- component

export function ChatPanel({ className }: { className?: string }) {
  // ---- store (fine-grained selectors)
  const activeId = useMistStore((s) => s.threads.activeId)
  const threadsList = useMistStore((s) => s.threads.list)
  const setActiveThread = useMistStore((s) => s.setActiveThread)
  const bumpThreadsRefresh = useMistStore((s) => s.bumpThreadsRefresh)
  const provider = useMistStore((s) => s.provider)
  const setProvider = useMistStore((s) => s.setProvider)
  const ttsEnabled = useMistStore((s) => s.ttsEnabled)
  const setTtsEnabled = useMistStore((s) => s.setTtsEnabled)
  const neuralState = useMistStore((s) => s.neural.state)
  const micFocus = useMistStore((s) => s.micFocus)

  const storeReduced = useMistStore((s) => s.reducedMotion)
  const prefersReduced = useReducedMotion()
  const reduced = storeReduced || !!prefersReduced

  // ---- neural socket
  const { sendThought, setProvider: setNeuralProvider, sendVoiceEnergy, onResponse } = useNeural()

  // ---- local state (message state lives HERE per spec)
  const [messages, setMessages] = useState<LocalMessage[]>([])
  const [input, setInput] = useState('')
  const [awaiting, setAwaiting] = useState(false)
  const [historyLoading, setHistoryLoading] = useState(false)
  const [recording, setRecording] = useState(false)
  const [providers, setProviders] = useState<ProviderId[]>(['auto'])
  const [skillDraft, setSkillDraft] = useState<SkillDraft | null>(null)

  // ---- refs
  const messagesRef = useRef<LocalMessage[]>(messages)
  const awaitingRef = useRef(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const atBottomRef = useRef(true)
  const skipHistoryLoadRef = useRef(false)
  const sendThreadIdRef = useRef<string | null>(null)
  const recorderRef = useRef<MicRecorder | null>(null)
  const recordingRef = useRef(false)
  const energyIntervalRef = useRef<number | null>(null)
  const audioElRef = useRef<HTMLAudioElement | null>(null)

  const setAwaitingBoth = (b: boolean) => {
    awaitingRef.current = b
    setAwaiting(b)
  }

  // Keep the messages mirror in sync for event-handler reads (send history).
  useEffect(() => {
    messagesRef.current = messages
  }, [messages])

  // ---------------------------------------------------------------- speak

  const speak = useCallback(async (text: string) => {
    try {
      const store = useMistStore.getState()
      audioElRef.current?.pause()
      const blob = await mistApi.voice.tts(text.slice(0, 900), store.voice, 1.0)
      const url = URL.createObjectURL(blob)
      const audio = new Audio(url)
      audioElRef.current = audio
      store.setNeuralState('speaking')
      audio.onended = () => {
        URL.revokeObjectURL(url)
        useMistStore.getState().setNeuralState('dormant')
      }
      await audio.play()
    } catch (err) {
      useMistStore.getState().setNeuralState('dormant')
      // Autoplay policy blocks unmuted audio without a gesture — skip silently.
      if (err instanceof DOMException && (err.name === 'NotAllowedError' || err.name === 'AbortError')) return
      toast.error('Voice playback unavailable')
    }
  }, [])

  // ---------------------------------------------------------------- send

  const send = useCallback(
    async (content: string): Promise<boolean> => {
      const text = content.trim()
      if (!text || awaitingRef.current) return false

      const store = useMistStore.getState()
      const userMsg: LocalMessage = { id: uid(), role: 'user', content: text, ts: new Date() }
      setMessages((prev) => [...prev, userMsg])
      setInput('')
      setAwaitingBoth(true)
      atBottomRef.current = true

      // Ensure a thread exists (bootstrap with the first thought).
      let threadId = store.threads.activeId
      if (!threadId) {
        try {
          const conv = await mistApi.conversations.create(text.slice(0, 40) || 'New thread')
          threadId = conv.id
          skipHistoryLoadRef.current = true // keep the just-appended local message
          store.setActiveThread(threadId)
          store.bumpThreadsRefresh()
        } catch {
          toast.error('Could not create thread — message not persisted')
        }
      }
      sendThreadIdRef.current = threadId ?? null

      // Persist the user message (fire-and-forget).
      if (threadId) {
        mistApi.conversations.appendMessage(threadId, 'user', text).catch(() => {})
      }

      // Last 12 local messages as history (including the one just sent).
      const history = [...messagesRef.current, userMsg]
        .slice(-12)
        .map((m) => ({ role: m.role, content: m.content }))

      sendThought({
        content: text,
        provider: store.provider,
        conversation_id: threadId ?? undefined,
        history,
      })
      return true
    },
    [sendThought]
  )

  // ---------------------------------------------------------------- receive

  const handleResponse = useCallback(
    (msg: ConsciousnessResponseMsg) => {
      const store = useMistStore.getState()
      const citations = Array.isArray(msg.citations) ? msg.citations : []
      const attachments = Array.isArray(msg.attachments) ? msg.attachments : []
      const suggestions = Array.isArray(msg.suggestions) ? msg.suggestions : []
      const capability_request = msg.capability_request ?? null
      const assistantMsg: LocalMessage = {
        id: uid(),
        role: 'assistant',
        content: msg.text,
        provider: msg.provider,
        model: msg.model,
        fallback: msg.fallback,
        emotion: msg.emotion,
        tools_used: msg.tools_used,
        skills_used: msg.skills_used,
        skill_hint: msg.skill_hint,
        citations,
        attachments,
        suggestions,
        capability_request,
        ts: msg.timestamp ? new Date(msg.timestamp) : new Date(),
      }
      // Only render into the view that owns this exchange.
      const currentId = store.threads.activeId
      const belongsHere =
        !sendThreadIdRef.current || sendThreadIdRef.current === currentId || currentId === null
      if (belongsHere) setMessages((prev) => [...prev, assistantMsg])
      setAwaitingBoth(false)

      // "It opens a tab" — MIST proactively surfaces media in the in-app browser.
      if (attachments.length > 0 && store.autoOpenMedia) {
        const first = attachments[0]
        store.openBrowserTab({
          url: first.url,
          title: first.title,
          kind: first.type === 'video' ? 'video' : 'article',
          seekTo: first.seek_to,
          note: first.note,
        })
      }

      const persistTo = sendThreadIdRef.current ?? store.threads.activeId
      if (persistTo) {
        mistApi.conversations
          .appendMessage(persistTo, 'assistant', msg.text, {
            provider: msg.provider,
            model: msg.model,
            fallback: msg.fallback,
            meta: { citations, attachments, suggestions, capability_request },
          })
          .catch(() => {})
      }
      store.bumpThreadsRefresh()
      if (store.ttsEnabled && msg.text) void speak(msg.text)
    },
    [speak]
  )

  // Register ONCE — handler + onResponse are stable callbacks.
  useEffect(() => {
    const unsub = onResponse(handleResponse)
    return unsub
  }, [onResponse, handleResponse])

  // External compose requests (e.g. "ask M.I.S.T. about this page" from the
  // in-app browser window) pre-fill the composer.
  useEffect(() => {
    const onCompose = (e: Event) => {
      const detail = (e as CustomEvent<string>).detail
      if (typeof detail === 'string' && detail.trim()) {
        setInput(detail.slice(0, 2000))
        textareaRef.current?.focus()
      }
    }
    window.addEventListener('mist:compose', onCompose)
    return () => window.removeEventListener('mist:compose', onCompose)
  }, [])

  // ---------------------------------------------------------------- history
  // Thread clearing for activeId → null happens in the "New thread" handler;
  // every setState below runs inside async callbacks (no cascading renders).

  useEffect(() => {
    let cancelled = false
    if (skipHistoryLoadRef.current) {
      skipHistoryLoadRef.current = false
      return
    }
    if (!activeId) return
    Promise.resolve()
      .then(() => {
        if (!cancelled) setHistoryLoading(true)
        return mistApi.conversations.messages(activeId)
      })
      .then((rows) => {
        if (cancelled) return
        setMessages(
          rows
            .filter((m) => m.role === 'user' || m.role === 'assistant')
            .map<LocalMessage>((m) => {
              const meta = (m.meta ?? {}) as {
                citations?: Citation[]
                attachments?: MediaAttachment[]
                suggestions?: string[]
                capability_request?: CapabilityRequest | null
              }
              return {
                id: m.id,
                role: m.role === 'assistant' ? 'assistant' : 'user',
                content: m.content,
                provider: m.provider,
                model: m.model,
                fallback: m.fallback,
                citations: Array.isArray(meta.citations) ? meta.citations : undefined,
                attachments: Array.isArray(meta.attachments) ? meta.attachments : undefined,
                suggestions: Array.isArray(meta.suggestions) ? meta.suggestions : undefined,
                capability_request: meta.capability_request ?? undefined,
                ts: new Date(m.created_at),
              }
            })
        )
      })
      .catch(() => {
        if (cancelled) return
        setMessages([])
        toast.error('Could not load conversation history')
      })
      .finally(() => {
        if (!cancelled) setHistoryLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [activeId])

  // ---------------------------------------------------------------- providers

  useEffect(() => {
    let alive = true
    mistApi.llm
      .status()
      .then((s) => {
        if (!alive) return
        const list = s.available_providers?.length ? s.available_providers : ['auto']
        setProviders(list as ProviderId[])
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [])

  const providerOptions = providers.includes(provider) ? providers : [...providers, provider]

  const onProviderChange = (v: string) => {
    const p = v as ProviderId
    setProvider(p)
    setNeuralProvider(p)
  }

  // ---------------------------------------------------------------- autoscroll

  const onScroll = () => {
    const el = scrollRef.current
    if (!el) return
    atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120
  }

  useEffect(() => {
    const el = scrollRef.current
    if (el && atBottomRef.current) el.scrollTop = el.scrollHeight
  }, [messages, awaiting, historyLoading])

  // ---------------------------------------------------------------- composer

  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, COMPOSER_MAX_H)}px`
    el.style.overflowY = el.scrollHeight > COMPOSER_MAX_H ? 'auto' : 'hidden'
  }, [input])

  const submit = (e?: FormEvent) => {
    e?.preventDefault()
    void send(input)
  }

  const onComposerKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void send(input)
    }
  }

  // ---------------------------------------------------------------- voice

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
        const energy = rec.getEnergy()
        useMistStore.getState().setAudioEnergy(energy)
        sendVoiceEnergy(energy)
      }, 120)
    } catch {
      recorderRef.current = null
      toast.error('Microphone unavailable')
    }
  }, [sendVoiceEnergy])

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
    const store = useMistStore.getState()
    store.setAudioEnergy(0)
    store.setNeuralState('dormant')
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
    useMistStore.getState().setAudioEnergy(0)
    if (!wav) {
      toast.error('No speech captured')
      useMistStore.getState().setNeuralState('dormant')
      return
    }
    try {
      const { transcription } = await mistApi.voice.stt(wav)
      const text = transcription?.trim()
      if (text) {
        const sent = await send(text)
        if (!sent) toast('M.I.S.T. is still processing — try again in a moment')
      } else {
        toast("I couldn't hear anything")
        useMistStore.getState().setNeuralState('dormant')
      }
    } catch {
      toast.error('Speech recognition unavailable')
      useMistStore.getState().setNeuralState('dormant')
    }
  }, [send])

  // Global pointerup / Escape safety nets.
  useEffect(() => {
    const onUp = () => {
      if (recordingRef.current) void stopRecording()
    }
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape' && recordingRef.current) cancelRecording()
    }
    window.addEventListener('pointerup', onUp)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('keydown', onKey)
    }
  }, [stopRecording, cancelRecording])

  // Mic focus (Alt+V) — toggles push-to-talk while on the consciousness view.
  // Deferred to a macrotask so the effect body stays free of sync setState.
  useEffect(() => {
    if (micFocus === 0) return
    if (useMistStore.getState().view !== 'consciousness') return
    const id = window.setTimeout(() => {
      if (recordingRef.current) void stopRecording()
      else void startRecording()
    }, 0)
    return () => window.clearTimeout(id)
  }, [micFocus, startRecording, stopRecording])

  // ---------------------------------------------------------------- skills

  const openSkillDraft = (m: LocalMessage) => {
    if (!m.skill_hint) return
    setSkillDraft({
      msgId: m.id,
      tool: m.skill_hint.tool,
      name: m.skill_hint.tool,
      trigger: `when I ask to ${m.skill_hint.tool.replace(/[_-]+/g, ' ')}`,
      steps: JSON.stringify(m.skill_hint.args ?? {}, null, 2),
    })
  }

  const saveSkill = async () => {
    if (!skillDraft) return
    try {
      await mistApi.skills.save({
        name: skillDraft.name.trim() || skillDraft.tool,
        trigger: skillDraft.trigger,
        steps: skillDraft.steps,
        tool_chain: [skillDraft.tool],
      })
      toast.success('Skill saved')
      setMessages((prev) =>
        prev.map((m) => (m.id === skillDraft.msgId ? { ...m, skillSaved: true } : m))
      )
      setSkillDraft(null)
    } catch {
      toast.error('Could not save skill')
    }
  }

  // ---------------------------------------------------------------- media (v2)

  const openAttachment = useCallback((a: MediaAttachment, seekTo?: number) => {
    useMistStore.getState().openBrowserTab({
      url: a.url,
      title: a.title,
      kind: a.type === 'video' ? 'video' : 'article',
      seekTo: seekTo ?? a.seek_to,
      note: a.note,
    })
  }, [])

  const saveAttachment = useCallback(async (a: MediaAttachment) => {
    try {
      let domain = a.url
      try {
        domain = new URL(a.url).hostname.replace(/^www\./, '')
      } catch {
        /* keep url */
      }
      await mistApi.memory.longterm.set(`saved ${domain}`, `${a.title} — ${a.url}`)
      toast.success('Saved to long-term memory')
    } catch {
      toast.error('Could not save link')
    }
  }, [])

  // ---------------------------------------------------------------- render

  const activeThread = threadsList.find((t) => t.id === activeId)
  const stateColor = STATE_COLORS[neuralState]

  return (
    <div className={cn('mist-glass flex h-full min-h-0 flex-col overflow-hidden', className)}>
      {/* HEADER */}
      <div className="flex items-center justify-between gap-3 border-b border-white/10 p-4">
        <div className="min-w-0">
          <h2 className="truncate text-sm font-medium text-slate-200">
            {activeThread?.title || 'New consciousness thread'}
          </h2>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <Select value={provider} onValueChange={onProviderChange}>
            <SelectTrigger
              size="sm"
              aria-label="AI provider"
              className="w-[150px] rounded-lg border-white/10 bg-white/5 font-mono text-xs text-slate-300 focus-visible:ring-purple-400/60"
            >
              <SelectValue placeholder="provider" />
            </SelectTrigger>
            <SelectContent className="border-white/10 bg-slate-900/95 font-mono text-xs backdrop-blur-xl">
              {providerOptions.map((p) => (
                <SelectItem
                  key={p}
                  value={p}
                  className="text-slate-300 focus:bg-purple-400/15 focus:text-purple-100"
                >
                  {PROVIDER_LABELS[p] ?? p}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Toggle voice replies"
            aria-pressed={ttsEnabled}
            onClick={() => setTtsEnabled(!ttsEnabled)}
            className={cn(
              'h-9 w-9 rounded-lg hover:bg-white/5 focus-visible:ring-purple-400/60',
              ttsEnabled ? 'text-teal-300' : 'text-slate-500 hover:text-slate-300'
            )}
          >
            {ttsEnabled ? (
              <Volume2 aria-hidden className="h-4 w-4" />
            ) : (
              <VolumeX aria-hidden className="h-4 w-4" />
            )}
          </Button>

          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="New thread"
            onClick={() => {
              setActiveThread(null)
              setMessages([])
              sendThreadIdRef.current = null
            }}
            className="h-9 w-9 rounded-lg text-slate-400 hover:bg-white/5 hover:text-purple-200 focus-visible:ring-purple-400/60"
          >
            <Plus aria-hidden className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* MESSAGES */}
      <div
        ref={scrollRef}
        onScroll={onScroll}
        role="log"
        aria-label="Conversation"
        className="mist-scroll min-h-0 flex-1 space-y-4 overflow-y-auto p-4 sm:p-5"
      >
        {historyLoading ? (
          <div className="space-y-4" aria-hidden>
            <div className="flex justify-end">
              <Skeleton className="h-14 w-3/5 rounded-2xl rounded-br-md bg-white/5" />
            </div>
            <div className="flex gap-3">
              <Skeleton className="h-7 w-7 shrink-0 rounded-full bg-white/5" />
              <Skeleton className="h-16 w-2/3 rounded-2xl rounded-bl-md bg-white/5" />
            </div>
            <div className="flex justify-end">
              <Skeleton className="h-10 w-2/5 rounded-2xl rounded-br-md bg-white/5" />
            </div>
          </div>
        ) : messages.length === 0 && !awaiting ? (
          <div className="flex flex-col items-center justify-center gap-3 py-10 text-center">
            <div
              aria-hidden
              className="h-10 w-10 animate-mist-pulse-glow rounded-full"
              style={{
                background: `radial-gradient(circle at 35% 35%, ${stateColor}, transparent 70%)`,
                boxShadow: `0 0 24px ${stateColor}66`,
              }}
            />
            <p className="text-sm text-slate-300">Speak to the core</p>
            <p className="font-mono text-[11px] text-slate-500">
              I listen · think · remember · act · speak
            </p>
            <div className="mt-3 flex max-w-md flex-wrap justify-center gap-2">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => void send(s)}
                  className="mist-glass-soft rounded-full px-4 py-2 text-xs text-slate-300 transition-colors hover:border-purple-400/40 hover:text-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-400/60"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <>
            {messages.map((m) =>
              m.role === 'user' ? (
                <motion.div
                  key={m.id}
                  initial={reduced ? false : { opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="flex justify-end"
                >
                  <div className="max-w-[85%] sm:max-w-[75%]">
                    <div className="rounded-2xl rounded-br-md border border-purple-400/25 bg-purple-400/10 px-4 py-3 text-sm whitespace-pre-wrap break-words text-slate-100">
                      {m.content}
                    </div>
                    <div className="mt-1 text-right font-mono text-[10px] text-slate-500">
                      {fmtTime(m.ts)}
                    </div>
                  </div>
                </motion.div>
              ) : (
                <motion.div
                  key={m.id}
                  initial={reduced ? false : { opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="flex gap-3"
                >
                  <div
                    aria-hidden
                    className="h-7 w-7 shrink-0 animate-mist-pulse-glow rounded-full"
                    style={{
                      background: `radial-gradient(circle at 35% 35%, ${stateColor}, transparent 70%)`,
                      boxShadow: `0 0 10px ${stateColor}55`,
                    }}
                  />
                  <div className="min-w-0 max-w-[90%] sm:max-w-[80%]">
                    <div className="mist-glass-soft rounded-2xl rounded-bl-md px-4 py-3 text-sm whitespace-pre-wrap break-words text-slate-100">
                      {m.content}
                    </div>

                    {/* citations (v2) */}
                    {m.citations && m.citations.length > 0 && (
                      <div className="mt-2 flex flex-wrap items-center gap-1.5">
                        <span className="font-mono text-[10px] uppercase tracking-widest text-slate-600">
                          sources
                        </span>
                        {m.citations.map((c) => (
                          <a
                            key={`cite-${m.id}-${c.n}`}
                            href={c.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            title={c.title}
                            className={cn(
                              'inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 font-mono text-[10px] transition-colors hover:bg-white/10',
                              citationChipClass(c.quality)
                            )}
                          >
                            [{c.n}] {c.domain}
                            {c.verified ? <span aria-label="verified">✓</span> : null}
                          </a>
                        ))}
                      </div>
                    )}

                    {/* media attachments (v2 — "have you seen this?") */}
                    {m.attachments && m.attachments.length > 0 && (
                      <div className="mt-2 space-y-2">
                        {m.attachments.map((a, i) => (
                          <div
                            key={`att-${m.id}-${i}`}
                            className="mist-glass-soft rounded-xl border-purple-300/20 p-3"
                          >
                            <div className="flex items-start gap-3">
                              <div
                                aria-hidden
                                className={cn(
                                  'mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border',
                                  a.type === 'video'
                                    ? 'border-rose-300/30 bg-rose-300/10 text-rose-300'
                                    : 'border-teal-300/30 bg-teal-300/10 text-teal-300'
                                )}
                              >
                                {a.type === 'video' ? (
                                  <Play className="h-4 w-4" />
                                ) : (
                                  <FileText className="h-4 w-4" />
                                )}
                              </div>
                              <div className="min-w-0 flex-1">
                                <p className="truncate text-xs font-medium text-slate-100">{a.title}</p>
                                {a.note ? (
                                  <p className="mt-0.5 text-[11px] leading-snug text-slate-400">{a.note}</p>
                                ) : null}
                                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                                  <button
                                    type="button"
                                    onClick={() => openAttachment(a)}
                                    className="inline-flex items-center gap-1 rounded-md border border-purple-300/30 bg-purple-300/10 px-2 py-1 font-mono text-[10px] text-purple-200 transition-colors hover:bg-purple-300/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-400/60"
                                  >
                                    <Play aria-hidden className="h-3 w-3" />
                                    {a.type === 'video' ? 'Watch here' : 'Read here'}
                                  </button>
                                  {a.type === 'video' && a.seek_to ? (
                                    <button
                                      type="button"
                                      onClick={() => openAttachment(a, a.seek_to)}
                                      className="inline-flex items-center gap-1 rounded-md border border-rose-300/30 bg-rose-300/10 px-2 py-1 font-mono text-[10px] text-rose-200 transition-colors hover:bg-rose-300/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-400/60"
                                    >
                                      jump to {fmtSeek(a.seek_to)}
                                    </button>
                                  ) : null}
                                  <a
                                    href={a.url}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="inline-flex items-center gap-1 rounded-md border border-white/10 bg-white/5 px-2 py-1 font-mono text-[10px] text-slate-300 transition-colors hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-400/60"
                                  >
                                    <ExternalLink aria-hidden className="h-3 w-3" />
                                    open
                                  </a>
                                  <button
                                    type="button"
                                    onClick={() => void saveAttachment(a)}
                                    className="inline-flex items-center gap-1 rounded-md border border-white/10 bg-white/5 px-2 py-1 font-mono text-[10px] text-slate-300 transition-colors hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-400/60"
                                  >
                                    <BookmarkPlus aria-hidden className="h-3 w-3" />
                                    save
                                  </button>
                                </div>
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}

                    {/* capability request (v2 — never a dead end) */}
                    {m.capability_request ? (
                      <div className="mt-2 rounded-xl border border-amber-300/30 bg-amber-300/5 p-3">
                        <div className="flex items-start gap-2">
                          <HelpCircle aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" />
                          <div className="min-w-0">
                            <p className="text-xs font-medium text-amber-200">
                              M.I.S.T. needs your call — {m.capability_request.missing}
                            </p>
                            {m.capability_request.summary ? (
                              <p className="mt-0.5 text-[11px] leading-snug text-slate-400">
                                {m.capability_request.summary}
                              </p>
                            ) : null}
                          </div>
                        </div>
                        <div className="mt-2 flex flex-col gap-1.5">
                          {m.capability_request.options.map((opt) => (
                            <button
                              key={`cap-${m.id}-${opt.id}`}
                              type="button"
                              onClick={() => void send(opt.label)}
                              className="group flex items-start gap-2 rounded-lg border border-white/10 bg-white/5 px-2.5 py-2 text-left transition-colors hover:border-amber-300/40 hover:bg-amber-300/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60"
                            >
                              <span
                                className={cn(
                                  'mt-0.5 shrink-0 rounded border px-1 py-px font-mono text-[9px] uppercase tracking-wider',
                                  KIND_BADGES[opt.kind] ?? KIND_BADGES.alternative
                                )}
                              >
                                {opt.kind}
                              </span>
                              <span className="min-w-0">
                                <span className="block text-xs text-slate-100 group-hover:text-amber-100">
                                  {opt.label}
                                </span>
                                {opt.description ? (
                                  <span className="block text-[11px] leading-snug text-slate-500">
                                    {opt.description}
                                  </span>
                                ) : null}
                              </span>
                            </button>
                          ))}
                        </div>
                      </div>
                    ) : null}

                    {/* suggestions (v2) */}
                    {m.suggestions && m.suggestions.length > 0 && (
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {m.suggestions.map((s, i) => (
                          <button
                            key={`sug-${m.id}-${i}`}
                            type="button"
                            onClick={() => void send(s)}
                            className="inline-flex items-center gap-1 rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-[11px] text-slate-300 transition-colors hover:border-teal-300/40 hover:text-teal-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-400/60"
                          >
                            <Lightbulb aria-hidden className="h-3 w-3" />
                            {s}
                          </button>
                        ))}
                      </div>
                    )}

                    <div className="mt-2 flex flex-wrap items-center gap-1.5">
                      {m.fallback ? (
                        <span className="rounded border border-rose-300/25 bg-rose-300/5 px-1.5 py-0.5 font-mono text-[10px] text-rose-300/80">
                          offline-mind fallback
                        </span>
                      ) : m.provider ? (
                        <span className="rounded border border-emerald-300/20 bg-emerald-300/5 px-1.5 py-0.5 font-mono text-[10px] text-emerald-300/70">
                          via {PROVIDER_LABELS[m.provider as ProviderId] ?? m.provider}
                          {m.model ? ` · ${m.model}` : ''}
                        </span>
                      ) : null}
                      {m.emotion ? (
                        <span className="rounded border border-purple-300/25 bg-purple-300/5 px-1.5 py-0.5 font-mono text-[10px] text-purple-300/70">
                          {m.emotion}
                        </span>
                      ) : null}
                      {m.tools_used?.map((tool, i) => (
                        <span
                          key={`tool-${i}-${tool}`}
                          className="rounded border border-amber-300/20 bg-amber-300/5 px-1.5 py-0.5 font-mono text-[10px] text-amber-300/80"
                        >
                          ⚡ {tool}
                        </span>
                      ))}
                      {m.skills_used?.map((skill, i) => (
                        <span
                          key={`skill-${i}-${skill}`}
                          className="rounded border border-teal-300/20 bg-teal-300/5 px-1.5 py-0.5 font-mono text-[10px] text-teal-300/70"
                        >
                          ✦ {skill}
                        </span>
                      ))}
                      <span className="font-mono text-[10px] text-slate-600">{fmtTime(m.ts)}</span>
                      {m.skill_hint && !m.skillSaved ? (
                        <button
                          type="button"
                          onClick={() => openSkillDraft(m)}
                          className="ml-1 inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 font-mono text-[10px] text-slate-500 transition-colors hover:bg-white/5 hover:text-teal-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-400/60"
                        >
                          <GraduationCap aria-hidden className="h-3.5 w-3.5" />
                          save as skill
                        </button>
                      ) : null}
                    </div>
                  </div>
                </motion.div>
              )
            )}

            <AnimatePresence>
              {awaiting && (
                <motion.div
                  initial={reduced ? false : { opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0 }}
                  className="flex items-center gap-2 px-1"
                >
                  <div className="flex gap-1" aria-hidden>
                    {[0, 1, 2].map((i) => (
                      <motion.span
                        key={i}
                        className="h-1.5 w-1.5 rounded-full"
                        style={{ backgroundColor: stateColor }}
                        animate={reduced ? undefined : { y: [0, -4, 0], opacity: [0.4, 1, 0.4] }}
                        transition={{ duration: 0.9, repeat: Infinity, delay: i * 0.15 }}
                      />
                    ))}
                  </div>
                  <span className="font-mono text-[10px] text-slate-500">processing</span>
                  <span className="sr-only">M.I.S.T. is processing your message</span>
                </motion.div>
              )}
            </AnimatePresence>
          </>
        )}
      </div>

      {/* COMPOSER */}
      <form onSubmit={submit} className="border-t border-white/10 p-3 sm:p-4">
        <div className="flex items-end gap-2">
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onComposerKeyDown}
            rows={1}
            disabled={awaiting}
            placeholder="Speak your mind…"
            aria-label="Message M.I.S.T."
            className="mist-glass-soft min-h-11 w-full flex-1 resize-none bg-transparent px-3 py-2.5 text-sm text-slate-100 placeholder:text-slate-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-400/60 disabled:cursor-not-allowed disabled:opacity-50"
          />

          <motion.button
            type="button"
            aria-label="Hold to talk"
            onPointerDown={(e) => {
              e.preventDefault()
              void startRecording()
            }}
            onPointerUp={() => void stopRecording()}
            onPointerLeave={() => {
              if (recordingRef.current) void stopRecording()
            }}
            onKeyDown={(e) => {
              if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) {
                e.preventDefault()
                void startRecording()
              }
            }}
            onKeyUp={(e) => {
              if (e.key === ' ' || e.key === 'Enter') {
                e.preventDefault()
                void stopRecording()
              }
            }}
            whileHover={reduced ? undefined : { scale: 1.05 }}
            whileTap={reduced ? undefined : { scale: 0.96 }}
            className={cn(
              'relative flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center rounded-xl transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-400/60',
              recording
                ? 'border border-rose-400/50 bg-rose-400/20 text-rose-300'
                : 'mist-glass-soft text-slate-300 hover:text-emerald-300'
            )}
          >
            {recording && (
              <span
                aria-hidden
                className="absolute inset-0 animate-mist-pulse-glow rounded-xl border-2 border-rose-400/40"
              />
            )}
            {recording ? (
              <MicOff aria-hidden className="h-4 w-4" />
            ) : (
              <Mic aria-hidden className="h-4 w-4" />
            )}
          </motion.button>

          <motion.button
            type="button"
            aria-label="Send message"
            onClick={() => void send(input)}
            disabled={!input.trim() || awaiting}
            whileHover={reduced ? undefined : { scale: 1.05 }}
            whileTap={reduced ? undefined : { scale: 0.96 }}
            className="flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center rounded-xl border border-purple-400/40 bg-purple-400/20 text-purple-200 transition-colors hover:bg-purple-400/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-400/60 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Send aria-hidden className="h-4 w-4" />
          </motion.button>
        </div>
      </form>

      {/* SAVE-AS-SKILL DIALOG */}
      <Dialog open={!!skillDraft} onOpenChange={(o) => !o && setSkillDraft(null)}>
        <DialogContent className="border-white/10 bg-slate-900/95 backdrop-blur-xl sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-slate-100">Save as skill</DialogTitle>
            <DialogDescription className="text-slate-500">
              Teach M.I.S.T. to reuse this tool pattern later.
            </DialogDescription>
          </DialogHeader>
          <form
            onSubmit={(e) => {
              e.preventDefault()
              void saveSkill()
            }}
            className="space-y-3"
          >
            <div className="space-y-1.5">
              <label
                htmlFor="skill-name"
                className="font-mono text-[10px] uppercase tracking-widest text-slate-500"
              >
                name
              </label>
              <Input
                id="skill-name"
                value={skillDraft?.name ?? ''}
                onChange={(e) =>
                  setSkillDraft((d) => (d ? { ...d, name: e.target.value } : d))
                }
                className="border-white/10 bg-white/5 text-sm text-slate-100 focus-visible:ring-purple-400/60"
              />
            </div>
            <div className="space-y-1.5">
              <label
                htmlFor="skill-trigger"
                className="font-mono text-[10px] uppercase tracking-widest text-slate-500"
              >
                trigger
              </label>
              <Input
                id="skill-trigger"
                value={skillDraft?.trigger ?? ''}
                onChange={(e) =>
                  setSkillDraft((d) => (d ? { ...d, trigger: e.target.value } : d))
                }
                className="border-white/10 bg-white/5 text-sm text-slate-100 focus-visible:ring-purple-400/60"
              />
            </div>
            <div className="space-y-1.5">
              <label
                htmlFor="skill-steps"
                className="font-mono text-[10px] uppercase tracking-widest text-slate-500"
              >
                steps
              </label>
              <Textarea
                id="skill-steps"
                rows={4}
                value={skillDraft?.steps ?? ''}
                onChange={(e) =>
                  setSkillDraft((d) => (d ? { ...d, steps: e.target.value } : d))
                }
                className="min-h-20 border-white/10 bg-white/5 font-mono text-xs text-slate-200 focus-visible:ring-purple-400/60"
              />
            </div>
            <DialogFooter className="gap-2">
              <Button
                type="button"
                variant="ghost"
                onClick={() => setSkillDraft(null)}
                className="rounded-lg text-slate-400 hover:bg-white/5 hover:text-slate-200 focus-visible:ring-purple-400/60"
              >
                Cancel
              </Button>
              <Button
                type="submit"
                className="rounded-lg border border-purple-400/40 bg-purple-400/20 text-purple-100 hover:bg-purple-400/30 focus-visible:ring-purple-400/60"
              >
                Save skill
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  )
}
