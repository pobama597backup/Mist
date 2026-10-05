'use client'

// M.I.S.T. — ResearchConsole: the live deep-research progress card (v5).
// Rendered inside the chat stream while a research job runs. Polls the
// research job API (~1.5s) and shows an animated phase tracker, ticking
// stats, query chips and an accumulating source stream. On completion the
// parent swaps this card for the persisted assistant report message.
// Also exports ResearchMarkdown — the lightweight report renderer used by
// the chat panel for research messages (provider === 'research').
// Task 10-e1 · frontend research mode

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import {
  AlertTriangle,
  Check,
  Eye,
  FileText,
  Globe,
  Loader2,
  RotateCcw,
  Search,
  Telescope,
} from 'lucide-react'
import { mistApi } from '@/lib/mist-api'
import type { ResearchJob } from '@/lib/types'
import { cn } from '@/lib/utils'

const POLL_MS = 1500
const MAX_POLL_FAILURES = 3

const PHASE_NAMES = ['planning', 'searching', 'reading', 'synthesizing'] as const

const PHASE_LABELS: Record<string, string> = {
  planning: 'Planning',
  searching: 'Searching',
  reading: 'Reading',
  synthesizing: 'Synthesis',
}

const CRED_STYLES: Record<string, string> = {
  high: 'border-emerald-300/30 bg-emerald-300/10 text-emerald-300/90',
  medium: 'border-amber-300/30 bg-amber-300/10 text-amber-300/90',
  low: 'border-rose-300/30 bg-rose-300/10 text-rose-300/90',
}

function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return `${m}m ${(s % 60).toString().padStart(2, '0')}s`
}

function phaseCircle(status: string): string {
  switch (status) {
    case 'done':
      return 'border-emerald-300/50 bg-emerald-300/10 text-emerald-300'
    case 'active':
      return 'border-fuchsia-400/60 bg-fuchsia-400/15 text-fuchsia-200 shadow-[0_0_10px_rgba(232,121,249,0.4)]'
    case 'error':
      return 'border-rose-400/50 bg-rose-400/10 text-rose-300'
    default:
      return 'border-white/10 text-slate-600'
  }
}

function phaseLabel(status: string): string {
  switch (status) {
    case 'done':
      return 'text-emerald-300/80'
    case 'active':
      return 'text-fuchsia-200'
    case 'error':
      return 'text-rose-300'
    default:
      return 'text-slate-600'
  }
}

// ------------------------------------------------------------ markdown-lite

/** Inline tokens: **bold**, *italic*, `code`, [label](url). */
function inlineNodes(text: string, keyPrefix: string): ReactNode[] {
  const out: ReactNode[] = []
  const re = /(\*\*[^*]+\*\*|\*[^*\s][^*]*\*|`[^`]+`|\[[^\]]+\]\([^)\s]+\))/g
  let last = 0
  let i = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index))
    const tok = m[0]
    const key = `${keyPrefix}-i${i++}`
    if (tok.startsWith('**')) {
      out.push(
        <strong key={key} className="font-semibold text-slate-50">
          {tok.slice(2, -2)}
        </strong>
      )
    } else if (tok.startsWith('`')) {
      out.push(
        <code key={key} className="rounded bg-white/10 px-1 py-px font-mono text-[11px] text-fuchsia-200">
          {tok.slice(1, -1)}
        </code>
      )
    } else if (tok.startsWith('[')) {
      const mm = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(tok)
      if (mm) {
        out.push(
          <a
            key={key}
            href={mm[2]}
            target="_blank"
            rel="noopener noreferrer"
            className="text-purple-300 underline decoration-purple-400/40 underline-offset-2 transition-colors hover:text-purple-200"
          >
            {mm[1]}
          </a>
        )
      } else {
        out.push(tok)
      }
    } else {
      out.push(
        <em key={key} className="italic text-slate-300">
          {tok.slice(1, -1)}
        </em>
      )
    }
    last = m.index + tok.length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

