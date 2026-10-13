'use client'

// ControlRoomTab — Phase 6-a: the owner surface over the Arbiter's authority.
//
// Three rooms in one tab (the phase2-closeout backlog: "standing-order owner
// UI" + "Why did she do that?" audit viewer + the A4 panel):
//   · AUTONOMY — the current scope badge, the live A4 session state, the
//     ONE-TAP KILL (bodyless DELETE /api/mist/autonomy/unleash — designed for
//     exactly this), and the candor dial chip. Starting A4 is NOT possible
//     here by design: the passphrased ritual lives in Settings
//     (POST /api/mist/autonomy/unleash).
//   · STANDING ORDERS — rule cards (create/revoke) backed by
//     /api/mist/orders; the same cards the engine's arbitrate() matches, so
//     what you see here is what authorizes her.
//   · AUDIT TRAIL — the hash-chained decision history with a live chain-
//     validity badge (recomputed server-side on every read, never trusting
//     stored hashes) and cursor "load more".
//
// Fetches mirror the mist-api.ts json() helper locally (the typed client is
// frozen for this agent) — same headers, same error extraction, same-origin.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Ban,
  ChevronDown,
  Loader2,
  Plus,
  RefreshCw,
  ScrollText,
  ShieldCheck,
  Skull,
  X,
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
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import type { ToolInfo } from '@/lib/types'
import { cn } from '@/lib/utils'
import { MonoBadge, SectionLabel, relTime } from './shared'
import { useInterval } from '@/hooks/use-interval'

// ---------- the local fetch helper (mist-api.ts shape, client frozen) ----------

class ControlRoomApiError extends Error {
  status: number
  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api/mist${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    cache: 'no-store',
  })
  if (!res.ok) {
    let detail = res.statusText
    try {
      const body = (await res.json()) as { error?: unknown }
      if (body && typeof body.error === 'string') detail = body.error
    } catch {
      /* ignore */
    }
    throw new ControlRoomApiError(detail, res.status)
  }
  return (await res.json()) as T
}

// ---------- shared types (mirror the routes' responses) ----------

interface OrderView {
  id: string
  title: string
  tools: string[]
  pathPrefixes: string[]
  budget: { maxCalls?: number; windowMs?: number; spendCapUsd?: number }
  expiryAt: string | null
  active: boolean
  expired: boolean
  createdAt: string
  revokedAt: string | null
  createdBy: string
  usage: { calls: number }
}

interface A4StatusView {
  active: boolean
  remainingMs?: number
  expiryAt?: number
  scope?: { tools: string[]; pathPrefixes: string[]; budget: { maxCalls?: number; windowMs?: number; spendCapUsd?: number }; voiceWaived: boolean }
  usedCalls?: number
  passphraseRequired: boolean
  currentScope: 'A0' | 'A1' | 'A2' | 'A3' | 'A4'
}

interface CandorView {
  mode: 'standard' | 'frank' | 'unfiltered'
  autonomyScope: 'A0' | 'A1' | 'A2' | 'A3'
}

interface AuditEventView {
  id: string
  seq: number
  ts: string
  tool: string
  risk: string
  origin: string
  tainted: boolean
  decision: 'allow' | 'ask' | 'deny' | 'defer'
  reason: string
  argsJson: string
  orderRef?: string | null
  turnId?: string | null
}

interface AuditChainView {
  valid: boolean
  checkedCount: number
  brokenAtSeq?: number
  reason?: string
}

interface AuditPage {
  events: AuditEventView[]
  chain: AuditChainView
  nextBefore: number | null
}

// ---------- palette maps (app palette — no indigo/blue) ----------

const SCOPE_LABEL: Record<string, string> = {
  A0: 'frozen — observe only',
  A1: 'observe — ask to act',
  A2: 'ask-by-default',
  A3: 'standing orders honored',
  A4: 'unleashed — time-boxed',
}

const SCOPE_CLASS: Record<string, string> = {
  A0: 'border-white/10 bg-white/5 text-slate-300',
  A1: 'border-teal-300/30 bg-teal-300/10 text-teal-200',
  A2: 'border-amber-300/30 bg-amber-300/10 text-amber-200',
  A3: 'border-purple-300/30 bg-purple-300/10 text-purple-200',
  A4: 'border-rose-400/40 bg-rose-400/10 text-rose-300',
}

const DECISION_CLASS: Record<string, string> = {
  allow: 'border-emerald-400/30 bg-emerald-400/10 text-emerald-300',
  ask: 'border-amber-300/30 bg-amber-300/10 text-amber-200',
  deny: 'border-rose-400/30 bg-rose-400/10 text-rose-300',
  defer: 'border-white/10 bg-white/5 text-slate-400',
}

const RISK_CLASS: Record<string, string> = {
  read: 'border-emerald-400/20 text-emerald-300/90',
  'sensitive-read': 'border-amber-300/20 text-amber-200/90',
  network: 'border-teal-300/20 text-teal-200/90',
  write: 'border-amber-300/30 text-amber-200',
  persist: 'border-purple-300/25 text-purple-200',
  exec: 'border-rose-400/25 text-rose-300',
  destructive: 'border-rose-400/40 text-rose-300',
  egress: 'border-fuchsia-400/25 text-fuchsia-300',
  'self-modify': 'border-rose-400/40 bg-rose-400/10 text-rose-200',
}

