'use client'

// M.I.S.T. — message-list: the conversation log.
//
// Phase 4-a · chat-panel split: the messages region extracted from the
// god-file one-to-one — same skeletons, empty state, message choreography,
// research console, live stream preview, thinking row and cancelled note.
// The panel owns the message STATE and all flow logic; this list is the
// presentation layer plus the scroll bookkeeping that only it needs.
//
// Phase 4-a perf: every message item carries `content-visibility:auto` +
// `contain-intrinsic-size` — the CSS-first win. Off-screen messages skip
// layout/paint entirely (the browser renders just the intrinsic-size box),
// so a 200-message thread costs like the ~15 messages on screen.

import { type RefObject } from 'react'
import dynamic from 'next/dynamic'
import { AnimatePresence, motion } from 'framer-motion'
import {
  FileText,
  GraduationCap,
  HelpCircle,
  Lightbulb,
  Square,
  Telescope,
  Volume2,
  X,
} from 'lucide-react'
import type { ResearchDepth } from '@/lib/store'
import { stripEmotionMarkers } from '@/lib/voice-emotion'
import { PROVIDER_LABELS } from '@/lib/mist-constants'
import type { ProviderId, ResearchJob } from '@/lib/types'
import { MarkdownMessage } from '@/components/mist/chat/markdown-message'
import { ActivityLine } from '@/components/mist/shared/activity-line'
import { XRayFooter } from '@/components/mist/chat/xray-footer'
import { ToolCallCard, type ToolCallRecord } from '@/components/mist/chat/tool-call-card'
import { ResearchTimeline, type ResearchPipelineMeta } from '@/components/mist/chat/research-timeline'
import { Skeleton } from '@/components/ui/skeleton'
import { MessageMedia } from './media-tabs'
import type { LocalMessage } from './chat-panel'
import { cn } from '@/lib/utils'

// Phase 4-a · P1: the research console is a heavy rarely-mounted surface —
// dynamic (client-only) with a skeleton; it loads on the first live job.
const ResearchConsole = dynamic(
  () => import('./research-console').then((m) => m.ResearchConsole),
  {
    ssr: false,
    loading: () => (
      <div className="space-y-2" aria-hidden>
        <Skeleton className="h-16 w-2/3 rounded-2xl bg-white/5" />
        <Skeleton className="h-4 w-1/3 rounded-full bg-white/5" />
      </div>
    ),
  }
)

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

const springIn = { type: 'spring' as const, stiffness: 170, damping: 22 }