/**
 * Markdown-ish renderer for research reports — headings, lists, quotes,
 * rules, table rows (as mono text) and inline emphasis/links. Intentionally
 * small: reports are the only consumer, so no full AST.
 */
export function ResearchMarkdown({ text }: { text: string }) {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const nodes: ReactNode[] = []
  let list: ReactNode[] = []

  const flushList = (key: string) => {
    if (list.length === 0) return
    nodes.push(
      <ul key={key} className="ml-1 space-y-1">
        {list}
      </ul>
    )
    list = []
  }

  lines.forEach((raw, idx) => {
    const line = raw.trimEnd()
    const key = `l${idx}`

    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line)
    if (bullet) {
      list.push(
        <li key={key} className="flex gap-2 text-[13px] leading-relaxed text-slate-300">
          <span aria-hidden className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-fuchsia-300/70" />
          <span className="min-w-0 break-words">{inlineNodes(bullet[1], key)}</span>
        </li>
      )
      return
    }

    const numbered = /^\s*(\d+)[.)]\s+(.*)$/.exec(line)
    if (numbered) {
      list.push(
        <li key={key} className="flex gap-2 text-[13px] leading-relaxed text-slate-300">
          <span aria-hidden className="shrink-0 font-mono text-[10px] leading-5 text-fuchsia-300/80">
            {numbered[1]}.
          </span>
          <span className="min-w-0 break-words">{inlineNodes(numbered[2], key)}</span>
        </li>
      )
      return
    }

    flushList(`${key}-ul`)

    const heading = /^(#{1,4})\s+(.*)$/.exec(line)
    if (heading) {
      const level = heading[1].length
      const cls =
        level === 1
          ? 'mt-2 border-b border-fuchsia-400/20 pb-1 text-sm font-semibold tracking-wide text-fuchsia-100'
          : level === 2
            ? 'mt-3 text-[13px] font-semibold uppercase tracking-[0.14em] text-purple-200/90'
            : 'mt-2 text-[13px] font-medium text-slate-100'
      nodes.push(
        <p key={key} className={cls}>
          {inlineNodes(heading[2], key)}
        </p>
      )
      return
    }

    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line)) {
      nodes.push(<hr key={key} className="border-white/10" />)
      return
    }

    const quote = /^>\s?(.*)$/.exec(line)
    if (quote) {
      nodes.push(
        <blockquote key={key} className="border-l-2 border-fuchsia-400/40 pl-3 text-[13px] italic leading-relaxed text-slate-400">
          {inlineNodes(quote[1], key)}
        </blockquote>
      )
      return
    }

    if (line.trim() === '') return

    // markdown table rows render as aligned mono text (reports use simple tables)
    if (line.trimStart().startsWith('|')) {
      if (/^\|[\s:|-]+\|?$/.test(line.trim())) return // separator row
      nodes.push(
        <p key={key} className="break-words font-mono text-[11px] leading-relaxed text-slate-400">
          {line.trim()}
        </p>
      )
      return
    }

    nodes.push(
      <p key={key} className="break-words text-[13px] leading-relaxed text-slate-200">
        {inlineNodes(line, key)}
      </p>
    )
  })

  flushList('tail-ul')

  return <div className="space-y-1.5 break-words">{nodes}</div>
}

// ------------------------------------------------------------ console card

export interface ResearchConsoleProps {
  jobId: string
  query: string
  depth: 1 | 2
  /** Calm mode — keep every progress update, drop the theatrics. */
  reduced: boolean
  /** Fires on each successful poll while running (orb re-assert + autoscroll). */
  onTick?: () => void
  onDone: (job: ResearchJob) => void
  onError: (message: string) => void
  onRetry: (query: string, depth: 1 | 2) => void
}

