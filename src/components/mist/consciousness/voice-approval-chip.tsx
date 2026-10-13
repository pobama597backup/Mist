'use client'

// Phase 2-d · S14: the visible voice-approval chip — a pending voice-originated
// Approval shows "heard: '<last transcript>'" with a 1-TAP CANCEL (deny) and an
// APPROVE tap (the on-screen-tap half of voice-exec; the spoken-phrase half is
// wired in use-voice). Polls the pending approvals feed every 5s.

import { useCallback, useEffect, useState } from 'react'
import { Check, X } from 'lucide-react'
import { toast } from 'sonner'

/** One pending approval row (the fields the chip reads; payload is parsed server-side). */
interface PendingVoiceApproval { id: string; title: string; createdAt: string; payload?: { origin?: string } }

export function VoiceApprovalChip({ lastHeard }: { lastHeard: string }) {
  const [approval, setApproval] = useState<PendingVoiceApproval | null>(null)

  const decide = useCallback(
    async (decision: 'approve' | 'deny') => {
      if (!approval) return
      try {
        const res = await fetch(`/api/mist/approvals/${encodeURIComponent(approval.id)}`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ decision }),
        })
        if (!res.ok) throw new Error('decide failed')
        setApproval(null)
        toast.success(decision === 'approve' ? 'Approved — running it now' : 'Cancelled')
      } catch {
        toast.error('Could not reach the approval')
      }
    },
    [approval],
  )

  useEffect(() => {
    let alive = true
    const poll = async () => {
      try {
        const res = await fetch('/api/mist/approvals?status=pending', { cache: 'no-store' })
        if (!res.ok || !alive) return
        const data = (await res.json()) as { approvals?: PendingVoiceApproval[] }
        if (!alive) return
        const voice = (data.approvals ?? []).filter((a) => a.payload?.origin === 'owner_voice').sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0]
        setApproval(voice ?? null) // the chip is UX, not a gate — poll errors pass
      } catch {
        /* next poll */
      }
    }
    void poll()
    const timer = window.setInterval(poll, 5_000)
    return () => {
      alive = false
      window.clearInterval(timer)
    }
  }, [])

  if (!approval) return null
  const heard = lastHeard.trim() || approval.title
  return (
    <div role="alert" aria-label="Voice approval needed — approve or cancel" className="mist-glass-soft mx-auto mb-2 flex max-w-md flex-wrap items-center justify-between gap-2 rounded-full border border-amber-400/30 px-4 py-2">
      <p className="min-w-0 flex-1 truncate text-xs text-amber-200/90">
        heard: <span className="text-amber-100">“{heard.slice(0, 90)}”</span>
      </p>
      <span className="flex items-center gap-1.5">
        <button type="button" onClick={() => void decide('deny')} aria-label="Cancel the voice approval" className="flex h-8 items-center gap-1 rounded-full border border-white/10 px-3 font-mono text-[10px] uppercase tracking-widest text-slate-300 transition-colors hover:border-rose-400/50 hover:text-rose-300">
          <X aria-hidden className="h-3 w-3" /> cancel
        </button>
        <button type="button" onClick={() => void decide('approve')} aria-label="Approve the voice approval" className="flex h-8 items-center gap-1 rounded-full border border-emerald-400/40 bg-emerald-400/10 px-3 font-mono text-[10px] uppercase tracking-widest text-emerald-200 transition-colors hover:bg-emerald-400/20">
          <Check aria-hidden className="h-3 w-3" /> approve
        </button>
      </span>
    </div>
  )
}
