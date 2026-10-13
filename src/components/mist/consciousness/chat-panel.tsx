'use client'

// M.I.S.T. — ChatPanel: the conversation surface (the SHELL).
//
// Owns message state locally (spec 4.7); talks to the neural socket via
// use-neural (single registered listener) and persists via mistApi.
// Full flows: text send → thread bootstrap → socket thought → response render
// → persistence → TTS; push-to-talk mic → WAV → STT → send.
//
// Phase 4-a · god-file split: the 2183-line monolith became this shell plus
// five siblings, extracted one-to-one with ZERO data-flow redesign —
//   composer.tsx        input + send + hold-to-talk + research toggle + grip
//   message-list.tsx    the conversation log (content-visibility per item)
//   tts-orchestrator.tsx voice-replies orchestration (the speak wiring)
//   mic-controller.tsx  mic arming/PTT/energy loop (audio-bus, not the store)
//   media-tabs.tsx      per-message media attachment cards
// Message state, the send/receive/interrupt/history flows and the header
// (persona + provider pickers) stay HERE — the siblings are presentation +
// device wiring lifted out through props only.
// v6 lineage: real markdown rendering, resizable composer grip, ALL speech
// through the shared mistSpeech singleton (interrupt-aware) + per-message
// read-aloud buttons.
// Task 3-b · frontend core — Task 12-c · chat tab wave 1

import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { useMistStore, type MistPersona, type ResearchDepth } from '@/lib/store'
import { useNeural, type ThoughtPayload } from '@/hooks/use-neural'
import { onInterrupt } from '@/lib/interrupt-bus'
import { useSpecular } from '@/hooks/use-specular'
import { mistApi } from '@/lib/mist-api'
import { STATE_COLORS } from '@/lib/mist-constants'
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
import type { ToolCallRecord } from '@/components/mist/chat/tool-call-card'
import type { ResearchPipelineMeta } from '@/components/mist/chat/research-timeline'
import { useTabBoundary } from '@/hooks/use-tab-boundary'
import { useAudioSession } from '@/lib/audio-session'
import { cn } from '@/lib/utils'
// Phase 4-a · the split siblings
import { ChatHeader } from './chat-header'
import { Composer } from './composer'
import { MessageList } from './message-list'
import { SkillDraftDialog, type SkillDraft } from './skill-draft-dialog'
import { useTtsOrchestrator } from './tts-orchestrator'
import { useMicController } from './mic-controller'
import { useResearchFlow } from './research-flow'

// ---------------------------------------------------------------- types

/** The panel's message row (state lives HERE per spec 4.7 — the extracted
 *  siblings import this type; message state never leaves the shell). */
export interface LocalMessage {
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
  /** Research pipeline snapshot persisted in meta (oj-face-5) — phases,
   *  queries, sources with credibility + pages read. Absent on legacy rows. */
  research?: ResearchPipelineMeta
  /** Structured tool calls from meta (oj-face-5). Chat turns persist only
   *  bare tool NAMES today — this stays undefined until meta carries them. */
  toolCalls?: ToolCallRecord[]
  ts: Date
}

// ---------------------------------------------------------------- interrupt
// mlv-ux-2 — Mark-LV's 3-part interrupt (web edition), client half.
// When a thought is cancelled, the service aborts the backend fetch and
// never emits a response — but the race where the reply was already in
// flight is real, so a module-level guard drops ONE late reply for the
// cancelled turn (never rendered, persisted, or spoken). Cleared on the
// service's thought_cancelled ack, on the next send, and by a 15s window.
let ignoreNextResponse = false
let ignoreNextResponseAt = 0
const IGNORE_RESPONSE_WINDOW_MS = 15_000

