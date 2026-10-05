'use client'

// M.I.S.T. — ChatPanel: the conversation surface.
// Owns message state locally (spec 4.7); talks to the neural socket via
// use-neural (single registered listener) and persists via mistApi.
// Full flows: text send → thread bootstrap → socket thought → response render
// → persistence → TTS; push-to-talk mic → WAV → STT → send.
// v6: real markdown rendering (MarkdownMessage), resizable composer grip,
// ALL speech routed through the shared mistSpeech singleton (interrupt-aware,
// markdown/code stripped before speaking) + per-message read-aloud buttons.
// Task 3-b · frontend core — Task 12-c · chat tab wave 1

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type PointerEvent,
} from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import {
  BookmarkPlus,
  ExternalLink,
  FileText,
  GraduationCap,
  GripHorizontal,
  HelpCircle,
  Lightbulb,
  Mic,
  MicOff,
  Play,
  Plus,
  Send,
  Square,
  Telescope,
  Users,
  Volume2,
  VolumeX,
} from 'lucide-react'
import { toast } from 'sonner'
import { useMistStore, type MistPersona, type ResearchDepth } from '@/lib/store'
import { useNeural, type ThoughtPayload } from '@/hooks/use-neural'
import { useSpecular } from '@/hooks/use-specular'
import { mistApi } from '@/lib/mist-api'
import { mistSpeech } from '@/lib/speech'
import { createMicRecorder, type MicRecorder } from '@/lib/audio-utils'
import { PROVIDER_LABELS, STATE_COLORS } from '@/lib/mist-constants'
import type {
  CapabilityRequest,
  ChatMessage,
  Citation,
  ConsciousnessResponseMsg,
  MediaAttachment,
  ProviderId,
  ResearchJob,
  SkillHint,
} from '@/lib/types'
import { ResearchConsole } from './research-console'
import { MarkdownMessage } from '@/components/mist/chat/markdown-message'
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
import { micDeniedGuidance } from '@/hooks/use-voice'
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
  /** Deep-research report path (provider === 'research' messages). */
  savedTo?: string
  /** Set on live arrivals → word-by-word reveal (absent on history loads). */
  revealAt?: number
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

/** Deep-research-flavored starters — swapped in while research mode is armed. */
const RESEARCH_SUGGESTIONS = [
  "What's trending in AI agents right now?",
  'Research the latest model releases',
  'Deep dive: agentic memory architectures',
]

/** The 6 backend personas (unified LLM modes) surfaced as a picker. */
const PERSONAS: Array<{ id: MistPersona; label: string; hint: string }> = [
  { id: 'consciousness', label: 'Consciousness', hint: 'poetic-aware core' },
  { id: 'chat', label: 'Chat', hint: 'fast + practical' },
  { id: 'studio', label: 'Studio', hint: 'creative mode' },
  { id: 'vision', label: 'Vision', hint: 'visual analysis' },
  { id: 'swarm', label: 'Swarm', hint: 'orchestrator' },
  { id: 'memory_query', label: 'Memory Query', hint: 'recall-focused' },
]

/** Cycling "thinking" placeholders — Manus-style contextual states. */
const THINKING_PHRASES = [
  'aligning synapses',
  'consulting memory',
  'composing response',
  'weighing tools',
]

const COMPOSER_MAX_H = 144 // ~6 rows (auto-grow cap — a dragged minimum raises it)

// Drag-resize grip bounds + persistence (v6 resizable composer).
const COMPOSER_H_MIN = 96
const COMPOSER_H_MAX = 340
const COMPOSER_H_DEFAULT = 96
const COMPOSER_H_STEP = 24
const COMPOSER_H_KEY = 'mist:composerHeight'

function clampComposerH(v: number): number {
  if (!Number.isFinite(v)) return COMPOSER_H_DEFAULT
  return Math.min(COMPOSER_H_MAX, Math.max(COMPOSER_H_MIN, Math.round(v)))
}

function saveComposerH(v: number) {
  try {
    window.localStorage.setItem(COMPOSER_H_KEY, JSON.stringify(v))
  } catch {
    /* storage unavailable — ignore */
  }
}

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

/** Research report file path → tidy relative form (db/notes/research/…). */
function shortSavedPath(p: string): string {
  const m = /(^|[\\/])(db\/notes\/.+)$/.exec(p.replace(/\\/g, '/'))
  return m ? m[2] : p
}

