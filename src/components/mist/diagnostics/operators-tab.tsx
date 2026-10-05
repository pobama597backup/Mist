'use client'

// OperatorsTab — the proactive ops console: OpenJarvis's always-on operators
// with schedules and budgets, plus the digest surface (latest synthesis,
// on-demand generation, and the cron schedule with a human preview).

import { useCallback, useEffect, useState } from 'react'
import {
  AlarmClock,
  CalendarClock,
  Loader2,
  Newspaper,
  Pause,
  Play,
  PlayCircle,
  Radar,
  RefreshCw,
  TriangleAlert,
} from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'
import {
  ojApi,
  type DigestListResponse,
  type OperatorInfo,
} from '@/lib/oj/lab-api'
import { MonoBadge, SectionLabel, relTime } from './shared'

// ---------- helpers ----------

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

const LAST_STATUS_STYLE: Record<string, string> = {
  ok: 'border-emerald-400/30 bg-emerald-400/10 text-emerald-300',
  degraded: 'border-amber-400/30 bg-amber-400/10 text-amber-300',
  error: 'border-rose-400/30 bg-rose-400/10 text-rose-300',
  failed: 'border-rose-400/30 bg-rose-400/10 text-rose-300',
}

/** Human preview for the trivial cron shapes; honest null otherwise. */
function cronPreview(cron: string): string | null {
  const parts = cron.trim().split(/\s+/)
  if (parts.length !== 5) return null
  const [m, h, dom, mon, dow] = parts
  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
  const hh = (v: string) => String(Number(v)).padStart(2, '0')
  const isNum = (v: string) => /^\d+$/.test(v)

  if (dom === '*' && mon === '*') {
    // every N minutes: */N * * * *
    if (m.startsWith('*/') && h === '*' && dow === '*') return `every ${m.slice(2)} minutes`
    // hourly at :MM: M * * * *
    if (isNum(m) && h === '*' && dow === '*') return `hourly at :${String(Number(m)).padStart(2, '0')}`
    // every N hours: 0 */N * * *
    if (isNum(m) && h.startsWith('*/') && dow === '*') return `every ${h.slice(2)} hours`
    // daily at HH:MM
    if (isNum(m) && isNum(h) && dow === '*') return `daily at ${hh(h)}:${String(Number(m)).padStart(2, '0')}`
    // weekly
    if (isNum(m) && isNum(h) && isNum(dow) && Number(dow) >= 0 && Number(dow) <= 7) {
      const d = dayNames[Number(dow) % 7]
      return `${d}s at ${hh(h)}:${String(Number(m)).padStart(2, '0')}`
    }
  }
  return null
}

// ---------- operator card ----------