function uid(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID()
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
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
  const thinkingEnabled = useMistStore((s) => s.thinkingEnabled)
  const setThinkingEnabled = useMistStore((s) => s.setThinkingEnabled)
  const neuralState = useMistStore((s) => s.neural.state)

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

  // ---- Phase 3-b · TabBoundary: the panel's tick timers (thinking counter,
  // typing dots, response watchdog) pause while the tab is hidden — the
  // effects below re-arm when it returns (the mic's energy loop lives in the
  // mic-controller and gates itself the same way).
  const { visible: tabVisible } = useTabBoundary('chat-panel')

  // ---- neural socket
  const { sendThought, sendVoiceEnergy, setProvider: setNeuralProvider, onResponse, cancelThought, onThoughtCancelled, onChunk } =
    useNeural()

  // ---- Phase 4-a · the split pieces (state stays HERE, wiring below)
  const tts = useTtsOrchestrator()

  // ---- local state (message state lives HERE per spec)
  const [messages, setMessages] = useState<LocalMessage[]>([])
  const [input, setInput] = useState('')
  const [awaiting, setAwaiting] = useState(false)
  const [thinkingSecs, setThinkingSecs] = useState(0)
  const [historyLoading, setHistoryLoading] = useState(false)
  const [providers, setProviders] = useState<ProviderId[]>(['auto'])
  const [skillDraft, setSkillDraft] = useState<SkillDraft | null>(null)
  /** mlv-ux-2 — when the last thought was cancelled (drives the quiet
   *  "— cancelled —" note; self-clears after a few seconds). */
  const [cancelledAt, setCancelledAt] = useState<number | null>(null)
  // Real-time typing indicator state
  const [isTyping, setIsTyping] = useState(false)
  const [typingText, setTypingText] = useState('')

  // Swipe-to-dismiss for heartbeat alerts (⏰/📦 cards) — HER design
  // (proposals cmukeyz2n / cmukdrqg1 lineage, applied by hand after three
  // transit-mangled payloads: horizontal drag past 80px or the X button
  // dismisses; dismissed ids persist in localStorage so alerts stay gone).
  const [dismissedAlertIds, setDismissedAlertIds] = useState<string[]>(() => {
    try {
      return JSON.parse(localStorage.getItem('mist-dismissedAlertIds') || '[]') as string[]
    } catch {
      return []
    }
  })
  const dismissAlert = useCallback((id: string) => {
    setMessages((prev) => prev.filter((m) => m.id !== id))
    setDismissedAlertIds((prev) => {
      if (prev.includes(id)) return prev
      const next = [...prev, id]
      try {
        localStorage.setItem('mist-dismissedAlertIds', JSON.stringify(next))
      } catch {
        /* storage unavailable — session-only dismissal */
      }
      return next
    })
  }, [])

  // ---- refs
  const messagesRef = useRef<LocalMessage[]>(messages)
  const awaitingRef = useRef(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const atBottomRef = useRef(true)
  const skipHistoryLoadRef = useRef(false)
  const sendThreadIdRef = useRef<string | null>(null)
  const awaitStartRef = useRef(0)

  const setAwaitingBoth = (b: boolean) => {
    awaitingRef.current = b
    setAwaiting(b)
    setIsTyping(b)
    // Phase 3-b · audio-session machine: the chat's thinking turn publishes
    // the ONE audio state (idle→thinking on send; the reply's settle walks
    // speaking→idle in speech.ts after TTS ends — a no-TTS reply ends here).
    useAudioSession.getState().transition(b ? 'thinking' : 'idle')
    if (b) {
      awaitStartRef.current = Date.now()
      setThinkingSecs(0)
      setTypingText('')
      streamPreviewRef.current = ''
      setStreamPreview('')
    } else {
      // the awaiting row (and its streaming preview) leaves with the reply
      setStreamPreview('')
    }
  }

  // ---- w5 voice-speed — the progressive reply preview: clean prose chunks
  // stream in WHILE she generates; the final message replaces it whole. The
  // chat is never a blank waiting row on complex replies. ----
  const [streamPreview, setStreamPreview] = useState('')
  const streamPreviewRef = useRef('')
  useEffect(() => {
    return onChunk((c) => {
      if (!awaitingRef.current || !c.text) return
      streamPreviewRef.current += c.text
      setStreamPreview(streamPreviewRef.current)
    })
  }, [onChunk])

  // Keep the messages mirror in sync for event-handler reads (send history).
  useEffect(() => {
    messagesRef.current = messages
  }, [messages])

  // Thinking theatrics: elapsed counter (the label itself is now the LIVE
  // activity — thinking / reading <file> / searching the web — w3-activity).
  // TabBoundary: both ticks pause while the tab is hidden (Date.now-based —
  // the counters stay honest when the boundary re-arms them on return).
  useEffect(() => {
    if (!awaiting || !tabVisible) return
    const tick = window.setInterval(
      () => setThinkingSecs(Math.floor((Date.now() - awaitStartRef.current) / 1000)),
      500
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
      window.clearInterval(typingInterval)
    }
  }, [awaiting, isTyping, tabVisible])

  // Response watchdog — a dropped reply must never freeze the conversation.
  // The neural service always answers (worst case its 150s offline fallback),
  // but if the socket dies mid-thought (network blip, service restart) the
  // consciousness_response is emitted into the void and the composer would
  // stay locked forever — the exact "she said she'd do it and then nothing
  // happened" experience. Watch: 180s hard cap, or 45s while the socket is
  // down (the reply cannot arrive on a dead link). TabBoundary: the watchdog
  // sleeps while hidden — the elapsed clock is wall time, so a hidden tab
  // that overruns recovers within one 3s tick of returning.
  useEffect(() => {
    if (!awaiting || !tabVisible) return
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
  }, [awaiting, tabVisible])

  // ------------------------------------------------------------- deep research
  // Phase 4-a: the research job lifecycle (start → console ticks → done/
  // error + persistence + TTS) lives in research-flow.ts — it runs against
  // THIS panel's state through the handles below, identical call order.
  const researchFlow = useResearchFlow({
    setAwaitingBoth: (b) => setAwaitingBoth(b),
    scrollRef,
    atBottomRef,
    sendThreadIdRef,
    tts,
    appendMessage: (m) => setMessages((prev) => [...prev, m]),
  })
  const { research, setResearch, researchRef, startResearch, handleResearchDone, handleResearchError, handleResearchTick } =
    researchFlow

  // ---------------------------------------------------------------- send

  const send = useCallback(
    async (content: string): Promise<boolean> => {
      const text = content.trim()
      if (!text || awaitingRef.current) return false

      // mlv-ux-2 — a fresh turn clears any stale cancel guard
      ignoreNextResponse = false

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
      // mlv-ux-2 — a late reply for a cancelled turn is dropped silently:
      // not rendered, not persisted, not spoken. A guard older than the
      // window is stale and must never eat a fresh reply.
      if (ignoreNextResponse) {
        ignoreNextResponse = false
        if (Date.now() - ignoreNextResponseAt < IGNORE_RESPONSE_WINDOW_MS) return
      }
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
        tts.speakReply(assistantMsg.id, msg.text)
      }
    },
    [tts]
  )

  // Register ONCE — handler + onResponse are stable callbacks.
  useEffect(() => {
    const unsub = onResponse(handleResponse)
    return unsub
  }, [onResponse, handleResponse])

  // ---------------------------------------------------------------- interrupt (mlv-ux-2)

  /** Mark-LV's 3-part interrupt, one sequence for every entry point:
   *  the Stop button, Escape, and the orb (via the interrupt bus).
   *  1) silence her voice instantly; 2) abort the in-flight thought
   *  server-side; 3) settle the local UI with a quiet cancelled note.
   *  The deep-research console owns its own lifecycle — never aborted here. */
  const runInterruptSequence = useCallback(
    (_reason: 'escape' | 'stop-button' | 'orb-tap') => {
      // 1) kill any audio — she falls silent mid-word
      tts.stopSpeaking()
      // 2) if a socket thought is in flight, cancel it server-side
      if (awaitingRef.current && !researchRef.current) {
        cancelThought()
        ignoreNextResponse = true
        ignoreNextResponseAt = Date.now()
        // 3) local UI: unlock the composer, settle the orb, quiet note
        setAwaitingBoth(false)
        useMistStore.getState().setNeuralState('dormant')
        setCancelledAt(Date.now())
      }
    },
    [cancelThought, tts]
  )

  /** Stable ref so the mic-controller's window listeners never re-register. */
  const runInterruptSequenceRef = useRef(runInterruptSequence)
  useEffect(() => {
    runInterruptSequenceRef.current = runInterruptSequence
  }, [runInterruptSequence])

  // Phase 4-a · the mic controller (PTT) — transcript flows back through send,
  // Escape while silent runs the interrupt superset above.
  const mic = useMicController({
    sendVoiceEnergy,
    onTranscript: send,
    onEscapeInterrupt: () => runInterruptSequenceRef.current('escape'),
  })

  // The orb (and any other surface) fires the interrupt bus; this panel
  // runs the superset sequence.
  useEffect(() => {
    const unsub = onInterrupt((reason) => runInterruptSequence(reason))
    return unsub
  }, [runInterruptSequence])

  // The service's cancel ack: no response can come for the cancelled turn —
  // settle the UI and drop the ignore-late guard (belt-and-suspenders for the
  // emit-before-cancel race; the guard only ever needed to span that gap).
  useEffect(() => {
    const unsub = onThoughtCancelled(() => {
      ignoreNextResponse = false
      setAwaitingBoth(false)
    })
    return unsub
  }, [onThoughtCancelled])

  // The quiet "— cancelled —" note fades after a few seconds.
  useEffect(() => {
    if (!cancelledAt) return
    const id = window.setTimeout(() => setCancelledAt(null), 4200)
    return () => window.clearTimeout(id)
  }, [cancelledAt])

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
      // swipe-to-dismiss: an alert the creator already swiped away stays away
      try {
        const dismissed = JSON.parse(localStorage.getItem('mist-dismissedAlertIds') || '[]') as string[]
        if (saved.id && dismissed.includes(saved.id)) return
      } catch {
        /* fresh check failed — show the alert rather than lose it */
      }
      // duplicate-alert guard: the poller can rebroadcast the same id (or a
      // test can fire it twice) — never mount two cards with one React key
      if (saved.id && messagesRef.current.some((m) => m.id === saved.id)) return
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
                research?: ResearchPipelineMeta
                tool_calls?: ToolCallRecord[]
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
                // oj-face-5: research pipeline snapshot (validated shape only)
                research:
                  meta.research && Array.isArray(meta.research.phases) && Array.isArray(meta.research.sources)
                    ? meta.research
                    : undefined,
                // oj-face-5: structured tool calls — absent in current rows,
                // parsed honestly when future messages persist them
                toolCalls: Array.isArray(meta.tool_calls) ? meta.tool_calls : undefined,
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

  // ---------------------------------------------------------------- render

  const activeThread = threadsList.find((t) => t.id === activeId)
  const stateColor = STATE_COLORS[neuralState]
  const { ref: specularRef, onPointerMove: onSpecularMove } = useSpecular<HTMLDivElement>()

  return (
    <div
      ref={specularRef}
      onPointerMove={onSpecularMove}
      className={cn('mist-specular mist-glass flex h-full min-h-0 flex-col overflow-hidden', className)}
    >
      {/* HEADER (Phase 4-a · split sibling) */}
      <ChatHeader
        threadTitle={activeThread?.title}
        persona={persona}
        onPersona={setPersona}
        provider={provider}
        providerOptions={providerOptions}
        onProvider={onProviderChange}
        thinkingEnabled={thinkingEnabled}
        onThinking={setThinkingEnabled}
        ttsEnabled={ttsEnabled}
        onTts={setTtsEnabled}
        onNewThread={() => {
          setActiveThread(null)
          setMessages([])
          sendThreadIdRef.current = null
          // A dead (errored) research console is dismissed with the view;
          // a RUNNING one stays — its report still lands when it finishes.
          if (research && !awaitingRef.current) setResearch(null)
        }}
      />

      {/* MESSAGES (Phase 4-a · split sibling) */}
      <MessageList
        messages={messages}
        historyLoading={historyLoading}
        awaiting={awaiting}
        research={research}
        streamPreview={streamPreview}
        thinkingSecs={thinkingSecs}
        cancelledAt={cancelledAt}
        reduced={reduced}
        stateColor={stateColor}
        researchMode={researchMode}
        speakingId={tts.speakingId}
        onSpeakMessage={tts.speakMessage}
        onStopSpeaking={tts.stopSpeaking}
        onSend={(text) => void send(text)}
        onDismissAlert={dismissAlert}
        onSkillDraft={openSkillDraft}
        onInterrupt={() => runInterruptSequence('stop-button')}
        scrollRef={scrollRef}
        onScroll={onScroll}
        onResearchTick={handleResearchTick}
        onResearchDone={handleResearchDone}
        onResearchError={handleResearchError}
        onResearchRetry={(q, d) => void startResearch(q, d)}
      />

      {/* COMPOSER (Phase 4-a · split sibling) */}
      <Composer
        input={input}
        onInput={setInput}
        textareaRef={textareaRef}
        onSend={(text) => void send(text)}
        awaiting={awaiting}
        recording={mic.recording}
        micActiveRef={mic.recordingRef}
        onMicDown={() => void mic.startRecording()}
        onMicUp={() => void mic.stopRecording()}
        persona={persona}
        researchMode={researchMode}
        onResearchMode={setResearchMode}
        researchDepth={researchDepth}
        onResearchDepth={setResearchDepth}
        reduced={reduced}
      />

      {/* SAVE-AS-SKILL DIALOG (Phase 4-a · split sibling) */}
      <SkillDraftDialog
        draft={skillDraft}
        onDraftChange={(next) => setSkillDraft(next)}
        onClose={() => setSkillDraft(null)}
        onSave={() => void saveSkill()}
      />
    </div>
  )
}
