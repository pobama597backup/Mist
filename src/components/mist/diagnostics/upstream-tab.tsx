'use client'

// UpstreamTab — Clare's automatic self-update surface (the creator's personal
// order). The OpenJarvis upstream watch: live status, on-demand sweep with an
// honest delta report, the port map, and the absorption history with gated
// Apply buttons. Nothing applies without approval unless auto_patch is on.

import { useCallback, useEffect, useState } from 'react'
import {
  BookOpen,
  CheckCircle2,
  ChevronDown,
  Eye,
  FileCode2,
  GitBranch,
  GitCommitHorizontal,
  GraduationCap,
  Layers,
  Loader2,
  Mail,
  Radar,
  RefreshCw,
  Settings2,
  ShieldCheck,
  TriangleAlert,
  Wand2,
} from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'
import {
  ojApi,
  type MarkLvSyncStatus,
  type OjPortMapModule,
  type OjSyncCheckResponse,
  type OjSyncHistoryEntry,
  type OjSyncStatus,
  type OjSyncStatusResponse,
  type TeacherNoticeInfo,
  type TeacherNoticePreviewResponse,
} from '@/lib/oj/lab-api'
import { MonoBadge, SectionLabel, StatusDot, relTime } from './shared'

// ---------- helpers ----------

function shortSha(sha: string | null | undefined, len = 7): string {
  if (!sha) return '—'
  return sha.slice(0, len)
}

