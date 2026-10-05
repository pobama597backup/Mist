'use client'

// AutomationsTab — M.I.S.T.'s Hermes-style scheduler console. Create jobs in
// plain English ("every day at 9am"), then run / pause / resume / delete them.
// Seeded self-care jobs (origin "auto") are marked violet. Everything talks to
// /api/mist/cron via the typed client; every mutation refreshes the list.

import { useCallback, useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import {
  AlarmClock,
  ChevronDown,
  Loader2,
  Pause,
  Play,
  RefreshCw,
  Trash2,
  Wand2,
} from 'lucide-react'
import { toast } from 'sonner'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import { mistApi } from '@/lib/mist-api'
import { cn } from '@/lib/utils'
import { MonoBadge, StatusDot } from './shared'
import type { CronJobRow } from '@/lib/types'

// ---------- helpers ----------

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/** "0 8 * * *" → "daily 08:00" style short label (falls back to the raw expr). */
function cronLabel(expr: string): string {
  const f = expr.trim().split(/\s+/)
  if (f.length !== 5) return expr
  const [min, hour, dom, , dow] = f
  const mm = min === '*' ? '00' : min.padStart(2, '0')
  const at = hour === '*' ? null : `${hour.padStart(2, '0')}:${mm}`
  if (min.startsWith('*/') && hour === '*' && dom === '*' && dow === '*') {
    return `every ${min.slice(2)} min`
  }
  if (dom === '*' && dow === '*') return at ? `daily ${at}` : `hourly :${mm}`
  if (dom === '*' && dow !== '*') {
    if (dow === '1-5') return at ? `weekdays ${at}` : 'weekdays'
    if (dow === '0,6' || dow === '6,0') return at ? `weekends ${at}` : 'weekends'
    const days = dow
      .split(',')
      .map((d) => DAY_NAMES[Number(d) % 7] ?? d)
      .join('/')
    return at ? `weekly ${days} ${at}` : `weekly ${days}`
  }
  if (dow === '*' && dom.startsWith('*/')) {
    return at ? `every ${dom.slice(2)} days ${at}` : `every ${dom.slice(2)} days`
  }
  return expr
}

function describeSchedule(job: CronJobRow): string {
  if (job.kind === 'fixed_rate') return `every ${job.intervalMin} min`
  if (job.kind === 'one_time') {
    return job.runAt ? new Date(job.runAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : 'once'
  }
  return cronLabel(job.expr)
}

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

function deriveName(prompt: string): string {
  const words = prompt.trim().split(/\s+/).slice(0, 5).join(' ')
  if (!words) return 'Untitled automation'
  return words.charAt(0).toUpperCase() + words.slice(1)
}

// ---------- quick templates ----------

const TEMPLATES = [
  {
    label: 'Daily briefing 8am',
    name: 'Daily briefing',
    schedule: 'every day at 8am',
    prompt:
      'Good morning. Give me a compact briefing: the weather, the top world and tech headlines, and one thing worth knowing today.',
  },
  {
    label: 'Hourly pulse',
    name: 'Hourly pulse',
    schedule: 'every hour',
    prompt:
      'One-paragraph pulse check: anything important or unusual in the last hour? Keep it under 80 words.',
  },
  {
    label: 'Weekly review Monday 10am',
    name: 'Weekly review',
    schedule: 'every monday at 10am',
    prompt:
      'Weekly review: summarize the week that passed (news + my notes), list wins and open threads, and propose 3 priorities for next week.',
  },
] as const

// ---------- job card ----------

function JobCard({
  job,
  expanded,
  busy,
  onToggleExpand,
  onRun,
  onToggleEnabled,
  onRequestDelete,
}: {
  job: CronJobRow
  expanded: boolean
  busy: boolean
  onToggleExpand: () => void
  onRun: () => void
  onToggleEnabled: () => void
  onRequestDelete: () => void
}) {
  const status =
    job.lastStatus === 'ok'
      ? { label: 'last run ok', cls: 'border-emerald-400/30 bg-emerald-400/10 text-emerald-300', dot: 'bg-emerald-400' }
      : job.lastStatus != null
        ? { label: `last: ${job.lastStatus}`, cls: 'border-rose-400/30 bg-rose-400/10 text-rose-300', dot: 'bg-rose-400' }
        : { label: 'never ran', cls: 'border-white/10 bg-white/5 text-slate-500', dot: 'bg-slate-500' }

  return (
    <motion.article
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2 }}
      className={cn(
        'mist-glass-soft mist-glass-hover min-w-0 rounded-xl p-3.5',
        !job.enabled && 'opacity-70'
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            <h4 className="truncate text-sm font-medium text-slate-200">{job.name}</h4>
            {job.origin === 'auto' ? (
              <MonoBadge className="border-purple-400/30 bg-purple-400/10 text-purple-300" title="Created by M.I.S.T. itself">
                M.I.S.T. seeded
              </MonoBadge>
            ) : (
              <MonoBadge className="border-emerald-400/30 bg-emerald-400/10 text-emerald-300">yours</MonoBadge>
            )}
            <MonoBadge
              className={cn(
                job.delivery === 'alert'
                  ? 'border-amber-400/30 bg-amber-400/10 text-amber-300'
                  : 'border-white/10 bg-white/5 text-slate-500'
              )}
              title={job.delivery === 'alert' ? 'Results arrive as system alerts in the chat' : 'Runs silently — only logged in the ledger'}
            >
              {job.delivery}
            </MonoBadge>
          </div>
          <p className="mt-1 font-mono text-[10px] leading-relaxed text-slate-500">
            {describeSchedule(job)} · {job.timezone} · next {untilLabel(job.nextRunAt)} ·{' '}
            {job.runCount} run{job.runCount === 1 ? '' : 's'}
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={onRun}
            disabled={busy}
            aria-label={`Run ${job.name} now`}
            title="Run now"
            className="flex h-7 w-7 items-center justify-center rounded-md text-emerald-300/90 transition-colors hover:bg-emerald-400/10 hover:text-emerald-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-400/60 disabled:opacity-40"
          >
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <Play className="h-3.5 w-3.5" aria-hidden />}
          </button>
          <button
            type="button"
            onClick={onToggleEnabled}
            disabled={busy}
            aria-label={job.enabled ? `Pause ${job.name}` : `Resume ${job.name}`}
            title={job.enabled ? 'Pause' : 'Resume'}
            className={cn(
              'flex h-7 w-7 items-center justify-center rounded-md transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-400/60 disabled:opacity-40',
              job.enabled
                ? 'text-amber-300/90 hover:bg-amber-400/10 hover:text-amber-200'
                : 'text-slate-400 hover:bg-emerald-400/10 hover:text-emerald-200'
            )}
          >
            {busy ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
            ) : job.enabled ? (
              <Pause className="h-3.5 w-3.5" aria-hidden />
            ) : (
              <Play className="h-3.5 w-3.5" aria-hidden />
            )}
          </button>
          <button
            type="button"
            onClick={onRequestDelete}
            disabled={busy}
            aria-label={`Delete ${job.name}`}
            title="Delete"
            className="flex h-7 w-7 items-center justify-center rounded-md text-slate-500 transition-colors hover:bg-rose-400/10 hover:text-rose-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-400/60 disabled:opacity-40"
          >
            <Trash2 className="h-3.5 w-3.5" aria-hidden />
          </button>
        </div>
      </div>

      <div className="mt-2 flex items-center justify-between gap-2">
        <span
          className={cn(
            'inline-flex shrink-0 items-center gap-1.5 rounded-full border px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wide',
            status.cls
          )}
        >
          <StatusDot className={status.dot} pulse={false} />
          {status.label}
        </span>
        <button
          type="button"
          onClick={onToggleExpand}
          aria-expanded={expanded}
          className="inline-flex min-w-0 items-center gap-1 font-mono text-[10px] text-slate-500 transition-colors hover:text-slate-300"
        >
          <ChevronDown aria-hidden className={cn('h-3 w-3 shrink-0 transition-transform', expanded && 'rotate-180')} />
          prompt &amp; last result
        </button>
      </div>

      {expanded ? (
        <div className="animate-mist-fade-in mt-2.5 space-y-2 border-t border-white/5 pt-2.5">
          <div>
            <p className="mb-1 font-mono text-[9px] uppercase tracking-wider text-purple-300/70">prompt</p>
            <p className="whitespace-pre-wrap text-[11px] leading-relaxed text-slate-400">{job.prompt}</p>
          </div>
          <div>
            <p className="mb-1 font-mono text-[9px] uppercase tracking-wider text-emerald-300/70">last result</p>
            {job.lastResult ? (
              <pre className="mist-scroll max-h-32 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-white/5 bg-white/[0.02] p-2 font-mono text-[10px] leading-relaxed text-slate-400">
                {job.lastResult.slice(0, 300)}
                {job.lastResult.length > 300 ? '…' : ''}
              </pre>
            ) : (
              <p className="font-mono text-[10px] text-slate-500">no runs yet</p>
            )}
          </div>
        </div>
      ) : null}
    </motion.article>
  )
}

