'use client'

// TracesTab — the OpenJarvis trace explorer (oj-spine-1's XRay telemetry).
// Every chat turn, cascade call and mission run lands here as a typed trace;
// rows expand into the full step timeline with honest input/output payloads.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Check,
  ChevronDown,
  Cpu,
  Loader2,
  MessageCircle,
  RefreshCw,
  Route,
  Search,
  ShieldCheck,
  TriangleAlert,
  Wrench,
  Zap,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { cn } from '@/lib/utils'
import { ojApi, type TraceDetail, type TraceStep, type TraceSummary } from '@/lib/oj/lab-api'
import { MonoBadge, SectionLabel, metricBarColor, relTime } from './shared'

// ---------- styling maps (app palette: emerald / amber / rose / teal / purple / fuchsia) ----------

const OUTCOME_STYLE: Record<string, string> = {
  success: 'border-emerald-400/30 bg-emerald-400/10 text-emerald-300',
  degraded: 'border-amber-400/30 bg-amber-400/10 text-amber-300',
  failure: 'border-rose-400/30 bg-rose-400/10 text-rose-300',
  blocked: 'border-rose-400/30 bg-rose-400/10 text-rose-300',
  running: 'border-purple-400/30 bg-purple-400/10 text-purple-300',
}

const TIER_STYLE: Record<string, string> = {
  instant: 'border-emerald-400/30 text-emerald-300',
  standard: 'border-teal-400/30 text-teal-300',
  deep: 'border-amber-400/30 text-amber-300',
  research: 'border-fuchsia-400/30 text-fuchsia-300',
}

const STEP_ICON: Record<string, LucideIcon> = {
  generate: Zap,
  tool: Wrench,
  system: Cpu,
  guard: ShieldCheck,
  retrieval: Search,
}

const OUTCOMES = ['success', 'degraded', 'failure', 'blocked', 'running'] as const
const LIMITS = [10, 25, 50, 100] as const

// ---------- helpers ----------

function shortSha(sha: string | null | undefined, len = 7): string {
  if (!sha) return '—'
  return sha.slice(0, len)
}

function clipPayload(s: string | null | undefined, max = 4096): string {
  const v = s ?? ''
  if (v.length <= max) return v
  return `${v.slice(0, max)}\n… [${(v.length - max).toLocaleString()} more chars truncated for display]`
}

function fmtNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

function fmtMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—'
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.round(ms)}ms`
}

// ---------- one step row (collapsible input/output) ----------

function StepRow({ step }: { step: TraceStep }) {
  const [open, setOpen] = useState(false)
  const Icon = STEP_ICON[step.type] ?? Cpu
  const hasPayload = Boolean(step.input || step.output)
  return (
    <li className="relative pl-3">
      <span
        aria-hidden="true"
        className={cn(
          'absolute left-0 top-2 h-1.5 w-1.5 rounded-full',
          step.ok ? 'bg-emerald-400' : 'bg-rose-400'
        )}
      />
      <div className="rounded-lg border border-white/5 bg-white/[0.02]">
        <button
          type="button"
          onClick={() => hasPayload && setOpen((o) => !o)}
          aria-expanded={hasPayload ? open : undefined}
          aria-label={`Step ${step.idx}: ${step.type} ${step.name}${step.ok ? ' (ok)' : ' (failed)'}`}
          className={cn(
            'flex w-full items-center gap-2 px-2.5 py-1.5 text-left',
            hasPayload && 'cursor-pointer hover:bg-white/[0.03] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-400/60'
          )}
        >
          <span className="w-5 shrink-0 font-mono text-[9px] tabular-nums text-slate-600">
            {String(step.idx).padStart(2, '0')}
          </span>
          <Icon aria-hidden className="h-3 w-3 shrink-0 text-slate-500" />
          <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-slate-300">{step.name}</span>
          <span className="shrink-0 font-mono text-[9px] tabular-nums text-slate-600">{step.type}</span>
          {step.ok ? (
            <Check aria-hidden className="h-3 w-3 shrink-0 text-emerald-400" />
          ) : (
            <TriangleAlert aria-hidden className="h-3 w-3 shrink-0 text-rose-400" />
          )}
          <span className="shrink-0 font-mono text-[9px] tabular-nums text-slate-600">
            {fmtMs(step.durationMs ?? undefined)}
          </span>
          {step.tokens ? (
            <span className="shrink-0 font-mono text-[9px] tabular-nums text-slate-600" title="estimated tokens">
              ~{fmtNum(step.tokens)}t
            </span>
          ) : null}
          {hasPayload ? (
            <ChevronDown
              aria-hidden
              className={cn('h-3.5 w-3.5 shrink-0 text-slate-600 transition-transform', open && 'rotate-180')}
            />
          ) : (
            <span className="w-3.5" />
          )}
        </button>
        {open && hasPayload ? (
          <div className="space-y-2 border-t border-white/5 px-2.5 py-2">
            {step.input ? (
              <div>
                <p className="mb-1 font-mono text-[9px] uppercase tracking-wider text-slate-500">input</p>
                <pre className="mist-scroll max-h-36 overflow-auto whitespace-pre-wrap break-all rounded bg-slate-950/60 p-2 font-mono text-[10px] leading-relaxed text-slate-400">
                  {clipPayload(step.input)}
                </pre>
              </div>
            ) : null}
            {step.output ? (
              <div>
                <p className="mb-1 font-mono text-[9px] uppercase tracking-wider text-slate-500">
                  output {step.ok ? '' : '· failed'}
                </p>
                <pre
                  className={cn(
                    'mist-scroll max-h-44 overflow-auto whitespace-pre-wrap break-all rounded p-2 font-mono text-[10px] leading-relaxed',
                    step.ok ? 'bg-emerald-950/20 text-slate-400' : 'bg-rose-950/20 text-rose-300/80'
                  )}
                >
                  {clipPayload(step.output)}
                </pre>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </li>
  )
}

// ---------- expanded trace detail ----------

function TraceDetailBody({ trace }: { trace: TraceDetail }) {
  const toolsUsed = Array.isArray(trace.meta?.toolsUsed) ? (trace.meta!.toolsUsed as unknown[]) : []
  const basis = typeof trace.meta?.tokenBasis === 'string' ? (trace.meta!.tokenBasis as string) : null
  return (
    <div className="space-y-2.5">
      {trace.result ? (
        <p className="rounded-lg bg-emerald-950/20 px-2.5 py-1.5 font-mono text-[10px] leading-relaxed text-emerald-300/90">
          result · {clipPayload(trace.result, 600)}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-1.5">
        {trace.tokenBudget !== null && trace.tokenBudget !== undefined ? (
          <MonoBadge className="border-white/10 text-slate-500">budget {trace.tokenBudget}t</MonoBadge>
        ) : null}
        {typeof trace.meta?.lane === 'string' ? (
          <MonoBadge className="border-purple-400/30 text-purple-300" title={String(trace.meta!.lane)}>
            lane
          </MonoBadge>
        ) : null}
        {toolsUsed.length > 0 ? (
          <MonoBadge className="border-teal-400/30 text-teal-300">tools: {toolsUsed.join(', ')}</MonoBadge>
        ) : null}
        {typeof trace.costUsd === 'number' && trace.costUsd > 0 ? (
          <MonoBadge className="border-amber-400/30 text-amber-300">≈ ${trace.costUsd.toFixed(4)}</MonoBadge>
        ) : null}
        {basis ? <MonoBadge className="border-white/10 text-slate-600">tokens: {basis}</MonoBadge> : null}
      </div>
      {trace.steps.length > 0 ? (
        <ul className="space-y-1.5 border-l border-white/10 pl-1">
          {trace.steps.map((s) => (
            <StepRow key={s.idx} step={s} />
          ))}
        </ul>
      ) : (
        <p className="px-1 text-[11px] text-slate-600">no steps were recorded for this trace</p>
      )}
      {trace.startedAt && trace.endedAt ? (
        <p className="font-mono text-[9px] text-slate-600">
          {new Date(trace.startedAt).toLocaleTimeString()} → {new Date(trace.endedAt).toLocaleTimeString()}
        </p>
      ) : null}
    </div>
  )
}

// ---------- one trace row ----------

function TraceRow({
  trace,
  expanded,
  onToggle,
  detail,
  detailLoading,
  detailError,
}: {
  trace: TraceSummary
  expanded: boolean
  onToggle: () => void
  detail: TraceDetail | null
  detailLoading: boolean
  detailError: string | null
}) {
  return (
    <article className={cn('mist-glass-soft rounded-xl transition-colors', expanded && 'bg-white/[0.06]')}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        aria-label={`Trace: ${trace.query.slice(0, 80)} — ${trace.outcome}`}
        className="flex w-full flex-col gap-2 rounded-xl p-3 text-left mist-glass-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-400/60"
      >
        <div className="flex items-start gap-2">
          <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-slate-200" title={trace.query}>
            {trace.query || '(empty query)'}
          </span>
          <span
            className={cn(
              'shrink-0 rounded-full border px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wide',
              OUTCOME_STYLE[trace.outcome] ?? 'border-white/10 bg-white/5 text-slate-400'
            )}
          >
            {trace.outcome}
          </span>
          <ChevronDown
            aria-hidden
            className={cn('h-3.5 w-3.5 shrink-0 text-slate-600 transition-transform', expanded && 'rotate-180')}
          />
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <MonoBadge className="border-white/10 text-slate-400">{trace.agent}</MonoBadge>
          <MonoBadge className="border-white/10 text-slate-500" title={trace.model}>
            {trace.provider}
          </MonoBadge>
          <span
            className={cn('rounded-full border px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wide', TIER_STYLE[trace.tier] ?? 'border-white/10 text-slate-500')}
          >
            {trace.tier}
          </span>
          <span
            className="inline-flex items-center gap-1"
            title={`complexity ${trace.complexity.toFixed(3)} → ${trace.tier} lane`}
          >
            <span className="font-mono text-[9px] tabular-nums text-slate-600">{trace.complexity.toFixed(2)}</span>
            <span className="h-1 w-10 overflow-hidden rounded-full bg-white/10" aria-hidden="true">
              <span
                className={cn('block h-full', metricBarColor(trace.complexity * 100))}
                style={{ width: `${Math.max(6, Math.min(100, trace.complexity * 100))}%` }}
              />
            </span>
          </span>
          <span className="font-mono text-[9px] tabular-nums text-slate-600" title={`tokens in ${trace.tokensIn} · out ${trace.tokensOut} (chars/4 estimate)`}>
            ↑{fmtNum(trace.tokensIn)} ↓{fmtNum(trace.tokensOut)}
          </span>
          <span className="font-mono text-[9px] tabular-nums text-slate-600">{fmtMs(trace.latencyMs)}</span>
          <span className="font-mono text-[9px] tabular-nums text-slate-600">{trace.steps} steps</span>
          <span className="font-mono text-[9px] text-slate-600">{relTime(trace.createdAt)}</span>
        </div>
      </button>
      {expanded ? (
        <div className="border-t border-white/5 px-3 pb-3 pt-2.5">
          {detailError ? (
            <p className="flex items-center gap-1.5 rounded-lg bg-rose-950/20 px-2.5 py-2 font-mono text-[10px] text-rose-300/90">
              <TriangleAlert aria-hidden className="h-3.5 w-3.5 shrink-0" />
              {detailError}
            </p>
          ) : detail ? (
            <TraceDetailBody trace={detail} />
          ) : detailLoading ? (
            <div className="space-y-2">
              <Skeleton className="h-4 w-3/4" />
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-5/6" />
              <Skeleton className="h-8 w-2/3" />
            </div>
          ) : null}
        </div>
      ) : null}
    </article>
  )
}

// ---------- the tab ----------

export function TracesTab() {
  const [agent, setAgent] = useState<string>('')
  const [outcome, setOutcome] = useState<string>('')
  const [limit, setLimit] = useState<number>(25)
  const [traces, setTraces] = useState<TraceSummary[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [detailCache, setDetailCache] = useState<Record<string, TraceDetail>>({})
  const [detailLoading, setDetailLoading] = useState<Record<string, boolean>>({})
  const [detailErrors, setDetailErrors] = useState<Record<string, string>>({})
  const agentsSeen = useRef<Set<string>>(new Set())

  const refresh = useCallback(
    async (opts?: { silent?: boolean }) => {
      if (!opts?.silent) setLoading(true)
      try {
        const res = await ojApi.traces.list({
          agent: agent || undefined,
          outcome: outcome || undefined,
          limit,
        })
        setTraces(res.traces)
        for (const t of res.traces) agentsSeen.current.add(t.agent)
        setError(null)
      } catch (e) {
        setError(e instanceof Error ? e.message : 'trace store unreachable')
      } finally {
        setLoading(false)
      }
    },
    [agent, outcome, limit]
  )

  useEffect(() => {
    refresh()
  }, [refresh])

  // fetch the detail for the currently expanded trace (cache-first)
  useEffect(() => {
    if (!expandedId || detailCache[expandedId] || detailLoading[expandedId]) return
    setDetailLoading((m) => ({ ...m, [expandedId]: true }))
    setDetailErrors((m) => ({ ...m, [expandedId]: '' }))
    ojApi.traces
      .detail(expandedId)
      .then((res) => {
        setDetailCache((m) => ({ ...m, [expandedId]: res.trace }))
        setDetailErrors((m) => ({ ...m, [expandedId]: '' }))
      })
      .catch((e) => {
        setDetailErrors((m) => ({ ...m, [expandedId]: e instanceof Error ? e.message : 'failed to load trace detail' }))
      })
      .finally(() => {
        setDetailLoading((m) => ({ ...m, [expandedId]: false }))
      })
  }, [expandedId, detailCache, detailLoading])

  const agentOptions = useMemo(() => Array.from(agentsSeen.current).sort(), [traces])
  const filteredEmpty = traces !== null && traces.length === 0 && (agent !== '' || outcome !== '')

  return (
    <div className="space-y-3">
      <SectionLabel
        right={
          <span className="font-mono text-[10px] text-slate-600">
            {traces ? `${traces.length} trace${traces.length === 1 ? '' : 's'}` : '…'}
          </span>
        }
      >
        <span className="inline-flex items-center gap-1.5">
          <Route aria-hidden className="h-3 w-3 text-slate-500" />
          trace explorer
        </span>
      </SectionLabel>

      {/* filter bar */}
      <div className="mist-glass-soft grid grid-cols-3 gap-2 p-2.5" role="search" aria-label="trace filters">
        <div className="min-w-0">
          <label htmlFor="trace-agent" className="mb-1 block font-mono text-[9px] uppercase tracking-wider text-slate-600">
            agent
          </label>
          <Select value={agent || 'all'} onValueChange={(v) => setAgent(v === 'all' ? '' : v)}>
            <SelectTrigger id="trace-agent" size="sm" className="h-8 w-full border-white/10 bg-white/5 font-mono text-[11px">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">all</SelectItem>
              {agentOptions.map((a) => (
                <SelectItem key={a} value={a}>
                  {a}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="min-w-0">
          <label htmlFor="trace-outcome" className="mb-1 block font-mono text-[9px] uppercase tracking-wider text-slate-600">
            outcome
          </label>
          <Select value={outcome || 'all'} onValueChange={(v) => setOutcome(v === 'all' ? '' : v)}>
            <SelectTrigger id="trace-outcome" size="sm" className="h-8 w-full border-white/10 bg-white/5 font-mono text-[11px">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">all</SelectItem>
              {OUTCOMES.map((o) => (
                <SelectItem key={o} value={o}>
                  {o}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="min-w-0">
          <label htmlFor="trace-limit" className="mb-1 block font-mono text-[9px] uppercase tracking-wider text-slate-600">
            limit
          </label>
          <Select value={String(limit)} onValueChange={(v) => setLimit(Number(v) || 25)}>
            <SelectTrigger id="trace-limit" size="sm" className="h-8 w-full border-white/10 bg-white/5 font-mono text-[11px">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {LIMITS.map((l) => (
                <SelectItem key={l} value={String(l)}>
                  {l}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* list */}
      {loading ? (
        <div className="space-y-2" aria-busy="true" aria-label="loading traces">
          {[0, 1, 2, 3, 4].map((i) => (
            <Skeleton key={i} className="h-24 w-full rounded-xl" />
          ))}
        </div>
      ) : error ? (
        <div role="alert" className="mist-glass rounded-xl p-4">
          <p className="flex items-center gap-2 text-sm text-rose-300">
            <TriangleAlert aria-hidden className="h-4 w-4" />
            trace store unreachable
          </p>
          <p className="mt-1 font-mono text-[10px] text-slate-500">{error}</p>
          <Button variant="outline" size="sm" className="mt-3 h-8 border-white/10 bg-white/5 font-mono text-[10px] uppercase tracking-widest" onClick={() => refresh()}>
            <RefreshCw aria-hidden className="h-3 w-3" />
            Retry
          </Button>
        </div>
      ) : traces === null || traces.length === 0 ? (
        <div className="mist-glass rounded-xl p-6 text-center">
          <MessageCircle aria-hidden className="mx-auto h-5 w-5 text-slate-600" />
          <p className="mt-2 text-sm text-slate-300">
            {filteredEmpty ? 'no traces match the current filters' : 'no traces yet — chat with her first'}
          </p>
          <p className="mt-1 text-[11px] text-slate-600">
            {filteredEmpty
              ? 'loosen the agent or outcome filter and refresh'
              : 'every chat turn, cascade call and mission run will land here as a typed trace'}
          </p>
        </div>
      ) : (
        <div className="mist-scroll max-h-[70vh] space-y-2 overflow-y-auto pr-1" aria-label="trace list">
          {traces.map((t) => (
            <TraceRow
              key={t.id}
              trace={t}
              expanded={expandedId === t.id}
              onToggle={() => setExpandedId((cur) => (cur === t.id ? null : t.id))}
              detail={detailCache[t.id] ?? null}
              detailLoading={Boolean(detailLoading[t.id])}
              detailError={detailErrors[t.id] || null}
            />
          ))}
          {traces.length >= limit ? (
            <p className="px-1 py-1.5 text-center font-mono text-[9px] text-slate-600">
              showing the latest {limit} — raise the limit for more
            </p>
          ) : null}
        </div>
      )}

      <div className="flex items-center justify-between gap-2">
        <p className="font-mono text-[9px] text-slate-600">
          tokens are chars/4 estimates · costs use the documented price table
        </p>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            toast.promise(refresh(), {
              loading: 'refreshing traces…',
              success: 'traces refreshed',
              error: (e) => (e instanceof Error ? e.message : 'refresh failed'),
            })
          }}
          className="h-8 shrink-0 border-white/10 bg-white/5 font-mono text-[10px] uppercase tracking-widest text-slate-300 hover:border-purple-400/40 hover:text-purple-200"
          aria-label="refresh traces"
        >
          <RefreshCw aria-hidden className="h-3 w-3" />
          refresh
        </Button>
      </div>
    </div>
  )
}
