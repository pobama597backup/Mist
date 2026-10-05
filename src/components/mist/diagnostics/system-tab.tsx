'use client'

// SystemTab — backend vitals: core health, resource gauges, CPU history
// sparkline and the LLM provider matrix.

import { useCallback, useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import { RotateCw } from 'lucide-react'
import { useBackendStatus } from '@/hooks/use-backend'
import { useTelemetry } from '@/hooks/use-telemetry'
import { mistApi } from '@/lib/mist-api'
import { cn } from '@/lib/utils'
import { GaugeCard, MonoBadge, SectionLabel, Sparkline, StatusDot, metricTextColor } from './shared'
import { Skeleton } from '@/components/ui/skeleton'
import { Button } from '@/components/ui/button'
import { SelfDoctorCard } from './self-doctor-card'
import type { LlmStatus } from '@/lib/types'

export function SystemTab() {
  const backend = useBackendStatus()
  const { data: t, history, error: telemetryError } = useTelemetry(true, 2000)

  const [version, setVersion] = useState<string | null>(null)
  const [llm, setLlm] = useState<LlmStatus | null>(null)
  const [llmLoading, setLlmLoading] = useState(true)
  const [llmError, setLlmError] = useState<string | null>(null)
  const [reloadKey, setReloadKey] = useState(0)

  useEffect(() => {
    let alive = true
    mistApi
      .health()
      .then((h) => {
        if (alive) setVersion(h.version)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [])

  useEffect(() => {
    let alive = true
    mistApi
      .llm.status()
      .then((s) => {
        if (alive) setLlm(s)
      })
      .catch((e) => {
        if (alive) setLlmError(e instanceof Error ? e.message : 'provider status unavailable')
      })
      .finally(() => {
        if (alive) setLlmLoading(false)
      })
    return () => {
      alive = false
    }
  }, [reloadKey])

  const retryProviders = () => {
    setLlmLoading(true)
    setLlmError(null)
    setReloadKey((k) => k + 1)
  }

  const cpuHistory = history.map((h) => h.cpu_percent)

  const ramPct = t ? t.ram_percent : 0
  const rssPct = t ? Math.min(100, (t.rss_mb / 1024) * 100) : 0

  return (
    <div className="flex min-w-0 flex-col gap-4">
      {/* ---- backend card ---- */}
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.25 }}
        className="mist-glass-soft p-4"
      >
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2.5">
            <StatusDot className={backend.online ? 'bg-emerald-400' : 'bg-rose-400'} />
            <span className="font-mono text-xs tracking-[0.2em] text-slate-200">MIST-CORE</span>
          </div>
          <span
            className={cn(
              'font-mono text-[10px] tabular-nums',
              backend.online ? 'text-emerald-300' : 'text-rose-300'
            )}
          >
            {backend.online ? (backend.latency != null ? `${backend.latency}ms` : 'online') : 'offline'}
          </span>
        </div>
        <div className="mt-2.5 flex flex-wrap gap-x-3 gap-y-1 font-mono text-[10px] text-slate-500">
          <span className="shrink-0">v{version ?? '—'}</span>
          {t ? (
            <span className="min-w-0 truncate" title={`${t.platform} · node ${t.node_version} · ${t.hostname}`}>
              {t.platform} · node {t.node_version} · {t.hostname}
            </span>
          ) : (
            <span className="text-slate-500">{telemetryError ? 'telemetry offline' : 'reading platform…'}</span>
          )}
        </div>
      </motion.div>

      {/* ---- resource gauges ---- */}
      {t ? (
        <div className="grid grid-cols-2 gap-3">
          <GaugeCard label="CPU" value={`${Math.round(t.cpu_percent)}%`} pct={t.cpu_percent} />
          <GaugeCard
            label="RAM"
            value={`${Math.round(t.ram_percent)}%`}
            pct={ramPct}
            sub={`${(t.ram_used_mb / 1024).toFixed(1)}/${(t.ram_total_mb / 1024).toFixed(0)} GB`}
          />
          <GaugeCard
            label="DISK"
            value={`${Math.round(t.disk_percent)}%`}
            pct={t.disk_percent}
            sub={`${t.disk_used_gb.toFixed(0)}/${t.disk_total_gb.toFixed(0)} GB`}
          />
          <GaugeCard label="RSS" value={`${Math.round(t.rss_mb)} MB`} pct={rssPct} sub="process · of 1 GB" />
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="mist-glass-soft p-3">
              <Skeleton className="h-3 w-12 bg-white/5" />
              <Skeleton className="mt-2 h-6 w-16 bg-white/5" />
              <Skeleton className="mt-3 h-1.5 w-full bg-white/5" />
            </div>
          ))}
        </div>
      )}

      {/* ---- cpu history ---- */}
      <div className="mist-glass-soft p-4">
        <SectionLabel
          right={
            t ? (
              <span className={cn('font-mono text-[10px] tabular-nums', metricTextColor(t.cpu_percent))}>
                {Math.round(t.cpu_percent)}%
              </span>
            ) : null
          }
        >
          cpu history (2s samples)
        </SectionLabel>
        {cpuHistory.length > 0 ? (
          <Sparkline
            values={cpuHistory}
            color="purple"
            max={100}
            className="mt-3 h-12"
            label={`CPU history, last ${cpuHistory.length} samples`}
          />
        ) : (
          <div className="mt-3 flex h-12 items-center font-mono text-[10px] text-slate-500">
            {telemetryError ? 'telemetry offline — will resume when core answers' : 'collecting samples…'}
          </div>
        )}
      </div>

      {/* ---- providers ---- */}
      <div className="mist-glass-soft p-4">
        <SectionLabel
          right={
            llmError ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={retryProviders}
                className="h-6 gap-1 px-2 font-mono text-[10px] text-slate-400 hover:text-slate-200"
              >
                <RotateCw className="h-3 w-3" aria-hidden="true" /> retry
              </Button>
            ) : null
          }
        >
          llm providers
        </SectionLabel>
        <div className="mt-3 space-y-2">
          {llmLoading ? (
            Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="flex items-center justify-between gap-2">
                <Skeleton className="h-4 w-28 bg-white/5" />
                <Skeleton className="h-4 w-20 bg-white/5" />
              </div>
            ))
          ) : llmError ? (
            <p className="font-mono text-[10px] text-rose-300/80">{llmError}</p>
          ) : (
            (llm?.providers_detail ?? []).map((p) => (
              <div key={p.id} className="flex items-center justify-between gap-2">
                <span className="min-w-0 truncate text-xs text-slate-300">{p.label}</span>
                <span className="flex shrink-0 items-center gap-2">
                  {p.model ? (
                    <span className="max-w-32 truncate font-mono text-[10px] text-slate-500" title={p.model}>
                      {p.model}
                    </span>
                  ) : null}
                  {p.available ? (
                    <MonoBadge className="border-emerald-400/30 bg-emerald-400/10 text-emerald-300">ready</MonoBadge>
                  ) : (
                    <MonoBadge className="border-white/10 bg-white/5 text-slate-500">not configured</MonoBadge>
                  )}
                </span>
              </div>
            ))
          )}
        </div>
      </div>

      {/* ---- self-doctor (introspection v1.0 — she catches her own shortcomings) ---- */}
      <SelfDoctorCard />
    </div>
  )
}