// ---------- tab ----------

export function AutomationsTab() {
  const [jobs, setJobs] = useState<CronJobRow[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [reloadKey, setReloadKey] = useState(0)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<CronJobRow | null>(null)

  // natural-language creator
  const [cName, setCName] = useState('')
  const [cSchedule, setCSchedule] = useState('')
  const [cPrompt, setCPrompt] = useState('')
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)

  const reload = useCallback(() => {
    let alive = true
    mistApi.cron
      .list()
      .then((r) => {
        if (alive) {
          setJobs(r.jobs)
          setLoadError(null)
        }
      })
      .catch((e) => {
        if (alive) setLoadError(e instanceof Error ? e.message : 'scheduler unreachable')
      })
    return () => {
      alive = false
    }
  }, [])

  useEffect(() => {
    const cleanup = reload()
    return cleanup
  }, [reload, reloadKey])

  const onRun = (job: CronJobRow) => {
    setBusyId(job.id)
    mistApi.cron
      .run(job.id)
      .then((r) => {
        toast.success(`Ran "${job.name}"`, {
          description: r.result ? r.result.slice(0, 180) : undefined,
        })
        reload()
      })
      .catch((e) => toast.error(e instanceof Error ? e.message : 'run failed'))
      .finally(() => setBusyId(null))
  }

  const onToggleEnabled = (job: CronJobRow) => {
    setBusyId(job.id)
    mistApi.cron
      .update(job.id, { enabled: !job.enabled })
      .then(() => {
        toast.success(job.enabled ? `Paused "${job.name}"` : `Resumed "${job.name}"`)
        reload()
      })
      .catch((e) => toast.error(e instanceof Error ? e.message : 'update failed'))
      .finally(() => setBusyId(null))
  }

  const onDelete = (job: CronJobRow) => {
    setBusyId(job.id)
    mistApi.cron
      .remove(job.id)
      .then(() => {
        toast.success(`Deleted "${job.name}"`)
        setConfirmDelete(null)
        reload()
      })
      .catch((e) => toast.error(e instanceof Error ? e.message : 'delete failed'))
      .finally(() => setBusyId(null))
  }

  const onCreate = () => {
    const schedule = cSchedule.trim()
    const prompt = cPrompt.trim()
    if (!schedule || !prompt) {
      setCreateError('A schedule and a prompt are required.')
      return
    }
    setCreating(true)
    setCreateError(null)
    mistApi.cron
      .create({ name: cName.trim() || deriveName(prompt), prompt, schedule })
      .then((r) => {
        toast.success(
          r.explanation
            ? `Automation armed — ${r.explanation}`
            : `Automation "${r.job?.name ?? 'created'}" scheduled`,
          { duration: 6000 }
        )
        setCName('')
        setCSchedule('')
        setCPrompt('')
        reload()
      })
      .catch((e) => {
        setCreateError(e instanceof Error ? e.message : 'could not parse that schedule')
      })
      .finally(() => setCreating(false))
  }

  const total = jobs?.length ?? 0
  const enabledCount = jobs?.filter((j) => j.enabled).length ?? 0
  const nextIso =
    jobs
      ?.filter((j) => j.enabled && j.nextRunAt)
      .map((j) => j.nextRunAt as string)
      .sort()[0] ?? null

  return (
    <div className="flex min-w-0 flex-col gap-4">
      {/* ---- header ---- */}
      <section aria-labelledby="automations-heading">
        <div className="mb-2 flex items-center justify-between">
          <h3
            id="automations-heading"
            className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.25em] text-slate-500"
          >
            <AlarmClock aria-hidden className="h-3.5 w-3.5" />
            automations · scheduled mind
          </h3>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Refresh automations"
            onClick={() => setReloadKey((k) => k + 1)}
            className="h-7 w-7 rounded-lg text-slate-500 hover:bg-white/5 hover:text-slate-300"
          >
            <RefreshCw aria-hidden className="h-3.5 w-3.5" />
          </Button>
        </div>

        <div className="grid grid-cols-3 gap-2">
          {[
            { label: 'JOBS', value: jobs ? `${total}` : null },
            { label: 'ACTIVE', value: jobs ? `${enabledCount}` : null },
            { label: 'NEXT RUN', value: jobs ? untilLabel(nextIso) : null },
          ].map((s) => (
            <div key={s.label} className="mist-glass-soft mist-glass-hover p-2.5 text-center">
              <div className="truncate font-mono text-base tabular-nums text-purple-300">
                {s.value ?? <Skeleton className="mx-auto h-5 w-10 bg-white/5" />}
              </div>
              <div className="mt-0.5 font-mono text-[9px] tracking-[0.2em] text-slate-500">{s.label}</div>
            </div>
          ))}
        </div>
        <p className="mt-2 font-mono text-[9px] leading-relaxed text-slate-500">
          the scheduler ticks every 30s · alert-delivered results land in the chat · silent ones only in the ledger
        </p>
      </section>

      {/* ---- natural-language creator ---- */}
      <section aria-labelledby="creator-heading" className="mist-glass rounded-xl border-purple-400/15 p-3.5">
        <h3 id="creator-heading" className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.25em] text-slate-500">
          <Wand2 aria-hidden className="h-3.5 w-3.5 text-purple-300" />
          new automation — speak naturally
        </h3>

        <div className="mt-2.5 flex flex-wrap gap-1.5" role="group" aria-label="Quick templates">
          {TEMPLATES.map((t) => (
            <button
              key={t.label}
              type="button"
              onClick={() => {
                setCName(t.name)
                setCSchedule(t.schedule)
                setCPrompt(t.prompt)
                setCreateError(null)
              }}
              className="rounded-full border border-purple-400/25 bg-purple-400/5 px-2 py-1 font-mono text-[10px] text-purple-200/90 transition-colors hover:border-purple-400/50 hover:bg-purple-400/10 hover:text-purple-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-400/60"
            >
              {t.label}
            </button>
          ))}
        </div>

        <form
          className="mt-3 space-y-2"
          onSubmit={(e) => {
            e.preventDefault()
            onCreate()
          }}
        >
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              value={cName}
              onChange={(e) => setCName(e.target.value)}
              placeholder="name (optional — derived from the prompt)"
              aria-label="Automation name (optional)"
              className="h-9 min-w-0 border-white/10 bg-white/5 font-mono text-xs text-slate-200 placeholder:text-slate-500 sm:w-52 sm:shrink-0"
              maxLength={80}
            />
            <Input
              value={cSchedule}
              onChange={(e) => setCSchedule(e.target.value)}
              placeholder="every day at 9am"
              aria-label="Schedule in natural language"
              className="h-9 min-w-0 flex-1 border-white/10 bg-white/5 font-mono text-xs text-slate-200 placeholder:text-slate-500"
              maxLength={120}
            />
          </div>
          <Textarea
            value={cPrompt}
            onChange={(e) => setCPrompt(e.target.value)}
            placeholder="what should M.I.S.T. do when it fires? e.g. “brief me on today's weather and top tech news”"
            aria-label="Automation prompt"
            className="h-20 min-w-0 resize-none border-white/5 bg-white/[0.03] text-xs leading-relaxed text-slate-200 placeholder:text-slate-500"
            maxLength={2000}
          />
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="font-mono text-[9px] leading-relaxed text-slate-500">
              understands cron (“0 8 * * *”), “in 45 minutes”, “weekdays at 9”, “every monday 10am”…
            </p>
            <Button
              type="submit"
              size="sm"
              disabled={creating}
              className="h-8 shrink-0 gap-1.5 bg-purple-400/90 px-3 font-mono text-[11px] text-slate-950 hover:bg-purple-300"
            >
              {creating ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <Wand2 className="h-3.5 w-3.5" aria-hidden />}
              Create automation
            </Button>
          </div>
          {createError ? (
            <p className="animate-mist-fade-in rounded-lg border border-amber-400/25 bg-amber-400/5 p-2 font-mono text-[10px] leading-relaxed text-amber-300">
              {createError}
            </p>
          ) : null}
        </form>
      </section>

      {/* ---- jobs ---- */}
      <section aria-label="Scheduled jobs" className="flex min-w-0 flex-col gap-2">
        {jobs === null && loadError === null ? (
          <div className="space-y-2.5" aria-hidden>
            {[0, 1].map((i) => (
              <Skeleton key={i} className="h-24 w-full rounded-xl bg-white/5" />
            ))}
          </div>
        ) : loadError !== null && jobs === null ? (
          <div className="mist-glass-soft flex flex-col items-start gap-3 p-4">
            <p className="font-mono text-[11px] text-rose-300/90">scheduler unreachable — {loadError}</p>
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
        ) : total === 0 ? (
          <div className="mist-glass-soft rounded-xl p-4 text-center">
            <p className="text-xs text-slate-400">No automations yet.</p>
            <p className="mt-1 font-mono text-[10px] text-slate-500">
              Describe one above — “every day at 9am, summarize my unread research” — and M.I.S.T. schedules it.
            </p>
          </div>
        ) : (
          <>
            {jobs !== null && loadError !== null ? (
              <p className="font-mono text-[10px] text-amber-300/70">refresh failed — showing last known jobs</p>
            ) : null}
            <div className="mist-scroll max-h-96 min-w-0 space-y-2.5 overflow-y-auto pr-1">
              {jobs?.map((job) => (
                <JobCard
                  key={job.id}
                  job={job}
                  expanded={expanded === job.id}
                  busy={busyId === job.id}
                  onToggleExpand={() => setExpanded((e) => (e === job.id ? null : job.id))}
                  onRun={() => onRun(job)}
                  onToggleEnabled={() => onToggleEnabled(job)}
                  onRequestDelete={() => setConfirmDelete(job)}
                />
              ))}
            </div>
          </>
        )}
      </section>

      {/* ---- delete confirmation ---- */}
      <AlertDialog open={confirmDelete != null} onOpenChange={(o) => !o && setConfirmDelete(null)}>
        <AlertDialogContent className="border-white/10 bg-slate-950/95 backdrop-blur-2xl sm:max-w-sm">
          <AlertDialogHeader>
            <AlertDialogTitle className="font-mono text-sm tracking-widest text-rose-300">
              DELETE AUTOMATION?
            </AlertDialogTitle>
            <AlertDialogDescription className="font-mono text-[11px] leading-relaxed text-slate-400">
              “{confirmDelete?.name}” will stop firing immediately and its schedule will be forgotten. This cannot be
              undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="gap-2 sm:justify-end">
            <AlertDialogCancel className="font-mono text-xs">Keep it</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault()
                if (confirmDelete) onDelete(confirmDelete)
              }}
              disabled={busyId === confirmDelete?.id}
              className="bg-rose-400/90 font-mono text-xs text-slate-950 hover:bg-rose-300"
            >
              {busyId === confirmDelete?.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : null}
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