function fmtTime(d: Date): string {
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
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

const KIND_BADGES: Record<string, string> = {
  alternative: 'border-emerald-300/25 bg-emerald-300/5 text-emerald-300/80',
  workaround: 'border-amber-300/25 bg-amber-300/5 text-amber-300/80',
  enable: 'border-purple-300/25 bg-purple-300/5 text-purple-300/80',
  clarify: 'border-teal-300/25 bg-teal-300/5 text-teal-300/80',
  later: 'border-slate-400/25 bg-slate-400/5 text-slate-400/80',
}

/** oj-face-5: mounts the XRay telemetry footer on an assistant chat turn —
 *  resolves the nearest preceding user message (the spine trace's query text
 *  + the turn's start time for nearest-createdAt matching). Renders nothing
 *  for the special providers (research runs carry the ResearchTimeline;
 *  heartbeat alerts + watchdog notes have no user turn to match). */
function XRayMount({
  messages,
  index,
  message,
}: {
  messages: LocalMessage[]
  index: number
  message: LocalMessage
}) {
  if (
    message.provider === 'research' ||
    message.provider === 'heartbeat' ||
    message.provider === 'watchdog'
  ) {
    return null
  }
  let prevUser: LocalMessage | null = null
  for (let i = index - 1; i >= 0; i--) {
    if (messages[i]?.role === 'user') {
      prevUser = messages[i]
      break
    }
  }
  if (!prevUser) return null
  return (
    <XRayFooter
      query={prevUser.content}
      userTs={prevUser.ts}
      provider={message.provider}
      model={message.model}
    />
  )
}

// ---------------------------------------------------------------- props

export interface MessageListProps {
  messages: LocalMessage[]
  historyLoading: boolean
  awaiting: boolean
  /** The live deep-research job (console + spinner ownership). */
  research: { jobId: string; query: string; depth: ResearchDepth } | null
  streamPreview: string
  thinkingSecs: number
  cancelledAt: number | null
  reduced: boolean
  stateColor: string
  researchMode: boolean
  /** TTS orchestrator surface (per-message read-aloud). */
  speakingId: string | null
  onSpeakMessage: (id: string, content: string) => void
  onStopSpeaking: () => void
  onSend: (text: string) => void
  onDismissAlert: (id: string) => void
  onSkillDraft: (m: LocalMessage) => void
  /** Stop button — the interrupt sequence (mlv-ux-2). */
  onInterrupt: () => void
  scrollRef: RefObject<HTMLDivElement | null>
  onScroll: () => void
  /** Research console callbacks (owned by the panel). */
  onResearchTick: () => void
  onResearchDone: (job: ResearchJob) => void
  onResearchError: (message: string) => void
  onResearchRetry: (query: string, depth: ResearchDepth) => void
}

// ---------------------------------------------------------------- component

export function MessageList(props: MessageListProps) {
  const {
    messages,
    historyLoading,
    awaiting,
    research,
    streamPreview,
    thinkingSecs,
    cancelledAt,
    reduced,
    stateColor,
    researchMode,
    speakingId,
    onSpeakMessage,
    onStopSpeaking,
    onSend,
    onDismissAlert,
    onSkillDraft,
    onInterrupt,
    scrollRef,
    onScroll,
    onResearchTick,
    onResearchDone,
    onResearchError,
    onResearchRetry,
  } = props

  return (
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
                  onClick={() => onSend(s)}
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
            <AnimatePresence initial={false}>
            {messages.map((m, mi) =>
              m.role === 'user' ? (
                <motion.div
                  key={m.id}
                  initial={reduced ? false : { opacity: 0, x: 28, scale: 0.97 }}
                  animate={{ opacity: 1, x: 0, scale: 1 }}
                  transition={springIn}
                  className="flex justify-end"
                  // Phase 4-a: off-screen messages skip layout + paint
                  // (contain-intrinsic-size keeps the scrollbar honest).
                  style={{ contentVisibility: 'auto', containIntrinsicSize: 'auto 96px' }}
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
                  exit={
                    m.provider === 'heartbeat'
                      ? { opacity: 0, x: -220, transition: { duration: 0.25 } }
                      : { opacity: 0, transition: { duration: 0.15 } }
                  }
                  transition={springIn}
                  className="group flex gap-3"
                  // Phase 4-a: off-screen messages skip layout + paint
                  // (contain-intrinsic-size keeps the scrollbar honest).
                  style={{ contentVisibility: 'auto', containIntrinsicSize: 'auto 180px' }}
                  {...(m.provider === 'heartbeat'
                    ? {
                        drag: 'x' as const,
                        dragConstraints: { left: -120, right: 120 },
                        dragElastic: 0.6,
                        onDragEnd: (_e: unknown, info: { offset: { x: number } }) => {
                          if (Math.abs(info.offset.x) > 80) onDismissAlert(m.id)
                        },
                      }
                    : {})}
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

                    {/* swipe-to-dismiss: keyboard/a11y affordance on heartbeat cards */}
                    {m.provider === 'heartbeat' && (
                      <button
                        type="button"
                        aria-label="dismiss alert"
                        onClick={() => onDismissAlert(m.id)}
                        className="mt-2 inline-flex h-6 w-6 items-center justify-center rounded-lg border border-white/10 bg-white/5 text-slate-400 hover:bg-white/10 hover:text-slate-200"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    )}

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
                    <MessageMedia message={m} />

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
                              onClick={() => onSend(opt.label)}
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
                            onClick={() => onSend(s)}
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
                            onStopSpeaking()
                          } else {
                            onSpeakMessage(m.id, m.content)
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
                          onClick={() => onSkillDraft(m)}
                          className="ml-1 inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 font-mono text-[10px] text-slate-500 transition-colors hover:bg-white/5 hover:text-teal-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-400/60"
                        >
                          <GraduationCap aria-hidden className="h-3.5 w-3.5" />
                          save as skill
                        </button>
                      ) : null}
                    </div>

                    {/* oj-face-5 — OpenJarvis UX mounts (additive):
                        · structured tool-call cards (renders nothing until
                          message meta actually carries tool_calls)
                        · research pipeline timeline (research messages with
                          the persisted pipeline snapshot)
                        · XRay telemetry footer (assistant chat turns — matched
                          against the real spine trace, never invented) */}
                    <ToolCallCard calls={m.toolCalls} />
                    {m.provider === 'research' ? (
                      <ResearchTimeline research={m.research} />
                    ) : null}
                    <XRayMount messages={messages} index={mi} message={m} />
                  </div>
                </motion.div>
              )
            )}
            </AnimatePresence>

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
                      onTick={onResearchTick}
                      onDone={onResearchDone}
                      onError={onResearchError}
                      onRetry={onResearchRetry}
                    />
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

            <AnimatePresence>
              {awaiting && !research && streamPreview && (
                <motion.div
                  initial={reduced ? false : { opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0 }}
                  className="ml-8 max-w-[90%] sm:ml-9 sm:max-w-[80%]"
                  aria-live="polite"
                  aria-label="Mist is writing — live preview"
                >
                  <p className="whitespace-pre-wrap text-balance text-[14px] leading-relaxed text-slate-400/90">
                    {/* w8: markers are for her voice, never for the reader */}
                    {(() => {
                      const preview = stripEmotionMarkers(streamPreview)
                      return preview.length > 900 ? `${preview.slice(0, 900).trimEnd()}…` : preview
                    })()}
                    <span className="animate-mist-thinking-pulse ml-1 inline-block h-3 w-1.5 translate-y-0.5 rounded-sm bg-slate-500/80" aria-hidden />
                  </p>
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
                  {/* w3-activity — the LIVE activity line: what she is
                      doing right now ("thinking" → "reading package.json" →
                      "searching the web — …"), streamed from her neural
                      service while she works. Falls back to "thinking" until
                      the first event lands; clears with the row on reply. */}
                  <ActivityLine active className="text-[11px] text-slate-400" />
                  <span className="font-mono text-[10px] text-slate-500 tabular-nums">
                    {thinkingSecs > 0 ? `${thinkingSecs}s` : ''}
                  </span>
                  {/* mlv-ux-2 — the creator's stop affordance: cancel the
                      in-flight reply (also Escape, or tap the orb) */}
                  <button
                    type="button"
                    onClick={onInterrupt}
                    aria-label="Stop her reply"
                    title="Stop her reply (Esc)"
                    className="ml-1 inline-flex h-6 items-center gap-1.5 rounded-lg border border-rose-300/25 bg-rose-300/5 px-2 font-mono text-[10px] text-rose-300/80 transition-colors hover:border-rose-300/50 hover:bg-rose-300/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-400/60"
                  >
                    <Square aria-hidden className="h-2.5 w-2.5" />
                    Stop
                  </button>
                  <span className="sr-only">M.I.S.T. is processing your message</span>
                </motion.div>
              )}
            </AnimatePresence>

            {/* mlv-ux-2 — the quiet cancelled note (fades a few seconds
                after the interrupt; local-only, never persisted) */}
            <AnimatePresence>
              {cancelledAt && !awaiting && (
                <motion.div
                  key="cancelled-note"
                  initial={reduced ? false : { opacity: 0, y: 4 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.25 }}
                  className="flex items-center gap-3 px-1"
                >
                  <span className="font-mono text-[10px] italic text-slate-500">
                    — cancelled —
                  </span>
                </motion.div>
              )}
            </AnimatePresence>
          </>
        )}
      </div>
    </div>
  )
}
