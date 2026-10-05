'use client'

// SelfDoctorCard — the self-doctor panel (introspection v1.0): the probe
// battery, findings with their repair lanes, and what she repaired herself.
// Lives inside the System tab (adding an 11th drawer tab would orphan the
// grid — the exact regression class the ui probe now guards against).

import { useCallback, useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import { Activity, CheckCircle2, AlertTriangle, XCircle, Loader2 } from 'lucide-react'
import { mistApi, type IntrospectionReportResponse } from '@/lib/mist-api'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { MonoBadge, SectionLabel } from './shared'

const PROBE_LABELS: Record<string, string> = {
  providers: 'providers',
  apis: 'api surface',
  ui: 'ui render',
  tools: 'tool body',
  'toolchain-honesty': 'honesty filter',
  'evolution-gates': 'evolution gates',
  db: 'database',
  devlog: 'dev log',
  'self-model': 'self-model',
  dreams: 'dream cycle',
}

const STATUS_STYLES = {
  pass: 'border-emerald-400/30 bg-emerald-400/10 text-emerald-300',
  warn: 'border-amber-400/30 bg-amber-400/10 text-amber-300',
  fail: 'border-rose-400/30 bg-rose-400/10 text-rose-300',
} as const

function timeAgo(iso: string): string {
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000))
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.round(s / 60)}m ago`
  return `${Math.round(s / 3600)}h ago`
}

export function SelfDoctorCard() {
  const [report, setReport] = useState<IntrospectionReportResponse | null>(null)
  const [neverRan, setNeverRan] = useState(false)
  const [loading, setLoading] = useState(true)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const loadLast = useCallback(() => {
    mistApi.introspection
      .last()
      .then((res) => {
        if ('never_ran' in res) {
          setNeverRan(true)
          setReport(null)
        } else {
          setNeverRan(false)
          setReport(res)
        }
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'unavailable'))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    loadLast()
  }, [loadLast])

  const runSweep = async () => {
    setRunning(true)
    setError(null)
    try {
      const res = await mistApi.introspection.run(true)
      setReport(res)
      setNeverRan(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'sweep failed')
    } finally {
      setRunning(false)
    }
  }

  const failCount = report?.findings.filter((f) => f.severity === 'fail').length ?? 0
  const warnCount = report?.findings.filter((f) => f.severity === 'warn').length ?? 0

  return (
    <div className="mist-glass-soft p-4">
      <SectionLabel
        right={
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={runSweep}
            disabled={running}
            className="h-6 gap-1 px-2 font-mono text-[10px] text-slate-400 hover:text-slate-200"
          >
            {running ? (
              <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
            ) : (
              <Activity className="h-3 w-3" aria-hidden="true" />
            )}
            {running ? 'sweeping…' : 'run deep self-check'}
          </Button>
        }
      >
        self-doctor (introspection)
      </SectionLabel>

      {loading ? (
        <p className="mt-3 font-mono text-[10px] text-slate-500">reading last sweep…</p>
      ) : error ? (
        <p className="mt-3 font-mono text-[10px] text-rose-300/80">{error}</p>
      ) : neverRan || !report ? (
        <p className="mt-3 font-mono text-[10px] text-slate-500">
          no sweep yet — she checks herself every 30 minutes, or run one now
        </p>
      ) : (
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="mt-3 space-y-3">
          {/* summary line */}
          <div className="flex flex-wrap items-center gap-2">
            <span className="flex items-center gap-1.5 font-mono text-[10px] text-slate-400">
              {report.all_green ? (
                <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" aria-hidden="true" />
              ) : failCount > 0 ? (
                <XCircle className="h-3.5 w-3.5 text-rose-400" aria-hidden="true" />
              ) : (
                <AlertTriangle className="h-3.5 w-3.5 text-amber-400" aria-hidden="true" />
              )}
              {report.all_green
                ? `all ${report.probes.length} probes green`
                : `${failCount} fail · ${warnCount} warn`}
              <span className="text-slate-600">·</span>
              <span className="text-slate-500">{timeAgo(report.ran_at)} ({report.source})</span>
              <span className="text-slate-600">·</span>
              <span className="text-slate-500">{Math.round(report.duration_ms / 100) / 10}s</span>
            </span>
          </div>

          {/* probe chips */}
          <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-5" role="list" aria-label="probe statuses">
            {report.probes.map((p) => (
              <div
                key={p.id}
                role="listitem"
                title={`${p.id}: ${p.status}${p.note ? ` — ${p.note}` : ''}`}
                className={cn(
                  'flex items-center justify-between gap-1 rounded-md border px-2 py-1 font-mono text-[10px]',
                  STATUS_STYLES[p.status]
                )}
              >
                <span className="min-w-0 truncate">{PROBE_LABELS[p.id] ?? p.id}</span>
                <span className="shrink-0 tabular-nums opacity-70">{p.status === 'pass' ? '✓' : p.status === 'warn' ? '!' : '✗'}</span>
              </div>
            ))}
          </div>

          {/* findings */}
          {report.findings.length > 0 && (
            <div className="space-y-1.5">
              <p className="font-mono text-[10px] tracking-wider text-slate-500">FINDINGS</p>
              <div className="max-h-44 space-y-1.5 overflow-y-auto pr-1">
                {report.findings.map((f) => (
                  <div key={f.fingerprint} className="rounded-md border border-white/5 bg-white/[0.03] px-2.5 py-1.5">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <MonoBadge
                        className={cn(
                          'shrink-0',
                          f.severity === 'fail'
                            ? STATUS_STYLES.fail
                            : STATUS_STYLES.warn
                        )}
                      >
                        {f.severity}
                      </MonoBadge>
                      <span className="min-w-0 flex-1 truncate text-xs text-slate-200">{f.title}</span>
                      <MonoBadge className="shrink-0 border-white/10 bg-white/5 text-slate-500">{f.repair_class}</MonoBadge>
                    </div>
                    <p className="mt-1 line-clamp-2 font-mono text-[10px] leading-relaxed text-slate-500">{f.detail}</p>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* repairs she made */}
          {report.repairs.length > 0 && (
            <div className="space-y-1.5">
              <p className="font-mono text-[10px] tracking-wider text-slate-500">SELF-REPAIRS</p>
              <div className="max-h-32 space-y-1 overflow-y-auto pr-1">
                {report.repairs.map((r, i) => (
                  <div key={i} className="flex items-start gap-2 rounded-md border border-white/5 bg-white/[0.03] px-2.5 py-1.5">
                    <MonoBadge className="mt-0.5 shrink-0 border-violet-400/30 bg-violet-400/10 text-violet-300">{r.lane}</MonoBadge>
                    <div className="min-w-0">
                      <p className="truncate text-xs text-slate-300">{r.finding}</p>
                      <p className="font-mono text-[10px] leading-relaxed text-slate-500">{r.outcome}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </motion.div>
      )}
    </div>
  )
}
