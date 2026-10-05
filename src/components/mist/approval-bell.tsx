'use client'

// M.I.S.T. — ApprovalBell (oj-face-5, OpenJarvis UX port).
//
// The tiered-approval gate surface: a bell chip (floating top-right, under
// the navbar) with a pending-count badge; the popover lists pending
// approvals from the wave-1 approval queue — title, tier badge (auto=neutral
// · standard=amber · destructive=rose), origin, payload preview, age — with
// Approve/Deny actions and a per-item "remember" switch that maps onto
// {decision, remember: always_approve|always_deny}.
//
// Polls GET /api/mist/approvals every 30s + refreshes on open. Decisions
// POST optimistically with rollback + toast on failure. Honest states all
// the way down: empty queue renders "nothing awaiting your call".

import { useCallback, useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { Bell, Check, Loader2, ShieldCheck, X } from 'lucide-react'
import { toast } from 'sonner'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Switch } from '@/components/ui/switch'
import { Skeleton } from '@/components/ui/skeleton'
import { listApprovals, decideApproval, relAge, type ApprovalItem } from '@/lib/oj/ui-api'
import { useMistStore } from '@/lib/store'
import { cn } from '@/lib/utils'

const POLL_MS = 30_000

const TIER_BADGE: Record<string, string> = {
  auto: 'border-white/15 bg-white/5 text-slate-400',
  standard: 'border-amber-300/30 bg-amber-300/10 text-amber-200',
  destructive: 'border-rose-400/30 bg-rose-400/10 text-rose-300',
}

const STATUS_BADGE: Record<string, string> = {
  approved: 'border-emerald-300/25 bg-emerald-300/5 text-emerald-300/80',
  denied: 'border-rose-300/25 bg-rose-300/5 text-rose-300/80',
  expired: 'border-white/10 bg-white/5 text-slate-500',
}

function payloadPreview(payload: Record<string, unknown>): string {
  try {
    const s = JSON.stringify(payload)
    return s.length > 160 ? `${s.slice(0, 160)}…` : s
  } catch {
    return ''
  }
}