const CANDOR_CLASS: Record<string, string> = {
  standard: 'border-white/10 bg-white/5 text-slate-300',
  frank: 'border-amber-300/30 bg-amber-300/10 text-amber-200',
  unfiltered: 'border-rose-400/30 bg-rose-400/10 text-rose-300',
}

const ORIGINS = ['owner_chat', 'owner_voice', 'owner_cron', 'owner_heartbeat', 'tool_output', 'web', 'skill', 'memory', 'mcp'] as const

/** ms → "2h 03m" / "45s" (for remaining time + expiry countdowns). */
function fmtRemaining(ms: number): string {
  if (ms <= 0) return '0s'
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ${String(m % 60).padStart(2, '0')}m`
  return `${Math.floor(h / 24)}d ${h % 24}h`
}

function fmtWindow(ms: number): string {
  if (ms >= 86_400_000 && ms % 86_400_000 === 0) return `${ms / 86_400_000}d`
  if (ms >= 3_600_000 && ms % 3_600_000 === 0) return `${ms / 3_600_000}h`
  if (ms >= 60_000 && ms % 60_000 === 0) return `${ms / 60_000}m`
  return `${Math.round(ms / 1000)}s`
}

// ============================================================ AUTONOMY / A4

function AutonomySection() {
  const [a4, setA4] = useState<A4StatusView | null>(null)
  const [candor, setCandor] = useState<CandorView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [killing, setKilling] = useState(false)
  const [confirmKill, setConfirmKill] = useState(false)

  const refresh = useCallback(async () => {
    try {
      const [status, dial] = await Promise.all([
        api<A4StatusView>('/autonomy/unleash'),
        api<CandorView>('/candor').catch(() => null),
      ])
      setA4(status)
      if (dial) setCandor(dial)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'unleash status unreachable')
    }
  }, [])

  useEffect(() => {
    // deferred to a macrotask — refresh() setStates synchronously (loading)
    const id = window.setTimeout(() => void refresh(), 0)
    return () => window.clearTimeout(id)
  }, [refresh])
  useInterval(() => {
    void refresh()
  }, 5_000) // the badge lives at 5s resolution — the kill itself is instant

  const kill = async () => {
    setKilling(true)
    try {
      // bodyless DELETE by design — one tap, no passphrase, ever (A6)
      const res = await api<{ ok: boolean; killed: boolean; active: boolean }>('/autonomy/unleash', { method: 'DELETE' })
      toast.success(res.killed ? 'A4 killed — every in-flight turn aborted, scope reverted' : 'No active A4 session — nothing to kill')
      await refresh() // show the honest reverted state immediately
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'kill failed')
    } finally {
      setKilling(false)
    }
  }

  return (
    <section aria-label="Autonomy and unleash state" className="flex min-w-0 flex-col gap-2">
      <SectionLabel
        right={
          candor ? (
            <span className="flex items-center gap-1.5">
              <MonoBadge className={CANDOR_CLASS[candor.mode] ?? CANDOR_CLASS.standard} title="the candor dial (Settings)">
                candor · {candor.mode}
              </MonoBadge>
              <MonoBadge className="border-white/10 text-slate-400" title="the settings autonomy dial (A0–A3)">
                dial · {candor.autonomyScope}
              </MonoBadge>
            </span>
          ) : null
        }
      >
        autonomy / unleash
      </SectionLabel>

      {error && a4 === null ? (
        <div className="mist-glass-soft flex items-center justify-between gap-3 p-3">
          <p className="font-mono text-[11px] text-rose-300/90">unleash status unreachable — {error}</p>
          <Button type="button" variant="outline" size="sm" onClick={() => void refresh()} className="gap-1.5 font-mono text-[10px]">
            <RefreshCw className="h-3 w-3" aria-hidden="true" /> Retry
          </Button>
        </div>
      ) : (
        <div className="mist-glass-soft mist-glass-hover flex min-w-0 flex-col gap-3 p-3">
          <div className="flex flex-wrap items-center gap-2">
            {a4 === null ? (
              <Skeleton className="h-6 w-32 rounded-full bg-white/5" />
            ) : (
              <MonoBadge className={cn('px-2 py-1 text-[11px]', SCOPE_CLASS[a4.currentScope])} title={SCOPE_LABEL[a4.currentScope]}>
                scope {a4.currentScope} — {SCOPE_LABEL[a4.currentScope]}
              </MonoBadge>
            )}
            {a4?.active ? (
              <MonoBadge className="border-rose-400/40 bg-rose-400/10 px-2 py-1 text-[11px] text-rose-300">
                <span className="mr-1 inline-block h-1.5 w-1.5 animate-mist-pulse-glow rounded-full bg-rose-400" aria-hidden="true" />
                A4 session live · {fmtRemaining(a4.remainingMs ?? 0)} left
              </MonoBadge>
            ) : (
              <MonoBadge className="border-white/10 bg-white/5 px-2 py-1 text-[11px] text-slate-400">no unleash session</MonoBadge>
            )}
            {a4?.passphraseRequired ? (
              <MonoBadge className="border-amber-300/30 bg-amber-300/10 px-2 py-1 text-[11px] text-amber-200" title="a passphrase guards starting A4 (Settings)">
                passphrase armed
              </MonoBadge>
            ) : null}
          </div>

          {a4?.active ? (
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-[10px] text-slate-400">
              {a4.scope ? (
                <span>
                  tools: <span className="text-slate-300">{a4.scope.tools.includes('*') ? 'all (*)' : a4.scope.tools.slice(0, 6).join(', ')}</span>
                  {a4.scope.pathPrefixes.length > 0 ? <> · paths: <span className="text-slate-300">{a4.scope.pathPrefixes.join(', ')}</span></> : null}
                </span>
              ) : null}
              {typeof a4.scope?.budget.maxCalls === 'number' ? (
                <span>
                  budget: <span className="text-slate-300">{a4.usedCalls ?? 0}/{a4.scope.budget.maxCalls} calls</span>
                </span>
              ) : null}
              {a4.expiryAt ? (
                <span>
                  reverts at <span className="text-slate-300">{new Date(a4.expiryAt).toLocaleTimeString()}</span>
                </span>
              ) : null}
            </div>
          ) : (
            <p className="font-mono text-[10px] leading-relaxed text-slate-500">
              A4 is reached only through the passphrased unleash ritual (Settings · POST /api/mist/autonomy/unleash) — this room can only end it.
            </p>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={!a4?.active || killing}
              onClick={() => setConfirmKill(true)}
              className="gap-1.5 border-rose-400/30 bg-rose-400/10 font-mono text-[11px] text-rose-300 hover:border-rose-400/50 hover:bg-rose-400/20 hover:text-rose-200 disabled:opacity-40"
            >
              {killing ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <Skull className="h-3.5 w-3.5" aria-hidden="true" />}
              Kill A4 now
            </Button>
            <span className="font-mono text-[10px] text-slate-500">one tap · no passphrase · aborts every in-flight turn ≤1s</span>
          </div>
        </div>
      )}

      <AlertDialog open={confirmKill} onOpenChange={setConfirmKill}>
        <AlertDialogContent className="border-white/10 bg-slate-950/95 backdrop-blur-2xl sm:max-w-sm">
          <AlertDialogHeader>
            <AlertDialogTitle className="font-mono text-sm tracking-widest text-rose-300">
              KILL THE A4 SESSION?
            </AlertDialogTitle>
            <AlertDialogDescription className="font-mono text-[11px] leading-relaxed text-slate-400">
              Every in-flight turn is aborted immediately (state of a running actuator becomes
              honestly unknown), the scope reverts, and the kill is audit-logged. No passphrase
              is needed — one tap is the point.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="gap-2 sm:justify-end">
            <AlertDialogCancel className="font-mono text-xs">Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setConfirmKill(false)
                void kill()
              }}
              className="bg-rose-400/90 font-mono text-xs text-slate-950 hover:bg-rose-300"
            >
              Kill it
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  )
}

// ============================================================ STANDING ORDERS

const EXPIRY_PRESETS = [
  { value: 'none', label: 'no expiry' },
  { value: '15', label: '15 minutes' },
  { value: '60', label: '1 hour' },
  { value: '360', label: '6 hours' },
  { value: '1440', label: '24 hours' },
  { value: '10080', label: '7 days' },
] as const

function OrderCard({ order, onRevoke, revoking }: { order: OrderView; onRevoke: (o: OrderView) => void; revoking: boolean }) {
  const state = !order.active
    ? { label: 'revoked', cls: 'border-white/10 bg-white/5 text-slate-500' }
    : order.expired
      ? { label: 'expired', cls: 'border-amber-300/30 bg-amber-300/10 text-amber-200' }
      : { label: 'active', cls: 'border-emerald-400/30 bg-emerald-400/10 text-emerald-300' }
  const budgetBits: string[] = []
  if (typeof order.budget.maxCalls === 'number') {
    budgetBits.push(`${order.usage.calls}/${order.budget.maxCalls} calls`)
    if (typeof order.budget.windowMs === 'number') budgetBits.push(`${fmtWindow(order.budget.windowMs)} window`)
  }
  if (typeof order.budget.spendCapUsd === 'number') budgetBits.push(`≤ $${order.budget.spendCapUsd}`)
  return (
    <div className={cn('mist-glass-soft min-w-0 p-3', !order.active && 'opacity-60')}>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-slate-200" title={order.title}>
          {order.title}
        </span>
        <MonoBadge className={state.cls}>{state.label}</MonoBadge>
        {order.active ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={revoking}
            onClick={() => onRevoke(order)}
            className="h-7 gap-1 border-rose-400/20 px-2 font-mono text-[10px] text-rose-300 hover:border-rose-400/40 hover:bg-rose-400/10 disabled:opacity-40"
          >
            {revoking ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" /> : <Ban className="h-3 w-3" aria-hidden="true" />}
            Revoke
          </Button>
        ) : null}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {order.tools.map((t) => (
          <MonoBadge key={t} className={t === '*' ? 'border-purple-300/40 bg-purple-300/10 text-purple-200' : 'border-purple-300/25 text-purple-200'}>
            {t}
          </MonoBadge>
        ))}
      </div>
      {order.pathPrefixes.length > 0 ? (
        <p className="mt-1.5 break-all font-mono text-[10px] text-slate-400">paths: {order.pathPrefixes.join(' · ')}</p>
      ) : null}
      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[10px] text-slate-500">
        {budgetBits.length > 0 ? <span className="text-slate-400">{budgetBits.join(' · ')}</span> : <span>no budget cap</span>}
        {order.expiryAt ? (
          order.expired ? (
            <span className="text-amber-300/80">expired {relTime(order.expiryAt)}</span>
          ) : (
            <span className="text-teal-300/80">expires in {fmtRemaining(new Date(order.expiryAt).getTime() - Date.now())}</span>
          )
        ) : (
          <span>no expiry</span>
        )}
        <span>created {relTime(order.createdAt)}</span>
      </div>
    </div>
  )
}

function CreateOrderForm({
  tools,
  toolsError,
  onCreate,
  creating,
}: {
  tools: ToolInfo[] | null
  toolsError: string | null
  onCreate: (payload: {
    title: string
    tools: string[]
    pathPrefixes: string[]
    budget: { maxCalls?: number; windowMs?: number; spendCapUsd?: number }
    expiryAt: string | null
  }) => Promise<boolean>
  creating: boolean
}) {
  const [title, setTitle] = useState('')
  const [wildcard, setWildcard] = useState(false)
  const [selected, setSelected] = useState<string[]>([])
  const [search, setSearch] = useState('')
  const [prefixes, setPrefixes] = useState('')
  const [maxCalls, setMaxCalls] = useState('')
  const [windowMin, setWindowMin] = useState('')
  const [spendCap, setSpendCap] = useState('')
  const [expiry, setExpiry] = useState<string>('none')

  const visibleTools = useMemo(() => {
    const q = search.trim().toLowerCase()
    const list = tools ?? []
    if (!q) return list.slice(0, 40)
    return list.filter((t) => t.name.toLowerCase().includes(q) || t.category.toLowerCase().includes(q)).slice(0, 40)
  }, [tools, search])

  const toggleTool = (name: string) => {
    setSelected((prev) => (prev.includes(name) ? prev.filter((t) => t !== name) : [...prev, name]))
  }

  const submit = async () => {
    const t = title.trim()
    if (!t) {
      toast.error('Give the order a title')
      return
    }
    const chosen = wildcard ? ['*'] : selected
    if (chosen.length === 0) {
      toast.error('Pick at least one tool (or the any-tool wildcard)')
      return
    }
    const budget: { maxCalls?: number; windowMs?: number; spendCapUsd?: number } = {}
    if (maxCalls.trim()) {
      const n = Number(maxCalls)
      if (!Number.isInteger(n) || n < 1) {
        toast.error('max calls must be a whole number ≥ 1')
        return
      }
      budget.maxCalls = n
    }
    if (windowMin.trim()) {
      const n = Number(windowMin)
      if (!Number.isFinite(n) || n <= 0) {
        toast.error('window (minutes) must be a positive number')
        return
      }
      budget.windowMs = Math.round(n * 60_000)
    }
    if (spendCap.trim()) {
      const n = Number(spendCap)
      if (!Number.isFinite(n) || n <= 0) {
        toast.error('spend cap must be a positive number')
        return
      }
      budget.spendCapUsd = n
    }
    const pathPrefixes = prefixes
      .split(',')
      .map((p) => p.trim())
      .filter((p) => p.length > 0)
    let expiryAt: string | null = null
    if (expiry !== 'none') expiryAt = new Date(Date.now() + Number(expiry) * 60_000).toISOString()
    const ok = await onCreate({ title: t, tools: chosen, pathPrefixes, budget, expiryAt })
    if (ok) {
      setTitle('')
      setWildcard(false)
      setSelected([])
      setPrefixes('')
      setMaxCalls('')
      setWindowMin('')
      setSpendCap('')
      setExpiry('none')
    }
  }

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div>
        <Label htmlFor="cr-order-title" className="font-mono text-[10px] uppercase tracking-widest text-slate-500">
          title
        </Label>
        <Input
          id="cr-order-title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="e.g. notes vault pre-consent"
          maxLength={120}
          className="mt-1 h-9 border-white/10 bg-white/5 font-mono text-xs text-slate-200 placeholder:text-slate-500"
        />
      </div>

      <div className="min-w-0">
        <span className="font-mono text-[10px] uppercase tracking-widest text-slate-500">tools</span>
        <div className="mt-1 flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            aria-pressed={wildcard}
            onClick={() => setWildcard((w) => !w)}
            className={cn(
              'rounded-full border px-2 py-1 font-mono text-[10px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-400/60',
              wildcard
                ? 'border-purple-400/50 bg-purple-400/10 text-purple-200'
                : 'border-white/10 text-slate-400 hover:border-white/25 hover:text-slate-300'
            )}
          >
            * · any tool
          </button>
          {wildcard ? (
            <span className="font-mono text-[10px] text-amber-300/80">wildcard — every tool, choose a budget below</span>
          ) : selected.length > 0 ? (
            selected.map((s) => (
              <button
                key={s}
                type="button"
                aria-label={`Remove ${s}`}
                onClick={() => toggleTool(s)}
                className="inline-flex items-center gap-1 rounded-full border border-purple-400/50 bg-purple-400/10 px-2 py-1 font-mono text-[10px] text-purple-200 transition-colors hover:border-rose-400/40 hover:text-rose-300"
              >
                {s} <X className="h-2.5 w-2.5" aria-hidden="true" />
              </button>
            ))
          ) : (
            <span className="font-mono text-[10px] text-slate-500">pick from the live registry below</span>
          )}
        </div>
        {!wildcard ? (
          <>
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="search the live tool registry…"
              aria-label="Search tools for the order"
              className="mt-2 h-8 border-white/10 bg-white/5 font-mono text-xs text-slate-200 placeholder:text-slate-500"
            />
            <div className="mt-2 max-h-40 min-w-0 overflow-y-auto mist-scroll rounded-lg border border-white/5 bg-white/[0.02] p-1.5">
              {toolsError ? (
                <p className="px-1.5 py-2 font-mono text-[10px] text-rose-300/80">registry unreachable — {toolsError}</p>
              ) : tools === null ? (
                <div className="space-y-1.5 p-1">
                  {Array.from({ length: 3 }).map((_, i) => (
                    <Skeleton key={i} className="h-5 w-full bg-white/5" />
                  ))}
                </div>
              ) : visibleTools.length === 0 ? (
                <p className="px-1.5 py-2 font-mono text-[10px] text-slate-500">no tool matches</p>
              ) : (
                visibleTools.map((tool) => {
                  const on = selected.includes(tool.name)
                  return (
                    <button
                      key={tool.name}
                      type="button"
                      aria-pressed={on}
                      onClick={() => toggleTool(tool.name)}
                      title={tool.description}
                      className={cn(
                        'flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-400/60',
                        on ? 'bg-purple-400/10' : 'hover:bg-white/[0.04]'
                      )}
                    >
                      <span className={cn('h-2 w-2 shrink-0 rounded-full', on ? 'bg-purple-300' : 'bg-white/15')} aria-hidden="true" />
                      <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-slate-300">{tool.name}</span>
                      <MonoBadge className="border-white/10 text-slate-500">{tool.category}</MonoBadge>
                    </button>
                  )
                })
              )}
            </div>
          </>
        ) : null}
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div className="col-span-2">
          <Label htmlFor="cr-order-paths" className="font-mono text-[10px] uppercase tracking-widest text-slate-500">
            path prefixes (optional, comma-sep)
          </Label>
          <Input
            id="cr-order-paths"
            value={prefixes}
            onChange={(e) => setPrefixes(e.target.value)}
            placeholder="db/notes/, db/skills/"
            className="mt-1 h-9 border-white/10 bg-white/5 font-mono text-xs text-slate-200 placeholder:text-slate-500"
          />
        </div>
        <div>
          <Label htmlFor="cr-order-calls" className="font-mono text-[10px] uppercase tracking-widest text-slate-500">
            max calls
          </Label>
          <Input
            id="cr-order-calls"
            value={maxCalls}
            onChange={(e) => setMaxCalls(e.target.value)}
            inputMode="numeric"
            placeholder="—"
            className="mt-1 h-9 border-white/10 bg-white/5 font-mono text-xs text-slate-200 placeholder:text-slate-500"
          />
        </div>
        <div>
          <Label htmlFor="cr-order-window" className="font-mono text-[10px] uppercase tracking-widest text-slate-500">
            window (min)
          </Label>
          <Input
            id="cr-order-window"
            value={windowMin}
            onChange={(e) => setWindowMin(e.target.value)}
            inputMode="numeric"
            placeholder="—"
            className="mt-1 h-9 border-white/10 bg-white/5 font-mono text-xs text-slate-200 placeholder:text-slate-500"
          />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label htmlFor="cr-order-spend" className="font-mono text-[10px] uppercase tracking-widest text-slate-500">
            spend cap (usd)
          </Label>
          <Input
            id="cr-order-spend"
            value={spendCap}
            onChange={(e) => setSpendCap(e.target.value)}
            inputMode="decimal"
            placeholder="—"
            className="mt-1 h-9 border-white/10 bg-white/5 font-mono text-xs text-slate-200 placeholder:text-slate-500"
          />
        </div>
        <div>
          <Label htmlFor="cr-order-expiry" className="font-mono text-[10px] uppercase tracking-widest text-slate-500">
            expiry
          </Label>
          <Select value={expiry} onValueChange={setExpiry}>
            <SelectTrigger id="cr-order-expiry" className="mt-1 h-9 border-white/10 bg-white/5 font-mono text-xs text-slate-200">
              <SelectValue placeholder="no expiry" />
            </SelectTrigger>
            <SelectContent className="border-white/10 bg-slate-950/95 font-mono text-xs text-slate-200 backdrop-blur-2xl">
              {EXPIRY_PRESETS.map((p) => (
                <SelectItem key={p.value} value={p.value}>
                  {p.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <Button
        type="button"
        size="sm"
        disabled={creating}
        onClick={() => void submit()}
        className="w-fit gap-1.5 bg-purple-400/90 font-mono text-[11px] text-slate-950 hover:bg-purple-300"
      >
        {creating ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <Plus className="h-3.5 w-3.5" aria-hidden="true" />}
        Issue order
      </Button>
    </div>
  )
}

function OrdersSection({ onMutated }: { onMutated?: () => void }) {
  const [orders, setOrders] = useState<OrderView[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [formOpen, setFormOpen] = useState(false)
  const [tools, setTools] = useState<ToolInfo[] | null>(null)
  const [toolsError, setToolsError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [revokingId, setRevokingId] = useState<string | null>(null)
  const [confirmRevoke, setConfirmRevoke] = useState<OrderView | null>(null)
  const toolsFetched = useRef(false)

  const refresh = useCallback(async () => {
    try {
      const res = await api<{ orders: OrderView[] }>('/orders')
      setOrders(res.orders)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'orders unreachable')
    }
  }, [])

  useEffect(() => {
    // deferred to a macrotask — refresh() setStates synchronously (loading)
    const id = window.setTimeout(() => void refresh(), 0)
    return () => window.clearTimeout(id)
  }, [refresh])

  // the live registry loads with the form (the tab stays light until the
  // owner actually issues an order)
  useEffect(() => {
    if (!formOpen || toolsFetched.current) return
    toolsFetched.current = true
    api<ToolInfo[]>('/tools/list')
      .then((list) => setTools(list))
      .catch((e: unknown) => setToolsError(e instanceof Error ? e.message : 'registry unreachable'))
  }, [formOpen])

  const create = async (payload: {
    title: string
    tools: string[]
    pathPrefixes: string[]
    budget: { maxCalls?: number; windowMs?: number; spendCapUsd?: number }
    expiryAt: string | null
  }): Promise<boolean> => {
    setCreating(true)
    try {
      await api<{ ok: boolean }>('/orders', { method: 'POST', body: JSON.stringify(payload) })
      toast.success(`Standing order issued — "${payload.title}"`)
      await refresh()
      onMutated?.() // the audit trail below should show the create immediately
      return true
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'failed to issue the order')
      return false
    } finally {
      setCreating(false)
    }
  }

  const revoke = async (order: OrderView) => {
    setRevokingId(order.id)
    try {
      await api<{ ok: boolean }>(`/orders/${encodeURIComponent(order.id)}`, { method: 'DELETE' })
      toast.success(`Order revoked — "${order.title}" (the engine forgets it immediately)`)
      await refresh()
      onMutated?.() // the audit trail below should show the revoke immediately
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'failed to revoke')
    } finally {
      setRevokingId(null)
    }
  }

  const activeCount = (orders ?? []).filter((o) => o.active && !o.expired).length

  return (
    <section aria-label="Standing orders" className="flex min-w-0 flex-col gap-2">
      <SectionLabel
        right={
          <span className="flex items-center gap-2">
            {orders ? <span className="font-mono text-[10px] text-slate-500">{activeCount} active</span> : null}
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => setFormOpen((o) => !o)}
              aria-expanded={formOpen}
              className="h-7 gap-1 border-purple-400/25 bg-purple-400/10 px-2 font-mono text-[10px] text-purple-200 hover:border-purple-400/40 hover:bg-purple-400/15"
            >
              <Plus className="h-3 w-3" aria-hidden="true" /> New order
            </Button>
          </span>
        }
      >
        standing orders — pre-consent the engine honors
      </SectionLabel>

      <Collapsible open={formOpen} onOpenChange={setFormOpen}>
        <CollapsibleContent className="mist-glass-soft mb-2 p-3 data-[state=open]:animate-mist-fade-in">
          <p className="mb-3 font-mono text-[10px] leading-relaxed text-slate-500">
            A standing order is your explicit pre-consent: matching tool calls (trusted origins,
            untainted content, inside budget and expiry) are allowed without asking — floor rules
            (protected paths, untrusted origins, taint) are never softened by an order.
          </p>
          <CreateOrderForm tools={tools} toolsError={toolsError} onCreate={create} creating={creating} />
        </CollapsibleContent>
      </Collapsible>

      {error && orders === null ? (
        <div className="mist-glass-soft flex items-center justify-between gap-3 p-3">
          <p className="font-mono text-[11px] text-rose-300/90">orders unreachable — {error}</p>
          <Button type="button" variant="outline" size="sm" onClick={() => void refresh()} className="gap-1.5 font-mono text-[10px]">
            <RefreshCw className="h-3 w-3" aria-hidden="true" /> Retry
          </Button>
        </div>
      ) : orders === null ? (
        <div className="space-y-2">
          {Array.from({ length: 2 }).map((_, i) => (
            <Skeleton key={i} className="h-20 w-full bg-white/5" />
          ))}
        </div>
      ) : orders.length === 0 ? (
        <p className="py-2 font-mono text-[11px] text-slate-500">no standing orders — she asks for every side effect</p>
      ) : (
        <div className="max-h-96 min-w-0 space-y-2 overflow-y-auto mist-scroll pr-1">
          {orders.map((o) => (
            <OrderCard key={o.id} order={o} onRevoke={setConfirmRevoke} revoking={revokingId === o.id} />
          ))}
        </div>
      )}

      <AlertDialog open={confirmRevoke != null} onOpenChange={(o) => { if (!o) setConfirmRevoke(null) }}>
        <AlertDialogContent className="border-white/10 bg-slate-950/95 backdrop-blur-2xl sm:max-w-sm">
          <AlertDialogHeader>
            <AlertDialogTitle className="font-mono text-sm tracking-widest text-amber-200">
              REVOKE THIS ORDER?
            </AlertDialogTitle>
            <AlertDialogDescription className="font-mono text-[11px] leading-relaxed text-slate-400">
              {confirmRevoke ? `"${confirmRevoke.title}"` : ''} stops authorizing anything on the
              very next decision. The card stays in the list as revoked history.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="gap-2 sm:justify-end">
            <AlertDialogCancel className="font-mono text-xs">Keep it</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const o = confirmRevoke
                setConfirmRevoke(null)
                if (o) void revoke(o)
              }}
              className="bg-amber-400/90 font-mono text-xs text-slate-950 hover:bg-amber-300"
            >
              Revoke
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  )
}

// ============================================================ AUDIT TRAIL

function AuditRow({ event }: { event: AuditEventView }) {
  const [open, setOpen] = useState(false)
  let args = ''
  let argsOk = false
  try {
    args = JSON.stringify(JSON.parse(event.argsJson), null, 2)
    argsOk = true
  } catch {
    args = event.argsJson
  }
  return (
    <div className="min-w-0 rounded-lg border border-white/5 bg-white/[0.02]">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full flex-wrap items-center gap-x-2 gap-y-1 px-2.5 py-1.5 text-left transition-colors hover:bg-white/[0.03] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-400/60"
      >
        <span className="w-14 shrink-0 font-mono text-[9px] tabular-nums text-slate-600" title={event.ts}>
          #{event.seq} · {relTime(event.ts)}
        </span>
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-emerald-300">{event.tool}</span>
        <MonoBadge className={RISK_CLASS[event.risk] ?? 'border-white/10 text-slate-400'}>{event.risk}</MonoBadge>
        <MonoBadge className="border-white/10 text-slate-500">{event.origin}</MonoBadge>
        {event.tainted ? <MonoBadge className="border-amber-300/40 bg-amber-300/10 text-amber-200">tainted</MonoBadge> : null}
        <MonoBadge className={DECISION_CLASS[event.decision]}>{event.decision}</MonoBadge>
        {event.orderRef ? (
          <MonoBadge className="border-purple-300/30 bg-purple-300/10 text-purple-200" title={`authorized by standing order ${event.orderRef}`}>
            order
          </MonoBadge>
        ) : null}
        <ChevronDown
          aria-hidden="true"
          className={cn('h-3.5 w-3.5 shrink-0 text-slate-500 transition-transform duration-200', open && 'rotate-180')}
        />
      </button>
      <p className="px-2.5 pb-1.5 font-mono text-[10px] leading-relaxed text-slate-500" title={event.reason}>
        {event.reason || '—'}
      </p>
      {open ? (
        <div className="animate-mist-fade-in border-t border-white/5 px-2.5 py-2">
          <p className="mb-1 font-mono text-[9px] uppercase tracking-widest text-slate-600">args {argsOk ? '' : '(raw — not valid JSON)'}</p>
          <pre className="max-h-40 min-w-0 overflow-auto mist-scroll whitespace-pre-wrap break-all rounded-md border border-white/5 bg-white/[0.02] p-2 font-mono text-[10px] leading-relaxed text-slate-300">
            {args}
          </pre>
        </div>
      ) : null}
    </div>
  )
}

function AuditSection({ refreshKey }: { refreshKey: number }) {
  const [page, setPage] = useState<AuditPage | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [toolFilter, setToolFilter] = useState('')
  const [decision, setDecision] = useState<string>('all')
  const [origin, setOrigin] = useState<string>('all')
  const [limit, setLimit] = useState('50')
  const fetchSeq = useRef(0)

  const query = useCallback((before?: number) => {
    const sp = new URLSearchParams()
    sp.set('limit', limit)
    if (before) sp.set('before', String(before))
    if (toolFilter.trim()) sp.set('tool', toolFilter.trim())
    if (decision !== 'all') sp.set('decision', decision)
    if (origin !== 'all') sp.set('origin', origin)
    return `/audit?${sp.toString()}`
  }, [limit, toolFilter, decision, origin])

  const load = useCallback(async () => {
    const seq = ++fetchSeq.current
    setLoading(true)
    try {
      const res = await api<AuditPage>(query())
      if (seq !== fetchSeq.current) return // a newer filter won the race
      setPage(res)
      setError(null)
    } catch (e) {
      if (seq === fetchSeq.current) setError(e instanceof Error ? e.message : 'audit trail unreachable')
    } finally {
      if (seq === fetchSeq.current) setLoading(false)
    }
  }, [query])

  useEffect(() => {
    // deferred to a macrotask — load() setStates synchronously (loading)
    const id = window.setTimeout(() => void load(), 0)
    return () => window.clearTimeout(id)
  }, [load, refreshKey]) // refreshKey: an order mutation in the room above re-reads the trail

  const loadMore = async () => {
    if (page?.nextBefore == null) return
    setLoadingMore(true)
    try {
      const res = await api<AuditPage>(query(page.nextBefore))
      setPage({ ...res, events: page ? [...page.events, ...res.events] : res.events, nextBefore: res.nextBefore })
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'could not load older rows')
    } finally {
      setLoadingMore(false)
    }
  }

  const chain = page?.chain

  return (
    <section aria-label="Audit trail" className="flex min-w-0 flex-col gap-2">
      <SectionLabel
        right={
          <span className="flex items-center gap-1.5">
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => void load()}
              aria-label="Refresh the audit trail"
              className="h-6 w-6 gap-0 border-white/10 p-0 text-slate-400 hover:border-white/25 hover:text-slate-200"
            >
              <RefreshCw className={cn('h-3 w-3', loading && 'animate-spin')} aria-hidden="true" />
            </Button>
            {chain ? (
              chain.valid ? (
                <MonoBadge className="border-emerald-400/30 bg-emerald-400/10 px-2 py-1 text-[10px] text-emerald-300" title="every row's hash recomputed server-side on this read — stored hashes are never trusted">
                  <ShieldCheck className="mr-1 inline h-3 w-3" aria-hidden="true" />
                  hash chain verified · {chain.checkedCount} rows
                </MonoBadge>
              ) : (
                <MonoBadge className="border-rose-400/40 bg-rose-400/10 px-2 py-1 text-[10px] text-rose-300" title={chain.reason}>
                  CHAIN BROKEN at seq {chain.brokenAtSeq}
                </MonoBadge>
              )
            ) : null}
          </span>
        }
      >
        audit trail — why did she do that
      </SectionLabel>

      {/* filters */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Input
          value={toolFilter}
          onChange={(e) => setToolFilter(e.target.value)}
          placeholder="tool (exact)"
          aria-label="Filter by tool name"
          className="h-8 border-white/10 bg-white/5 font-mono text-[11px] text-slate-200 placeholder:text-slate-500"
        />
        <Select value={decision} onValueChange={setDecision}>
          <SelectTrigger aria-label="Filter by decision" className="h-8 border-white/10 bg-white/5 font-mono text-[11px] text-slate-200">
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="border-white/10 bg-slate-950/95 font-mono text-[11px] text-slate-200 backdrop-blur-2xl">
            <SelectItem value="all">any decision</SelectItem>
            <SelectItem value="allow">allow</SelectItem>
            <SelectItem value="ask">ask</SelectItem>
            <SelectItem value="deny">deny</SelectItem>
            <SelectItem value="defer">defer</SelectItem>
          </SelectContent>
        </Select>
        <Select value={origin} onValueChange={setOrigin}>
          <SelectTrigger aria-label="Filter by origin" className="h-8 border-white/10 bg-white/5 font-mono text-[11px] text-slate-200">
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="max-h-64 border-white/10 bg-slate-950/95 font-mono text-[11px] text-slate-200 backdrop-blur-2xl">
            <SelectItem value="all">any origin</SelectItem>
            {ORIGINS.map((o) => (
              <SelectItem key={o} value={o}>
                {o}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={limit} onValueChange={setLimit}>
          <SelectTrigger aria-label="Page size" className="h-8 border-white/10 bg-white/5 font-mono text-[11px] text-slate-200">
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="border-white/10 bg-slate-950/95 font-mono text-[11px] text-slate-200 backdrop-blur-2xl">
            {['25', '50', '100', '200'].map((n) => (
              <SelectItem key={n} value={n}>
                {n} rows
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {error && page === null ? (
        <div className="mist-glass-soft flex items-center justify-between gap-3 p-3">
          <p className="font-mono text-[11px] text-rose-300/90">audit trail unreachable — {error}</p>
          <Button type="button" variant="outline" size="sm" onClick={() => void load()} className="gap-1.5 font-mono text-[10px]">
            <RefreshCw className="h-3 w-3" aria-hidden="true" /> Retry
          </Button>
        </div>
      ) : loading && page === null ? (
        <div className="space-y-1.5">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-10 w-full bg-white/5" />
          ))}
        </div>
      ) : !page || page.events.length === 0 ? (
        <div className="mist-glass-soft flex items-center gap-2 p-3">
          <ScrollText className="h-4 w-4 shrink-0 text-slate-500" aria-hidden="true" />
          <p className="font-mono text-[11px] text-slate-500">no rows match this filter — an empty trail is the honest answer, not a guess</p>
        </div>
      ) : (
        <>
          <div className="max-h-96 min-w-0 space-y-1.5 overflow-y-auto mist-scroll pr-1" aria-live="polite">
            {page.events.map((e) => (
              <AuditRow key={e.id} event={e} />
            ))}
          </div>
          {page.nextBefore != null ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={loadingMore}
              onClick={() => void loadMore()}
              className="w-full gap-1.5 border-white/10 font-mono text-[10px] text-slate-300 hover:border-white/25"
            >
              {loadingMore ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" /> : <ChevronDown className="h-3 w-3" aria-hidden="true" />}
              load older
            </Button>
          ) : null}
        </>
      )}
    </section>
  )
}

// ============================================================ the tab

export function ControlRoomTab() {
  // order mutations above re-read the audit trail below — the "why did she do
  // that?" surface must show the row the owner's own action just minted
  const [auditRefreshKey, setAuditRefreshKey] = useState(0)
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <AutonomySection />
      <OrdersSection onMutated={() => setAuditRefreshKey((k) => k + 1)} />
      <AuditSection refreshKey={auditRefreshKey} />
    </div>
  )
}
