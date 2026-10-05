'use client'

// M.I.S.T. — XRayFooter (oj-face-5, OpenJarvis UX port).
//
// OpenJarvis's per-message telemetry footer: a slim collapsible strip under
// an assistant message showing tokens in/out, latency, cost estimate,
// complexity tier + score, and — expanded — the full TRACE step timeline
// (provider attempts, tool calls with inputs/outputs, honest error
// categories) from the wave-1 spine.
//
// HONESTY CONTRACT: the trace is MATCHED, never assumed — GET /api/mist/traces
// (shared 30s cache) matched by query text + nearest createdAt. No match →
// a subtle "no trace recorded" state. Numbers are never fabricated.

import { useEffect, useMemo, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import {
  AlertTriangle,
  Brain,
  ChevronDown,
  CircleSlash,
  Clock,
  Cog,
  Coins,
  Database,
  Radio,
  Wrench,
  Zap,
} from 'lucide-react'
import {
  fmtCost,
  fmtDuration,
  fmtTokens,
  getRecentTracesCached,
  getTraceDetailCached,
  type TraceDetail,
  type TraceListItem,
  type TraceStep,
} from '@/lib/oj/ui-api'
import { ToolCallCard, traceStepToToolCall, type ToolCallRecord } from './tool-call-card'
import { useMistStore } from '@/lib/store'
import { cn } from '@/lib/utils'

// ---------------------------------------------------------------- matching

/** Normalize a query for matching: trim + collapse all whitespace runs. */
function normQuery(s: string): string {
  return s.trim().replace(/\s+/g, ' ')
}

function matchTrace(
  traces: TraceListItem[],
  query: string,
  userTs: number | null
): TraceListItem | null {
  const needle = normQuery(query)
  if (!needle) return null
  const candidates = traces.filter((t) => normQuery(t.query) === needle)
  if (candidates.length === 0) return null
  if (candidates.length === 1) return candidates[0]
  // several identical queries → the one nearest in time to this turn
  if (userTs === null) return candidates[0]
  let best = candidates[0]
  let bestDist = Math.abs(new Date(best.createdAt).getTime() - userTs)
  for (const t of candidates.slice(1)) {
    const d = Math.abs(new Date(t.createdAt).getTime() - userTs)
    if (d < bestDist) {
      best = t
      bestDist = d
    }
  }
  return best
}

// ---------------------------------------------------------------- tokens

const TIER_BADGE: Record<string, string> = {
  instant: 'border-teal-300/25 bg-teal-300/5 text-teal-300/85',
  standard: 'border-purple-300/25 bg-purple-300/5 text-purple-300/85',
  deep: 'border-fuchsia-300/25 bg-fuchsia-300/5 text-fuchsia-300/85',
  research: 'border-amber-300/25 bg-amber-300/5 text-amber-300/85',
}

const OUTCOME_STYLE: Record<string, { dot: string; label: string }> = {
  success: { dot: 'bg-emerald-400', label: 'success' },
  degraded: { dot: 'bg-amber-400', label: 'degraded' },
  failure: { dot: 'bg-rose-400', label: 'failure' },
  blocked: { dot: 'bg-rose-400', label: 'blocked' },
  running: { dot: 'bg-purple-400', label: 'running' },
}

function StepTypeIcon({ type }: { type: string }) {
  const cls = 'h-3 w-3'
  switch (type) {
    case 'generate':
      return <Zap aria-hidden className={cls} />
    case 'tool_call':
      return <Wrench aria-hidden className={cls} />
    case 'system':
      return <Cog aria-hidden className={cls} />
    case 'memory':
      return <Database aria-hidden className={cls} />
    default:
      return <Radio aria-hidden className={cls} />
  }
}

/** One step row in the expanded trace timeline. */
function TraceStepRow({ step }: { step: TraceStep }) {
  const [open, setOpen] = useState(false)
  const isTool = step.type === 'tool_call'
  const toolCall: ToolCallRecord = useMemo(() => (isTool ? traceStepToToolCall(step) : { name: step.name }), [isTool, step])

  // tool_call steps render as the rich ToolCallCard
  if (isTool) {
    return <ToolCallCard calls={[toolCall]} />
  }

  let detail: { input: string; output: string } = { input: '', output: '' }
  try {
    const parsedIn = JSON.parse(step.input) as Record<string, unknown>
    detail = {
      input: Object.entries(parsedIn)
        .map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)
        .join(' · ')
        .slice(0, 400),
      output: '',
    }
  } catch {
    detail = { input: step.input.slice(0, 400), output: '' }
  }
  let errorNote: string | null = null
  try {
    const parsedOut = JSON.parse(step.output) as Record<string, unknown>
    if (typeof parsedOut.error === 'string') {
      errorNote = parsedOut.error
      if (typeof parsedOut.category === 'string') errorNote += ` · ${parsedOut.category}`
    } else {
      detail = { ...detail, output: JSON.stringify(parsedOut).slice(0, 400) }
    }
  } catch {
    detail = { ...detail, output: step.output.slice(0, 400) }
  }

  const expandable = detail.input.length > 0 || detail.output.length > 0 || errorNote !== null

  return (
    <div
      className={cn(
        'rounded-xl border px-2.5 py-2',
        step.ok ? 'border-white/10 bg-white/[0.03]' : 'border-rose-400/30 bg-rose-400/[0.06]'
      )}
    >
      <button
        type="button"
        onClick={() => expandable && setOpen((v) => !v)}
        aria-expanded={expandable ? open : undefined}
        className={cn(
          'flex w-full items-center gap-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-400/60',
          expandable ? 'cursor-pointer rounded-lg' : 'cursor-default'
        )}
      >
        <span
          aria-hidden
          className={cn(
            'flex h-5 w-5 shrink-0 items-center justify-center rounded-md border',
            step.ok ? 'border-purple-300/25 bg-purple-300/10 text-purple-300' : 'border-rose-400/40 bg-rose-400/10 text-rose-300'
          )}
        >
          <StepTypeIcon type={step.type} />
        </span>
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-slate-300">
          <span className="text-slate-600">{String(step.idx).padStart(2, '0')}</span> {step.name}
          {!step.ok && errorNote ? <span className="ml-2 text-rose-300/80">{errorNote}</span> : null}
        </span>
        <span className="flex shrink-0 items-center gap-2 font-mono text-[10px] text-slate-500">
          {step.tokens > 0 ? <span>{fmtTokens(step.tokens)} tok</span> : null}
          <span>{fmtDuration(step.durationMs)}</span>
          {expandable ? (
            <ChevronDown aria-hidden className={cn('h-3.5 w-3.5 transition-transform duration-200', open && 'rotate-180')} />
          ) : null}
        </span>
      </button>
      {open ? (
        <div className="mist-scroll mt-1.5 max-h-40 space-y-1.5 overflow-y-auto pr-1">
          {detail.input ? (
            <p className="whitespace-pre-wrap break-all font-mono text-[10.5px] leading-relaxed text-slate-400">
              <span className="text-slate-600">in · </span>
              {detail.input}
            </p>
          ) : null}
          {detail.output ? (
            <p className="whitespace-pre-wrap break-all font-mono text-[10.5px] leading-relaxed text-slate-400">
              <span className="text-slate-600">out · </span>
              {detail.output}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

// ---------------------------------------------------------------- footer

type MatchState =
  | { kind: 'loading' }
  | { kind: 'none' }
  | { kind: 'error'; message: string }
  | { kind: 'matched'; trace: TraceListItem }

export function XRayFooter({
  query,
  userTs,
  provider,
  model,
}: {
  /** The user text of THIS turn — the trace's query field. */
  query: string
  /** When the user message was sent (nearest-createdAt disambiguation). */
  userTs?: Date | string | null
  provider?: string
  model?: string
}) {
  const reduced = useMistStore((s) => s.reducedMotion)
  const [open, setOpen] = useState(false)
  const [match, setMatch] = useState<MatchState>({ kind: 'loading' })
  const [detail, setDetail] = useState<TraceDetail | null>(null)
  const [detailError, setDetailError] = useState<string | null>(null)

  // resolve the matching trace from the shared cached list
  useEffect(() => {
    let alive = true
    const ts = userTs ? new Date(userTs).getTime() : null
    getRecentTracesCached(50)
      .then((res) => {
        if (!alive) return
        if (!res.ok) {
          setMatch({ kind: 'error', message: res.error })
          return
        }
        const found = matchTrace(res.data, query, Number.isNaN(ts as number) ? null : ts)
        setMatch(found ? { kind: 'matched', trace: found } : { kind: 'none' })
      })
      .catch(() => {
        if (alive) setMatch({ kind: 'error', message: 'trace store unreachable' })
      })
    return () => {
      alive = false
    }
  }, [query, userTs])

  // fetch the step timeline when expanded
  useEffect(() => {
    if (!open || match.kind !== 'matched' || detail || detailError) return
    let alive = true
    getTraceDetailCached(match.trace.id)
      .then((res) => {
        if (!alive) return
        if (res.ok) {
          setDetail(res.data)
        } else {
          setDetailError(res.error)
        }
      })
      .catch(() => {
        if (alive) setDetailError('trace detail unreachable')
      })
    return () => {
      alive = false
    }
  }, [open, match, detail, detailError])

  // ---------------------------------------------------------------- renders

  // honest empty state — nothing recorded for this turn
  if (match.kind === 'none') {
    return (
      <p className="mt-1.5 flex items-center gap-1.5 font-mono text-[10px] text-slate-600" title="No trace matched this message — nothing recorded">
        <CircleSlash aria-hidden className="h-3 w-3" />
        no trace recorded
      </p>
    )
  }

  if (match.kind === 'error') {
    return (
      <p className="mt-1.5 flex items-center gap-1.5 font-mono text-[10px] text-slate-600" title={match.message}>
        <AlertTriangle aria-hidden className="h-3 w-3" />
        trace store unreachable
      </p>
    )
  }

  // resolving — a slim shimmer placeholder strip
  if (match.kind === 'loading') {
    return <div aria-hidden className="mist-glass-soft mt-2 h-7 animate-mist-pulse-glow rounded-lg" />
  }

  const trace = match.trace
  const outcome = OUTCOME_STYLE[trace.outcome] ?? { dot: 'bg-slate-400', label: trace.outcome }

  return (
    <div className="mt-2">
      {/* slim collapsed strip */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls="xray-trace-body"
        aria-label={`XRay telemetry: tier ${trace.tier}, complexity ${trace.complexity}, ${trace.steps} steps${open ? ', collapse trace' : ', expand trace'}`}
        className="mist-glass-soft mist-glass-hover flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-400/60"
      >
        <ChevronDown
          aria-hidden
          className={cn('h-3.5 w-3.5 shrink-0 text-slate-500 transition-transform duration-200', open && 'rotate-180')}
        />
        <span className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2.5 gap-y-0.5 font-mono text-[10px] text-slate-400">
          <span className="uppercase tracking-[0.18em] text-slate-500">xray</span>
          <span
            className={cn('rounded border px-1.5 py-px text-[9px] uppercase tracking-wide', TIER_BADGE[trace.tier] ?? 'border-white/10 bg-white/5 text-slate-400')}
            title={`complexity ${trace.complexity.toFixed(2)} → ${trace.tier} lane`}
          >
            {trace.tier} · c {trace.complexity.toFixed(2)}
          </span>
          <span className="inline-flex items-center gap-1" title="tokens in / out (chars/4 estimate)">
            <Brain aria-hidden className="h-3 w-3 text-slate-500" />
            {fmtTokens(trace.tokensIn)} in · {fmtTokens(trace.tokensOut)} out
          </span>
          <span className="inline-flex items-center gap-1" title="end-to-end latency">
            <Clock aria-hidden className="h-3 w-3 text-slate-500" />
            {fmtDuration(trace.latencyMs)}
          </span>
          <span title="trace steps">
            {trace.steps} {trace.steps === 1 ? 'step' : 'steps'}
          </span>
          <span className="inline-flex items-center gap-1" title={`outcome: ${outcome.label}`}>
            <span aria-hidden className={cn('h-1.5 w-1.5 rounded-full', outcome.dot)} />
            {outcome.label}
          </span>
        </span>
      </button>

      {/* expanded full trace timeline */}
      <AnimatePresence initial={false}>
        {open ? (
          <motion.div
            id="xray-trace-body"
            initial={reduced ? { opacity: 0 } : { height: 0, opacity: 0 }}
            animate={reduced ? { opacity: 1 } : { height: 'auto', opacity: 1 }}
            exit={reduced ? { opacity: 0 } : { height: 0, opacity: 0 }}
            transition={{ duration: reduced ? 0.15 : 0.28, ease: [0.22, 1, 0.36, 1] }}
            className="overflow-hidden"
          >
            <div className="mist-glass-soft mt-1.5 rounded-xl p-3">
              {/* trace header — provider lane + cost estimate + budget */}
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-slate-500">trace</span>
                {provider ? (
                  <span className="font-mono text-[10px] text-emerald-300/80">
                    served by {provider}
                    {model ? ` · ${model}` : ''}
                  </span>
                ) : null}
                <span className="inline-flex items-center gap-1 font-mono text-[10px] text-slate-400" title="estimated cost — keyless lanes are $0, keyed lanes at public list prices">
                  <Coins aria-hidden className="h-3 w-3 text-slate-500" />
                  {detail ? `${fmtCost(detail.costUsd)} est` : '…'}
                </span>
                {detail?.tokenBudget ? (
                  <span className="font-mono text-[10px] text-slate-500" title="complexity-routed token budget">
                    budget {fmtTokens(detail.tokenBudget)}
                  </span>
                ) : null}
                <span className="font-mono text-[10px] text-slate-600" title="token basis">tokens est. chars/4</span>
              </div>

              {/* step timeline */}
              {detailError ? (
                <p className="mt-2 flex items-center gap-1.5 font-mono text-[10px] text-rose-300/80">
                  <AlertTriangle aria-hidden className="h-3 w-3" />
                  {detailError}
                </p>
              ) : !detail ? (
                <div className="mt-2 space-y-1.5" aria-hidden>
                  {[0, 1, 2].map((i) => (
                    <div key={i} className="h-9 animate-mist-pulse-glow rounded-xl bg-white/[0.04]" />
                  ))}
                </div>
              ) : (
                <div className="mist-scroll mt-2 max-h-96 space-y-1.5 overflow-y-auto pr-1" role="list" aria-label="Trace steps">
                  {detail.steps.map((s) => (
                    <div role="listitem" key={s.idx}>
                      <TraceStepRow step={s} />
                    </div>
                  ))}
                  {detail.steps.length === 0 ? (
                    <p className="flex items-center gap-1.5 py-1 font-mono text-[10px] text-slate-600">
                      <CircleSlash aria-hidden className="h-3 w-3" />
                      trace recorded without steps
                    </p>
                  ) : null}
                </div>
              )}
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  )
}
