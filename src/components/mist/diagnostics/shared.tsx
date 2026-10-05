'use client'

// Shared presentational helpers for the M.I.S.T. diagnostics tabs + settings.
// Small, dependency-free widgets so every panel stays visually identical.

import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

// ---------- metric coloring (emerald < 60 · amber < 85 · rose >= 85) ----------

export function metricTextColor(pct: number): string {
  if (pct < 60) return 'text-emerald-300'
  if (pct < 85) return 'text-amber-300'
  return 'text-rose-300'
}

export function metricBarColor(pct: number): string {
  if (pct < 60) return 'bg-emerald-400/80'
  if (pct < 85) return 'bg-amber-300/80'
  return 'bg-rose-400/80'
}

// ---------- tiny sparkline (hand-rolled div bars — zero deps, animates well) ----------

export type SparkColor = 'purple' | 'emerald' | 'amber' | 'teal' | 'fuchsia'

const SPARK_BG: Record<SparkColor, string> = {
  purple: 'bg-purple-400',
  emerald: 'bg-emerald-400',
  amber: 'bg-amber-300',
  teal: 'bg-teal-300',
  fuchsia: 'bg-fuchsia-400',
}

export function Sparkline({
  values,
  color,
  max = 100,
  className,
  label,
}: {
  values: number[]
  color: SparkColor
  max?: number
  className?: string
  label?: string
}) {
  const n = values.length
  return (
    <div
      className={cn('flex min-w-0 items-end gap-[2px]', className)}
      role="img"
      aria-label={label ?? 'sparkline'}
    >
      {values.map((v, i) => {
        const pct = Math.max(2, Math.min(100, (v / max) * 100))
        const opacity = n > 1 ? 0.25 + (0.75 * i) / (n - 1) : 1
        return (
          <div
            key={i}
            className={cn('min-w-0 flex-1 rounded-[1px] transition-[height] duration-300', SPARK_BG[color])}
            style={{ height: `${pct}%`, opacity }}
          />
        )
      })}
    </div>
  )
}

// ---------- gauge card (label + value + threshold bar) ----------

export function GaugeCard({
  label,
  value,
  sub,
  pct,
}: {
  label: string
  value: string
  sub?: string
  pct: number
}) {
  const clamped = Math.max(0, Math.min(100, pct))
  return (
    <div className="mist-glass-soft mist-glass-hover p-3">
      <div className="flex items-baseline justify-between gap-2">
        <span className="font-mono text-[10px] uppercase tracking-widest text-slate-500">{label}</span>
        {sub ? <span className="truncate font-mono text-[10px] text-slate-500">{sub}</span> : null}
      </div>
      <div className={cn('mt-1 font-mono text-xl tabular-nums', metricTextColor(clamped))}>{value}</div>
      <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-white/10" role="progressbar" aria-valuenow={Math.round(clamped)} aria-valuemin={0} aria-valuemax={100} aria-label={label}>
        <div
          className={cn('h-full rounded-full transition-all duration-500', metricBarColor(clamped))}
          style={{ width: `${clamped}%` }}
        />
      </div>
    </div>
  )
}

// ---------- status dot ----------

export function StatusDot({ className, pulse = true }: { className: string; pulse?: boolean }) {
  return <span className={cn('inline-block h-2 w-2 shrink-0 rounded-full', pulse && 'animate-mist-pulse-glow', className)} />
}

// ---------- mono pill badge ----------

export function MonoBadge({
  children,
  className,
  title,
}: {
  children: ReactNode
  className?: string
  title?: string
}) {
  return (
    <span
      title={title}
      className={cn(
        'inline-flex w-fit shrink-0 items-center rounded-full border px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wide',
        className
      )}
    >
      {children}
    </span>
  )
}

// ---------- relative time ----------

export function relTime(iso: string): string {
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return ''
  const s = Math.max(0, Math.floor((Date.now() - then) / 1000))
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

// ---------- section header inside a tab ----------

export function SectionLabel({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="font-mono text-[10px] uppercase tracking-[0.25em] text-slate-500">{children}</span>
      {right}
    </div>
  )
}
