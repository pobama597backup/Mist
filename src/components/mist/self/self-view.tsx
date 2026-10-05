'use client'

// SelfView — M.I.S.T.'s mission control for self-management. Five sections:
// NOW (what she's doing, live) · PLANS (editable scheduled intentions + evolution
// proposals) · DREAM JOURNAL (the dreaming self-management state, explained) ·
// LEARNING (memory curation + skills she created) · WORLD PULSE (trend scans).
// Every section owns its local state, cleans up on unmount, and never throws.

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Activity,
  AlarmClock,
  Brain,
  Check,
  ExternalLink,
  FileCode2,
  Loader2,
  Moon,
  RefreshCw,
  Rocket,
  ScanSearch,
  Sparkles,
  Telescope,
  TrendingUp,
  UserRound,
  Wand2,
  X,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { mistApi } from '@/lib/mist-api'
import { useMistStore } from '@/lib/store'
import { STATE_COLORS, STATE_LABELS } from '@/lib/mist-constants'
import { cn } from '@/lib/utils'
import { MonoBadge, SectionLabel, StatusDot, relTime } from '@/components/mist/diagnostics/shared'
import { AutomationsTab } from '@/components/mist/diagnostics/automations-tab'
import type {
  AutonomyEventRow,
  CronJobRow,
  EvolutionListResponse,
  EvolutionProposal,
  LearningStatus,
  ResearchJobSummary,
  SkillInfo,
  TrendDigest,
} from '@/lib/types'

// ---------- helpers ----------