function untilTime(iso: string | null | undefined): string {
  if (!iso) return '—'
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return '—'
  const s = Math.max(0, Math.floor((t - Date.now()) / 1000))
  if (s < 60) return `in ${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `in ${m}m`
  const h = Math.floor(m / 60)
  if (h < 48) return `in ${h}h`
  return `in ${Math.floor(h / 24)}d`
}

/** Her notes may carry light markdown (the chat renders it) — the tab shows
 *  plain text, so emphasis markers are stripped for display only. */
function plainNote(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
}

const MODULE_TIER_STYLE: Record<string, string> = {
  structural: 'border-purple-400/30 bg-purple-400/10 text-purple-300',
  knowledge: 'border-emerald-400/30 bg-emerald-400/10 text-emerald-300',
  excluded: 'border-white/10 bg-white/5 text-slate-500',
}

// ---------- small stat cell ----------

function StatCell({ label, value, title }: { label: string; value: string; title?: string }) {
  return (
    <div className="rounded-lg border border-white/5 bg-white/[0.02] px-2.5 py-2" title={title}>
      <p className="font-mono text-[9px] uppercase tracking-widest text-slate-600">{label}</p>
      <p className="mt-0.5 truncate font-mono text-xs tabular-nums text-slate-200">{value}</p>
    </div>
  )
}

// ---------- history event card ----------

function HistoryCard({
  entry,
  applying,
  onApply,
}: {
  entry: OjSyncHistoryEntry
  applying: string | null
  onApply: (proposalId: string) => void
}) {
  const [briefOpen, setBriefOpen] = useState(false)
  const failed = Boolean(entry.error)
  return (
    <article className="mist-glass-soft rounded-xl p-3">
      <div className="flex flex-wrap items-center gap-1.5">
        <GitCommitHorizontal aria-hidden className="h-3.5 w-3.5 shrink-0 text-purple-300" />
        <span className="font-mono text-[11px] text-slate-200" title={new Date(entry.at).toISOString()}>
          {relTime(entry.at)}
        </span>
        <MonoBadge className="border-white/10 font-mono text-slate-400">
          {shortSha(entry.old_head)} → {shortSha(entry.new_head)}
        </MonoBadge>
        {entry.merged ? (
          <MonoBadge className="border-teal-400/30 text-teal-300">merged</MonoBadge>
        ) : null}
        {entry.pending_knowledge ? (
          <MonoBadge className="border-amber-400/30 text-amber-300">knowledge pending</MonoBadge>
        ) : null}
        {failed ? (
          <MonoBadge className="border-rose-400/30 bg-rose-400/10 text-rose-300">error</MonoBadge>
        ) : null}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <MonoBadge className="border-white/10 text-slate-400">{entry.commits} commit{entry.commits === 1 ? '' : 's'}</MonoBadge>
        <MonoBadge className="border-white/10 text-slate-400">{entry.files} file{entry.files === 1 ? '' : 's'}</MonoBadge>
        {entry.tiers ? (
          <>
            <MonoBadge className="border-purple-400/30 text-purple-300">{entry.tiers.structural} structural</MonoBadge>
            <MonoBadge className="border-emerald-400/30 text-emerald-300">{entry.tiers.knowledge} knowledge</MonoBadge>
            <MonoBadge className="border-white/10 text-slate-500">{entry.tiers.excluded} excluded</MonoBadge>
            {entry.tiers.unknown > 0 ? (
              <MonoBadge className="border-amber-400/30 text-amber-300">{entry.tiers.unknown} unmapped</MonoBadge>
            ) : null}
          </>
        ) : null}
      </div>
      {failed ? (
        <p className="mt-2 rounded-lg bg-rose-950/20 px-2.5 py-1.5 font-mono text-[10px] leading-relaxed text-rose-300/90">
          {entry.error}
        </p>
      ) : null}
      {entry.brief ? (
        <div className="mt-2">
          <button
            type="button"
            onClick={() => setBriefOpen((o) => !o)}
            aria-expanded={briefOpen}
            className="flex w-full items-center gap-1.5 rounded-lg bg-white/[0.02] px-2.5 py-1.5 text-left transition-colors hover:bg-white/[0.05] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-400/60"
          >
            <span className={cn('min-w-0 flex-1 font-mono text-[10px] leading-relaxed text-slate-400', !briefOpen && 'line-clamp-2')}>
              {entry.brief}
            </span>
            <ChevronDown aria-hidden className={cn('h-3 w-3 shrink-0 text-slate-600 transition-transform', briefOpen && 'rotate-180')} />
          </button>
        </div>
      ) : null}
      {entry.proposals.length > 0 ? (
        <div className="mt-2 space-y-1.5">
          {entry.proposals.map((pid) => {
            const busy = applying === pid
            return (
              <div
                key={pid}
                className="flex items-center gap-2 rounded-lg border border-white/5 bg-white/[0.02] px-2.5 py-1.5"
              >
                <Wand2 aria-hidden className="h-3 w-3 shrink-0 text-fuchsia-300" />
                <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-slate-400">{pid}</span>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={() => onApply(pid)}
                  className="h-6 shrink-0 border-white/10 bg-white/5 px-2 font-mono text-[9px] uppercase tracking-widest text-slate-300 hover:border-purple-400/40 hover:text-purple-200"
                  aria-label={`Apply proposal ${pid}`}
                >
                  {busy ? <Loader2 aria-hidden className="h-3 w-3 animate-spin" /> : <ShieldCheck aria-hidden className="h-3 w-3" />}
                  apply
                </Button>
              </div>
            )
          })}
        </div>
      ) : null}
    </article>
  )
}

// ---------- mapping module card ----------

function ModuleCard({ module }: { module: OjPortMapModule }) {
  const tierStyle = MODULE_TIER_STYLE[module.tier] ?? MODULE_TIER_STYLE.excluded
  return (
    <div className="mist-glass-soft mist-glass-hover p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="min-w-0 truncate font-mono text-xs text-slate-200">{module.module}</span>
        <span className={cn('shrink-0 rounded-full border px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wide', tierStyle)}>
          {module.tier}
        </span>
      </div>
      <p className="mt-1 font-mono text-[10px] text-slate-500">
        → {module.targets} target file{module.targets === 1 ? '' : 's'} in M.I.S.T.
      </p>
      <div className="mt-2 flex flex-wrap gap-1">
        {module.prefixes.map((p) => (
          <span
            key={p}
            className="rounded border border-white/10 bg-white/[0.02] px-1 py-0.5 font-mono text-[9px] text-slate-500"
            title={`upstream prefix → ${module.module}`}
          >
            {p}
          </span>
        ))}
      </div>
    </div>
  )
}

// ---------- Mark-LV card (mlv-rust-3 — the teacher's assistant anti-rust watch) ----------

const MARK_LV_STATUS_STYLE: Record<MarkLvSyncStatus['status'], string> = {
  watching: 'border-emerald-400/30 bg-emerald-400/10 text-emerald-300',
  updated: 'border-teal-400/30 bg-teal-400/10 text-teal-300',
  diverged: 'border-amber-400/30 bg-amber-400/10 text-amber-300',
  error: 'border-rose-400/30 bg-rose-400/10 text-rose-300',
}

function MarkLvCard({ mlv, onChecked }: { mlv: MarkLvSyncStatus | null; onChecked: () => Promise<void> | void }) {
  const [checking, setChecking] = useState(false)
  const [digestOpen, setDigestOpen] = useState(false)

  const runCheck = async () => {
    setChecking(true)
    try {
      const res = await ojApi.markLv.check()
      if (!res.ok) {
        toast.error(`Mark-LV check — ${res.message}`)
      } else if (res.changed) {
        toast.success(`Mark-LV moved to ${shortSha(res.head)} — absorbed as knowledge`)
      } else {
        toast.info(res.message)
      }
      await onChecked()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Mark-LV check failed')
    } finally {
      setChecking(false)
    }
  }

  // honest fallback: the route should always send mark_lv — if it is absent
  // (older shape / partial failure) say so, never fake a status
  if (!mlv) {
    return (
      <section className="mist-glass rounded-xl p-3.5" aria-label="Mark-LV watch status">
        <div className="flex flex-wrap items-center gap-2">
          <GraduationCap aria-hidden className="h-4 w-4 shrink-0 text-amber-300" />
          <span className="min-w-0 flex-1 truncate font-mono text-xs text-slate-200">FatihMakes/Mark-LV</span>
          <span className="inline-flex shrink-0 items-center gap-1.5 font-mono text-[10px] text-slate-400">
            <StatusDot className="bg-slate-500" />
            not reported
          </span>
        </div>
        <p className="mt-2 font-mono text-[10px] text-slate-600">
          the watch did not report a status yet — try checking now
        </p>
        <div className="mt-3">
          <Button
            onClick={runCheck}
            disabled={checking}
            className="h-8 border border-amber-400/30 bg-amber-400/15 px-3 font-mono text-[10px] uppercase tracking-widest text-amber-200 hover:bg-amber-400/25"
            aria-label="Check the Mark-LV repo for new commits now"
          >
            {checking ? <Loader2 aria-hidden className="h-3 w-3 animate-spin" /> : <GraduationCap aria-hidden className="h-3 w-3" />}
            {checking ? 'scanning…' : 'check mark-lv now'}
          </Button>
        </div>
      </section>
    )
  }

  const lastAbsorbed = mlv.history.length > 0 ? mlv.history[mlv.history.length - 1] : null

  return (
    <section className="mist-glass p-3.5" aria-label="Mark-LV anti-rust watch status">
      <div className="flex flex-wrap items-center gap-2">
        <GraduationCap aria-hidden className="h-4 w-4 shrink-0 text-amber-300" />
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-slate-200" title={`${mlv.name} — ${mlv.url}`}>
          {mlv.repo}
        </span>
        <span
          className={cn(
            'shrink-0 rounded-full border px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wide',
            MARK_LV_STATUS_STYLE[mlv.status] ?? MARK_LV_STATUS_STYLE.error
          )}
          title={`anti-rust watch: ${mlv.status}`}
        >
          {mlv.status}
        </span>
      </div>

      {mlv.error ? (
        <p role="alert" className="mt-2.5 flex items-start gap-1.5 rounded-lg bg-rose-950/25 px-2.5 py-2 font-mono text-[10px] leading-relaxed text-rose-300/90">
          <TriangleAlert aria-hidden className="mt-0.5 h-3 w-3 shrink-0" />
          {mlv.error}
        </p>
      ) : null}

      {mlv.knowledge_pending ? (
        <p className="mt-2.5 flex items-start gap-1.5 rounded-lg bg-amber-950/25 px-2.5 py-2 font-mono text-[10px] leading-relaxed text-amber-300/90">
          <BookOpen aria-hidden className="mt-0.5 h-3 w-3 shrink-0" />
          knowledge absorption pending for {shortSha(mlv.head)} — the digest retries on the next scan
        </p>
      ) : null}

      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
        <StatCell label="upstream head" value={shortSha(mlv.head)} title={mlv.head ?? undefined} />
        <StatCell label="local clone" value={shortSha(mlv.local_head)} title={mlv.local_head ?? undefined} />
        <StatCell
          label="commits behind"
          value={mlv.commits_behind === null ? '—' : String(mlv.commits_behind)}
          title="clone vs origin/main at the last fetch (local count, no network)"
        />
        <StatCell label="interval" value={`every ${mlv.interval_min}m`} title="shares the upstream-watch interval" />
        <StatCell label="last scan" value={mlv.last_scan_at ? relTime(mlv.last_scan_at) : '—'} title={mlv.last_scan_at ?? undefined} />
        <StatCell label="last update" value={mlv.last_update_at ? relTime(mlv.last_update_at) : 'never'} title={mlv.last_update_at ?? undefined} />
      </div>

      {mlv.last_digest ? (
        <div className="mt-2">
          <button
            type="button"
            onClick={() => setDigestOpen((o) => !o)}
            aria-expanded={digestOpen}
            className="flex w-full items-center gap-1.5 rounded-lg bg-white/[0.02] px-2.5 py-1.5 text-left transition-colors hover:bg-white/[0.05] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60"
          >
            <span
              className={cn(
                'min-w-0 flex-1 font-mono text-[10px] leading-relaxed text-slate-400 whitespace-pre-wrap',
                !digestOpen && 'line-clamp-2'
              )}
            >
              {mlv.last_digest}
            </span>
            <ChevronDown aria-hidden className={cn('h-3 w-3 shrink-0 text-slate-600 transition-transform', digestOpen && 'rotate-180')} />
          </button>
        </div>
      ) : lastAbsorbed ? (
        <p className="mt-2 font-mono text-[10px] text-slate-500">
          last absorbed {lastAbsorbed.commits} commit{lastAbsorbed.commits === 1 ? '' : 's'} · {lastAbsorbed.filesChanged} file
          {lastAbsorbed.filesChanged === 1 ? '' : 's'} at {shortSha(lastAbsorbed.head)} {relTime(lastAbsorbed.at)}
        </p>
      ) : null}

      <p className="mt-2 font-mono text-[9px] leading-relaxed text-slate-600">
        knowledge-first absorption — her teacher&apos;s Python/PyQt desktop code is never auto-ported; every update becomes
        a knowledge digest she can cite.
      </p>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button
          onClick={runCheck}
          disabled={checking}
          className="h-8 border border-amber-400/30 bg-amber-400/15 px-3 font-mono text-[10px] uppercase tracking-widest text-amber-200 hover:bg-amber-400/25"
          aria-label="Check the Mark-LV repo for new commits now"
        >
          {checking ? <Loader2 aria-hidden className="h-3 w-3 animate-spin" /> : <GraduationCap aria-hidden className="h-3 w-3" />}
          {checking ? 'scanning…' : 'check mark-lv now'}
        </Button>
      </div>
    </section>
  )
}

// ---------- teacher notices (w3-notify — when Mark-LV moves, Clare writes) ----------

const NOTICE_STATUS_CHIP: Record<string, string> = {
  new: 'border-amber-400/30 bg-amber-400/10 text-amber-300',
  wanted: 'border-emerald-400/30 bg-emerald-400/10 text-emerald-300',
  dismissed: 'border-white/10 bg-white/5 text-slate-500',
}

const NOTICE_STATUS_LABEL: Record<string, string> = {
  new: 'awaiting your answer',
  wanted: 'queued for porting',
  dismissed: 'archived',
}

/** One notice from Clare — her message (soft glass, her chat voice), her take
 *  (amber sub-block), and when it is new, the two answer buttons. */
function TeacherNoticeCard({
  notice,
  deciding,
  onDecide,
}: {
  notice: TeacherNoticeInfo
  deciding: { id: string; decision: 'wanted' | 'dismissed' } | null
  onDecide: (id: string, decision: 'wanted' | 'dismissed') => void
}) {
  const busy = deciding?.id === notice.id
  return (
    <article className="mist-glass-soft rounded-xl p-3" aria-label={`notice from Clare — ${shortSha(notice.head)}`}>
      <div className="flex flex-wrap items-center gap-1.5">
        <Mail aria-hidden className="h-3.5 w-3.5 shrink-0 text-amber-300" />
        <span className="font-mono text-[11px] text-slate-200" title={notice.created_at}>
          {relTime(notice.created_at)}
        </span>
        <MonoBadge className="border-white/10 text-slate-400">
          {notice.commits} commit{notice.commits === 1 ? '' : 's'}
        </MonoBadge>
        <MonoBadge className="border-white/10 text-slate-500" title={notice.head}>
          {shortSha(notice.head)}
        </MonoBadge>
        <span
          className={cn(
            'ml-auto shrink-0 rounded-full border px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wide',
            NOTICE_STATUS_CHIP[notice.status] ?? NOTICE_STATUS_CHIP.dismissed
          )}
          title={`her notice status: ${notice.status}`}
        >
          {NOTICE_STATUS_LABEL[notice.status] ?? notice.status}
        </span>
      </div>

      {/* her message — soft glass, her chat voice */}
      <div className="mt-2.5 rounded-xl border border-amber-400/10 bg-amber-400/[0.04] px-3 py-2.5">
        <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-slate-100">{plainNote(notice.message)}</p>
      </div>

      {/* her take — the honest one-sentence opinion, amber accent */}
      {notice.opinion ? (
        <div className="mt-2.5 border-l-2 border-amber-400/40 pl-3">
          <p className="font-mono text-[9px] uppercase tracking-widest text-amber-400/80">her take</p>
          <p className="mt-0.5 text-[12px] leading-relaxed text-amber-200/90">{plainNote(notice.opinion)}</p>
        </div>
      ) : null}

      {notice.status === 'new' ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button
            onClick={() => onDecide(notice.id, 'wanted')}
            disabled={busy}
            className="h-7 border border-emerald-400/30 bg-emerald-400/15 px-2.5 font-mono text-[9px] uppercase tracking-widest text-emerald-200 hover:bg-emerald-400/25"
            aria-label={`Queue the Mark-LV update ${shortSha(notice.head)} for porting`}
          >
            {busy && deciding?.decision === 'wanted' ? (
              <Loader2 aria-hidden className="h-3 w-3 animate-spin" />
            ) : (
              <Wand2 aria-hidden className="h-3 w-3" />
            )}
            port it
          </Button>
          <Button
            variant="outline"
            onClick={() => onDecide(notice.id, 'dismissed')}
            disabled={busy}
            className="h-7 border-white/10 bg-white/5 px-2.5 font-mono text-[9px] uppercase tracking-widest text-slate-400 hover:border-white/20 hover:text-slate-200"
            aria-label={`Archive the Mark-LV update notice ${shortSha(notice.head)} without porting`}
          >
            {busy && deciding?.decision === 'dismissed' ? (
              <Loader2 aria-hidden className="h-3 w-3 animate-spin" />
            ) : (
              <CheckCircle2 aria-hidden className="h-3 w-3" />
            )}
            not now
          </Button>
        </div>
      ) : null}
    </article>
  )
}

/** A resolved earlier notice — compact row, expandable to re-read her words. */
function EarlierNoticeCard({ notice }: { notice: TeacherNoticeInfo }) {
  const [open, setOpen] = useState(false)
  return (
    <article className="mist-glass-soft rounded-xl p-2.5" aria-label={`earlier notice — ${shortSha(notice.head)}`}>
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="font-mono text-[10px] text-slate-400" title={notice.created_at}>
          {relTime(notice.created_at)}
        </span>
        <MonoBadge className="border-white/10 text-slate-500">{notice.commits} commit{notice.commits === 1 ? '' : 's'}</MonoBadge>
        <span
          className={cn(
            'shrink-0 rounded-full border px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wide',
            NOTICE_STATUS_CHIP[notice.status] ?? NOTICE_STATUS_CHIP.dismissed
          )}
        >
          {NOTICE_STATUS_LABEL[notice.status] ?? notice.status}
        </span>
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className="ml-auto flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-widest text-slate-500 transition-colors hover:text-slate-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60"
          aria-label={open ? 'collapse her message' : 'read her message'}
        >
          {open ? 'hide' : 'read'}
          <ChevronDown aria-hidden className={cn('h-3 w-3 transition-transform', open && 'rotate-180')} />
        </button>
      </div>
      {open ? (
        <div className="mt-2">
          <div className="rounded-xl border border-amber-400/10 bg-amber-400/[0.04] px-3 py-2.5">
            <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-slate-100">{plainNote(notice.message)}</p>
          </div>
          {notice.opinion ? (
            <div className="mt-2.5 border-l-2 border-amber-400/40 pl-3">
              <p className="font-mono text-[9px] uppercase tracking-widest text-amber-400/80">her take</p>
              <p className="mt-0.5 text-[12px] leading-relaxed text-amber-200/90">{plainNote(notice.opinion)}</p>
            </div>
          ) : null}
        </div>
      ) : (
        <p className="mt-1 line-clamp-1 font-mono text-[10px] text-slate-600">{notice.message}</p>
      )}
    </article>
  )
}

// ---------- the tab ----------

export function UpstreamTab() {
  const [data, setData] = useState<OjSyncStatusResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [checking, setChecking] = useState(false)
  const [checkResult, setCheckResult] = useState<OjSyncCheckResponse | null>(null)

  const [applying, setApplying] = useState<string | null>(null)

  const [configOpen, setConfigOpen] = useState(false)
  const [intervalInput, setIntervalInput] = useState('30')
  const [autoPatchInput, setAutoPatchInput] = useState(false)
  const [savingConfig, setSavingConfig] = useState(false)

  // w3-notify — the teacher's notices (Clare writes, the creator answers)
  const [deciding, setDeciding] = useState<{ id: string; decision: 'wanted' | 'dismissed' } | null>(null)
  const [noticeHistoryOpen, setNoticeHistoryOpen] = useState(false)
  const [previewing, setPreviewing] = useState(false)
  const [noticePreview, setNoticePreview] = useState<TeacherNoticePreviewResponse | null>(null)

  const refresh = useCallback(async (silent = false) => {
    if (!silent) setLoading(true)
    try {
      const res = await ojApi.ojSync.status()
      setData(res)
      setIntervalInput(String(res.status.interval_min))
      setAutoPatchInput(res.status.auto_patch)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'upstream watch unreachable')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  const runCheck = async () => {
    setChecking(true)
    try {
      const res = await ojApi.ojSync.check()
      setCheckResult(res)
      if (!res.ok) {
        toast.error(`upstream check failed — ${res.message}`)
      } else if (res.changed) {
        toast.success(`upstream moved to ${shortSha(res.head)} — ${res.message}`)
      } else {
        toast.info(res.message)
      }
      // refresh status either way — sweeps/last_sweep_at move even on no-change
      await refresh(true)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'upstream check failed')
    } finally {
      setChecking(false)
    }
  }

  const applyProposal = async (proposalId: string) => {
    setApplying(proposalId)
    try {
      const res = await ojApi.ojSync.apply(proposalId)
      if (res.ok) {
        toast.success(res.message)
      } else {
        toast.info(res.message) // honest "already applied / needs develop" answers
      }
      await refresh(true)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'apply failed')
    } finally {
      setApplying(null)
    }
  }

  // w3-notify — answer one of Clare's notes (queued for porting / archived)
  const decideNotice = async (id: string, decision: 'wanted' | 'dismissed') => {
    setDeciding({ id, decision })
    try {
      const res = await ojApi.teacherNotices.decide(id, decision)
      if (res.ok) {
        toast.success(res.message)
      } else {
        toast.info(res.message) // honest "already resolved" answers
      }
      await refresh(true)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'notice update failed')
    } finally {
      setDeciding(null)
    }
  }

  // w3-notify — dry-run a notice from the current repo state (never stored)
  const runNoticePreview = async () => {
    setPreviewing(true)
    try {
      const res = await ojApi.teacherNotices.preview()
      setNoticePreview(res)
      toast.info(
        res.degraded
          ? 'preview degraded — her lanes were down, so the honest fallback is shown'
          : `preview ready — served by ${res.provider}`
      )
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'preview failed')
    } finally {
      setPreviewing(false)
    }
  }

  const saveConfig = async () => {
    const n = Number.parseInt(intervalInput, 10)
    if (!Number.isFinite(n) || n <= 0) {
      toast.error('interval must be a positive number of minutes')
      return
    }
    setSavingConfig(true)
    try {
      const res = await ojApi.ojSync.configure({ interval_min: n, auto_patch: autoPatchInput })
      if (res.ok) {
        toast.success(res.message)
        setConfigOpen(false)
        await refresh(true)
      } else {
        toast.error(res.message)
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'configure failed')
    } finally {
      setSavingConfig(false)
    }
  }

  if (loading) {
    return (
      <div className="space-y-3" aria-busy="true" aria-label="loading upstream status">
        <Skeleton className="h-40 w-full rounded-xl" />
        <Skeleton className="h-16 w-full rounded-xl" />
        <Skeleton className="h-24 w-full rounded-xl" />
      </div>
    )
  }

  if (error || !data) {
    return (
      <div role="alert" className="mist-glass rounded-xl p-4">
        <p className="flex items-center gap-2 text-sm text-rose-300">
          <TriangleAlert aria-hidden className="h-4 w-4" />
          upstream watch unreachable
        </p>
        <p className="mt-1 font-mono text-[10px] text-slate-500">{error}</p>
        <Button
          variant="outline"
          size="sm"
          className="mt-3 h-8 border-white/10 bg-white/5 font-mono text-[10px] uppercase tracking-widest"
          onClick={() => refresh()}
        >
          <RefreshCw aria-hidden className="h-3 w-3" />
          Retry
        </Button>
      </div>
    )
  }

  const status: OjSyncStatus = data.status
  const inSync = status.head !== null && status.local_head !== null && status.head === status.local_head

  return (
    <div className="space-y-3">
      <SectionLabel
        right={
          <MonoBadge className="border-white/10 text-slate-500" title={`sweeps every ${status.interval_min} min`}>
            {status.sweeps} sweeps
          </MonoBadge>
        }
      >
        <span className="inline-flex items-center gap-1.5">
          <Radar aria-hidden className="h-3 w-3 text-slate-500" />
          upstream self-update
        </span>
      </SectionLabel>

      {/* ---- status card ---- */}
      <section className="mist-glass p-3.5" aria-label="upstream watch status">
        <div className="flex flex-wrap items-center gap-2">
          <GitBranch aria-hidden className="h-4 w-4 shrink-0 text-purple-300" />
          <span className="min-w-0 flex-1 truncate font-mono text-xs text-slate-200">{status.repo}</span>
          <span className="inline-flex shrink-0 items-center gap-1.5 font-mono text-[10px] text-slate-400">
            <StatusDot className={status.watching ? 'bg-emerald-400' : 'bg-rose-400'} pulse={status.watching} />
            {status.watching ? 'watching' : 'watch stopped'}
          </span>
        </div>

        {status.error ? (
          <p role="alert" className="mt-2.5 flex items-start gap-1.5 rounded-lg bg-rose-950/25 px-2.5 py-2 font-mono text-[10px] leading-relaxed text-rose-300/90">
            <TriangleAlert aria-hidden className="mt-0.5 h-3 w-3 shrink-0" />
            {status.error}
          </p>
        ) : null}

        {status.pending_knowledge ? (
          <p className="mt-2.5 flex items-start gap-1.5 rounded-lg bg-amber-950/25 px-2.5 py-2 font-mono text-[10px] leading-relaxed text-amber-300/90">
            <BookOpen aria-hidden className="mt-0.5 h-3 w-3 shrink-0" />
            knowledge absorption pending — {status.pending_knowledge.commits} commit
            {status.pending_knowledge.commits === 1 ? '' : 's'} at {shortSha(status.pending_knowledge.new_head)} waiting for
            the LLM brief lane (since {relTime(status.pending_knowledge.since)})
          </p>
        ) : null}

        <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
          <StatCell label="upstream head" value={shortSha(status.head)} title={status.head ?? undefined} />
          <StatCell
            label="local clone"
            value={shortSha(status.local_head)}
            title={status.local_head ?? undefined}
          />
          <StatCell
            label="clone state"
            value={inSync ? 'in sync' : status.merge_pending ? 'merge pending' : 'behind'}
            title={inSync ? 'reference clone matches upstream HEAD' : 'the clone catches up on the next change sweep'}
          />
          <StatCell label="interval" value={`every ${status.interval_min}m`} />
          <StatCell label="last sweep" value={status.last_sweep_at ? relTime(status.last_sweep_at) : '—'} title={status.last_sweep_at ?? undefined} />
          <StatCell label="next sweep" value={untilTime(status.next_sweep_at)} title={status.next_sweep_at ?? undefined} />
        </div>

        <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
          <MonoBadge
            className={cn(
              status.auto_patch
                ? 'border-amber-400/30 bg-amber-400/10 text-amber-300'
                : 'border-emerald-400/30 bg-emerald-400/10 text-emerald-300'
            )}
            title={status.auto_patch ? 'structural proposals develop automatically — applies still need approval' : 'structural changes wait as pending proposals until developed'}
          >
            auto_patch {status.auto_patch ? 'on' : 'off'}
          </MonoBadge>
          {status.developing.length > 0 ? (
            <MonoBadge className="border-fuchsia-400/30 bg-fuchsia-400/10 text-fuchsia-300">
              {status.developing.length} proposal{status.developing.length === 1 ? '' : 's'} developing
            </MonoBadge>
          ) : null}
          {status.last_head_at ? (
            <MonoBadge className="border-white/10 text-slate-500" title={status.last_head_at}>
              head seen {status.last_head_at ? relTime(status.last_head_at) : 'never' }
            </MonoBadge>
          ) : null}
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button
            onClick={runCheck}
            disabled={checking}
            className="h-8 border border-purple-400/30 bg-purple-400/15 px-3 font-mono text-[10px] uppercase tracking-widest text-purple-200 hover:bg-purple-400/25"
            aria-label="Check the OpenJarvis upstream for new commits now"
          >
            {checking ? <Loader2 aria-hidden className="h-3 w-3 animate-spin" /> : <Radar aria-hidden className="h-3 w-3" />}
            {checking ? 'sweeping…' : 'check upstream now'}
          </Button>

          <Popover open={configOpen} onOpenChange={setConfigOpen}>
            <PopoverTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                className="h-8 border-white/10 bg-white/5 font-mono text-[10px] uppercase tracking-widest text-slate-300 hover:border-purple-400/40 hover:text-purple-200"
                aria-label="Configure the upstream watch"
              >
                <Settings2 aria-hidden className="h-3 w-3" />
                configure
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-72 border-white/10 bg-slate-900/95 backdrop-blur-xl">
              <div className="space-y-3">
                <div className="space-y-1.5">
                  <Label htmlFor="oj-interval" className="font-mono text-[10px] uppercase tracking-widest text-slate-400">
                    sweep interval (minutes)
                  </Label>
                  <Input
                    id="oj-interval"
                    type="number"
                    min={5}
                    max={1440}
                    value={intervalInput}
                    onChange={(e) => setIntervalInput(e.target.value)}
                    className="h-8 border-white/10 bg-white/5 font-mono text-xs"
                  />
                  <p className="font-mono text-[9px] text-slate-600">clamped to 5–1440 by the watch</p>
                </div>
                <div className="flex items-center justify-between gap-2 rounded-lg border border-white/5 bg-white/[0.02] px-2.5 py-2">
                  <Label htmlFor="oj-autopatch" className="font-mono text-[10px] uppercase tracking-widest text-slate-400">
                    auto_patch
                  </Label>
                  <Switch id="oj-autopatch" checked={autoPatchInput} onCheckedChange={setAutoPatchInput} />
                </div>
                <p className="font-mono text-[9px] leading-relaxed text-slate-600">
                  auto_patch develops structural proposals automatically — applies still need your approval.
                </p>
                <Button
                  onClick={saveConfig}
                  disabled={savingConfig}
                  className="h-8 w-full border border-purple-400/30 bg-purple-400/15 font-mono text-[10px] uppercase tracking-widest text-purple-200 hover:bg-purple-400/25"
                >
                  {savingConfig ? <Loader2 aria-hidden className="h-3 w-3 animate-spin" /> : <CheckCircle2 aria-hidden className="h-3 w-3" />}
                  save
                </Button>
              </div>
            </PopoverContent>
          </Popover>
        </div>
      </section>

      {/* ---- check result banner ---- */}
      {checkResult ? (
        <section
          role="status"
          aria-label="upstream check result"
          className={cn(
            'rounded-xl border p-3.5',
            !checkResult.ok
              ? 'border-rose-400/20 bg-rose-950/20'
              : checkResult.changed
                ? 'border-purple-400/20 bg-purple-950/20'
                : 'border-emerald-400/20 bg-emerald-950/20'
          )}
        >
          <div className="flex items-start gap-2">
            {!checkResult.ok ? (
              <TriangleAlert aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-rose-300" />
            ) : checkResult.changed ? (
              <GitCommitHorizontal aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-purple-300" />
            ) : (
              <CheckCircle2 aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-emerald-300" />
            )}
            <div className="min-w-0 flex-1">
              <p className="text-[13px] font-medium text-slate-100">
                {!checkResult.ok
                  ? 'sweep failed'
                  : checkResult.changed
                    ? `upstream moved to ${shortSha(checkResult.head)}`
                    : 'up to date'}
              </p>
              <p className="mt-0.5 font-mono text-[10px] leading-relaxed text-slate-400">{checkResult.message}</p>
              {checkResult.changed ? (
                <div className="mt-2 space-y-2">
                  <div className="flex flex-wrap items-center gap-1.5">
                    {checkResult.commits ? (
                      <MonoBadge className="border-white/10 text-slate-400">
                        {checkResult.commits.total} commit{checkResult.commits.total === 1 ? '' : 's'}
                      </MonoBadge>
                    ) : null}
                    {checkResult.files ? (
                      <MonoBadge className="border-white/10 text-slate-400">
                        {checkResult.files.total} file{checkResult.files.total === 1 ? '' : 's'}
                      </MonoBadge>
                    ) : null}
                    {checkResult.tiers ? (
                      <>
                        <MonoBadge className="border-purple-400/30 text-purple-300">{checkResult.tiers.structural} structural</MonoBadge>
                        <MonoBadge className="border-emerald-400/30 text-emerald-300">{checkResult.tiers.knowledge} knowledge</MonoBadge>
                        <MonoBadge className="border-white/10 text-slate-500">{checkResult.tiers.excluded} excluded</MonoBadge>
                      </>
                    ) : null}
                    {checkResult.pending_knowledge ? (
                      <MonoBadge className="border-amber-400/30 text-amber-300">knowledge queued</MonoBadge>
                    ) : null}
                  </div>
                  {checkResult.brief ? (
                    <pre className="mist-scroll max-h-40 overflow-auto whitespace-pre-wrap rounded-lg bg-slate-950/50 p-2.5 font-mono text-[10px] leading-relaxed text-slate-400">
                      {checkResult.brief}
                    </pre>
                  ) : null}
                  {checkResult.commits && checkResult.commits.sample.length > 0 ? (
                    <ul className="space-y-1">
                      {checkResult.commits.sample.slice(0, 5).map((c) => (
                        <li key={c.sha} className="flex items-center gap-2 font-mono text-[10px] text-slate-500">
                          <span className="shrink-0 text-purple-300/80">{shortSha(c.sha)}</span>
                          <span className="min-w-0 flex-1 truncate">{c.title}</span>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  {checkResult.proposals && checkResult.proposals.length > 0 ? (
                    <div className="space-y-1">
                      <p className="font-mono text-[9px] uppercase tracking-widest text-slate-600">
                        proposals created — apply from the history below
                      </p>
                      {checkResult.proposals.map((p) => (
                        <p key={p.id} className="truncate font-mono text-[10px] text-slate-400">
                          <span className="text-fuchsia-300">{shortSha(p.id, 8)}</span> · {p.module} — {p.title}
                          {p.developing ? ' (developing…)' : ''}
                        </p>
                      ))}
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
          </div>
        </section>
      ) : null}

      {/* ---- absorption history ---- */}
      <SectionLabel right={<MonoBadge className="border-white/10 text-slate-600">last {status.history.length}</MonoBadge>}>
        <span className="inline-flex items-center gap-1.5">
          <Layers aria-hidden className="h-3 w-3 text-slate-500" />
          absorption history
        </span>
      </SectionLabel>
      {status.history.length === 0 ? (
        <div className="mist-glass rounded-xl p-5 text-center">
          <GitBranch aria-hidden className="mx-auto h-5 w-5 text-slate-600" />
          <p className="mt-2 text-sm text-slate-300">no upstream changes absorbed yet</p>
          <p className="mt-1 text-[11px] text-slate-600">
            the watch is quiet at {shortSha(status.head)} — check upstream now, or wait for the next sweep{' '}
            {untilTime(status.next_sweep_at)}
          </p>
        </div>
      ) : (
        <div className="mist-scroll max-h-[50vh] space-y-2 overflow-y-auto pr-1" aria-label="absorption history">
          {status.history.map((h) => (
            <HistoryCard key={`${h.at}-${h.new_head}`} entry={h} applying={applying} onApply={applyProposal} />
          ))}
        </div>
      )}

      {/* ---- port map ---- */}
      <SectionLabel right={<MonoBadge className="border-white/10 text-slate-600">{data.mapping.entries} prefixes</MonoBadge>}>
        <span className="inline-flex items-center gap-1.5">
          <FileCode2 aria-hidden className="h-3 w-3 text-slate-500" />
          port map · {data.mapping.repo}@{data.mapping.branch}
        </span>
      </SectionLabel>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2" aria-label="port map modules">
        {data.mapping.modules.map((m) => (
          <ModuleCard key={m.module} module={m} />
        ))}
      </div>

      {/* ---- mark-lv · the teacher's assistant (mlv-rust-3 anti-rust watch) ---- */}
      <SectionLabel right={<MonoBadge className="border-white/10 text-slate-600" title={`next scan ${untilTime(data.mark_lv?.next_scan_at)}`}>anti-rust</MonoBadge>}>
        <span className="inline-flex items-center gap-1.5">
          <GraduationCap aria-hidden className="h-3 w-3 text-slate-500" />
          mark-lv · the teacher&apos;s assistant
        </span>
      </SectionLabel>
      <MarkLvCard mlv={data.mark_lv ?? null} onChecked={() => refresh(true)} />

      {/* ---- notices from her (w3-notify) ---- */}
      <SectionLabel
        right={
          <MonoBadge
            className={cn(
              (data.teacher_notices?.summary.pending ?? 0) > 0
                ? 'border-amber-400/30 text-amber-300'
                : 'border-white/10 text-slate-600'
            )}
            title="notices awaiting your answer"
          >
            {data.teacher_notices?.summary.pending ?? 0} pending
          </MonoBadge>
        }
      >
        <span className="inline-flex items-center gap-1.5">
          <Mail aria-hidden className="h-3 w-3 text-slate-500" />
          notices from her
        </span>
      </SectionLabel>

      {/* the preview dry-run — honest, labelled, never stored */}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="ghost"
          onClick={runNoticePreview}
          disabled={previewing}
          className="h-7 border border-white/10 bg-transparent px-2.5 font-mono text-[9px] uppercase tracking-widest text-slate-400 hover:border-amber-400/30 hover:text-amber-200"
          aria-label="Preview what a notice from her would look like — generated from the current repo state, never stored"
        >
          {previewing ? <Loader2 aria-hidden className="h-3 w-3 animate-spin" /> : <Eye aria-hidden className="h-3 w-3" />}
          {previewing ? 'composing…' : 'preview a notice'}
        </Button>
        <p className="min-w-0 flex-1 font-mono text-[9px] leading-relaxed text-slate-600">
          when the teacher&apos;s assistant moves she writes you a note and asks — answer her right here
        </p>
      </div>

      {noticePreview ? (
        <section
          role="status"
          aria-label="notice preview — not stored, not sent"
          className="mist-glass rounded-xl border-dashed border-amber-400/30 p-3.5"
        >
          <div className="flex flex-wrap items-center gap-1.5">
            <Eye aria-hidden className="h-3.5 w-3.5 shrink-0 text-amber-300" />
            <span className="font-mono text-[10px] uppercase tracking-widest text-amber-300">preview — not stored, not sent</span>
            <MonoBadge className="ml-auto border-white/10 text-slate-500" title={noticePreview.head ?? undefined}>
              {noticePreview.commits} commit{noticePreview.commits === 1 ? '' : 's'} · {shortSha(noticePreview.head)}
            </MonoBadge>
          </div>
          <div className="mt-2.5 rounded-xl border border-amber-400/10 bg-amber-400/[0.04] px-3 py-2.5">
            <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-slate-100">{plainNote(noticePreview.message)}</p>
          </div>
          {noticePreview.opinion ? (
            <div className="mt-2.5 border-l-2 border-amber-400/40 pl-3">
              <p className="font-mono text-[9px] uppercase tracking-widest text-amber-400/80">her take</p>
              <p className="mt-0.5 text-[12px] leading-relaxed text-amber-200/90">{plainNote(noticePreview.opinion)}</p>
            </div>
          ) : null}
          <p className="mt-2 font-mono text-[9px] leading-relaxed text-slate-600">
            {noticePreview.source === 'last_absorbed'
              ? 'drawn from the last update her watch absorbed'
              : 'drawn from the repo\u2019s current HEAD commit — the teacher has not pushed anything new yet'}
            {' · '}
            {noticePreview.degraded
              ? 'degraded — her lanes were down, so this is her honest fallback'
              : `served by ${noticePreview.provider} · ${noticePreview.model}`}
          </p>
        </section>
      ) : null}

      {!data.teacher_notices ? (
        <div className="mist-glass rounded-xl p-3.5">
          <p className="font-mono text-[10px] text-slate-600">
            the notices did not report — refresh, or check the watch above
          </p>
        </div>
      ) : data.teacher_notices.notices.length === 0 ? (
        <div className="mist-glass rounded-xl p-5 text-center">
          <Mail aria-hidden className="mx-auto h-5 w-5 text-slate-600" />
          <p className="mt-2 text-sm text-slate-300">no notices yet</p>
          <p className="mt-1 text-[11px] text-slate-600">
            the teacher&apos;s assistant is quiet — when it moves, she&apos;ll write you a note, give her honest take, and ask
            whether you want it ported
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {(() => {
            const notices = data.teacher_notices.notices
            const activeIdx = notices.findIndex((n) => n.status === 'new')
            const active = activeIdx >= 0 ? notices[activeIdx] : null
            const earlier = notices.filter((n) => n !== active)
            return (
              <>
                {active ? (
                  <TeacherNoticeCard notice={active} deciding={deciding} onDecide={decideNotice} />
                ) : (
                  <p className="px-1 font-mono text-[10px] text-slate-600">
                    no notice is waiting on you — the newest one below is already answered
                  </p>
                )}
                {earlier.length > 0 ? (
                  <div>
                    <button
                      type="button"
                      onClick={() => setNoticeHistoryOpen((o) => !o)}
                      aria-expanded={noticeHistoryOpen}
                      className="flex w-full items-center gap-1.5 rounded-lg bg-white/[0.02] px-2.5 py-1.5 text-left transition-colors hover:bg-white/[0.05] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60"
                    >
                      <Layers aria-hidden className="h-3 w-3 shrink-0 text-slate-500" />
                      <span className="min-w-0 flex-1 font-mono text-[10px] uppercase tracking-widest text-slate-500">
                        earlier notices ({earlier.length})
                      </span>
                      <ChevronDown aria-hidden className={cn('h-3 w-3 shrink-0 text-slate-600 transition-transform', noticeHistoryOpen && 'rotate-180')} />
                    </button>
                    {noticeHistoryOpen ? (
                      <div className="mist-scroll mt-2 max-h-96 space-y-2 overflow-y-auto pr-1" aria-label="earlier notices from her">
                        {earlier.map((n) => (
                          <EarlierNoticeCard key={n.id} notice={n} />
                        ))}
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </>
            )
          })()}
        </div>
      )}

      <p className="px-1 font-mono text-[9px] leading-relaxed text-slate-600">
        sweeps ls-remote every {status.interval_min} min · on change: fetch → map → adapt — knowledge auto-ingests,
        structural changes become evolution proposals, excluded paths stay out. nothing applies without your approval
        unless auto_patch is on.
      </p>
    </div>
  )
}