function OperatorCard({
  op,
  busy,
  onAction,
}: {
  op: OperatorInfo
  busy: string | null
  onAction: (slug: string, action: 'run' | 'pause' | 'resume') => void
}) {
  const paused = op.status === 'paused' || op.enabled === false
  const rowBusy = busy !== null
  return (
    <article className="mist-glass-soft rounded-xl p-3.5">
      <div className="flex items-start justify-between gap-2">
        <span className="min-w-0 text-[13px] font-medium text-slate-100">{op.name}</span>
        <span
          className={cn(
            'shrink-0 rounded-full border px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wide',
            paused
              ? 'border-amber-400/30 bg-amber-400/10 text-amber-300'
              : 'border-emerald-400/30 bg-emerald-400/10 text-emerald-300'
          )}
        >
          {paused ? 'paused' : 'active'}
        </span>
      </div>
      <p className="mt-1 line-clamp-3 text-[11px] leading-relaxed text-slate-500">{op.description}</p>
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[9px] text-slate-500">
        <span className="inline-flex items-center gap-1" title={`schedule: ${op.schedule.type} · ${op.schedule.value}`}>
          <AlarmClock aria-hidden className="h-3 w-3 text-slate-600" />
          {op.humanSchedule}
        </span>
        <span title={op.nextRunAt ?? undefined}>next {untilTime(op.nextRunAt)}</span>
        <span title={op.lastRunAt ?? undefined}>
          {op.lastRunAt ? `ran ${relTime(op.lastRunAt)}` : 'never ran'}
        </span>
        {op.lastStatus ? (
          <span
            className={cn(
              'rounded-full border px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wide',
              LAST_STATUS_STYLE[op.lastStatus] ?? 'border-white/10 bg-white/5 text-slate-400'
            )}
          >
            {op.lastStatus}
          </span>
        ) : null}
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
        <MonoBadge className="border-white/10 text-slate-600">{op.runCount} run{op.runCount === 1 ? '' : 's'}</MonoBadge>
        {op.budget?.maxActionsPerRun !== undefined ? (
          <MonoBadge className="border-white/10 text-slate-600">≤{op.budget.maxActionsPerRun} actions/run</MonoBadge>
        ) : null}
        {op.budget?.maxTokens !== undefined ? (
          <MonoBadge className="border-white/10 text-slate-600">≤{op.budget.maxTokens}t/run</MonoBadge>
        ) : null}
      </div>
      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={rowBusy}
          onClick={() => onAction(op.slug, 'run')}
          className="h-7 border-white/10 bg-white/5 px-2 font-mono text-[9px] uppercase tracking-widest text-slate-300 hover:border-purple-400/40 hover:text-purple-200"
          aria-label={`Run ${op.name} now`}
        >
          {busy === 'run' ? <Loader2 aria-hidden className="h-3 w-3 animate-spin" /> : <Play aria-hidden className="h-3 w-3" />}
          run now
        </Button>
        {paused ? (
          <Button
            variant="outline"
            size="sm"
            disabled={rowBusy}
            onClick={() => onAction(op.slug, 'resume')}
            className="h-7 border-emerald-400/20 bg-emerald-400/10 px-2 font-mono text-[9px] uppercase tracking-widest text-emerald-300 hover:bg-emerald-400/20"
            aria-label={`Resume ${op.name}`}
          >
            {busy === 'resume' ? <Loader2 aria-hidden className="h-3 w-3 animate-spin" /> : <PlayCircle aria-hidden className="h-3 w-3" />}
            resume
          </Button>
        ) : (
          <Button
            variant="outline"
            size="sm"
            disabled={rowBusy}
            onClick={() => onAction(op.slug, 'pause')}
            className="h-7 border-amber-400/20 bg-amber-400/10 px-2 font-mono text-[9px] uppercase tracking-widest text-amber-300 hover:bg-amber-400/20"
            aria-label={`Pause ${op.name}`}
          >
            {busy === 'pause' ? <Loader2 aria-hidden className="h-3 w-3 animate-spin" /> : <Pause aria-hidden className="h-3 w-3" />}
            pause
          </Button>
        )}
      </div>
    </article>
  )
}

// ---------- the tab ----------

