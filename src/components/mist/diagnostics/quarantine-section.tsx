'use client'

// QuarantineSection — the S11 inbox in the memory drawer (Phase 2-c): tainted
// internal auto-writes wait for the owner's accept/edit/drop (never in recall
// until accepted).
import { useCallback, useEffect, useState } from 'react'
import { Check, Loader2, Pencil, ShieldAlert, Trash2, X } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { mistApi } from '@/lib/mist-api'
import { MonoBadge, SectionLabel, relTime } from './shared'
import type { QuarantineItemView } from '@/lib/types'

const KIND_CLASS = {
  fact: 'border-amber-300/30 bg-amber-300/10 text-amber-200', skill: 'border-teal-300/30 bg-teal-300/10 text-teal-200',
  cron: 'border-purple-300/30 bg-purple-300/10 text-purple-200', persona: 'border-rose-300/30 bg-rose-300/10 text-rose-200' } as Record<string, string>
const BTN = 'h-7 gap-1 px-2 font-mono text-[10px]'
const empty = (text: string) => <p className="py-2 font-mono text-[11px] text-slate-500">{text}</p>
const spin = (on: boolean, Icon: typeof Check) => (on ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" /> : <Icon className="h-3 w-3" aria-hidden="true" />)

export function QuarantineSection() {
  const [pending, setPending] = useState<QuarantineItemView[] | null>(null)
  const [counts, setCounts] = useState<{ accepted: number; edited: number; dropped: number } | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const refresh = useCallback(async () => {
    try {
      const res = await mistApi.memory.quarantine.list()
      setPending(res.pending); setCounts(res.counts)
    } catch { /* keep the last good list — the inbox must never nag */ }
  }, [])

  useEffect(() => {
    // deferred to a macrotask — refresh() reaches setState from the effect's
    // sync frame per the lint rule
    const t = window.setTimeout(() => void refresh(), 0)
    const poll = setInterval(refresh, 15_000) // like the approval bell: poll while open
    return () => {
      window.clearTimeout(t)
      clearInterval(poll)
    }
  }, [refresh])
  const decide = async (id: string, decision: 'accept' | 'edit' | 'drop', content?: string) => {
    setBusy(id + decision)
    try {
      const res = await mistApi.memory.quarantine.decide(id, decision, content)
      if (!res.ok) throw new Error(res.error ?? 'decision failed')
      toast.success(decision === 'drop' ? 'Quarantined write dropped' : `Quarantined write ${decision}ed — now in memory`)
      setEditing(null); await refresh()
    } catch (e) { toast.error(e instanceof Error ? e.message : 'decision failed') } finally { setBusy(null) }
  }

  return (
    <section aria-label="Quarantine inbox" className="flex min-w-0 flex-col gap-2">
      <SectionLabel right={pending && pending.length > 0
        ? <span className="flex items-center gap-1 font-mono text-[10px] text-amber-300"><ShieldAlert className="h-3 w-3" aria-hidden="true" /> {pending.length} pending review</span>
        : counts ? <span className="font-mono text-[10px] text-slate-500">{counts.accepted}A · {counts.edited}E · {counts.dropped}D decided</span> : null}>
        quarantine inbox
      </SectionLabel>
      {pending === null ? empty('checking the inbox…')
        : pending.length === 0 ? empty('clean — no tainted writes awaiting review') : (
        <div className="max-h-64 min-w-0 space-y-1.5 overflow-y-auto mist-scroll pr-1">
          {pending.map((item) => (
            <div key={item.id} className="flex min-w-0 flex-col gap-1.5 rounded-lg border border-amber-300/15 bg-amber-300/[0.04] px-2.5 py-2">
              <div className="flex min-w-0 items-center gap-2">
                <MonoBadge className={KIND_CLASS[item.kind] ?? KIND_CLASS.fact}>{item.kind}</MonoBadge>
                <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-slate-400" title={item.reason}>{item.source} · {item.reason}</span>
                <span className="shrink-0 text-[10px] text-slate-500">{relTime(item.createdAt)}</span>
              </div>
              {editing === item.id
                ? <Textarea value={draft} onChange={(e) => setDraft(e.target.value)} aria-label="Edited content (JSON)" className="min-h-16 border-white/10 bg-white/5 font-mono text-[11px] text-slate-200" />
                : <p className="min-w-0 break-all font-mono text-[11px] leading-relaxed text-slate-300 line-clamp-3" title={item.contentJson}>{item.contentJson}</p>}
              <div className="flex gap-1.5">
                {editing === item.id ? (
                  <>
                    <Button size="sm" className={`${BTN} bg-amber-400/90 text-slate-950 hover:bg-amber-300`} disabled={busy !== null} onClick={() => void decide(item.id, 'edit', draft)}>{spin(busy === item.id + 'edit', Check)} Save edit</Button>
                    <Button size="sm" variant="outline" className={`${BTN} border-white/10`} disabled={busy !== null} onClick={() => setEditing(null)}><X className="h-3 w-3" aria-hidden="true" /> Cancel</Button>
                  </>
                ) : (
                  <>
                    <Button size="sm" className={`${BTN} bg-emerald-400/90 text-slate-950 hover:bg-emerald-300`} disabled={busy !== null} onClick={() => void decide(item.id, 'accept')}>{spin(busy === item.id + 'accept', Check)} Accept</Button>
                    <Button size="sm" variant="outline" className={`${BTN} border-white/10`} disabled={busy !== null} onClick={() => { setEditing(item.id); setDraft(item.contentJson) }}><Pencil className="h-3 w-3" aria-hidden="true" /> Edit</Button>
                    <Button size="sm" variant="outline" className={`${BTN} border-rose-400/20 text-rose-300 hover:border-rose-400/40`} disabled={busy !== null} onClick={() => void decide(item.id, 'drop')}>{spin(busy === item.id + 'drop', Trash2)} Drop</Button>
                  </>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}