/** Job citations → panel Citation[] (credibility inherited from matched sources). */
function mapResearchCitations(job: ResearchJob): Citation[] {
  return (job.citations ?? []).map((c, i) => {
    let domain = c.url
    try {
      domain = new URL(c.url).hostname.replace(/^www\./, '')
    } catch {
      /* keep url */
    }
    const src = (job.sources ?? []).find((s) => s.url === c.url)
    return {
      n: i + 1,
      url: c.url,
      title: c.title,
      domain,
      quality: src?.credibility ?? 'medium',
      verified: c.verified,
    }
  })
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

  // deep research + persona (v5)
  const researchMode = useMistStore((s) => s.researchMode)
  const setResearchMode = useMistStore((s) => s.setResearchMode)
  const researchDepth = useMistStore((s) => s.researchDepth)
  const setResearchDepth = useMistStore((s) => s.setResearchDepth)
  const persona = useMistStore((s) => s.persona)
  const setPersona = useMistStore((s) => s.setPersona)

  // The user's explicit M.I.S.T. preference wins — the OS signal is adopted
  // into the store at boot but never overrides an explicit choice here.
  const reduced = useMistStore((s) => s.reducedMotion)

  // ---- neural socket
  const { sendThought, setProvider: setNeuralProvider, sendVoiceEnergy, onResponse } = useNeural()

  // ---- local state (message state lives HERE per spec)
  const [messages, setMessages] = useState<LocalMessage[]>([])
  const [input, setInput] = useState('')
  const [awaiting, setAwaiting] = useState(false)
  const [thinkingSecs, setThinkingSecs] = useState(0)
  const [phraseIdx, setPhraseIdx] = useState(0)
  const [historyLoading, setHistoryLoading] = useState(false)
  const [recording, setRecording] = useState(false)
  const [providers, setProviders] = useState<ProviderId[]>(['auto'])
  const [skillDraft, setSkillDraft] = useState<SkillDraft | null>(null)
  /** Live deep-research job rendered as the research console (v5). */
  const [research, setResearch] = useState<{
    jobId: string
    query: string
    depth: ResearchDepth
  } | null>(null)
  /** Which assistant message the shared TTS player is currently reading. */
  const [speakingId, setSpeakingId] = useState<string | null>(null)
  /** User-dragged minimum composer height (px) — auto-grow extends beyond it. */
  const [composerMinHeight, setComposerMinHeight] = useState(COMPOSER_H_DEFAULT)
  const [draggingComposer, setDraggingComposer] = useState(false)
  // Real-time typing indicator state
  const [isTyping, setIsTyping] = useState(false)
  const [typingText, setTypingText] = useState('')

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
  const awaitStartRef = useRef(0)
  const dragStartYRef = useRef(0)
  const dragStartHRef = useRef(0)
  /** Latest composer height for the window pointerup safety net (fresh reads
   * without re-registering the listener on every drag pixel). */
  const composerHRef = useRef(COMPOSER_H_DEFAULT)

  useEffect(() => {
    composerHRef.current = composerMinHeight
  }, [composerMinHeight])

  const setAwaitingBoth = (b: boolean) => {
    awaitingRef.current = b
    setAwaiting(b)
    setIsTyping(b)
    if (b) {
      awaitStartRef.current = Date.now()
      setThinkingSecs(0)
      setPhraseIdx(0)
      setTypingText('')
    }
  }

  // Keep the messages mirror in sync for event-handler reads (send history).
  useEffect(() => {
    messagesRef.current = messages
  }, [messages])

  // Thinking theatrics: elapsed counter + cycling shimmer placeholders.
  useEffect(() => {
    if (!awaiting) return
    const tick = window.setInterval(
      () => setThinkingSecs(Math.floor((Date.now() - awaitStartRef.current) / 1000)),
      500
    )
    const cycle = window.setInterval(
      () => setPhraseIdx((i) => (i + 1) % THINKING_PHRASES.length),
      2800
    )
    // Typing indicator effect
    const typingInterval = window.setInterval(() => {
      if (isTyping) {
        setTypingText(prev => {
          if (prev.length >= 3) return ''
          return prev + '.'
        })
      }
    }, 300)
    return () => {
      window.clearInterval(tick)
      window.clearInterval(cycle)
      window.clearInterval(typingInterval)
    }
  }, [awaiting, isTyping])

  // Response watchdog — a dropped reply must never freeze the conversation.
  // The neural service always answers (worst case its 150s offline fallback),
  // but if the socket dies mid-thought (network blip, service restart) the
  // consciousness_response is emitted into the void and the composer would
  // stay locked forever — the exact "she said she'd do it and then nothing
  // happened" experience. Watch: 180s hard cap, or 45s while the socket is
  // down (the reply cannot arrive on a dead link).
  useEffect(() => {
    if (!awaiting) return
    const id = window.setInterval(() => {
      const store = useMistStore.getState()
      const elapsed = Date.now() - awaitStartRef.current
      const linkDown = !store.neural.connected
      if (elapsed > 180_000 || (linkDown && elapsed > 45_000)) {
        window.clearInterval(id)
        setAwaitingBoth(false)
        store.setNeuralState('dormant')
        const note: LocalMessage = {
          id: uid(),
          role: 'assistant',
          content:
            'I dropped that reply in transit, sir — my link to my own core wavered mid-thought. ' +
            'Nothing was lost on your end; the thread is intact. Say the word and I\u2019ll take it from the top.',
          provider: 'watchdog',
          ts: new Date(),
        }
        const belongsHere =
          !sendThreadIdRef.current || sendThreadIdRef.current === store.threads.activeId
        if (belongsHere) setMessages((prev) => [...prev, note])
        const persistTo = sendThreadIdRef.current ?? store.threads.activeId
        if (persistTo) {
          mistApi.conversations.appendMessage(persistTo, 'assistant', note.content, {
            provider: 'watchdog',
          }).catch(() => {})
        }
      }
    }, 3000)
    return () => window.clearInterval(id)
  }, [awaiting])

  // ------------------------------------------------------------- deep research

  /** Kick off an async research job — the console polls it live. */
  const startResearch = useCallback(async (query: string, depth: ResearchDepth) => {
    setAwaitingBoth(true)
    atBottomRef.current = true
    const store = useMistStore.getState()
    try {
      const res = await mistApi.research.start(query, depth)
      if (!res?.jobId) throw new Error('the research engine returned no job id')
      setResearch({ jobId: res.jobId, query, depth })
      store.setResearchActive(true)
      store.setNeuralState('processing')
    } catch (err) {
      toast.error('Deep research could not start', {
        description:
          err instanceof Error && err.message
            ? err.message
            : 'The research engine is unreachable — try again in a moment.',
      })
      setAwaitingBoth(false)
      store.setResearchActive(false)
    }
  }, [])

  const handleResearchDone = useCallback(
    (job: ResearchJob) => {
      const store = useMistStore.getState()
      const report = (job.report ?? '').trim()
      const citations = mapResearchCitations(job)
      const suggestions = Array.isArray(job.suggestions) ? job.suggestions.slice(0, 6) : []
      const assistantMsg: LocalMessage = {
        id: uid(),
        role: 'assistant',
        content: report || 'Research completed, but the engine returned an empty report.',
        provider: 'research',
        model: 'deep-research',
        citations,
        suggestions,
        savedTo: job.savedTo,
        ts: new Date(),
      }
      // Only render into the view that owns this exchange (mirrors handleResponse).
      const currentId = store.threads.activeId
      const belongsHere =
        !sendThreadIdRef.current || sendThreadIdRef.current === currentId || currentId === null
      if (belongsHere) setMessages((prev) => [...prev, assistantMsg])
      setAwaitingBoth(false)
      setResearch(null)
      store.setResearchActive(false)
      store.setNeuralState('dormant')

      const persistTo = sendThreadIdRef.current ?? currentId
      if (persistTo && report) {
        mistApi.conversations
          .appendMessage(persistTo, 'assistant', report, {
            provider: 'research',
            model: 'deep-research',
            meta: { citations, suggestions, savedTo: job.savedTo },
          })
          .catch(() => {})
      }
      store.bumpThreadsRefresh()
      // v6: all speech flows through the shared mistSpeech singleton — it
      // strips markdown + code itself and always interrupts the previous
      // utterance, so only the newest report is ever heard.
      if (store.ttsEnabled && report) {
        setSpeakingId(assistantMsg.id)
        void mistSpeech.speak(report, {
          onEnd: () => setSpeakingId((cur) => (cur === assistantMsg.id ? null : cur)),
        })
      }
    },
    []
  )

  const handleResearchError = useCallback((_message: string) => {
    // The console stays mounted in its error state (retry lives there).
    setAwaitingBoth(false)
    const store = useMistStore.getState()
    store.setResearchActive(false)
    store.setNeuralState('dormant')
  }, [])

  const handleResearchTick = useCallback(() => {
    // Re-assert the processing orb against ambient socket pulses + keep the
    // stream pinned to the live console while the user is at the bottom.
    const store = useMistStore.getState()
    if (store.researchActive) store.setNeuralState('processing')
    const el = scrollRef.current
    if (el && atBottomRef.current) el.scrollTop = el.scrollHeight
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

      // Deep research branch: bypasses the neural socket entirely — the
      // research engine runs the job async and the console polls progress.
      if (store.researchMode) {
        await startResearch(text, store.researchDepth)
        return true
      }

      // Last 12 local messages as history (including the one just sent).
      const history = [...messagesRef.current, userMsg]
        .slice(-12)
        .map((m) => ({ role: m.role, content: m.content }))

      // Persona (v5) rides along as the unified mode — ThoughtPayload does not
      // declare it yet, so the payload is widened inline (types.ts is frozen).
      sendThought({
        content: text,
        provider: store.provider,
        conversation_id: threadId ?? undefined,
        history,
        mode: store.persona,
      } as ThoughtPayload)
      return true
    },
    [sendThought, startResearch]
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
        revealAt: Date.now(),
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
      // v6: shared singleton TTS — interrupts any in-flight playback so two
      // messages can never speak at once.
      if (store.ttsEnabled && msg.text) {
        setSpeakingId(assistantMsg.id)
        void mistSpeech.speak(msg.text, {
          onEnd: () => setSpeakingId((cur) => (cur === assistantMsg.id ? null : cur)),
        })
      }
    },
    []
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

  // Heartbeat alerts (⏰ due reminders, 📦 upstream releases) are persisted by
  // the useMistAlerts poller and broadcast here — render them live in-thread.
  useEffect(() => {
    const onAlert = (e: Event) => {
      const saved = (e as CustomEvent<ChatMessage>).detail
      if (!saved || typeof saved.content !== 'string' || !saved.content.trim()) return
      const currentId = useMistStore.getState().threads.activeId
      if (currentId && saved.conversation_id && saved.conversation_id !== currentId) return
      const alertMsg: LocalMessage = {
        id: saved.id || uid(),
        role: 'assistant',
        content: saved.content,
        provider: saved.provider ?? 'heartbeat',
        revealAt: Date.now(),
        ts: saved.created_at ? new Date(saved.created_at) : new Date(),
      }
      setMessages((prev) => [...prev, alertMsg])
      atBottomRef.current = true
    }
    window.addEventListener('mist:alert', onAlert)
    return () => window.removeEventListener('mist:alert', onAlert)
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
                savedTo?: string
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
                savedTo: typeof meta.savedTo === 'string' ? meta.savedTo : undefined,
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
  }, [messages, awaiting, historyLoading, research])

  // ---------------------------------------------------------------- composer

  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    // Auto-grow 1→6 rows, never below the user-dragged minimum (the inline
    // min-height enforces that floor visually) and never above a cap that the
    // dragged minimum may have raised.
    const cap = Math.max(COMPOSER_MAX_H, composerMinHeight)
    el.style.height = `${Math.min(el.scrollHeight, cap)}px`
    el.style.overflowY = el.scrollHeight > cap ? 'auto' : 'hidden'
  }, [input, composerMinHeight])

  // Restore the persisted composer height after mount (deferred a macrotask
  // so the effect body stays free of synchronous setState).
  useEffect(() => {
    const id = window.setTimeout(() => {
      try {
        const raw = window.localStorage.getItem(COMPOSER_H_KEY)
        if (raw === null) return
        const v = Number(JSON.parse(raw))
        if (Number.isFinite(v)) setComposerMinHeight(clampComposerH(v))
      } catch {
        /* ignore malformed storage */
      }
    }, 0)
    return () => window.clearTimeout(id)
  }, [])

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

  // ------------------------------------------------- composer resize grip (v6)

  const onGripPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return
    e.preventDefault()
    dragStartYRef.current = e.clientY
    dragStartHRef.current = composerMinHeight
    setDraggingComposer(true)
    try {
      // Pointer capture keeps the drag anchored to the grip even when the
      // pointer leaves the element (no window listeners needed).
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch {
      /* capture unsupported — drag still ends on pointerup */
    }
  }

  const onGripPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!draggingComposer) return
    // The grip sits below the box: dragging DOWN grows it.
    setComposerMinHeight(
      clampComposerH(dragStartHRef.current + (e.clientY - dragStartYRef.current))
    )
  }

  const onGripPointerEnd = (e: PointerEvent<HTMLDivElement>) => {
    if (!draggingComposer) return
    setDraggingComposer(false)
    try {
      e.currentTarget.releasePointerCapture(e.pointerId)
    } catch {
      /* already released */
    }
    saveComposerH(composerMinHeight)
  }

  // Safety net: if pointer capture is ever lost (synthetic events, alt-tab,
  // capture rejection), a window-level pointerup/pointercancel still ends the
  // drag so the accent line never sticks. Idempotent with the grip's own end
  // handler.
  useEffect(() => {
    if (!draggingComposer) return
    const onUp = () => {
      setDraggingComposer(false)
      saveComposerH(composerHRef.current)
    }
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
    return () => {
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
    }
  }, [draggingComposer])

  const onGripDoubleClick = () => {
    setComposerMinHeight(COMPOSER_H_DEFAULT)
    saveComposerH(COMPOSER_H_DEFAULT)
  }

  const onGripKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    let next: number | null = null
    if (e.key === 'ArrowUp') next = composerMinHeight + COMPOSER_H_STEP
    else if (e.key === 'ArrowDown') next = composerMinHeight - COMPOSER_H_STEP
    else if (e.key === 'Home') next = COMPOSER_H_MIN
    else if (e.key === 'End') next = COMPOSER_H_MAX
    if (next === null) return
    e.preventDefault()
    const v = clampComposerH(next)
    setComposerMinHeight(v)
    saveComposerH(v)
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
      toast.error('Microphone unavailable', { description: micDeniedGuidance(), duration: 5000 })
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
  const { ref: specularRef, onPointerMove: onSpecularMove } = useSpecular<HTMLDivElement>()
  const springIn = { type: 'spring' as const, stiffness: 170, damping: 22 }

  return (
    <div
      ref={specularRef}
      onPointerMove={onSpecularMove}
      className={cn('mist-specular mist-glass flex h-full min-h-0 flex-col overflow-hidden', className)}
    >
      {/* HEADER */}
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-b border-white/10 p-4">
        <div className="hidden min-w-0 flex-1 basis-36 sm:block">
          <h2 className="truncate text-sm font-medium text-slate-200">
            {activeThread?.title || 'New consciousness thread'}
          </h2>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-1.5">
          {/* persona picker (v5 — unified mode passthrough) */}
          <Select value={persona} onValueChange={(v) => setPersona(v as MistPersona)}>
            <SelectTrigger
              size="sm"
              aria-label="M.I.S.T. persona"
              className="w-[132px] rounded-lg border-white/10 bg-white/5 font-mono text-xs text-slate-300 focus-visible:ring-fuchsia-400/60"
            >
              <SelectValue placeholder="persona">
                {PERSONAS.find((p) => p.id === persona)?.label ?? 'Consciousness'}
              </SelectValue>
            </SelectTrigger>
            <SelectContent className="border-white/10 bg-slate-900/95 font-mono text-xs backdrop-blur-xl">
              {PERSONAS.map((p) => (
                <SelectItem
                  key={p.id}
                  value={p.id}
                  className="text-slate-300 focus:bg-fuchsia-400/15 focus:text-fuchsia-100"
                >
                  <span className="flex flex-col gap-0.5 py-0.5">
                    <span>{p.label}</span>
                    <span className="text-[10px] normal-case tracking-normal text-slate-500">
                      {p.hint}
                    </span>
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select value={provider} onValueChange={onProviderChange}>
            <SelectTrigger
              size="sm"
              aria-label="AI provider"
              className="w-[118px] rounded-lg border-white/10 bg-white/5 font-mono text-xs text-slate-300 focus-visible:ring-purple-400/60 sm:w-[150px]"
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

          {/* voice session quick-jump (v6) — hands-free at the orb */}
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Talk with Mist"
            title="Talk with Mist — hands-free voice session"
            onClick={() => {
              const store = useMistStore.getState()
              store.setView('consciousness')
              store.requestVoiceSession()
            }}
            className="h-9 w-9 rounded-lg text-slate-400 hover:bg-white/5 hover:text-teal-200 focus-visible:ring-purple-400/60"
          >
            <Mic aria-hidden className="h-4 w-4" />
          </Button>

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
              // A dead (errored) research console is dismissed with the view;
              // a RUNNING one stays — its report still lands when it finishes.
              if (research && !awaitingRef.current) setResearch(null)
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
        className="mist-scroll min-h-0 flex-1 overflow-y-auto p-4 sm:p-6"
      >
        {/* roomy centered column — the conversation reads like a document */}
        <div className="mx-auto w-full max-w-3xl space-y-5">
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
          <div className="flex flex-col items-center justify-center gap-4 py-14 text-center sm:py-20">
            <div
              aria-hidden
              className="h-12 w-12 animate-mist-pulse-glow rounded-full"
              style={{
                background: `radial-gradient(circle at 35% 35%, ${stateColor}, transparent 70%)`,
                boxShadow: `0 0 24px ${stateColor}66`,
              }}
            />
            <h3 className="text-lg font-semibold text-slate-100 sm:text-xl">
              Speak to the core
            </h3>
            <p className="font-mono text-[11px] text-slate-500">
              I listen · think · remember · act · speak
            </p>
            <div className="mt-4 flex max-w-md flex-wrap justify-center gap-2">
              {(researchMode ? RESEARCH_SUGGESTIONS : SUGGESTIONS).map((s, i) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => void send(s)}
                  className="mist-chip-in mist-glass-soft rounded-full px-4 py-2 text-xs text-slate-300 transition-all duration-200 hover:-translate-y-0.5 hover:border-purple-400/40 hover:text-slate-100 hover:shadow-[0_8px_24px_-12px_rgba(192,132,252,0.45)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-400/60"
                  style={{ animationDelay: `${350 + i * 70}ms` }}
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
                  initial={reduced ? false : { opacity: 0, x: 28, scale: 0.97 }}
                  animate={{ opacity: 1, x: 0, scale: 1 }}
                  transition={springIn}
                  className="flex justify-end"
                >
                  <div className="max-w-[85%] sm:max-w-[75%]">
                    <div className="rounded-2xl rounded-br-md border border-purple-400/25 bg-purple-400/10 px-4 py-3 text-[15px] whitespace-pre-wrap break-words text-slate-100 shadow-[0_8px_28px_-14px_rgba(192,132,252,0.5)]">
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
                  initial={reduced ? false : { opacity: 0, y: 12, scale: 0.98 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  transition={springIn}
                  className="group flex gap-3"
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
                    <div
                      className={cn(
                        'mist-glass-soft rounded-2xl rounded-bl-md px-4 py-3.5 text-[15px] text-slate-100',
                        m.revealAt && !reduced && 'mist-reveal-glow'
                      )}
                    >
                      {/* v6: real markdown for every assistant message — bold,
                          headings, lists, tables and code blocks render as they
                          were meant to be read. */}
                      <MarkdownMessage text={m.content} />
                    </div>

                    {/* research report artifact note (v5) */}
                    {m.provider === 'research' && m.savedTo ? (
                      <p
                        className="mt-2 inline-flex max-w-full items-center gap-1.5 rounded-md border border-teal-300/20 bg-teal-300/5 px-2 py-1 font-mono text-[10px] text-teal-300/80"
                        title={m.savedTo}
                      >
                        <FileText aria-hidden className="h-3 w-3 shrink-0" />
                        <span className="truncate">saved to {shortSavedPath(m.savedTo)}</span>
                      </p>
                    ) : null}

                    {/* citations (v2) */}
                    {m.citations && m.citations.length > 0 && (
                      <div className="mt-2 flex flex-wrap items-center gap-1.5">
                        <span className="font-mono text-[10px] uppercase tracking-widest text-slate-500">
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
                        <span className="mist-chip-in rounded border border-rose-300/25 bg-rose-300/5 px-1.5 py-0.5 font-mono text-[10px] text-rose-300/80" style={{ animationDelay: '0ms' }}>
                          offline-mind fallback
                        </span>
                      ) : m.provider ? (
                        <span className="mist-chip-in rounded border border-emerald-300/20 bg-emerald-300/5 px-1.5 py-0.5 font-mono text-[10px] text-emerald-300/70" style={{ animationDelay: '40ms' }}>
                          via {PROVIDER_LABELS[m.provider as ProviderId] ?? m.provider}
                          {m.model ? ` · ${m.model}` : ''}
                        </span>
                      ) : null}
                      {m.emotion ? (
                        <span className="mist-chip-in rounded border border-purple-300/25 bg-purple-300/5 px-1.5 py-0.5 font-mono text-[10px] text-purple-300/70" style={{ animationDelay: '80ms' }}>
                          {m.emotion}
                        </span>
                      ) : null}
                      {m.tools_used?.map((tool, i) => (
                        <span
                          key={`tool-${i}-${tool}`}
                          className="mist-chip-in rounded border border-amber-300/20 bg-amber-300/5 px-1.5 py-0.5 font-mono text-[10px] text-amber-300/80"
                          style={{ animationDelay: `${120 + i * 40}ms` }}
                        >
                          ⚡ {tool}
                        </span>
                      ))}
                      {m.skills_used?.map((skill, i) => (
                        <span
                          key={`skill-${i}-${skill}`}
                          className="mist-chip-in rounded border border-teal-300/20 bg-teal-300/5 px-1.5 py-0.5 font-mono text-[10px] text-teal-300/70"
                          style={{ animationDelay: `${160 + i * 40}ms` }}
                        >
                          ✦ {skill}
                        </span>
                      ))}
                      <span className="mist-chip-in font-mono text-[10px] text-slate-500" style={{ animationDelay: '200ms' }}>{fmtTime(m.ts)}</span>
                      {/* per-message read-aloud (v6) — ghost icon revealed on
                          hover/focus; stays lit while THIS message is playing */}
                      <button
                        type="button"
                        aria-label={speakingId === m.id ? 'Stop reading aloud' : 'Read message aloud'}
                        onClick={() => {
                          if (speakingId === m.id) {
                            mistSpeech.stop()
                            setSpeakingId(null)
                          } else {
                            setSpeakingId(m.id)
                            void mistSpeech.speak(m.content, {
                              // explicit action — ignores the auto-speak pref
                              force: true,
                              onEnd: () => setSpeakingId((cur) => (cur === m.id ? null : cur)),
                            })
                          }
                        }}
                        className={cn(
                          'ml-0.5 inline-flex h-7 w-7 items-center justify-center rounded-lg transition-all hover:bg-white/5 hover:text-purple-200 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-400/60 group-focus-within:opacity-100 group-hover:opacity-100',
                          speakingId === m.id
                            ? 'text-purple-300 opacity-100'
                            : 'text-slate-500 opacity-0'
                        )}
                      >
                        {speakingId === m.id ? (
                          <Square aria-hidden className="h-3 w-3" />
                        ) : (
                          <Volume2 aria-hidden className="h-3.5 w-3.5" />
                        )}
                      </button>
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

            {/* live research console (v5) — the console IS the thinking row */}
            <AnimatePresence>
              {research && (
                <motion.div
                  key={research.jobId}
                  initial={reduced ? false : { opacity: 0, y: 10, scale: 0.98 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={reduced ? undefined : { opacity: 0, scale: 0.98 }}
                  transition={springIn}
                  className="flex max-w-[90%] gap-3 sm:max-w-[80%]"
                >
                  <div
                    aria-hidden
                    className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-fuchsia-400/30 bg-fuchsia-400/10 text-fuchsia-300"
                  >
                    <Telescope className="h-3.5 w-3.5" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <ResearchConsole
                      jobId={research.jobId}
                      query={research.query}
                      depth={research.depth}
                      reduced={reduced}
                      onTick={handleResearchTick}
                      onDone={handleResearchDone}
                      onError={handleResearchError}
                      onRetry={(q, d) => void startResearch(q, d)}
                    />
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

            <AnimatePresence>
              {awaiting && !research && (
                <motion.div
                  initial={reduced ? false : { opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0 }}
                  className="flex items-center gap-3 px-1"
                >
                  {/* orbiting spark trio around a state-colored core.
                      The opacity heartbeat keeps the "working" tell alive
                      when the orbit spinner is disabled (reduced motion) —
                      never motion/color alone. */}
                  <div className="relative h-5 w-5 shrink-0" aria-hidden>
                    <div className="absolute inset-0 animate-mist-orbit">
                      {[0, 120, 240].map((deg) => (
                        <span
                          key={deg}
                          className="animate-mist-thinking-pulse absolute left-1/2 top-1/2 h-1.5 w-1.5 rounded-full"
                          style={{
                            backgroundColor: stateColor,
                            transform: `rotate(${deg}deg) translateY(-8px) translate(-50%, -50%)`,
                            animationDelay: `${deg / 360}ms`,
                          }}
                        />
                      ))}
                    </div>
                    <span
                      className="animate-mist-thinking-pulse absolute left-1/2 top-1/2 h-1 w-1 -translate-x-1/2 -translate-y-1/2 rounded-full"
                      style={{ backgroundColor: stateColor, boxShadow: `0 0 8px ${stateColor}` }}
                    />
                  </div>
                  <AnimatePresence mode="wait" initial={false}>
                    <motion.span
                      key={phraseIdx}
                      initial={reduced ? false : { opacity: 0, y: 3 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={reduced ? undefined : { opacity: 0, y: -3 }}
                      transition={{ duration: 0.25 }}
                      className="mist-shimmer-text font-mono text-[11px]"
                      style={{ ['--mist-shimmer-color' as string]: stateColor }}
                    >
                      {THINKING_PHRASES[phraseIdx]}…
                    </motion.span>
                  </AnimatePresence>
                  <span className="font-mono text-[10px] text-slate-500 tabular-nums">
                    {thinkingSecs > 0 ? `${thinkingSecs}s` : ''}
                  </span>
                  <span className="sr-only">M.I.S.T. is processing your message</span>
                </motion.div>
              )}
            </AnimatePresence>
          </>
        )}
        </div>
      </div>

      {/* COMPOSER */}
      <form
        onSubmit={submit}
        className={cn('border-t border-white/10 p-4', draggingComposer && 'select-none')}
      >
        {/* swarm persona hint (v5) */}
        {persona === 'swarm' && (
          <p className="mb-2 flex items-center gap-1.5 font-mono text-[10px] text-purple-300/70">
            <Users aria-hidden className="h-3 w-3 shrink-0" />
            Swarm orchestrator — MIST coordinates parallel roles
          </p>
        )}

        {/* deep research controls (v5) */}
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <button
            type="button"
            role="switch"
            aria-checked={researchMode}
            aria-label="Deep research mode"
            onClick={() => setResearchMode(!researchMode)}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fuchsia-400/60',
              researchMode
                ? 'border-fuchsia-400/60 bg-fuchsia-400/15 text-fuchsia-200 shadow-[0_0_18px_-4px_rgba(232,121,249,0.55)]'
                : 'border-white/10 bg-white/[0.03] text-slate-400 hover:border-fuchsia-400/30 hover:text-slate-200'
            )}
          >
            <Telescope
              aria-hidden
              className={cn('h-3.5 w-3.5 shrink-0', researchMode && !reduced && 'animate-mist-pulse-glow')}
            />
            Deep Research
          </button>
          {researchMode && (
            <div
              role="radiogroup"
              aria-label="Research depth"
              className="inline-flex items-center gap-1.5"
            >
              <span className="font-mono text-[10px] text-slate-500">depth</span>
              <div className="inline-flex overflow-hidden rounded-full border border-white/10 bg-white/[0.03]">
                {([1, 2] as const).map((d) => (
                  <button
                    key={d}
                    type="button"
                    role="radio"
                    aria-checked={researchDepth === d}
                    aria-label={d === 1 ? 'Standard depth, two pages' : 'Deep depth, four pages'}
                    onClick={() => setResearchDepth(d)}
                    className={cn(
                      'px-2.5 py-1 font-mono text-[10px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-fuchsia-400/60',
                      researchDepth === d
                        ? 'bg-fuchsia-400/20 text-fuchsia-200'
                        : 'text-slate-500 hover:text-slate-300'
                    )}
                  >
                    {d}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="flex items-end gap-2.5">
          {recording ? (
            <span
              aria-hidden
              className="mist-eq mb-3.5 shrink-0 text-rose-400"
              title="Recording"
            >
              <span /><span /><span /><span /><span />
            </span>
          ) : null}
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onComposerKeyDown}
            rows={1}
            disabled={awaiting}
            placeholder="Speak your mind…"
            aria-label="Message M.I.S.T."
            style={{ minHeight: composerMinHeight }}
            className="mist-glass-soft w-full flex-1 resize-none bg-transparent px-3.5 py-2.5 text-[15px] text-slate-100 placeholder:text-slate-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-400/60 disabled:cursor-not-allowed disabled:opacity-50"
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
            className={cn(
              'flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center rounded-xl border border-purple-400/40 bg-purple-400/20 text-purple-200 transition-all duration-200 hover:bg-purple-400/30 hover:shadow-[0_0_20px_-4px_rgba(192,132,252,0.6)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-400/60 disabled:cursor-not-allowed disabled:opacity-40 disabled:shadow-none',
              awaiting && !reduced && 'animate-mist-ripple-ring'
            )}
          >
            <Send aria-hidden className="h-4 w-4" />
          </motion.button>
        </div>

        {/* drag-resize grip (v6) — drag to set the composer's minimum height;
            double-click resets; ArrowUp/Down adjust when keyboard-focused */}
        <div
          role="slider"
          tabIndex={0}
          aria-label="Drag to resize the message box"
          aria-orientation="vertical"
          aria-valuemin={COMPOSER_H_MIN}
          aria-valuemax={COMPOSER_H_MAX}
          aria-valuenow={Math.round(composerMinHeight)}
          onPointerDown={onGripPointerDown}
          onPointerMove={onGripPointerMove}
          onPointerUp={onGripPointerEnd}
          onPointerCancel={onGripPointerEnd}
          onDoubleClick={onGripDoubleClick}
          onKeyDown={onGripKeyDown}
          className={cn(
            'mx-auto mt-2 flex h-6 w-20 cursor-ns-resize touch-none items-center justify-center rounded-lg transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-400/60',
            draggingComposer ? 'bg-purple-400/15' : 'hover:bg-white/5'
          )}
        >
          <GripHorizontal
            aria-hidden
            className={cn(
              'h-4 w-4 transition-colors',
              draggingComposer ? 'text-purple-300' : 'text-slate-600'
            )}
          />
        </div>
        {/* accent line — lit while dragging */}
        <div
          aria-hidden
          className={cn(
            '-mx-4 mt-1 h-0.5 rounded-full transition-colors duration-150',
            draggingComposer ? 'bg-purple-400/60' : 'bg-transparent'
          )}
        />
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