/** One pending approval card with its decision controls. */
function PendingApprovalRow({
  item,
  onDecide,
}: {
  item: ApprovalItem
  onDecide: (id: string, decision: 'approve' | 'deny', remember: boolean) => void
}) {
  const [remember, setRemember] = useState(false)
  const tier = TIER_BADGE[item.tier] ?? TIER_BADGE.standard
  return (
    <div className="mist-glass-soft rounded-xl p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-[13px] font-medium text-slate-100" title={item.title}>
            {item.title}
          </p>
          <p className="mt-0.5 flex flex-wrap items-center gap-x-2 font-mono text-[10px] text-slate-500">
            <span className={cn('rounded border px-1.5 py-px uppercase tracking-wide', tier)}>{item.tier}</span>
            <span>{item.actionType}</span>
            <span aria-hidden>·</span>
            <span>via {item.origin}</span>
            <span aria-hidden>·</span>
            <span>{relAge(item.createdAt)}</span>
          </p>
        </div>
      </div>
      {payloadPreview(item.payload) ? (
        <p className="mist-scroll mt-2 overflow-hidden whitespace-pre-wrap break-all rounded-lg border border-white/5 bg-white/[0.03] px-2 py-1.5 font-mono text-[10px] leading-relaxed text-slate-400" style={{ display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>
          {payloadPreview(item.payload)}
        </p>
      ) : null}

      {/* remember switch + decision buttons */}
      <div className="mt-2.5 flex items-center justify-between gap-2">
        <label className="flex min-w-0 cursor-pointer items-center gap-2">
          <Switch checked={remember} onCheckedChange={setRemember} aria-label="Remember this decision for this action type" />
          <span className="truncate font-mono text-[10px] text-slate-500" title="Apply this choice automatically to future actions of this type">
            {remember ? 'always apply' : 'ask every time'}
          </span>
        </label>
        <div className="flex shrink-0 items-center gap-1.5">
          <button
            type="button"
            onClick={() => onDecide(item.id, 'approve', remember)}
            className="inline-flex h-9 items-center gap-1 rounded-lg border border-emerald-300/30 bg-emerald-300/10 px-3 font-mono text-[11px] text-emerald-200 transition-colors hover:bg-emerald-300/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400/60"
          >
            <Check aria-hidden className="h-3.5 w-3.5" />
            approve
          </button>
          <button
            type="button"
            onClick={() => onDecide(item.id, 'deny', remember)}
            className="inline-flex h-9 items-center gap-1 rounded-lg border border-rose-400/30 bg-rose-400/10 px-3 font-mono text-[11px] text-rose-200 transition-colors hover:bg-rose-400/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-400/60"
          >
            <X aria-hidden className="h-3.5 w-3.5" />
            deny
          </button>
        </div>
      </div>
    </div>
  )
}

export function ApprovalBell() {
  const reduced = useMistStore((s) => s.reducedMotion)
  const [open, setOpen] = useState(false)
  const [items, setItems] = useState<ApprovalItem[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set())
  const inFlight = useRef(false)
  // latest items for the decision handler (stable callback — no array deps)
  const itemsRef = useRef<ApprovalItem[] | null>(null)
  useEffect(() => {
    itemsRef.current = items
  }, [items])

  const refresh = useCallback(async () => {
    if (inFlight.current) return
    inFlight.current = true
    const res = await listApprovals()
    inFlight.current = false
    if (res.ok) {
      setItems(res.data)
      setLoadError(null)
    } else {
      // keep the last good list — the chip must not flap on a network blip;
      // first-load failure lands on the honest empty state
      setLoadError(res.error)
      setItems((prev) => prev ?? [])
    }
  }, [])

  // poll every 30s while mounted (kickoff deferred a macrotask — the
  // chat-panel composer-restore pattern — so no setState rides the effect body)
  useEffect(() => {
    const kickoff = window.setTimeout(() => void refresh(), 0)
    const t = window.setInterval(() => void refresh(), POLL_MS)
    return () => {
      window.clearTimeout(kickoff)
      window.clearInterval(t)
    }
  }, [refresh])

  // fresh fetch each time the popover opens
  useEffect(() => {
    if (!open) return
    const t = window.setTimeout(() => void refresh(), 0)
    return () => window.clearTimeout(t)
  }, [open, refresh])

  const pending = (items ?? []).filter((a) => a.status === 'pending')
  const decided = (items ?? []).filter((a) => a.status !== 'pending').slice(0, 3)
  const destructive = pending.some((a) => a.tier === 'destructive')
  const count = pending.length

  const onDecide = useCallback(
    (id: string, decision: 'approve' | 'deny', remember: boolean) => {
      const item = itemsRef.current?.find((a) => a.id === id && a.status === 'pending')
      if (!item) return
      // optimistic: drop the row immediately, restore on failure
      setItems((prev) => (prev ? prev.filter((a) => a.id !== id) : prev))
      setBusyIds((prev) => new Set(prev).add(id))
      decideApproval(id, decision, remember ? (decision === 'approve' ? 'always_approve' : 'always_deny') : undefined)
        .then((res) => {
          if (res.ok) {
            toast.success(decision === 'approve' ? 'Approved' : 'Denied', {
              description: `${item.title}${remember ? ' — remembered for this action type' : ''}`,
            })
          } else {
            // rollback
            setItems((prev) => (prev ? [item, ...prev] : [item]))
            toast.error('Decision failed', { description: res.error })
          }
        })
        .catch(() => {
          setItems((prev) => (prev ? [item, ...prev] : [item]))
          toast.error('Decision failed', { description: 'network unreachable' })
        })
        .finally(() => {
          setBusyIds((prev) => {
            const next = new Set(prev)
            next.delete(id)
            return next
          })
        })
    },
    []
  )

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={count > 0 ? `Approvals — ${count} pending${destructive ? ', destructive actions included' : ''}` : 'Approvals — nothing pending'}
          className={cn(
            'mist-glass-soft fixed right-3 top-[4.5rem] z-40 flex h-10 w-10 items-center justify-center rounded-xl transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-400/60',
            count > 0
              ? cn(
                  'border-white/20 text-slate-100 shadow-[0_8px_24px_-12px_rgba(0,0,0,0.6)]',
                  destructive ? 'border-rose-400/40 text-rose-200' : 'border-amber-300/40 text-amber-200'
                )
              : 'text-slate-500 hover:border-white/20 hover:text-slate-300'
          )}
        >
          {count > 0 && !reduced ? (
            <span
              aria-hidden
              className={cn('absolute -inset-0.5 rounded-xl', destructive ? 'animate-mist-ripple-ring' : '')}
              style={{ ['--mist-ripple-color' as string]: destructive ? 'rgba(251, 113, 133, 0.35)' : 'rgba(252, 211, 77, 0.3)' }}
            />
          ) : null}
          <Bell aria-hidden className={cn('h-4.5 w-4.5', count > 0 && !reduced && 'animate-mist-bounce-soft')} />
          {count > 0 ? (
            <span
              aria-hidden
              className={cn(
                'absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full px-1 font-mono text-[9px] font-semibold text-slate-950',
                destructive ? 'bg-rose-400' : 'bg-amber-300'
              )}
            >
              {count}
            </span>
          ) : null}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" side="bottom" className="w-[min(92vw,26rem)] border-white/10 bg-slate-950/95 p-0 backdrop-blur-2xl">
        <div className="flex items-center justify-between gap-2 border-b border-white/10 px-3 py-2.5">
          <span className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.2em] text-slate-400">
            <ShieldCheck aria-hidden className="h-3.5 w-3.5 text-purple-300/80" />
            approval gate
          </span>
          <span className="font-mono text-[10px] text-slate-500">
            {items === null ? '…' : `${count} pending`}
          </span>
        </div>

        <div className="mist-scroll max-h-96 overflow-y-auto p-2.5">
          {items === null ? (
            <div className="space-y-2" aria-hidden>
              <Skeleton className="h-24 w-full rounded-xl bg-white/5" />
              <Skeleton className="h-24 w-full rounded-xl bg-white/5" />
            </div>
          ) : loadError !== null && items.length === 0 ? (
            <p className="px-1 py-4 text-center font-mono text-[11px] text-slate-500">
              approval queue unreachable — {loadError}
            </p>
          ) : count === 0 ? (
            <p className="px-1 py-5 text-center font-mono text-[11px] text-slate-500">
              nothing awaiting your call
            </p>
          ) : (
            <div className="space-y-2">
              <AnimatePresence initial={false}>
                {pending.map((a) => (
                  <motion.div
                    key={a.id}
                    initial={reduced ? false : { opacity: 0, y: 6 }}
                    animate={{ opacity: busyIds.has(a.id) ? 0.5 : 1, y: 0 }}
                    exit={{ opacity: 0, x: reduced ? 0 : -24 }}
                    transition={{ duration: 0.18 }}
                  >
                    <PendingApprovalRow item={a} onDecide={onDecide} />
                  </motion.div>
                ))}
              </AnimatePresence>
              {busyIds.size > 0 ? (
                <p className="flex items-center justify-center gap-1.5 font-mono text-[10px] text-slate-500">
                  <Loader2 aria-hidden className="h-3 w-3 animate-spin" />
                  filing decision…
                </p>
              ) : null}
            </div>
          )}

          {/* recently decided — quiet context, not actionable */}
          {decided.length > 0 ? (
            <div className="mt-2 border-t border-white/5 pt-2">
              <p className="px-1 pb-1.5 font-mono text-[9px] uppercase tracking-widest text-slate-600">recent decisions</p>
              <ul className="space-y-1">
                {decided.map((a) => (
                  <li key={`d-${a.id}`} className="flex min-w-0 items-center gap-2 px-1 py-0.5">
                    <span className={cn('shrink-0 rounded border px-1.5 py-px font-mono text-[9px] uppercase', STATUS_BADGE[a.status] ?? STATUS_BADGE.expired)}>
                      {a.status}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-[11px] text-slate-500" title={a.title}>
                      {a.title}
                    </span>
                    <span className="shrink-0 font-mono text-[10px] text-slate-600">{relAge(a.decidedAt ?? a.createdAt)}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      </PopoverContent>
    </Popover>
  )
}