export function OperatorsTab() {
  const [operators, setOperators] = useState<OperatorInfo[] | null>(null)
  const [digestData, setDigestData] = useState<DigestListResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [busyOp, setBusyOp] = useState<{ slug: string; action: string } | null>(null)
  const [generating, setGenerating] = useState(false)

  const [cronInput, setCronInput] = useState('0 8 * * *')
  const [scheduleEnabled, setScheduleEnabled] = useState(false)
  const [savingSchedule, setSavingSchedule] = useState(false)

  const refresh = useCallback(async () => {
    try {
      const [ops, dig] = await Promise.all([ojApi.operators.list(), ojApi.digest.list()])
      setOperators(ops.operators)
      setDigestData(dig)
      setCronInput(dig.schedule?.cron || '0 8 * * *')
      setScheduleEnabled(dig.schedule?.enabled ?? false)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'ops layer unreachable')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  const runOperatorAction = async (slug: string, action: 'run' | 'pause' | 'resume') => {
    setBusyOp({ slug, action })
    try {
      const res = await ojApi.operators.action(slug, action)
      if (res.ok) {
        const detail =
          action === 'run'
            ? typeof res.result === 'string' && res.result
              ? res.result
              : `run finished${res.status && res.status !== 'ok' ? ` (${res.status})` : ''}`
            : action === 'pause'
              ? 'operator paused — schedule stays, runs halt'
              : 'operator resumed'
        if (action === 'run' && res.status && res.status !== 'ok') {
          toast.warning(`${slug}: ${detail}`)
        } else {
          toast.success(`${slug}: ${detail}`)
        }
      } else {
        const detail =
          typeof res.error === 'string' ? res.error : typeof res.result === 'string' ? res.result : 'action failed'
        toast.error(`${slug}: ${detail}`)
      }
      await refresh()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'operator action failed')
    } finally {
      setBusyOp(null)
    }
  }

  const generateDigest = async () => {
    setGenerating(true)
    try {
      const res = await ojApi.digest.generate(false)
      const tone = res.digest.degraded ? ' (degraded — honest fallback)' : ''
      toast.success(`digest filed: ${res.digest.headline}${tone}`)
      await refresh()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'digest generation failed')
    } finally {
      setGenerating(false)
    }
  }

  const saveSchedule = async () => {
    const cron = cronInput.trim()
    if (!cron) {
      toast.error('the cron expression is empty')
      return
    }
    setSavingSchedule(true)
    try {
      const res = await ojApi.digest.setSchedule(scheduleEnabled, cron)
      if (res.ok) {
        toast.success(
          `digest schedule ${scheduleEnabled ? 'armed' : 'disarmed'}${res.nextRunAt ? ` — next run ${untilTime(res.nextRunAt)}` : ''}`
        )
        await refresh()
      } else {
        toast.error(res.error ?? 'failed to update the schedule')
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'schedule update failed')
    } finally {
      setSavingSchedule(false)
    }
  }

  if (loading) {
    return (
      <div className="space-y-3" aria-busy="true" aria-label="loading operators">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-44 w-full rounded-xl" />
        ))}
      </div>
    )
  }

  if (error || !operators) {
    return (
      <div role="alert" className="mist-glass rounded-xl p-4">
        <p className="flex items-center gap-2 text-sm text-rose-300">
          <TriangleAlert aria-hidden className="h-4 w-4" />
          ops layer unreachable
        </p>
        <p className="mt-1 font-mono text-[10px] text-slate-500">{error}</p>
        <Button
          variant="outline"
          size="sm"
          className="mt-3 h-8 border-white/10 bg-white/5 font-mono text-[10px] uppercase tracking-widest"
          onClick={() => {
            setLoading(true)
            refresh()
          }}
        >
          <RefreshCw aria-hidden className="h-3 w-3" />
          Retry
        </Button>
      </div>
    )
  }

  const latest = digestData?.latest
  const schedule = digestData?.schedule
  const preview = cronPreview(cronInput)

  return (
    <div className="space-y-3">
      <SectionLabel
        right={
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              toast.promise(refresh(), {
                loading: 'refreshing…',
                success: 'ops layer refreshed',
                error: (e) => (e instanceof Error ? e.message : 'refresh failed'),
              })
            }
            className="h-7 border-white/10 bg-white/5 px-2 font-mono text-[9px] uppercase tracking-widest text-slate-300 hover:border-purple-400/40 hover:text-purple-200"
            aria-label="refresh operators"
          >
            <RefreshCw aria-hidden className="h-3 w-3" />
            refresh
          </Button>
        }
      >
        <span className="inline-flex items-center gap-1.5">
          <Radar aria-hidden className="h-3 w-3 text-slate-500" />
          proactive operators
        </span>
      </SectionLabel>

      {operators.length === 0 ? (
        <div className="mist-glass rounded-xl p-6 text-center">
          <Radar aria-hidden className="mx-auto h-5 w-5 text-slate-600" />
          <p className="mt-2 text-sm text-slate-300">no operators registered</p>
          <p className="mt-1 text-[11px] text-slate-600">the builtin manifests seed on first backend touch</p>
        </div>
      ) : (
        <div className="mist-scroll max-h-[55vh] space-y-2 overflow-y-auto pr-1" aria-label="operator list">
          {operators.map((op) => (
            <OperatorCard
              key={op.slug}
              op={op}
              busy={busyOp?.slug === op.slug ? busyOp.action : null}
              onAction={runOperatorAction}
            />
          ))}
        </div>
      )}

      {/* ---- digest ---- */}
      <SectionLabel
        right={
          <MonoBadge className="border-white/10 text-slate-600">
            {digestData ? `${digestData.digests.length} filed` : '…'}
          </MonoBadge>
        }
      >
        <span className="inline-flex items-center gap-1.5">
          <Newspaper aria-hidden className="h-3 w-3 text-slate-500" />
          digest
        </span>
      </SectionLabel>

      {latest ? (
        <article className="mist-glass-soft rounded-xl p-3.5" aria-label="latest digest">
          <div className="flex items-start justify-between gap-2">
            <p className="min-w-0 flex-1 text-[13px] font-medium leading-snug text-slate-100">{latest.headline}</p>
            <MonoBadge className="border-white/10 text-slate-500">{latest.kind}</MonoBadge>
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <MonoBadge className="border-purple-400/30 text-purple-300">tone: {latest.tone}</MonoBadge>
            {latest.degraded ? (
              <MonoBadge className="border-amber-400/30 bg-amber-400/10 text-amber-300">degraded fallback</MonoBadge>
            ) : null}
            <span className="font-mono text-[9px] text-slate-600" title={latest.createdAt}>
              {relTime(latest.createdAt)}
            </span>
          </div>
          {latest.items.length > 0 ? (
            <ul className="mt-2 space-y-1">
              {latest.items.map((item, i) => (
                <li key={i} className="flex items-start gap-1.5 text-[11px] leading-relaxed text-slate-400">
                  <span aria-hidden="true" className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-purple-400/60" />
                  <span className="min-w-0">{item}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </article>
      ) : (
        <div className="mist-glass rounded-xl p-5 text-center">
          <Newspaper aria-hidden className="mx-auto h-5 w-5 text-slate-600" />
          <p className="mt-2 text-sm text-slate-300">no digest filed yet</p>
          <p className="mt-1 text-[11px] text-slate-600">generate one below, or arm the schedule</p>
        </div>
      )}

      <Button
        onClick={generateDigest}
        disabled={generating}
        className="h-8 w-full border border-purple-400/30 bg-purple-400/15 font-mono text-[10px] uppercase tracking-widest text-purple-200 hover:bg-purple-400/25"
        aria-label="Generate a digest now"
      >
        {generating ? <Loader2 aria-hidden className="h-3 w-3 animate-spin" /> : <Newspaper aria-hidden className="h-3 w-3" />}
        {generating ? 'collecting + synthesizing…' : 'generate digest now'}
      </Button>

      {/* ---- schedule ---- */}
      <div className="mist-glass-soft space-y-2.5 p-3" aria-label="digest schedule">
        <div className="flex items-center justify-between gap-2">
          <span className="inline-flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-widest text-slate-400">
            <CalendarClock aria-hidden className="h-3.5 w-3.5 text-slate-500" />
            schedule
          </span>
          <div className="flex items-center gap-2">
            <Label htmlFor="digest-enabled" className="font-mono text-[9px] uppercase tracking-widest text-slate-600">
              {scheduleEnabled ? 'armed' : 'off'}
            </Label>
            <Switch id="digest-enabled" checked={scheduleEnabled} onCheckedChange={setScheduleEnabled} />
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Input
            value={cronInput}
            onChange={(e) => setCronInput(e.target.value)}
            aria-label="digest cron expression"
            spellCheck={false}
            className="h-8 min-w-0 flex-1 border-white/10 bg-white/5 font-mono text-[11px]"
          />
          <Button
            variant="outline"
            size="sm"
            disabled={savingSchedule}
            onClick={saveSchedule}
            className="h-8 shrink-0 border-white/10 bg-white/5 px-2.5 font-mono text-[9px] uppercase tracking-widest text-slate-300 hover:border-purple-400/40 hover:text-purple-200"
            aria-label="Apply digest schedule"
          >
            {savingSchedule ? <Loader2 aria-hidden className="h-3 w-3 animate-spin" /> : null}
            apply
          </Button>
        </div>
        <p className="font-mono text-[9px] text-slate-600">
          {preview ? `"${cronInput.trim()}" → ${preview}` : 'custom cron — she computes the next run server-side'}
          {schedule?.nextRunAt && schedule.enabled ? ` · next ${untilTime(schedule.nextRunAt)}` : ''}
        </p>
      </div>

      <p className="px-1 font-mono text-[9px] leading-relaxed text-slate-600">
        operators ride the heartbeat beat (no extra loops); runs that propose destructive actions land in the approval
        queue first. digests are honest — unavailable sources say so instead of inventing data.
      </p>
    </div>
  )
}
