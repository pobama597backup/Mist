'use client'

// M.I.S.T. evolution tab — MIST codes itself, behind your approval.
// Fix proposals come from real self-audits (lint + dev log). Feature ideas are
// MIST's own (or inspired by the auto-updated OpenClaw digest). Nothing applies
// without Approve — and everything that applies must pass lint or it rolls back.

import { useCallback, useEffect, useState } from 'react'
import {
  Activity,
  AlarmClock,
  Brain,
  Check,
  ChevronDown,
  Dna,
  ExternalLink,
  FileCode2,
  Github,
  Lightbulb,
  Loader2,
  Radar,
  RefreshCw,
  Rocket,
  ScanSearch,
  SearchCheck,
  ShieldCheck,
  Sparkles,
  TrendingUp,
  Undo2,
  UserRound,
  Vault,
  Wand2,
  X,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { toast } from 'sonner'
import { mistApi } from '@/lib/mist-api'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'
import { MonoBadge, StatusDot, relTime } from './shared'
import type {
  AutonomyEventRow,
  AutonomyStats,
  EvolutionChange,
  EvolutionListResponse,
  EvolutionProposal,
  HeartbeatStatus,
  LearningStatus,
  TrendDigest,
  WatchlistStatus,
} from '@/lib/types'

const KIND_STYLE: Record<string, string> = {
  fix: 'border-amber-400/30 bg-amber-400/10 text-amber-300',
  feature: 'border-purple-400/30 bg-purple-400/10 text-purple-300',
  suggestion: 'border-teal-400/30 bg-teal-400/10 text-teal-300',
}

const STATUS_STYLE: Record<string, { chip: string; dot: string }> = {
  pending: { chip: 'border-amber-400/30 bg-amber-400/10 text-amber-300', dot: 'bg-amber-300' },
  applied: { chip: 'border-emerald-400/30 bg-emerald-400/10 text-emerald-300', dot: 'bg-emerald-300' },
  rolled_back: { chip: 'border-rose-400/30 bg-rose-400/10 text-rose-300', dot: 'bg-rose-300' },
  rejected: { chip: 'border-slate-400/30 bg-slate-400/10 text-slate-400', dot: 'bg-slate-400' },
  failed: { chip: 'border-rose-400/30 bg-rose-400/10 text-rose-300', dot: 'bg-rose-300' },
}

// v5 autonomy ledger — every self-directed act M.I.S.T. takes is logged
const AUTONOMY_ICONS: Record<string, LucideIcon> = {
  skill_created: Sparkles,
  skill_refined: Wand2,
  memory_curated: Brain,
  user_model_updated: UserRound,
  self_review: ScanSearch,
  trend_digest: TrendingUp,
  upgrade_proposed: Rocket,
  cron_run: AlarmClock,
  vault_event: Vault,
}

const AUTONOMY_COLORS: Record<string, string> = {
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

function ChangePreview({ change }: { change: EvolutionChange }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="rounded-lg border border-white/5 bg-white/[0.02]">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-2.5 py-2 text-left"
      >
        <FileCode2 aria-hidden className="h-3 w-3 shrink-0 text-slate-500" />
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-slate-300">{change.path}</span>
        <span
          className={cn(
            'shrink-0 rounded border px-1.5 py-0.5 font-mono text-[9px] uppercase',
            change.action === 'create' ? 'border-teal-400/30 text-teal-300' : 'border-purple-400/30 text-purple-300'
          )}
        >
          {change.action}
        </span>
        <ChevronDown
          aria-hidden
          className={cn('h-3.5 w-3.5 shrink-0 text-slate-500 transition-transform', open && 'rotate-180')}
        />
      </button>
      {open ? (
        <div className="space-y-2 border-t border-white/5 px-2.5 py-2">
          {change.note ? <p className="text-[10px] text-slate-500">{change.note}</p> : null}
          {change.action === 'patch' && change.find ? (
            <div>
              <p className="mb-1 font-mono text-[9px] uppercase tracking-wider text-rose-300/70">find</p>
              <pre className="mist-scroll max-h-32 overflow-auto rounded bg-rose-950/20 p-2 font-mono text-[10px] leading-relaxed text-slate-400">
                {change.find}
              </pre>
            </div>
          ) : null}
          <div>
            <p className="mb-1 font-mono text-[9px] uppercase tracking-wider text-emerald-300/70">
              {change.action === 'patch' ? 'replace with' : 'file content'}
            </p>
            <pre className="mist-scroll max-h-40 overflow-auto rounded bg-emerald-950/20 p-2 font-mono text-[10px] leading-relaxed text-slate-400">
              {change.content ?? ''}
            </pre>
          </div>
        </div>
      ) : null}
    </div>
  )
}

function ProposalCard({
  proposal,
  busy,
  onDevelop,
  onApprove,
  onReject,
}: {
  proposal: EvolutionProposal
  busy: string | null
  onDevelop: (id: string) => void
  onApprove: (id: string) => void
  onReject: (id: string) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const status = STATUS_STYLE[proposal.status] ?? STATUS_STYLE.pending
  const isPending = proposal.status === 'pending'
  const rowBusy = busy === proposal.id

  return (
    <article className="mist-glass-soft rounded-xl p-3.5">
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <span
            className={cn(
              'rounded-full border px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wide',
              KIND_STYLE[proposal.kind] ?? KIND_STYLE.suggestion
            )}
          >
            {proposal.kind}
          </span>
          <MonoBadge>{proposal.origin}</MonoBadge>
        </div>
        <span
          className={cn(
            'inline-flex shrink-0 items-center gap-1 rounded-full border px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wide',
            status.chip
          )}
        >
          <StatusDot className={status.dot} pulse={isPending} />
          {proposal.status.replace('_', '-')}
        </span>
      </div>

      <h4 className="mt-2 text-sm font-medium text-slate-200">{proposal.title}</h4>
      <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-slate-400">{proposal.summary}</p>

      <button
        type="button"
        onClick={() => setExpanded((e) => !e)}
        aria-expanded={expanded}
        className="mt-2 inline-flex items-center gap-1 font-mono text-[10px] text-slate-500 transition-colors hover:text-slate-300"
      >
        <ChevronDown aria-hidden className={cn('h-3 w-3 transition-transform', expanded && 'rotate-180')} />
        {expanded ? 'hide details' : proposal.changes.length > 0 ? `${proposal.changes.length} change(s) · details` : 'details'}
      </button>

      {expanded ? (
        <div className="mt-2 space-y-2">
          <p className="whitespace-pre-wrap text-[11px] leading-relaxed text-slate-500">{proposal.rationale}</p>
          {proposal.target_files.length > 0 ? (
            <p className="font-mono text-[10px] text-slate-500">targets: {proposal.target_files.join(', ')}</p>
          ) : null}
          {proposal.changes.length > 0 ? (
            <div className="space-y-1.5">
              {proposal.changes.map((c, i) => (
                <ChangePreview key={`${c.path}-${i}`} change={c} />
              ))}
            </div>
          ) : null}
          {proposal.lint_output ? (
            <details className="rounded-lg border border-white/5 bg-white/[0.02] p-2">
              <summary className="cursor-pointer font-mono text-[10px] text-slate-500">lint output</summary>
              <pre className="mist-scroll mt-1.5 max-h-40 overflow-auto font-mono text-[10px] leading-relaxed text-slate-500">
                {proposal.lint_output.slice(-3000)}
              </pre>
            </details>
          ) : null}
          {proposal.error ? (
            <p className="rounded-lg border border-rose-400/20 bg-rose-400/5 p-2 text-[10px] leading-relaxed text-rose-300/80">
              {proposal.error}
            </p>
          ) : null}
        </div>
      ) : null}

      {isPending ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {proposal.changes.length === 0 ? (
            <Button
              type="button"
              size="sm"
              disabled={rowBusy}
              onClick={() => onDevelop(proposal.id)}
              className="h-7 gap-1.5 bg-teal-400/90 px-2.5 font-mono text-[10px] text-slate-950 hover:bg-teal-300"
            >
              {rowBusy ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> : <FileCode2 className="h-3 w-3" aria-hidden />}
              Develop
            </Button>
          ) : null}
          <Button
            type="button"
            size="sm"
            disabled={rowBusy || proposal.changes.length === 0}
            onClick={() => onApprove(proposal.id)}
            className="h-7 gap-1.5 bg-emerald-400/90 px-2.5 font-mono text-[10px] text-slate-950 hover:bg-emerald-300"
          >
            {rowBusy ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> : <Check className="h-3 w-3" aria-hidden />}
            Approve &amp; apply
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={rowBusy}
            onClick={() => onReject(proposal.id)}
            className="h-7 gap-1.5 border-white/10 px-2.5 font-mono text-[10px] text-slate-400 hover:bg-white/5 hover:text-slate-200"
          >
            <X className="h-3 w-3" aria-hidden />
            Reject
          </Button>
        </div>
      ) : (
        <p className="mt-2.5 font-mono text-[9px] text-slate-500">
          {proposal.applied_at
            ? `applied ${relTime(proposal.applied_at)}`
            : `updated ${relTime(proposal.updated_at)}`}
          {proposal.status === 'rolled_back' ? ' · auto-rollback kept the dev server healthy' : ''}
        </p>
      )}
    </article>
  )
}

export function EvolutionTab() {
  const [data, setData] = useState<EvolutionListResponse | null>(null)
  const [loadError, setLoadError] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [actionBusy, setActionBusy] = useState<'scan' | 'suggest' | 'claw' | 'watch' | null>(null)
  const [reloadKey, setReloadKey] = useState(0)
  const [watchlist, setWatchlist] = useState<WatchlistStatus | null>(null)
  const [heartbeat, setHeartbeat] = useState<HeartbeatStatus | null>(null)
  // v5 autonomy · trends · learning
  const [autonomy, setAutonomy] = useState<{ events: AutonomyEventRow[]; stats: AutonomyStats } | null>(null)
  const [ledgerKey, setLedgerKey] = useState(0)
  const [digest, setDigest] = useState<TrendDigest | null>(null)
  const [learning, setLearning] = useState<LearningStatus | null>(null)
  const [trendBusy, setTrendBusy] = useState<'digest' | 'upgrade' | null>(null)
  const [learnBusy, setLearnBusy] = useState<'curate' | 'rebuild' | null>(null)

  const reload = useCallback(() => {
    let alive = true
    setData(null)
    setLoadError(false)
    mistApi.evolution
      .list()
      .then((r) => {
        if (alive) setData(r)
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
  }, [reload, reloadKey])

  // watchlist + heartbeat freshness (v4)
  useEffect(() => {
    let alive = true
    mistApi.watchlist
      .status()
      .then((w) => {
        if (alive) setWatchlist(w)
      })
      .catch(() => undefined)
    mistApi.alerts
      .list()
      .then((a) => {
        if (alive) setHeartbeat(a.heartbeat)
      })
      .catch(() => undefined)
    // v5 — last trend digest + learning status
    mistApi.trends
      .get()
      .then((t) => {
        if (alive) setDigest(t.last)
      })
      .catch(() => undefined)
    mistApi.learning
      .status()
      .then((l) => {
        if (alive) setLearning(l.status)
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [reloadKey])

  // v5 autonomy ledger (own key so the refresh button can pull it alone)
  useEffect(() => {
    let alive = true
    mistApi.autonomy
      .list(30)
      .then((r) => {
        if (alive) setAutonomy(r)
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [ledgerKey, reloadKey])

  const withBusy = async (key: string, fn: () => Promise<string>) => {
    setBusy(key)
    try {
      const message = await fn()
      toast.success(message)
      reload()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'request failed')
    } finally {
      setBusy(null)
    }
  }

  const onScan = () => {
    setActionBusy('scan')
    mistApi.evolution
      .scan()
      .then((r) => {
        if (r.issues.length === 0 || !r.proposal) toast.info(r.message)
        else toast.success(r.message)
        reload()
      })
      .catch(() => toast.error('Self-audit failed'))
      .finally(() => setActionBusy(null))
  }

  const onSuggest = (origin: 'self-idea' | 'openclaw') => {
    setActionBusy('suggest')
    mistApi.evolution
      .suggest(origin)
      .then((r) => {
        if (r.proposals.length === 0) toast.info(r.message)
        else toast.success(r.message)
        reload()
      })
      .catch(() => toast.error('Feature ideation failed'))
      .finally(() => setActionBusy(null))
  }

  const onClawSync = () => {
    setActionBusy('claw')
    mistApi.evolution
      .openclawSync()
      .then((r) => {
        toast.success(r.sync.message)
        reload()
      })
      .catch(() => toast.error('OpenClaw sync failed'))
      .finally(() => setActionBusy(null))
  }

  const onWatchSweep = () => {
    setActionBusy('watch')
    mistApi.watchlist
      .sync()
      .then((r) => {
        if (r.sweep.changed > 0) toast.success(r.sweep.message)
        else toast.info(r.sweep.message)
        setWatchlist(r.watchlist)
      })
      .catch(() => toast.error('Watchlist sweep failed'))
      .finally(() => setActionBusy(null))
  }

  // v5 trends — live-web digest (30–40s)
  const onTrendDigest = () => {
    setTrendBusy('digest')
    mistApi.trends
      .digest()
      .then((r) => {
        setDigest(r.digest)
        toast.success('Trend digest ready', { description: r.digest.headline, duration: 6000 })
        setLedgerKey((k) => k + 1)
      })
      .catch((e) => toast.error(e instanceof Error ? e.message : 'Trend scan failed'))
      .finally(() => setTrendBusy(null))
  }

  // v5 self-upgrade — digest + gap analysis → new proposals/skills (30–60s)
  const onUpgradeScan = () => {
    setTrendBusy('upgrade')
    mistApi.trends
      .upgrade()
      .then((r) => {
        toast.success('Self-upgrade scan complete', { description: r.result.summary, duration: 8000 })
        setDigest(r.result.digest)
        reload() // new EvolutionProposals may have appeared below
        setLedgerKey((k) => k + 1)
      })
      .catch((e) => toast.error(e instanceof Error ? e.message : 'Upgrade scan failed'))
      .finally(() => setTrendBusy(null))
  }

  const onCurate = () => {
    setLearnBusy('curate')
    mistApi.learning
      .curate()
      .then((r) => {
        toast.success(
          r.result.factsLearned > 0
            ? `Curated — ${r.result.factsLearned} fact${r.result.factsLearned === 1 ? '' : 's'} learned`
            : 'Memory curated — nothing new worth keeping',
          { description: r.result.notes }
        )
        mistApi.learning
          .status()
          .then((l) => setLearning(l.status))
          .catch(() => undefined)
        setLedgerKey((k) => k + 1)
      })
      .catch((e) => toast.error(e instanceof Error ? e.message : 'Curation failed'))
      .finally(() => setLearnBusy(null))
  }

  const onRebuildModel = () => {
    setLearnBusy('rebuild')
    mistApi.learning
      .rebuildUserModel()
      .then((r) => {
        toast.success('User model rebuilt', {
          description: r.result.length > 180 ? `${r.result.slice(0, 180)}…` : r.result,
          duration: 7000,
        })
        mistApi.learning
          .status()
          .then((l) => setLearning(l.status))
          .catch(() => undefined)
        setLedgerKey((k) => k + 1)
      })
      .catch((e) => toast.error(e instanceof Error ? e.message : 'Rebuild failed'))
      .finally(() => setLearnBusy(null))
  }

  const oc = data?.openclaw

  return (
    <div className="space-y-4">
      {/* header */}
      <section aria-labelledby="evolution-heading">
        <div className="mb-2 flex items-center justify-between">
          <h3
            id="evolution-heading"
            className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.25em] text-slate-500"
          >
            <Dna aria-hidden className="h-3.5 w-3.5" />
            self-evolution · mist codes itself
          </h3>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Reload evolution state"
            onClick={() => setReloadKey((k) => k + 1)}
            className="h-7 w-7 rounded-lg text-slate-500 hover:bg-white/5 hover:text-slate-300"
          >
            <RefreshCw aria-hidden className="h-3.5 w-3.5" />
          </Button>
        </div>

        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            size="sm"
            disabled={actionBusy !== null}
            onClick={onScan}
            className="h-8 gap-1.5 bg-purple-400/90 px-3 font-mono text-[11px] text-slate-950 hover:bg-purple-300"
          >
            {actionBusy === 'scan' ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <SearchCheck className="h-3.5 w-3.5" aria-hidden />}
            Scan for issues
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={actionBusy !== null}
            onClick={() => onSuggest('self-idea')}
            className="h-8 gap-1.5 bg-purple-400/90 px-3 font-mono text-[11px] text-slate-950 hover:bg-purple-300"
          >
            {actionBusy === 'suggest' ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <Lightbulb className="h-3.5 w-3.5" aria-hidden />}
            Suggest features
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={actionBusy !== null}
            onClick={() => onSuggest('openclaw')}
            className="h-8 gap-1.5 border-white/10 px-3 font-mono text-[11px] text-slate-300 hover:bg-white/5"
          >
            {actionBusy === 'suggest' ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <Github className="h-3.5 w-3.5" aria-hidden />}
            OpenClaw-inspired
          </Button>
        </div>
        <p className="mt-2 font-mono text-[10px] leading-relaxed text-slate-500">
          {data
            ? `auto-suggest every ${data.auto?.suggest_interval_hours ?? '?'}h · ${data.stats?.total ?? 0} proposals lifetime · ${data.stats?.applied ?? 0} applied`
            : 'loading evolution state…'}
        </p>
      </section>

      {/* autonomy ledger (v5) */}
      <section aria-labelledby="autonomy-heading" className="mist-glass-soft rounded-xl p-3.5">
        <div className="flex items-start justify-between gap-2">
          <h3 id="autonomy-heading" className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.25em] text-slate-500">
            <Activity aria-hidden className="h-3.5 w-3.5" />
            autonomy ledger
          </h3>
          <Button
            type="button"
            size="sm"
            variant="outline"
            aria-label="Refresh autonomy ledger"
            onClick={() => setLedgerKey((k) => k + 1)}
            className="h-7 gap-1.5 border-white/10 px-2.5 font-mono text-[10px] text-slate-300 hover:bg-white/5"
          >
            <RefreshCw aria-hidden className="h-3 w-3" />
            Refresh
          </Button>
        </div>

        <div className="mt-2.5 flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[10px] text-slate-500">
          <span className="text-slate-400">{autonomy ? autonomy.stats.total : '…'} actions</span>
          <span aria-hidden>·</span>
          <span>{autonomy ? `${autonomy.stats.last24h} in 24h` : '…'}</span>
          {autonomy
            ? Object.entries(autonomy.stats.byType)
                .sort((a, b) => b[1] - a[1])
                .slice(0, 5)
                .map(([type, n]) => (
                  <MonoBadge key={type} className="border-white/10 text-slate-400" title={`${n} total`}>
                    {type.replace(/_/g, ' ')} ×{n}
                  </MonoBadge>
                ))
            : null}
        </div>

        <div className="mist-scroll mt-2.5 max-h-64 space-y-1.5 overflow-y-auto pr-1">
          {autonomy === null ? (
            <p className="py-2 font-mono text-[10px] text-slate-500">reading the ledger…</p>
          ) : autonomy.events.length === 0 ? (
            <p className="py-2 font-mono text-[10px] leading-relaxed text-slate-500">
              nothing yet — every self-directed act (skills learned, crons fired, vault moves, trend scans) is logged here
            </p>
          ) : (
            autonomy.events.map((e) => {
              const Icon = AUTONOMY_ICONS[e.type] ?? Activity
              return (
                <div
                  key={e.id}
                  className="flex items-start gap-2 rounded-lg border border-white/5 bg-white/[0.02] px-2.5 py-1.5"
                  title={e.meta || undefined}
                >
                  <Icon aria-hidden className={cn('mt-0.5 h-3.5 w-3.5 shrink-0', AUTONOMY_COLORS[e.type] ?? 'text-slate-400')} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[11px] leading-snug text-slate-300">{e.summary}</p>
                    <p className="mt-0.5 font-mono text-[9px] text-slate-500">
                      {e.type.replace(/_/g, ' ')} · {relTime(e.createdAt)}
                    </p>
                  </div>
                </div>
              )
            })
          )}
        </div>
      </section>

      {/* trends (v5) */}
      <section aria-labelledby="trends-heading" className="mist-glass-soft rounded-xl p-3.5">
        <div className="flex items-start justify-between gap-2">
          <h3 id="trends-heading" className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.25em] text-slate-500">
            <TrendingUp aria-hidden className="h-3.5 w-3.5" />
            trends · world pulse
          </h3>
          <div className="flex shrink-0 flex-wrap justify-end gap-1.5">
            <Button
              type="button"
              size="sm"
              disabled={trendBusy !== null}
              onClick={onTrendDigest}
              className="h-7 gap-1.5 bg-purple-400/90 px-2.5 font-mono text-[10px] text-slate-950 hover:bg-purple-300"
            >
              {trendBusy === 'digest' ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> : <TrendingUp className="h-3 w-3" aria-hidden />}
              Scan now
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={trendBusy !== null}
              onClick={onUpgradeScan}
              className="h-7 gap-1.5 border-white/10 px-2.5 font-mono text-[10px] text-slate-300 hover:bg-white/5"
            >
              {trendBusy === 'upgrade' ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> : <Rocket className="h-3 w-3" aria-hidden />}
              Self-upgrade scan
            </Button>
          </div>
        </div>

        {digest === null ? (
          <p className="mt-2.5 font-mono text-[10px] leading-relaxed text-slate-500">
            no digest yet — run a scan and M.I.S.T. reads the live web over your watchlist + evergreen angles (~30–40s)
          </p>
        ) : (
          <>
            <p className="mt-2.5 text-xs leading-relaxed text-slate-300">{digest.headline}</p>
            <p className="mt-1 font-mono text-[9px] text-slate-500">
              generated {relTime(digest.generatedAt)} · {digest.watchlist.length} watch topic{digest.watchlist.length === 1 ? '' : 's'}
            </p>
            <div className="mt-2 space-y-1.5">
              {digest.items.slice(0, 5).map((it, i) => (
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
                  <p className="mt-0.5 truncate font-mono text-[9px] text-slate-500">
                    {it.source}
                    {it.actionable ? ' · actionable' : ''}
                  </p>
                </div>
              ))}
            </div>
          </>
        )}
        <p className="mt-2 font-mono text-[9px] leading-relaxed text-slate-500">
          scans take 30–60s (live web) · digests feed the self-upgrade cycle — new proposals land in the list below, always approval-gated
        </p>
      </section>

      {/* learning loop (v5) */}
      <section aria-labelledby="learning-heading" className="mist-glass-soft rounded-xl p-3.5">
        <div className="flex items-start justify-between gap-2">
          <h3 id="learning-heading" className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.25em] text-slate-500">
            <Brain aria-hidden className="h-3.5 w-3.5" />
            learning loop
          </h3>
          <div className="flex shrink-0 flex-wrap justify-end gap-1.5">
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={learnBusy !== null}
              onClick={onCurate}
              className="h-7 gap-1.5 border-teal-400/25 bg-teal-400/10 px-2.5 font-mono text-[10px] text-teal-300 hover:border-teal-400/40 hover:bg-teal-400/15 hover:text-teal-200"
            >
              {learnBusy === 'curate' ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> : <Brain className="h-3 w-3" aria-hidden />}
              Curate memory now
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={learnBusy !== null}
              onClick={onRebuildModel}
              className="h-7 gap-1.5 border-emerald-400/25 bg-emerald-400/10 px-2.5 font-mono text-[10px] text-emerald-300 hover:border-emerald-400/40 hover:bg-emerald-400/15 hover:text-emerald-200"
            >
              {learnBusy === 'rebuild' ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> : <UserRound className="h-3 w-3" aria-hidden />}
              Rebuild user model
            </Button>
          </div>
        </div>

        <div className="mt-2.5 grid grid-cols-3 gap-2 text-center">
          {[
            { label: 'AUTO SKILLS', value: learning ? `${learning.autoSkills}` : null },
            { label: 'LAST CURATION', value: learning ? (learning.lastCuration ? relTime(learning.lastCuration) : 'never') : null },
            { label: 'USER MODEL', value: learning ? (learning.lastUserModel ? relTime(learning.lastUserModel) : 'never') : null },
          ].map((s) => (
            <div key={s.label} className="rounded-lg border border-white/5 bg-white/[0.02] px-1 py-2">
              <div className="truncate font-mono text-xs tabular-nums text-purple-300">
                {s.value ?? <Skeleton className="mx-auto h-4 w-10 bg-white/5" />}
              </div>
              <div className="mt-0.5 font-mono text-[8px] uppercase tracking-[0.15em] text-slate-500">{s.label}</div>
            </div>
          ))}
        </div>
        <p className="mt-2 line-clamp-2 text-[10px] italic leading-relaxed text-slate-500">
          {learning?.userModelPreview || 'user model not built yet — chat a while, then rebuild it'}
        </p>
        <p className="mt-1.5 font-mono text-[9px] leading-relaxed text-slate-500">
          M.I.S.T. distills durable facts from your chats, learns skills from repeated tool use, and keeps a model of who you
          are — automatically, capped and never write-gated.
        </p>
      </section>

      {/* openclaw watchtower */}
      <section aria-labelledby="openclaw-heading" className="mist-glass-soft rounded-xl p-3.5">
        <div className="flex items-start justify-between gap-2">
          <h3 id="openclaw-heading" className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.25em] text-slate-500">
            <Github aria-hidden className="h-3.5 w-3.5" />
            openclaw watchtower
          </h3>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={actionBusy === 'claw'}
            onClick={onClawSync}
            className="h-7 gap-1.5 border-white/10 px-2.5 font-mono text-[10px] text-slate-300 hover:bg-white/5"
          >
            {actionBusy === 'claw' ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> : <RefreshCw className="h-3 w-3" aria-hidden />}
            Check &amp; update
          </Button>
        </div>
        <div className="mt-2.5 grid grid-cols-2 gap-x-4 gap-y-1.5 font-mono text-[10px] text-slate-500">
          <p>
            upstream: <span className="text-slate-300">{oc?.latest_version ?? 'unknown'}</span>
          </p>
          <p>
            auto-update: <span className={oc?.auto_update ? 'text-emerald-300' : 'text-slate-400'}>{oc?.auto_update ? 'on · 12h' : 'off'}</span>
          </p>
          <p>
            checked: <span className="text-slate-300">{oc?.checked_at ? relTime(oc.checked_at) : 'never'}</span>
          </p>
          <p>
            releases seen: <span className="text-slate-300">{oc?.history_count ?? 0}</span>
          </p>
        </div>
        {oc?.head_summary ? (
          <p className="mt-2 line-clamp-3 text-[10px] leading-relaxed text-slate-500">
            <span className="text-slate-400">latest release:</span> {oc.head_summary}
          </p>
        ) : null}
        <p className="mt-2 font-mono text-[9px] leading-relaxed text-slate-500">
          MIST studies OpenClaw&apos;s releases for ideas and keeps its digest fresh automatically — no rusty foundations.
        </p>
      </section>

      {/* watchlist — anti-rust freshness (v4) */}
      <section aria-labelledby="watchlist-heading" className="mist-glass-soft rounded-xl p-3.5">
        <div className="flex items-start justify-between gap-2">
          <h3
            id="watchlist-heading"
            className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.25em] text-slate-500"
          >
            <Radar aria-hidden className="h-3.5 w-3.5" />
            watchlist · anti-rust
          </h3>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={actionBusy !== null}
            onClick={onWatchSweep}
            className="h-7 gap-1.5 border-white/10 px-2.5 font-mono text-[10px] text-slate-300 hover:bg-white/5"
          >
            {actionBusy === 'watch' ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> : <Radar className="h-3 w-3" aria-hidden />}
            Sweep now
          </Button>
        </div>
        <div className="mt-2.5 space-y-1.5">
          {watchlist === null ? (
            <p className="font-mono text-[10px] text-slate-500">loading watchlist…</p>
          ) : (
            watchlist.entries.map((e) => (
              <div
                key={e.repo}
                className="flex items-center justify-between gap-2 rounded-lg border border-white/5 bg-white/[0.02] px-2.5 py-1.5"
              >
                <div className="min-w-0">
                  <p className="truncate font-mono text-[10px] text-slate-300">{e.repo}</p>
                  <p className="truncate font-mono text-[9px] text-slate-500">
                    {e.version_label ?? e.version ?? 'not checked yet'} · {e.channel}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  {e.error ? <span className="font-mono text-[9px] text-rose-300/80">unreachable</span> : null}
                  {e.first_seen ? (
                    <span className="rounded border border-slate-400/20 px-1 py-0.5 font-mono text-[8px] uppercase text-slate-500">baseline</span>
                  ) : null}
                  {e.changed ? (
                    <span className="rounded border border-amber-400/30 bg-amber-400/10 px-1 py-0.5 font-mono text-[8px] uppercase text-amber-300">moved</span>
                  ) : null}
                  <span className="font-mono text-[9px] text-slate-500">{e.checked_at ? relTime(e.checked_at) : '—'}</span>
                </div>
              </div>
            ))
          )}
        </div>
        <p className="mt-2 font-mono text-[9px] leading-relaxed text-slate-500">
          swept every {watchlist?.sweep_interval_hours ?? 6}h + on demand · releases raise 📦 alerts in the chat · first sighting is a silent baseline
          {heartbeat ? ` · heartbeat ${heartbeat.beating ? 'live' : 'idle'} · ${heartbeat.reminders_fired} reminder(s) fired` : ''}
        </p>
      </section>

      {/* policy */}
      <section aria-labelledby="evolution-policy-heading" className="mist-glass-soft rounded-xl p-3.5">
        <h3 id="evolution-policy-heading" className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.25em] text-slate-500">
          <ShieldCheck aria-hidden className="h-3.5 w-3.5" />
          deterministic policy
        </h3>
        <ul className="mt-2 space-y-1 font-mono text-[10px] leading-relaxed text-slate-500">
          <li>writes confined to src/ · mini-services/ · db/skills/ · db/notes/</li>
          <li>.env · package.json · prisma/ · configs are hard-blocked</li>
          <li>nothing self-applies — you approve every change</li>
          <li className="flex items-center gap-1.5">
            <Undo2 aria-hidden className="h-3 w-3 text-rose-300/70" />
            lint gate with automatic rollback keeps the dev server healthy
          </li>
        </ul>
      </section>

      {/* proposals */}
      <section aria-labelledby="evolution-proposals-heading">
        <h3
          id="evolution-proposals-heading"
          className="mb-2 font-mono text-[10px] uppercase tracking-[0.25em] text-slate-500"
        >
          proposals {data ? `(${data.stats?.pending ?? 0} pending)` : ''}
        </h3>

        {data === null && !loadError ? (
          <div className="space-y-2" aria-hidden>
            {[0, 1].map((i) => (
              <Skeleton key={i} className="h-28 w-full rounded-xl bg-white/5" />
            ))}
          </div>
        ) : loadError ? (
          <div className="mist-glass-soft rounded-xl p-4 text-center">
            <p className="text-xs text-slate-400">Evolution engine unreachable.</p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setReloadKey((k) => k + 1)}
              className="mt-2"
            >
              Retry
            </Button>
          </div>
        ) : (data?.proposals.length ?? 0) === 0 ? (
          <div className="mist-glass-soft rounded-xl p-4 text-center">
            <p className="text-xs text-slate-400">No proposals yet.</p>
            <p className="mt-1 font-mono text-[10px] text-slate-500">
              Run a scan, ask for feature ideas, or just chat — MIST also proposes improvements on its own.
            </p>
          </div>
        ) : (
          <div className="mist-scroll max-h-96 space-y-2.5 overflow-y-auto pr-1">
            {data?.proposals.map((p) => (
              <ProposalCard
                key={p.id}
                proposal={p}
                busy={busy}
                onDevelop={(id) =>
                  void withBusy(id, async () => {
                    const r = await mistApi.evolution.develop(id)
                    return r.message
                  })
                }
                onApprove={(id) =>
                  void withBusy(id, async () => {
                    const r = await mistApi.evolution.approve(id)
                    return r.message
                  })
                }
                onReject={(id) =>
                  void withBusy(id, async () => {
                    const r = await mistApi.evolution.reject(id)
                    return r.message
                  })
                }
              />
            ))}
          </div>
        )}
      </section>
    </div>
  )
}