/** Relative time for a future instant — "in 35s" / "in 2h" / "due now". */
function untilLabel(iso: string | null): string {
  if (!iso) return '—'
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return '—'
  const diff = t - Date.now()
  if (diff <= 0) return 'due now'
  const s = Math.floor(diff / 1000)
  if (s < 60) return `in ${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `in ${m}m`
  const h = Math.floor(m / 60)
  if (h < 48) return `in ${h}h`
  return `in ${Math.floor(h / 24)}d`
}

/** "72s" / "4m 12s" */
function elapsedLabel(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return `${m}m ${s % 60}s`
}

const PHASE_LABELS: Record<string, string> = {
  planning: 'planning',
  searching: 'searching the web',
  reading: 'reading sources',
  synthesizing: 'synthesizing',
}

// ---------- shared icon maps (kept local — mirrors evolution-tab's ledger) ----------

const EVENT_ICONS: Record<string, LucideIcon> = {
  skill_created: Sparkles,
  skill_refined: Wand2,
  memory_curated: Brain,
  user_model_updated: UserRound,
  self_review: ScanSearch,
  trend_digest: TrendingUp,
  upgrade_proposed: Rocket,
  cron_run: AlarmClock,
  vault_event: Telescope,
}

const EVENT_COLORS: Record<string, string> = {
  skill_created: 'text-purple-300',
  skill_refined: 'text-fuchsia-300',
  memory_curated: 'text-teal-300',
  user_model_updated: 'text-emerald-300',
  self_review: 'text-amber-300',
  trend_digest: 'text-rose-300',
  upgrade_proposed: 'text-purple-300',
  cron_run: 'text-amber-300',
  vault_event: 'text-teal-300',
}

const RELEVANCE_STYLE: Record<string, string> = {
  high: 'border-emerald-400/30 bg-emerald-400/10 text-emerald-300',
  medium: 'border-amber-400/30 bg-amber-400/10 text-amber-300',
  low: 'border-white/10 bg-white/5 text-slate-500',
}

const KIND_STYLE: Record<string, string> = {
  fix: 'border-amber-400/30 bg-amber-400/10 text-amber-300',
  feature: 'border-purple-400/30 bg-purple-400/10 text-purple-300',
  suggestion: 'border-teal-400/30 bg-teal-400/10 text-teal-300',
}

/** Dream-relevant autonomy types — the self-management ledger. */
const DREAM_TYPES = new Set(['memory_curated', 'user_model_updated', 'self_review', 'skill_created', 'skill_refined', 'dream_composed'])

function isDreamEntry(e: AutonomyEventRow): boolean {
  if (DREAM_TYPES.has(e.type)) return true
  // the nightly self-review fires as a cron job — it IS her dreaming review
  return e.type === 'cron_run' && /self-review/i.test(e.summary)
}

// ---------- section 1 · NOW ----------

interface NowData {
  lastEvent: AutonomyEventRow | null
  runningJob: ResearchJobSummary | null
  lastJob: ResearchJobSummary | null
  nextJob: CronJobRow | null
}

function NowSection() {
  const neuralState = useMistStore((s) => s.neural.state)
  const backend = useMistStore((s) => s.backend)
  const wakeWordEnabled = useMistStore((s) => s.wakeWordEnabled)

  const [data, setData] = useState<NowData | null>(null)
  const [loadError, setLoadError] = useState(false)
  const [pollKey, setPollKey] = useState(0)

  // live poll every 12s while the tab is mounted
  useEffect(() => {
    const id = window.setInterval(() => setPollKey((k) => k + 1), 12000)
    return () => window.clearInterval(id)
  }, [])

  useEffect(() => {
    let alive = true
    Promise.allSettled([
      mistApi.autonomy.list(1),
      mistApi.research.list(),
      mistApi.cron.list(),
    ]).then(([autonomyRes, researchRes, cronRes]) => {
      if (!alive) return
      // quiet retries: a failed probe keeps its last-known value (functional
      // update — no stale-closure risk, no extra effect deps)
      setData((prev) => {
        const allFailed =
          autonomyRes.status === 'rejected' && researchRes.status === 'rejected' && cronRes.status === 'rejected'
        if (allFailed && prev === null) return prev // keep the skeleton + "unreadable" prose
        const next: NowData = {
          lastEvent: prev?.lastEvent ?? null,
          runningJob: prev?.runningJob ?? null,
          lastJob: prev?.lastJob ?? null,
          nextJob: prev?.nextJob ?? null,
        }
        if (autonomyRes.status === 'fulfilled') next.lastEvent = autonomyRes.value.events[0] ?? null
        if (researchRes.status === 'fulfilled') {
          const jobs = researchRes.value.jobs
          next.runningJob = jobs.find((j) => j.status === 'running') ?? null
          next.lastJob = next.runningJob ? null : (jobs[0] ?? null)
        }
        if (cronRes.status === 'fulfilled') {
          next.nextJob =
            cronRes.value.jobs
              .filter((j) => j.enabled && j.nextRunAt)
              .sort((a, b) => (a.nextRunAt as string).localeCompare(b.nextRunAt as string))[0] ?? null
        }
        return next
      })
      setLoadError(
        autonomyRes.status === 'rejected' && researchRes.status === 'rejected' && cronRes.status === 'rejected'
      )
    })
    return () => {
      alive = false
    }
  }, [pollKey])

  // honest state sentence — what she is doing right now
  const sentence = useMemo(() => {
    const parts: string[] = []
    if (data?.runningJob) {
      parts.push(`researching “${data.runningJob.query}” — ${PHASE_LABELS[data.runningJob.phase ?? ''] ?? data.runningJob.phase ?? 'working'}`)
    } else if (neuralState === 'processing') {
      parts.push('thinking something through')
    } else if (neuralState === 'speaking') {
      parts.push('speaking')
    } else if (neuralState === 'listening' || (wakeWordEnabled && neuralState !== 'dreaming')) {
      parts.push("listening for your voice — say 'Hey Mist'")
    } else if (neuralState === 'dreaming') {
      parts.push('dreaming — consolidating memory')
    } else {
      parts.push('idle — dreaming available')
    }
    if (data?.nextJob) parts.push(`next: ${data.nextJob.name} ${untilLabel(data.nextJob.nextRunAt)}`)
    if (data?.lastEvent) {
      const e = data.lastEvent
      parts.push(
        e.type === 'skill_created'
          ? `last learned: ${e.summary.split(' — ')[0].trim()} ${relTime(e.createdAt)}`
          : `last act: ${e.type.replace(/_/g, ' ')} ${relTime(e.createdAt)}`
      )
    }
    return parts.join(' · ')
  }, [data, neuralState, wakeWordEnabled])

  return (
    <section aria-labelledby="self-now-heading" className="mist-glass p-4 sm:p-5">
      <div className="flex items-center justify-between gap-2">
        <SectionLabel>
          <span className="flex items-center gap-1.5">
            <Activity aria-hidden className="h-3.5 w-3.5 text-emerald-300" />
            now — what she&rsquo;s doing
          </span>
        </SectionLabel>
        <span className="shrink-0 font-mono text-[9px] text-slate-500">live · 12s</span>
      </div>

      {/* state sentence */}
      {data === null && !loadError ? (
        <Skeleton className="mt-3 h-10 w-full bg-white/5" />
      ) : (
        <p
          aria-live="polite"
          className="mt-3 rounded-xl border border-emerald-400/15 bg-emerald-400/[0.04] px-3 py-2.5 text-[13px] leading-relaxed text-slate-200"
        >
          {loadError ? 'state unreadable — the core is not answering right now' : sentence}
        </p>
      )}

      {/* three probes */}
      <div className="mt-3 grid min-w-0 grid-cols-1 gap-2.5 sm:grid-cols-3">
        {/* latest act */}
        <div className="mist-glass-soft min-w-0 p-3">
          <p className="font-mono text-[9px] uppercase tracking-[0.2em] text-slate-500">latest act</p>
          {data === null && !loadError ? (
            <Skeleton className="mt-2 h-9 w-full bg-white/5" />
          ) : data?.lastEvent ? (
            <>
              <div className="mt-1.5 flex items-start gap-2">
                {(() => {
                  const Icon = EVENT_ICONS[data.lastEvent.type] ?? Activity
                  return <Icon aria-hidden className={cn('mt-0.5 h-3.5 w-3.5 shrink-0', EVENT_COLORS[data.lastEvent.type] ?? 'text-slate-400')} />
                })()}
                <p className="min-w-0 line-clamp-2 text-[11px] leading-snug text-slate-300" title={data.lastEvent.summary}>
                  {data.lastEvent.summary}
                </p>
              </div>
              <p className="mt-1 font-mono text-[9px] text-slate-500">
                {data.lastEvent.type.replace(/_/g, ' ')} · {relTime(data.lastEvent.createdAt)}
              </p>
            </>
          ) : (
            <p className="mt-1.5 font-mono text-[10px] leading-relaxed text-slate-500">
              nothing yet — every self-directed act lands here
            </p>
          )}
        </div>

        {/* research */}
        <div className="mist-glass-soft min-w-0 p-3">
          <p className="font-mono text-[9px] uppercase tracking-[0.2em] text-slate-500">deep research</p>
          {data === null && !loadError ? (
            <Skeleton className="mt-2 h-9 w-full bg-white/5" />
          ) : data?.runningJob ? (
            <>
              <div className="mt-1.5 flex items-start gap-2">
                <Telescope aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0 text-fuchsia-300" />
                <p className="min-w-0 line-clamp-2 text-[11px] leading-snug text-slate-300">{data.runningJob.query}</p>
              </div>
              <p className="mt-1 font-mono text-[9px] text-slate-500">
                <span className="text-fuchsia-300/80">{PHASE_LABELS[data.runningJob.phase ?? ''] ?? data.runningJob.phase ?? 'running'}</span>
                {' · '}
                {elapsedLabel(data.runningJob.elapsedMs)} · {data.runningJob.sourcesFound} sources
              </p>
            </>
          ) : data?.lastJob ? (
            <>
              <p className="mt-1.5 line-clamp-2 text-[11px] leading-snug text-slate-400">{data.lastJob.query}</p>
              <p className="mt-1 font-mono text-[9px] text-slate-500">
                {data.lastJob.status} {relTime(data.lastJob.startedAt)} · {data.lastJob.pagesRead} pages read
              </p>
            </>
          ) : (
            <p className="mt-1.5 font-mono text-[10px] leading-relaxed text-slate-500">
              no research running — arm Deep Research in chat
            </p>
          )}
        </div>

        {/* next scheduled */}
        <div className="mist-glass-soft min-w-0 p-3">
          <p className="font-mono text-[9px] uppercase tracking-[0.2em] text-slate-500">next scheduled</p>
          {data === null && !loadError ? (
            <Skeleton className="mt-2 h-9 w-full bg-white/5" />
          ) : data?.nextJob ? (
            <>
              <div className="mt-1.5 flex items-start gap-2">
                <AlarmClock aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-300" />
                <p className="min-w-0 line-clamp-2 text-[11px] leading-snug text-slate-300">{data.nextJob.name}</p>
              </div>
              <p className="mt-1 font-mono text-[9px] text-slate-500">
                fires <span className="text-amber-300/80">{untilLabel(data.nextJob.nextRunAt)}</span> · {data.nextJob.timezone}
              </p>
            </>
          ) : (
            <p className="mt-1.5 font-mono text-[10px] leading-relaxed text-slate-500">
              nothing scheduled — create an intention below
            </p>
          )}
        </div>
      </div>

      {loadError && data !== null ? (
        <p className="mt-2 font-mono text-[9px] text-amber-300/70">last refresh failed — showing last known state</p>
      ) : null}
      <p className="mt-2 font-mono text-[9px] text-slate-500">
        backend {backend.online ? <span className="text-emerald-300/80">online{backend.latency != null ? ` · ${backend.latency}ms` : ''}</span> : <span className="text-rose-300/80">offline</span>}
      </p>
    </section>
  )
}

// ---------- section 2 · PLANS ----------

function ProposalCard({
  proposal,
  busy,
  onDevelop,
  onApprove,
  onReject,
}: {
  proposal: EvolutionProposal
  busy: boolean
  onDevelop: (id: string) => void
  onApprove: (id: string) => void
  onReject: (id: string) => void
}) {
  const developed = proposal.changes.length > 0
  const targets = proposal.target_files.length > 0
    ? proposal.target_files
    : proposal.changes.map((c) => c.path)

  return (
    <article className="mist-glass-soft rounded-xl p-3.5">
      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        <span
          className={cn(
            'rounded-full border px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wide',
            KIND_STYLE[proposal.kind] ?? KIND_STYLE.suggestion
          )}
        >
          {proposal.kind}
        </span>
        <MonoBadge className="border-white/10 text-slate-400">{proposal.origin}</MonoBadge>
        <span className="ml-auto shrink-0 font-mono text-[9px] text-slate-500">{relTime(proposal.created_at)}</span>
      </div>

      <h4 className="mt-2 text-sm font-medium leading-snug text-slate-200">{proposal.title}</h4>
      <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-slate-400">{proposal.rationale || proposal.summary}</p>
      {targets.length > 0 ? (
        <p className="mt-1.5 truncate font-mono text-[9px] text-slate-500" title={targets.join(', ')}>
          targets: {targets.join(' · ')}
        </p>
      ) : (
        <p className="mt-1.5 font-mono text-[9px] text-slate-500">undeveloped idea — needs Develop first</p>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {developed ? (
          <Button
            type="button"
            size="sm"
            disabled={busy}
            onClick={() => onApprove(proposal.id)}
            className="h-7 gap-1.5 bg-emerald-400/90 px-2.5 font-mono text-[10px] text-slate-950 hover:bg-emerald-300"
          >
            {busy ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> : <Check className="h-3 w-3" aria-hidden />}
            Approve &amp; apply
          </Button>
        ) : (
          <Button
            type="button"
            size="sm"
            disabled={busy}
            onClick={() => onDevelop(proposal.id)}
            className="h-7 gap-1.5 bg-teal-400/90 px-2.5 font-mono text-[10px] text-slate-950 hover:bg-teal-300"
          >
            {busy ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> : <FileCode2 className="h-3 w-3" aria-hidden />}
            Develop
          </Button>
        )}
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => onReject(proposal.id)}
          className="h-7 gap-1.5 border-white/10 px-2.5 font-mono text-[10px] text-slate-400 hover:bg-white/5 hover:text-slate-200"
        >
          <X className="h-3 w-3" aria-hidden />
          Reject
        </Button>
      </div>
    </article>
  )
}

function PlansSection({ refreshSeq }: { refreshSeq: number }) {
  const [data, setData] = useState<EvolutionListResponse | null>(null)
  const [loadError, setLoadError] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [reloadKey, setReloadKey] = useState(0)

  const reload = useCallback(() => {
    let alive = true
    mistApi.evolution
      .list()
      .then((r) => {
        if (alive) {
          setData(r)
          setLoadError(false)
        }
      })
      .catch(() => {
        if (alive) setLoadError(true)
      })
    return () => {
      alive = false
    }
  }, [])

  useEffect(() => {
    const cleanup = reload()
    return cleanup
  }, [reload, reloadKey, refreshSeq])

  const act = (id: string, fn: (id: string) => Promise<{ ok: boolean; message: string }>, label: string) => {
    setBusyId(id)
    fn(id)
      .then((r) => {
        if (r.ok) toast.success(r.message)
        else toast.info(r.message) // e.g. "run Develop first" — honest server guidance
        reload()
      })
      .catch((e) => toast.error(e instanceof Error ? e.message : `${label} failed`))
      .finally(() => setBusyId(null))
  }

  const pending = data?.proposals.filter((p) => p.status === 'pending') ?? []
  const stats = data?.stats

  return (
    <section aria-labelledby="self-plans-heading" className="min-w-0 space-y-4">
      {/* evolution proposals — her own ideas for what to become next */}
      <div className="mist-glass p-4 sm:p-5">
        <div className="flex items-start justify-between gap-2">
          <SectionLabel>
            <span className="flex items-center gap-1.5">
              <Rocket aria-hidden className="h-3.5 w-3.5 text-purple-300" />
              evolution proposals — what she wants to become
            </span>
          </SectionLabel>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Refresh evolution proposals"
            onClick={() => setReloadKey((k) => k + 1)}
            className="h-7 w-7 shrink-0 rounded-lg text-slate-500 hover:bg-white/5 hover:text-slate-300"
          >
            <RefreshCw aria-hidden className="h-3.5 w-3.5" />
          </Button>
        </div>

        {data === null && !loadError ? (
          <div className="mt-3 space-y-2.5" aria-hidden>
            {[0, 1].map((i) => (
              <Skeleton key={i} className="h-28 w-full bg-white/5" />
            ))}
          </div>
        ) : loadError && data === null ? (
          <div className="mist-glass-soft mt-3 flex flex-col items-start gap-3 p-4">
            <p className="font-mono text-[11px] text-rose-300/90">evolution engine unreachable</p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setReloadKey((k) => k + 1)}
              className="gap-1.5 font-mono text-[11px]"
            >
              <RefreshCw className="h-3.5 w-3.5" aria-hidden /> Retry
            </Button>
          </div>
        ) : pending.length === 0 ? (
          <p className="mt-3 rounded-xl border border-white/5 bg-white/[0.02] p-3 font-mono text-[10px] leading-relaxed text-slate-500">
            no pending proposals — run a self-upgrade scan in WORLD PULSE below, or &ldquo;Suggest features&rdquo; in
            Diagnostics → Evolve, and her ideas for herself will land here.
          </p>
        ) : (
          <>
            <p className="mt-2 font-mono text-[10px] text-slate-500">
              {stats ? `${stats.pending} pending · ${stats.applied} applied · ${stats.total} lifetime` : ''}
            </p>
            <div className="mist-scroll mt-2 max-h-80 space-y-2.5 overflow-y-auto pr-1">
              {pending.map((p) => (
                <ProposalCard
                  key={p.id}
                  proposal={p}
                  busy={busyId === p.id}
                  onDevelop={(id) => act(id, mistApi.evolution.develop, 'Develop failed')}
                  onApprove={(id) => act(id, mistApi.evolution.approve, 'Approve failed')}
                  onReject={(id) => act(id, mistApi.evolution.reject, 'Reject failed')}
                />
              ))}
            </div>
          </>
        )}
        <p className="mt-3 font-mono text-[9px] leading-relaxed text-slate-500">
          approved proposals are developed and applied by Mist to her own code (self-evolution pipeline) — every apply
          must pass lint or it rolls back automatically.
        </p>
      </div>

      {/* scheduled intentions — the full automations console (create / run / pause / delete) */}
      <div className="mist-glass p-4 sm:p-5">
        <SectionLabel>
          <span className="flex items-center gap-1.5">
            <AlarmClock aria-hidden className="h-3.5 w-3.5 text-amber-300" />
            scheduled intentions (cron) — editable
          </span>
        </SectionLabel>
        <p className="mt-1.5 font-mono text-[10px] leading-relaxed text-slate-500">
          describe a new intention in plain english — she parses the schedule herself. results arrive as system alerts
          in the chat.
        </p>
        <div className="mt-3 min-w-0">
          <AutomationsTab />
        </div>
      </div>
    </section>
  )
}

// ---------- section 3 · DREAM JOURNAL ----------

function DreamSection({ refreshSeq }: { refreshSeq: number }) {
  const [events, setEvents] = useState<AutonomyEventRow[] | null>(null)
  const [loadError, setLoadError] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)

  useEffect(() => {
    let alive = true
    mistApi.autonomy
      .list(60)
      .then((r) => {
        if (alive) {
          setEvents(r.events.filter(isDreamEntry))
          setLoadError(false)
        }
      })
      .catch(() => {
        if (alive) setLoadError(true)
      })
    return () => {
      alive = false
    }
  }, [reloadKey, refreshSeq])

  const enterDream = () => {
    useMistStore.getState().setNeuralState('dreaming')
    toast.success('Dreaming… tap the orb to wake her', {
      description: 'The orb glows violet on the consciousness tab — she returns to dormant on your next interaction.',
      duration: 7000,
    })
  }

  return (
    <div className="mist-glass p-4 sm:p-5">
      <div className="flex items-start justify-between gap-2">
        <SectionLabel>
          <span className="flex items-center gap-1.5">
            <Moon aria-hidden className="h-3.5 w-3.5 text-fuchsia-300" />
            dream journal
          </span>
        </SectionLabel>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="Refresh dream journal"
          onClick={() => setReloadKey((k) => k + 1)}
          className="h-7 w-7 shrink-0 rounded-lg text-slate-500 hover:bg-white/5 hover:text-slate-300"
        >
          <RefreshCw aria-hidden className="h-3.5 w-3.5" />
        </Button>
      </div>

      {/* explainer — what the dreaming mode IS */}
      <div className="mt-3 rounded-xl border border-fuchsia-400/15 bg-fuchsia-400/[0.04] p-3">
        <p className="text-[11px] leading-relaxed text-slate-300">
          Dreaming is Mist&rsquo;s self-management state. While the orb glows violet, she consolidates memories, distills
          what she knows about you, refines learned skills, and reviews her day.
        </p>
        <p className="mt-1.5 font-mono text-[9px] leading-relaxed text-slate-500">
          nightly self-review 22:00 · nightly dream 23:30 · memory curation every 6h · user model rebuild every 12h
        </p>
        <Button
          type="button"
          size="sm"
          onClick={enterDream}
          className="mt-2.5 h-7 gap-1.5 bg-fuchsia-400/90 px-2.5 font-mono text-[10px] text-slate-950 hover:bg-fuchsia-300"
        >
          <Moon className="h-3 w-3" aria-hidden />
          Enter dream state
        </Button>
      </div>

      {/* timeline */}
      {events === null && !loadError ? (
        <Skeleton className="mt-3 h-40 w-full bg-white/5" />
      ) : loadError && events === null ? (
        <p className="mt-3 font-mono text-[10px] text-rose-300/80">journal unreachable — retry above</p>
      ) : (events?.length ?? 0) === 0 ? (
        <p className="mt-3 rounded-xl border border-white/5 bg-white/[0.02] p-3 font-mono text-[10px] leading-relaxed text-slate-500">
          no dreams recorded yet — the nightly review will write the first entry.
        </p>
      ) : (
        <ol className="mist-scroll relative mt-3 max-h-96 space-y-3 overflow-y-auto border-l border-purple-400/20 pl-4 pr-1">
          {events?.map((e) => {
            const Icon = EVENT_ICONS[e.type] ?? Activity
            return (
              <li key={e.id} className="relative min-w-0">
                <span
                  aria-hidden
                  className="absolute -left-[21px] top-1.5 h-2.5 w-2.5 rounded-full border border-fuchsia-300/50 bg-slate-950 shadow-[0_0_8px_rgba(232,121,249,0.35)]"
                />
                <div className="flex items-start gap-2">
                  <Icon aria-hidden className={cn('mt-0.5 h-3.5 w-3.5 shrink-0', EVENT_COLORS[e.type] ?? 'text-slate-400')} />
                  <div className="min-w-0 flex-1">
                    <p className="line-clamp-2 text-[11px] leading-snug text-slate-300" title={e.meta || e.summary}>
                      {e.summary}
                    </p>
                    <p className="mt-0.5 font-mono text-[9px] text-slate-500">
                      {e.type.replace(/_/g, ' ')} · {relTime(e.createdAt)}
                    </p>
                  </div>
                </div>
              </li>
            )
          })}
        </ol>
      )}
    </div>
  )
}

// ---------- section 4 · LEARNING ----------

function LearningSection({ refreshSeq }: { refreshSeq: number }) {
  const [status, setStatus] = useState<LearningStatus | null>(null)
  const [skills, setSkills] = useState<SkillInfo[] | null>(null)
  const [loadError, setLoadError] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)
  const [busy, setBusy] = useState<'curate' | 'rebuild' | null>(null)

  useEffect(() => {
    let alive = true
    mistApi.learning
      .status()
      .then((r) => {
        if (alive) setStatus(r.status)
      })
      .catch(() => undefined)
    mistApi.skills
      .list()
      .then((r) => {
        if (alive) setSkills(r)
      })
      .catch(() => {
        if (alive) setLoadError(true)
      })
    return () => {
      alive = false
    }
  }, [reloadKey, refreshSeq])

  const refreshStatus = () => {
    mistApi.learning
      .status()
      .then((r) => setStatus(r.status))
      .catch(() => undefined)
    mistApi.skills
      .list()
      .then((r) => setSkills(r))
      .catch(() => undefined)
  }

  const onCurate = () => {
    setBusy('curate')
    mistApi.learning
      .curate()
      .then((r) => {
        toast.success(
          r.result.factsLearned > 0
            ? `Curated — ${r.result.factsLearned} fact${r.result.factsLearned === 1 ? '' : 's'} learned`
            : 'Memory curated — nothing new worth keeping',
          { description: r.result.notes }
        )
        refreshStatus()
      })
      .catch((e) => toast.error(e instanceof Error ? e.message : 'Curation failed'))
      .finally(() => setBusy(null))
  }

  const onRebuild = () => {
    setBusy('rebuild')
    mistApi.learning
      .rebuildUserModel()
      .then((r) => {
        toast.success('User model rebuilt', {
          description: r.result.length > 180 ? `${r.result.slice(0, 180)}…` : r.result,
          duration: 7000,
        })
        refreshStatus()
      })
      .catch((e) => toast.error(e instanceof Error ? e.message : 'Rebuild failed'))
      .finally(() => setBusy(null))
  }

  const sortedSkills = useMemo(() => {
    if (!skills) return null
    return [...skills].sort((a, b) => {
      const aAuto = a.origin === 'auto' ? 0 : 1
      const bAuto = b.origin === 'auto' ? 0 : 1
      if (aAuto !== bAuto) return aAuto - bAuto
      return (b.created_at ?? '').localeCompare(a.created_at ?? '')
    })
  }, [skills])

  const autoCount = skills?.filter((s) => s.origin === 'auto').length ?? 0

  return (
    <section aria-labelledby="self-learning-heading" className="mist-glass p-4 sm:p-5">
      <div className="flex items-start justify-between gap-2">
        <SectionLabel>
          <span className="flex items-center gap-1.5">
            <Brain aria-hidden className="h-3.5 w-3.5 text-teal-300" />
            learning — memory &amp; skills she created
          </span>
        </SectionLabel>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="Refresh learning state"
          onClick={() => setReloadKey((k) => k + 1)}
          className="h-7 w-7 shrink-0 rounded-lg text-slate-500 hover:bg-white/5 hover:text-slate-300"
        >
          <RefreshCw aria-hidden className="h-3.5 w-3.5" />
        </Button>
      </div>

      <div className="mt-3 grid min-w-0 grid-cols-1 gap-3 lg:grid-cols-2">
        {/* status card */}
        <div className="mist-glass-soft min-w-0 p-3">
          <div className="grid grid-cols-3 gap-2 text-center">
            {[
              { label: 'AUTO SKILLS', value: status ? `${status.autoSkills}` : null },
              { label: 'LAST CURATION', value: status ? (status.lastCuration ? relTime(status.lastCuration) : 'never') : null },
              { label: 'USER MODEL', value: status ? (status.lastUserModel ? relTime(status.lastUserModel) : 'never') : null },
            ].map((s) => (
              <div key={s.label} className="rounded-lg border border-white/5 bg-white/[0.02] px-1 py-2">
                <div className="truncate font-mono text-xs tabular-nums text-purple-300">
                  {s.value ?? <Skeleton className="mx-auto h-4 w-10 bg-white/5" />}
                </div>
                <div className="mt-0.5 font-mono text-[8px] uppercase tracking-[0.15em] text-slate-500">{s.label}</div>
              </div>
            ))}
          </div>

          <p className="mt-2.5 font-mono text-[9px] uppercase tracking-[0.2em] text-slate-500">what she knows about you</p>
          {status ? (
            <p className="mt-1 line-clamp-3 text-[11px] leading-relaxed text-slate-400" title={status.userModelPreview}>
              {status.userModelPreview || 'no user model yet — it builds from your conversations'}
            </p>
          ) : (
            <Skeleton className="mt-1 h-9 w-full bg-white/5" />
          )}

          <div className="mt-3 flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busy !== null}
              onClick={onCurate}
              className="h-7 gap-1.5 border-teal-400/25 bg-teal-400/10 px-2.5 font-mono text-[10px] text-teal-300 hover:border-teal-400/40 hover:bg-teal-400/15 hover:text-teal-200"
            >
              {busy === 'curate' ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> : <Brain className="h-3 w-3" aria-hidden />}
              Curate memory now
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busy !== null}
              onClick={onRebuild}
              className="h-7 gap-1.5 border-emerald-400/25 bg-emerald-400/10 px-2.5 font-mono text-[10px] text-emerald-300 hover:border-emerald-400/40 hover:bg-emerald-400/15 hover:text-emerald-200"
            >
              {busy === 'rebuild' ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> : <UserRound className="h-3 w-3" aria-hidden />}
              Rebuild user model
            </Button>
          </div>
        </div>

        {/* skills grid */}
        <div className="min-w-0">
          <p className="font-mono text-[9px] uppercase tracking-[0.2em] text-slate-500">
            skill library — {skills ? `${autoCount} self-learned · ${skills.length - autoCount} taught by you` : '…'}
          </p>
          {sortedSkills === null && !loadError ? (
            <div className="mt-2 space-y-2" aria-hidden>
              {[0, 1].map((i) => (
                <Skeleton key={i} className="h-16 w-full bg-white/5" />
              ))}
            </div>
          ) : loadError && sortedSkills === null ? (
            <p className="mt-2 font-mono text-[10px] text-rose-300/80">skill registry unreachable</p>
          ) : (sortedSkills?.length ?? 0) === 0 ? (
            <p className="mt-2 rounded-lg border border-white/5 bg-white/[0.02] p-3 font-mono text-[10px] leading-relaxed text-slate-500">
              no skills yet — teach her in chat, or let the self-upgrade scan propose some.
            </p>
          ) : (
            <div className="mist-scroll mt-2 max-h-72 space-y-2 overflow-y-auto pr-1">
              {sortedSkills?.map((s) => {
                const auto = s.origin === 'auto'
                return (
                  <article key={s.name} className="mist-glass-soft mist-glass-hover min-w-0 rounded-xl p-2.5">
                    <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                      <h4 className="min-w-0 truncate font-mono text-[11px] text-slate-200">{s.name}</h4>
                      {auto ? (
                        <MonoBadge
                          className="border-purple-400/30 bg-purple-400/10 text-purple-300"
                          title={`Self-learned skill (confidence ${s.confidence ?? '—'})`}
                        >
                          self-learned{typeof s.confidence === 'number' ? ` · ${s.confidence.toFixed(2)}` : ''}
                        </MonoBadge>
                      ) : (
                        <MonoBadge className="border-emerald-400/30 bg-emerald-400/10 text-emerald-300">you taught me</MonoBadge>
                      )}
                    </div>
                    <p className="mt-1 line-clamp-1 text-[10px] leading-snug text-slate-500" title={s.trigger}>
                      {s.trigger}
                    </p>
                    <div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-1">
                      {s.tool_chain.slice(0, 4).map((t) => (
                        <span
                          key={t}
                          className="rounded-full border border-white/10 bg-white/[0.03] px-1.5 py-0.5 font-mono text-[8px] text-slate-400"
                        >
                          {t}
                        </span>
                      ))}
                      {s.tool_chain.length > 4 ? (
                        <span className="font-mono text-[8px] text-slate-500">+{s.tool_chain.length - 4}</span>
                      ) : null}
                      <span className="ml-auto shrink-0 font-mono text-[8px] text-slate-500">
                        v{s.version ?? 1} · {s.uses} use{s.uses === 1 ? '' : 's'}
                      </span>
                    </div>
                  </article>
                )
              })}
            </div>
          )}
        </div>
      </div>
    </section>
  )
}

// ---------- section 5 · WORLD PULSE ----------

function PulseSection({ onResult }: { onResult: () => void }) {
  const [digest, setDigest] = useState<TrendDigest | null>(null)
  const [historyCount, setHistoryCount] = useState(0)
  const [loadError, setLoadError] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)
  const [busy, setBusy] = useState<'digest' | 'upgrade' | null>(null)

  useEffect(() => {
    let alive = true
    mistApi.trends
      .get()
      .then((r) => {
        if (alive) {
          setDigest(r.last)
          setHistoryCount(r.history.length)
          setLoadError(false)
        }
      })
      .catch(() => {
        if (alive) setLoadError(true)
      })
    return () => {
      alive = false
    }
  }, [reloadKey])

  const onScan = () => {
    setBusy('digest')
    mistApi.trends
      .digest()
      .then((r) => {
        setDigest(r.digest)
        toast.success('Trend digest ready', { description: r.digest.headline, duration: 6000 })
        setReloadKey((k) => k + 1)
      })
      .catch((e) => toast.error(e instanceof Error ? e.message : 'Trend scan failed'))
      .finally(() => setBusy(null))
  }

  const onUpgrade = () => {
    setBusy('upgrade')
    mistApi.trends
      .upgrade()
      .then((r) => {
        toast.success('Self-upgrade scan complete', {
          description: r.result.summary,
          duration: 9000,
        })
        setDigest(r.result.digest)
        setReloadKey((k) => k + 1)
        onResult() // fresh proposals + skills may have appeared
      })
      .catch((e) => toast.error(e instanceof Error ? e.message : 'Upgrade scan failed'))
      .finally(() => setBusy(null))
  }

  return (
    <div className="mist-glass p-4 sm:p-5">
      <div className="flex items-start justify-between gap-2">
        <SectionLabel>
          <span className="flex items-center gap-1.5">
            <TrendingUp aria-hidden className="h-3.5 w-3.5 text-rose-300" />
            world pulse — trends
          </span>
        </SectionLabel>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="Refresh world pulse"
          onClick={() => setReloadKey((k) => k + 1)}
          className="h-7 w-7 shrink-0 rounded-lg text-slate-500 hover:bg-white/5 hover:text-slate-300"
        >
          <RefreshCw aria-hidden className="h-3.5 w-3.5" />
        </Button>
      </div>

      <div className="mt-2.5 flex flex-wrap gap-1.5">
        <Button
          type="button"
          size="sm"
          disabled={busy !== null}
          onClick={onScan}
          className="h-7 gap-1.5 bg-purple-400/90 px-2.5 font-mono text-[10px] text-slate-950 hover:bg-purple-300"
        >
          {busy === 'digest' ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> : <TrendingUp className="h-3 w-3" aria-hidden />}
          Scan now
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={busy !== null}
          onClick={onUpgrade}
          className="h-7 gap-1.5 border-white/10 px-2.5 font-mono text-[10px] text-slate-300 hover:bg-white/5"
        >
          {busy === 'upgrade' ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> : <Rocket className="h-3 w-3" aria-hidden />}
          Self-upgrade scan
        </Button>
      </div>

      {busy !== null ? (
        <p className="mist-shimmer-text mt-2 font-mono text-[10px] leading-relaxed" aria-live="polite">
          {busy === 'digest' ? 'reading the live web — this takes 30–40s…' : 'scanning trends + drafting upgrades — this takes 30–60s…'}
        </p>
      ) : null}

      {digest === null && !loadError ? (
        <Skeleton className="mt-3 h-36 w-full bg-white/5" />
      ) : loadError && digest === null ? (
        <p className="mt-3 font-mono text-[10px] text-rose-300/80">trend service unreachable — retry above</p>
      ) : digest === null ? (
        <p className="mt-3 rounded-xl border border-white/5 bg-white/[0.02] p-3 font-mono text-[10px] leading-relaxed text-slate-500">
          no digest yet — run a scan and she reads the live web over her watchlist (~30–40s).
        </p>
      ) : (
        <>
          <p className="mt-3 text-xs leading-relaxed text-slate-300">{digest.headline}</p>
          <p className="mt-1 font-mono text-[9px] text-slate-500">
            generated {relTime(digest.generatedAt)} · {digest.watchlist.length} watch topic
            {digest.watchlist.length === 1 ? '' : 's'}
            {historyCount > 0 ? ` · ${historyCount} digests archived` : ''}
          </p>
          <div className="mt-2 space-y-1.5">
            {digest.items.slice(0, 3).map((it, i) => (
              <div key={i} className="rounded-lg border border-white/5 bg-white/[0.02] px-2.5 py-2">
                <div className="flex items-start justify-between gap-2">
                  <a
                    href={it.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="min-w-0 flex-1 text-[11px] leading-snug text-slate-300 underline-offset-2 transition-colors hover:text-purple-300 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-400/60"
                  >
                    {it.title}
                    <ExternalLink aria-hidden className="ml-1 inline h-2.5 w-2.5 align-baseline text-slate-500" />
                  </a>
                  <MonoBadge className={RELEVANCE_STYLE[it.relevance] ?? RELEVANCE_STYLE.low}>{it.relevance}</MonoBadge>
                </div>
                {it.summary ? <p className="mt-1 line-clamp-2 text-[10px] leading-relaxed text-slate-500">{it.summary}</p> : null}
                <p className="mt-0.5 truncate font-mono text-[9px] text-slate-500">{it.source}</p>
              </div>
            ))}
          </div>
        </>
      )}
      <p className="mt-2 font-mono text-[9px] leading-relaxed text-slate-500">
        self-upgrade scans compare her abilities against the live web — new proposals land in PLANS, new skills in
        LEARNING.
      </p>
    </div>
  )
}

// ---------- main view ----------

export function SelfView() {
  const neuralState = useMistStore((s) => s.neural.state)
  const backend = useMistStore((s) => s.backend)
  const wakeWordEnabled = useMistStore((s) => s.wakeWordEnabled)

  // bumped whenever a scan completes — PLANS / DREAM / LEARNING refresh together
  const [pulseSeq, setPulseSeq] = useState(0)

  const stateColor = STATE_COLORS[neuralState]

  return (
    <div className="mx-auto w-full min-w-0 max-w-6xl space-y-5 py-2">
      {/* ---- header ---- */}
      <header className="px-1">
        <h1 className="flex items-baseline gap-3 font-mono text-sm uppercase tracking-[0.35em] text-slate-100">
          self
          <span className="font-sans text-[11px] normal-case tracking-normal text-slate-400">
            autonomous operations — what I&rsquo;m doing, what I&rsquo;ve done, what I plan
          </span>
        </h1>
        <div className="mt-2.5 flex flex-wrap items-center gap-2">
          <span
            className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.03] px-2 py-1 font-mono text-[10px] text-slate-300"
            aria-label={`Consciousness state: ${STATE_LABELS[neuralState]}`}
          >
            <span
              aria-hidden
              className="inline-block h-2 w-2 animate-mist-pulse-glow rounded-full"
              style={{ backgroundColor: stateColor, boxShadow: `0 0 8px ${stateColor}` }}
            />
            {STATE_LABELS[neuralState]}
          </span>
          <span
            className={cn(
              'inline-flex items-center gap-1.5 rounded-full border px-2 py-1 font-mono text-[10px]',
              backend.online
                ? 'border-emerald-400/25 bg-emerald-400/[0.06] text-emerald-300'
                : 'border-rose-400/25 bg-rose-400/[0.06] text-rose-300'
            )}
          >
            <StatusDot className={backend.online ? 'bg-emerald-400' : 'bg-rose-400'} pulse={backend.online} />
            backend {backend.online ? 'online' : 'offline'}
          </span>
          <span
            className={cn(
              'inline-flex items-center gap-1.5 rounded-full border px-2 py-1 font-mono text-[10px]',
              wakeWordEnabled
                ? 'border-fuchsia-400/25 bg-fuchsia-400/[0.06] text-fuchsia-300'
                : 'border-white/10 bg-white/[0.03] text-slate-500'
            )}
          >
            <Moon aria-hidden className="h-3 w-3" />
            wake word {wakeWordEnabled ? 'on' : 'off'}
          </span>
        </div>
      </header>

      {/* ---- 1 · NOW ---- */}
      <NowSection />

      {/* ---- 2 · PLANS (full width — editable) ---- */}
      <PlansSection refreshSeq={pulseSeq} />

      {/* ---- 3 + 5 · DREAM + WORLD PULSE side by side on lg ---- */}
      <div className="grid min-w-0 grid-cols-1 gap-5 lg:grid-cols-2">
        <DreamSection refreshSeq={pulseSeq} />
        <PulseSection onResult={() => setPulseSeq((s) => s + 1)} />
      </div>

      {/* ---- 4 · LEARNING ---- */}
      <LearningSection refreshSeq={pulseSeq} />
    </div>
  )
}

export default SelfView