export function ResearchConsole({
  jobId,
  query,
  depth,
  reduced,
  onTick,
  onDone,
  onError,
  onRetry,
}: ResearchConsoleProps) {
  const [job, setJob] = useState<ResearchJob | null>(null)
  const [elapsedMs, setElapsedMs] = useState(0)
  const [pollError, setPollError] = useState<string | null>(null)
  const finishedRef = useRef(false)
  const startRef = useRef(Date.now())

  // Poll loop: async chain driven by setTimeout — every setState lives inside
  // a promise continuation (never directly in the effect body).
  useEffect(() => {
    let cancelled = false
    let timer: number | null = null
    let failures = 0
    finishedRef.current = false

    const finish = (message: string) => {
      if (cancelled || finishedRef.current) return
      finishedRef.current = true
      setPollError(message)
      onError(message)
    }

    const poll = async () => {
      try {
        const j = await mistApi.research.job(jobId)
        if (cancelled) return
        failures = 0
        setJob(j)
        setElapsedMs(j.elapsedMs > 0 ? j.elapsedMs : Date.now() - startRef.current)
        if (j.status === 'running') {
          onTick?.()
          timer = window.setTimeout(poll, POLL_MS)
        } else if (j.status === 'done') {
          if (!finishedRef.current) {
            finishedRef.current = true
            onDone(j)
          }
        } else {
          finish(j.error || 'The research engine reported an unknown error.')
        }
      } catch (err) {
        if (cancelled) return
        failures += 1
        const status = err instanceof Error ? (err as { status?: number }).status : undefined
        if (status === 404) {
          finish('This research job expired or was recycled (jobs live for 30 minutes).')
        } else if (failures >= MAX_POLL_FAILURES) {
          finish('Lost contact with the research engine after several attempts.')
        } else {
          timer = window.setTimeout(poll, POLL_MS)
        }
      }
    }

    void poll()
    return () => {
      cancelled = true
      if (timer !== null) window.clearTimeout(timer)
    }
  }, [jobId, onDone, onError, onTick])

  const errored = pollError !== null || job?.status === 'error'
  const running = !errored && (job === null || job.status === 'running')

  // Live 1s elapsed tick between polls — counters should never feel stale.
  useEffect(() => {
    if (!running) return
    const t = window.setInterval(() => {
      setElapsedMs(Date.now() - startRef.current)
    }, 1000)
    return () => window.clearInterval(t)
  }, [running])

  const phases =
    job?.phases && job.phases.length > 0
      ? job.phases
      : PHASE_NAMES.map((name, i) => ({
          name,
          status: (i === 0 ? 'active' : 'pending') as 'active' | 'pending',
        }))
  const doneCount = phases.filter((p) => p.status === 'done').length
  const activeIdx = phases.findIndex((p) => p.status === 'active')
  const progress = Math.min(
    100,
    Math.round(((doneCount + (activeIdx >= 0 ? 0.5 : 0)) / Math.max(1, phases.length)) * 100)
  )

  const sources = job?.sources ?? []
  const pagesRead = job?.pagesRead ?? 0
  const queries = job?.queries ?? []
  const errorMsg = job?.error || pollError || 'Unknown error'

  return (
    <div
      className={cn(
        'mist-glass relative overflow-hidden rounded-2xl border-fuchsia-400/20',
        running && !reduced && 'mist-border-beam'
      )}
    >
      {/* top shimmer rail — the "scanning" tell while the engine works */}
      <div className="relative h-0.5 w-full overflow-hidden bg-white/5" aria-hidden>
        <div
          className="h-full bg-gradient-to-r from-purple-400/70 to-fuchsia-400/70 transition-[width] duration-700 ease-out"
          style={{ width: `${errored ? 100 : Math.max(progress, 6)}%`, opacity: errored ? 0.25 : 1 }}
        />
        {running && !reduced && (
          <div
            className="absolute inset-0 bg-gradient-to-r from-transparent via-fuchsia-300/80 to-transparent bg-[length:200%_100%]"
            style={{ animation: 'mist-shimmer 1.8s linear infinite' }}
          />
        )}
      </div>

      <div className="p-3 sm:p-4">
        {/* header */}
        <div className="flex items-center gap-2.5">
          <span
            aria-hidden
            className={cn(
              'flex h-8 w-8 shrink-0 items-center justify-center rounded-xl border',
              errored
                ? 'border-rose-400/40 bg-rose-400/10 text-rose-300'
                : running
                  ? 'border-fuchsia-400/40 bg-fuchsia-400/10 text-fuchsia-300'
                  : 'border-emerald-300/40 bg-emerald-300/10 text-emerald-300'
            )}
          >
            {errored ? (
              <AlertTriangle className="h-4 w-4" />
            ) : running ? (
              <Telescope className={cn('h-4 w-4', !reduced && 'animate-mist-pulse-glow')} />
            ) : (
              <Check className="h-4 w-4" />
            )}
          </span>
          <div className="min-w-0 flex-1">
            <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-fuchsia-300/90">
              Deep Research{depth === 2 ? ' · depth 2' : ''}
            </p>
            <p className="truncate text-xs text-slate-300" title={query}>
              {query}
            </p>
          </div>
          <span
            className="shrink-0 font-mono text-[10px] tabular-nums text-slate-400"
            aria-label={`Elapsed ${fmtElapsed(elapsedMs)}`}
          >
            {fmtElapsed(elapsedMs)}
          </span>
        </div>

        {/* phase tracker */}
        <div className="mt-3" role="list" aria-label="Research phases">
          <div className="relative h-1 overflow-hidden rounded-full bg-white/5" aria-hidden>
            <div
              className="absolute inset-y-0 left-0 rounded-full bg-gradient-to-r from-purple-400/80 to-fuchsia-400/80 transition-[width] duration-700 ease-out"
              style={{ width: `${errored ? 100 : progress}%`, opacity: errored ? 0.3 : 1 }}
            />
            {running && !reduced && (
              <div
                className="absolute inset-0 bg-gradient-to-r from-transparent via-fuchsia-300/50 to-transparent bg-[length:200%_100%]"
                style={{ animation: 'mist-shimmer 1.8s linear infinite' }}
              />
            )}
          </div>
          <div className="mt-2 grid grid-cols-4 gap-1">
            {phases.map((p) => {
              const label = PHASE_LABELS[p.name] ?? p.name
              return (
                <div key={p.name} role="listitem" className="flex min-w-0 flex-col items-center gap-1">
                  <span
                    aria-hidden
                    className={cn(
                      'flex h-5 w-5 items-center justify-center rounded-full border',
                      phaseCircle(p.status),
                      p.status === 'active' && !reduced && 'animate-mist-pulse-glow'
                    )}
                  >
                    {p.status === 'done' ? (
                      <Check className="h-3 w-3" />
                    ) : p.status === 'active' ? (
                      reduced ? (
                        <span className="h-1.5 w-1.5 rounded-full bg-fuchsia-300" />
                      ) : (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      )
                    ) : p.status === 'error' ? (
                      <AlertTriangle className="h-3 w-3" />
                    ) : null}
                  </span>
                  <span
                    className={cn(
                      'truncate font-mono text-[9px] uppercase tracking-wider',
                      phaseLabel(p.status)
                    )}
                  >
                    {label}
                  </span>
                </div>
              )
            })}
          </div>
        </div>

        {/* live stats */}
        <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <span className="inline-flex items-center gap-1 font-mono text-[10px] text-slate-400">
            <Globe aria-hidden className="h-3 w-3 text-fuchsia-300/70" />
            <span className="tabular-nums">{sources.length}</span>
            <span className="text-slate-500">sources</span>
          </span>
          <span className="inline-flex items-center gap-1 font-mono text-[10px] text-slate-400">
            <FileText aria-hidden className="h-3 w-3 text-teal-300/70" />
            <span className="tabular-nums">{pagesRead}</span>
            <span className="text-slate-500">pages read</span>
          </span>
          <span className="inline-flex items-center gap-1 font-mono text-[10px] text-slate-400">
            <Search aria-hidden className="h-3 w-3 text-purple-300/70" />
            <span className="tabular-nums">{queries.length}</span>
            <span className="text-slate-500">queries</span>
          </span>
        </div>

        {/* query chips */}
        {queries.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {queries.map((q, i) => (
              <span
                key={`${i}-${q}`}
                className="mist-chip-in inline-block max-w-full truncate rounded-full border border-purple-300/20 bg-purple-300/5 px-2 py-0.5 font-mono text-[10px] text-purple-200/80"
                style={{ animationDelay: `${i * 70}ms` }}
                title={q}
              >
                {q}
              </span>
            ))}
          </div>
        )}

        {/* accumulating source stream */}
        {sources.length > 0 && (
          <div className="mt-3">
            <p className="mb-1.5 font-mono text-[9px] uppercase tracking-widest text-slate-500">
              source stream
            </p>
            <div
              className="mist-scroll max-h-56 space-y-1 overflow-y-auto pr-1"
              role="list"
              aria-label="Sources found"
            >
              <AnimatePresence initial={false}>
                {sources.map((s) => (
                  <motion.a
                    key={s.url}
                    href={s.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    role="listitem"
                    initial={reduced ? false : { opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ type: 'spring', stiffness: 260, damping: 24 }}
                    className="group flex items-center gap-2 rounded-lg border border-white/5 bg-white/[0.03] px-2 py-1.5 transition-colors hover:border-fuchsia-400/30 hover:bg-fuchsia-400/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fuchsia-400/60"
                  >
                    <span
                      className={cn(
                        'shrink-0 rounded border px-1 py-px font-mono text-[8px] uppercase tracking-wider',
                        CRED_STYLES[s.credibility] ?? CRED_STYLES.medium
                      )}
                    >
                      {s.credibility}
                    </span>
                    <span
                      className="min-w-0 flex-1 truncate text-[11px] text-slate-300 group-hover:text-slate-100"
                      title={s.title}
                    >
                      {s.title}
                    </span>
                    <span className="shrink-0 font-mono text-[9px] text-slate-500">
                      {s.host.replace(/^www\./, '')}
                    </span>
                    {s.read ? (
                      <Eye aria-label="read" className="h-3 w-3 shrink-0 text-emerald-300/80" />
                    ) : null}
                  </motion.a>
                ))}
              </AnimatePresence>
            </div>
          </div>
        )}

        {/* error card + retry */}
        {errored && (
          <div className="mt-3 rounded-xl border border-rose-400/30 bg-rose-400/5 p-3">
            <div className="flex items-start gap-2">
              <AlertTriangle aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-rose-300" />
              <div className="min-w-0 flex-1">
                <p className="text-xs font-medium text-rose-200">Research failed</p>
                <p className="mt-0.5 text-[11px] leading-snug text-slate-400">{errorMsg}</p>
              </div>
            </div>
            <div className="mt-2.5 flex justify-end">
              <button
                type="button"
                onClick={() => onRetry(query, depth)}
                className="inline-flex items-center gap-1.5 rounded-lg border border-rose-300/40 bg-rose-400/10 px-2.5 py-1.5 text-[11px] text-rose-100 transition-colors hover:bg-rose-400/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-400/60"
              >
                <RotateCcw aria-hidden className="h-3 w-3" />
                Retry research
              </button>
            </div>
          </div>
        )}

        <span className="sr-only" role="status">
          {running
            ? 'Deep research in progress'
            : errored
              ? 'Deep research failed'
              : 'Deep research complete'}
        </span>
      </div>
    </div>
  )
}
