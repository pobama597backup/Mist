'use client'

// EfficiencyTab — the OpenJarvis intelligence-per-watt dashboard, honestly
// adapted: tokens, latency and estimated cost across providers and agents.
// No GPU rails in this house — the currency is tokens and seconds.

import { useCallback, useEffect, useState } from 'react'
import { Activity, Coins, Gauge, Info, MessageCircle, RefreshCw, Timer, TriangleAlert } from 'lucide-react'
import { toast } from 'sonner'
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from 'recharts'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from '@/components/ui/chart'
import { cn } from '@/lib/utils'
import { ojApi, type EfficiencyResponse, type EfficiencySlice } from '@/lib/oj/lab-api'
import { MonoBadge, SectionLabel } from './shared'

// ---------- helpers ----------

function fmtNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

function fmtMs(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.round(ms)}ms`
}

function fmtUsd(n: number): string {
  if (n === 0) return '$0'
  if (n < 0.01) return `≈$${n.toFixed(4)}`
  return `≈$${n.toFixed(2)}`
}

const chartConfig = {
  requests: { label: 'requests', color: 'var(--chart-1)' },
  tokens: { label: 'tokens', color: 'var(--chart-2)' },
} satisfies ChartConfig

// ---------- totals card ----------

function TotalCard({
  icon: Icon,
  label,
  value,
  sub,
  tone,
}: {
  icon: typeof Activity
  label: string
  value: string
  sub?: string
  tone?: string
}) {
  return (
    <div className="mist-glass-soft mist-glass-hover p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-[9px] uppercase tracking-widest text-slate-600">{label}</span>
        <Icon aria-hidden className="h-3 w-3 shrink-0 text-slate-600" />
      </div>
      <p className={cn('mt-1 font-mono text-lg tabular-nums', tone ?? 'text-slate-100')}>{value}</p>
      {sub ? <p className="mt-0.5 font-mono text-[9px] text-slate-600">{sub}</p> : null}
    </div>
  )
}

// ---------- per-provider / per-agent row ----------

function SliceRow({ slice, max, kind }: { slice: EfficiencySlice; max: number; kind: 'provider' | 'agent' }) {
  const name = kind === 'provider' ? (slice.provider ?? 'unknown') : (slice.agent ?? 'unknown')
  const pct = max > 0 ? Math.max(4, Math.min(100, (slice.requests / max) * 100)) : 0
  return (
    <div className="mist-glass-soft rounded-xl p-2.5">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-slate-200">{name}</span>
        <span className="font-mono text-[10px] tabular-nums text-slate-400">
          {slice.requests} req
        </span>
        <span className="font-mono text-[10px] tabular-nums text-slate-500">{fmtMs(slice.avgLatencyMs)}</span>
        <span className="font-mono text-[10px] tabular-nums text-amber-300/80">{fmtUsd(slice.costUsd)}</span>
      </div>
      <div
        className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-white/10"
        role="progressbar"
        aria-valuenow={slice.requests}
        aria-valuemin={0}
        aria-valuemax={max}
        aria-label={`${name} requests`}
      >
        <div className="h-full rounded-full bg-purple-400/70 transition-all duration-500" style={{ width: `${pct}%` }} />
      </div>
      <div className="mt-1 flex items-center justify-between font-mono text-[9px] tabular-nums text-slate-600">
        <span>
          ↑{fmtNum(slice.tokensIn)} ↓{fmtNum(slice.tokensOut)} tokens
        </span>
        <span>{((slice.requests / max) * 100).toFixed(0)}% of peak</span>
      </div>
    </div>
  )
}

// ---------- the tab ----------

export function EfficiencyTab() {
  const [data, setData] = useState<EfficiencyResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async (silent = false) => {
    if (!silent) setLoading(true)
    try {
      const res = await ojApi.efficiency()
      setData(res)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'efficiency analytics unreachable')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  if (loading) {
    return (
      <div className="space-y-3" aria-busy="true" aria-label="loading efficiency analytics">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <Skeleton key={i} className="h-20 w-full rounded-xl" />
          ))}
        </div>
        <Skeleton className="h-40 w-full rounded-xl" />
        <Skeleton className="h-16 w-full rounded-xl" />
      </div>
    )
  }

  if (error || !data) {
    return (
      <div role="alert" className="mist-glass rounded-xl p-4">
        <p className="flex items-center gap-2 text-sm text-rose-300">
          <TriangleAlert aria-hidden className="h-4 w-4" />
          efficiency analytics unreachable
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

  const { totals, perProvider, perAgent, perDay } = data
  const hasTraffic = totals.requests > 0
  const maxProviderReq = Math.max(1, ...perProvider.map((p) => p.requests))
  const maxAgentReq = Math.max(1, ...perAgent.map((a) => a.requests))
  const chartData = perDay.map((d) => ({ ...d, day: d.day.slice(5) }))

  return (
    <div className="space-y-3">
      <SectionLabel
        right={
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              toast.promise(refresh(), {
                loading: 'recomputing…',
                success: 'efficiency analytics refreshed',
                error: (e) => (e instanceof Error ? e.message : 'refresh failed'),
              })
            }
            className="h-7 border-white/10 bg-white/5 px-2 font-mono text-[9px] uppercase tracking-widest text-slate-300 hover:border-purple-400/40 hover:text-purple-200"
            aria-label="refresh efficiency analytics"
          >
            <RefreshCw aria-hidden className="h-3 w-3" />
            refresh
          </Button>
        }
      >
        <span className="inline-flex items-center gap-1.5">
          <Gauge aria-hidden className="h-3 w-3 text-slate-500" />
          efficiency dashboard
        </span>
      </SectionLabel>

      {/* ---- totals ---- */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3" aria-label="totals">
        <TotalCard icon={Activity} label="requests" value={String(totals.requests)} sub="traced LLM calls" />
        <TotalCard icon={Timer} label="avg latency" value={fmtMs(totals.avgLatencyMs)} sub="per request" />
        <TotalCard
          icon={Coins}
          label="est. cost"
          value={fmtUsd(totals.costUsd)}
          sub="estimated — see note"
          tone="text-amber-300"
        />
        <TotalCard icon={Activity} label="tokens in" value={fmtNum(totals.tokensIn)} sub="chars/4 estimate" />
        <TotalCard icon={Activity} label="tokens out" value={fmtNum(totals.tokensOut)} sub="chars/4 estimate" />
        <TotalCard
          icon={Gauge}
          label="tokens / request"
          value={totals.requests > 0 ? fmtNum(Math.round((totals.tokensIn + totals.tokensOut) / totals.requests)) : '—'}
          sub="in + out, averaged"
        />
      </div>

      {/* ---- per-day chart ---- */}
      <SectionLabel>
        <span className="inline-flex items-center gap-1.5">
          <Activity aria-hidden className="h-3 w-3 text-slate-500" />
          requests per day
        </span>
      </SectionLabel>
      {chartData.length === 0 ? (
        <div className="mist-glass rounded-xl p-6 text-center">
          <MessageCircle aria-hidden className="mx-auto h-5 w-5 text-slate-600" />
          <p className="mt-2 text-sm text-slate-300">no traffic yet — chat with her first</p>
        </div>
      ) : (
        <div className="mist-glass-soft p-3" aria-label="requests per day bar chart">
          <ChartContainer config={chartConfig} className="h-40 w-full">
            <BarChart data={chartData} margin={{ top: 4, right: 4, left: -28, bottom: 0 }}>
              <CartesianGrid vertical={false} strokeDasharray="3 3" />
              <XAxis dataKey="day" tickLine={false} axisLine={false} tickMargin={6} fontSize={10} />
              <YAxis tickLine={false} axisLine={false} fontSize={10} allowDecimals={false} />
              <ChartTooltip
                cursor={{ fill: 'rgba(255,255,255,0.04)' }}
                content={
                  <ChartTooltipContent
                    formatter={(value, name) => (
                      <span className="font-mono text-[10px] text-slate-300">
                        {name === 'tokens' ? `${fmtNum(Number(value))} tokens` : `${value} requests`}
                      </span>
                    )}
                  />
                }
              />
              <Bar dataKey="requests" fill="var(--color-requests)" radius={[3, 3, 0, 0]} maxBarSize={28} />
            </BarChart>
          </ChartContainer>
          <p className="mt-1.5 text-center font-mono text-[9px] text-slate-600">
            {perDay.length} day{perDay.length === 1 ? '' : 's'} · {fmtNum(perDay.reduce((s, d) => s + d.tokens, 0))} tokens total (hover for detail)
          </p>
        </div>
      )}

      {/* ---- per provider ---- */}
      <SectionLabel right={<MonoBadge className="border-white/10 text-slate-600">{perProvider.length}</MonoBadge>}>
        <span className="inline-flex items-center gap-1.5">
          <Activity aria-hidden className="h-3 w-3 text-slate-500" />
          per provider
        </span>
      </SectionLabel>
      {perProvider.length === 0 ? (
        <p className="px-1 text-[11px] text-slate-600">no provider traffic recorded yet</p>
      ) : (
        <div className="space-y-2" aria-label="per provider breakdown">
          {perProvider.map((p) => (
            <SliceRow key={p.provider ?? 'unknown'} slice={p} max={maxProviderReq} kind="provider" />
          ))}
        </div>
      )}

      {/* ---- per agent ---- */}
      <SectionLabel right={<MonoBadge className="border-white/10 text-slate-600">{perAgent.length}</MonoBadge>}>
        <span className="inline-flex items-center gap-1.5">
          <Activity aria-hidden className="h-3 w-3 text-slate-500" />
          per agent
        </span>
      </SectionLabel>
      {perAgent.length === 0 ? (
        <p className="px-1 text-[11px] text-slate-600">no agent traffic recorded yet</p>
      ) : (
        <div className="space-y-2" aria-label="per agent breakdown">
          {perAgent.map((a) => (
            <SliceRow key={a.agent ?? 'unknown'} slice={a} max={maxAgentReq} kind="agent" />
          ))}
        </div>
      )}

      {/* ---- honesty note ---- */}
      <p className="flex items-start gap-1.5 rounded-xl border border-white/5 bg-white/[0.02] px-2.5 py-2 font-mono text-[9px] leading-relaxed text-slate-500">
        <Info aria-hidden className="mt-0.5 h-3 w-3 shrink-0 text-slate-600" />
        costs are estimates from the documented price table — core/keyless lanes (her free cascade) cost $0, keyed
        lanes are priced at public list rates. token counts use the chars/4 basis; latencies are wall-clock.
        {hasTraffic ? '' : ' no traffic recorded yet, so every number above is honestly zero.'}
      </p>
    </div>
  )
}
