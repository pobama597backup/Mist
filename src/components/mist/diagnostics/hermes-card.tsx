'use client'

// Hermes command card — the creator's business agent, front and center.
//
// The business runs on the creator's local Hermes agent (NousResearch/
// hermes-agent) reached through the Mist Bridge. This card is the command
// surface: live status (installed, version, gateway health, skills count),
// one-line delegation (hermes_ask — the business-control path), skills and
// cron peek. Honest by design: bridge disconnected says so with the connect
// hint, never a fake green light.

import { useCallback, useEffect, useState, type FormEvent } from 'react'
import {
  BriefcaseBusiness,
  Loader2,
  RefreshCw,
  Send,
  CalendarClock,
  Sparkles,
} from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { MonoBadge, StatusDot } from './shared'
import { cn } from '@/lib/utils'

interface HermesStatus {
  ok?: boolean
  error?: string
  hint?: string
  cached?: boolean
  data?: {
    installed?: boolean
    version?: string | null
    gateway?: { healthy?: boolean; url?: string } | null
    skills?: { count?: number } | unknown[]
    memory?: { files?: number } | null
    repoPath?: string | null
    [k: string]: unknown
  }
  [k: string]: unknown
}

interface SkillsResult {
  ok?: boolean
  data?: { skills?: Array<{ name?: string }> } | Array<{ name?: string }>
  [k: string]: unknown
}

interface CronResult {
  ok?: boolean
  data?: { jobs?: Array<{ name?: string; schedule?: string; enabled?: boolean }> } | Array<Record<string, unknown>>
  [k: string]: unknown
}

function skillsCount(s: HermesStatus['data']): number | null {
  if (!s) return null
  if (Array.isArray(s.skills)) return s.skills.length
  const sc = s.skills as { count?: unknown } | undefined
  const n = Number(sc?.count)
  return Number.isFinite(n) ? n : null
}

export function HermesCard() {
  const [status, setStatus] = useState<HermesStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [checking, setChecking] = useState(false)
  const [delegating, setDelegating] = useState(false)
  const [prompt, setPrompt] = useState('')
  const [delegateOut, setDelegateOut] = useState<string | null>(null)
  const [panel, setPanel] = useState<'none' | 'skills' | 'cron'>('none')
  const [panelLoading, setPanelLoading] = useState(false)
  const [skills, setSkills] = useState<string[]>([])
  const [cron, setCron] = useState<Array<{ name?: string; schedule?: string; enabled?: boolean }>>([])

  const loadStatus = useCallback(async (force = false) => {
    if (force) setChecking(true)
    try {
      const res = await fetch(force ? '/api/mist/hermes' : '/api/mist/hermes', {
        method: force ? 'POST' : 'GET',
        headers: { 'content-type': 'application/json' },
        ...(force ? { body: JSON.stringify({ action: 'status' }) } : {}),
      })
      const data = (await res.json()) as HermesStatus
      setStatus(data)
    } catch {
      setStatus({ ok: false, error: 'unreachable' })
    } finally {
      setLoading(false)
      setChecking(false)
    }
  }, [])

  useEffect(() => {
    void loadStatus()
    const id = setInterval(() => void loadStatus(), 60_000)
    return () => clearInterval(id)
  }, [loadStatus])

  const offline = status?.error === 'bridge-disconnected' || status?.ok === false
  const inner = status?.data
  const installed = inner?.installed === true
  const gatewayHealthy = inner?.gateway?.healthy === true
  const sc = skillsCount(inner)

  const onDelegate = async (e: FormEvent) => {
    e.preventDefault()
    const p = prompt.trim()
    if (!p) return
    setDelegating(true)
    setDelegateOut(null)
    try {
      const res = await fetch('/api/mist/hermes', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'delegate', prompt: p }),
      })
      const data = (await res.json()) as { ok?: boolean; error?: string; data?: { output?: string; result?: string } }
      if (!res.ok || data.ok === false) throw new Error(data.error ?? 'delegation failed')
      const out = data.data?.output ?? data.data?.result ?? '(Hermes finished — no text output)'
      setDelegateOut(String(out).slice(0, 2000))
      toast.success('Hermes finished the task')
    } catch (err) {
      toast.error('Hermes delegation failed', {
        description: err instanceof Error ? err.message : undefined,
      })
    } finally {
      setDelegating(false)
    }
  }

  const openPanel = async (which: 'skills' | 'cron') => {
    if (panel === which) {
      setPanel('none')
      return
    }
    setPanel(which)
    setPanelLoading(true)
    try {
      const res = await fetch('/api/mist/hermes', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: which }),
      })
      const data = (await res.json()) as SkillsResult & CronResult
      if (which === 'skills') {
        const list = Array.isArray(data.data) ? data.data : (data.data?.skills ?? [])
        setSkills(list.map((s) => String((s as { name?: string }).name ?? '?')).slice(0, 40))
      } else {
        const list = Array.isArray(data.data) ? data.data : (data.data?.jobs ?? [])
        setCron(
          list
            .slice(0, 20)
            .map((j) => ({
              name: typeof j.name === 'string' ? j.name : undefined,
              schedule: typeof j.schedule === 'string' ? j.schedule : undefined,
              enabled: j.enabled === true,
            }))
        )
      }
    } catch {
      toast.error(`Hermes ${which} peek failed`)
    } finally {
      setPanelLoading(false)
    }
  }

  return (
    <section aria-labelledby="hermes-heading" className="mist-glass rounded-xl p-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h3 id="hermes-heading" className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.25em] text-slate-500">
          <BriefcaseBusiness aria-hidden className="h-3.5 w-3.5 text-amber-300/80" />
          hermes · your business agent
        </h3>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="Re-probe Hermes now"
          onClick={() => void loadStatus(true)}
          disabled={checking}
          className="h-7 w-7 rounded-lg text-slate-500 hover:bg-white/5 hover:text-slate-300"
        >
          <RefreshCw aria-hidden className={cn('h-3.5 w-3.5', checking && 'animate-spin')} />
        </Button>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-6" aria-hidden>
          <Loader2 className="h-4 w-4 animate-spin text-slate-500" />
        </div>
      ) : offline ? (
        <div className="rounded-lg border border-amber-400/20 bg-amber-400/5 p-3">
          <div className="flex items-center gap-2">
            <StatusDot className={offline ? 'bg-rose-400' : 'bg-amber-400'} pulse={!offline} />
            <p className="text-xs font-medium text-amber-200">Bridge offline — Hermes not reachable</p>
          </div>
          <p className="mt-1.5 text-[11px] leading-relaxed text-slate-400">
            {status?.hint ??
              'Start the Mist Bridge on your PC to connect this console to your machine and the business agent.'}
          </p>
          <p className="mt-1 font-mono text-[10px] text-slate-600">
            watched every 10 min · you will be alerted the moment it connects and something changes
          </p>
        </div>
      ) : (
        <>
          {/* status strip */}
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <div className="rounded-lg border border-white/5 bg-white/[0.03] p-2.5">
              <p className="font-mono text-[9px] uppercase tracking-wider text-slate-600">installed</p>
              <div className="mt-1 flex items-center gap-1.5">
                <StatusDot className={installed ? 'bg-emerald-400' : 'bg-rose-400'} pulse={installed} />
                <span className="text-xs text-slate-200">{installed ? 'yes' : 'no'}</span>
              </div>
            </div>
            <div className="rounded-lg border border-white/5 bg-white/[0.03] p-2.5">
              <p className="font-mono text-[9px] uppercase tracking-wider text-slate-600">version</p>
              <p className="mt-1 truncate font-mono text-xs text-slate-200">{inner?.version ?? '—'}</p>
            </div>
            <div className="rounded-lg border border-white/5 bg-white/[0.03] p-2.5">
              <p className="font-mono text-[9px] uppercase tracking-wider text-slate-600">gateway</p>
              <div className="mt-1 flex items-center gap-1.5">
                <StatusDot className={gatewayHealthy ? 'bg-emerald-400' : 'bg-rose-400'} pulse={gatewayHealthy} />
                <span className="text-xs text-slate-200">{gatewayHealthy ? 'healthy' : 'down'}</span>
              </div>
            </div>
            <div className="rounded-lg border border-white/5 bg-white/[0.03] p-2.5">
              <p className="font-mono text-[9px] uppercase tracking-wider text-slate-600">skills</p>
              <p className="mt-1 font-mono text-xs text-slate-200">{sc !== null ? String(sc) : '—'}</p>
            </div>
          </div>

          {/* delegation — the business-control path */}
          <form onSubmit={onDelegate} className="mt-3 flex gap-2">
            <Input
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="Run a task on Hermes — e.g. 'summarize this week's sales and post the digest'"
              aria-label="Hermes delegation prompt"
              className="h-9 border-white/10 bg-white/[0.04] text-xs text-slate-200 placeholder:text-slate-600"
            />
            <Button
              type="submit"
              size="sm"
              disabled={delegating || !prompt.trim()}
              className="h-9 gap-1.5 rounded-lg bg-amber-400/15 text-[11px] font-medium text-amber-200 hover:bg-amber-400/25"
            >
              {delegating ? <Loader2 aria-hidden className="h-3.5 w-3.5 animate-spin" /> : <Send aria-hidden className="h-3.5 w-3.5" />}
              delegate
            </Button>
          </form>
          {delegating ? (
            <p className="mt-1.5 flex items-center gap-1.5 text-[10px] text-slate-500">
              <Sparkles aria-hidden className="h-3 w-3 animate-pulse text-amber-300/70" />
              Hermes is working — the conversation here stays alive while it runs.
            </p>
          ) : null}
          {delegateOut ? (
            <div className="mt-2 max-h-40 overflow-y-auto mist-scroll whitespace-pre-wrap rounded-lg border border-white/5 bg-black/30 p-2.5 font-mono text-[10px] leading-relaxed text-slate-300">
              {delegateOut}
            </div>
          ) : null}

          {/* skills + cron peeks */}
          <div className="mt-3 flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void openPanel('skills')}
              className={cn(
                'h-7 gap-1.5 rounded-lg border-white/10 bg-white/[0.03] px-2.5 text-[10px] text-slate-300 hover:bg-white/[0.07]',
                panel === 'skills' && 'border-amber-400/30 bg-amber-400/10 text-amber-200'
              )}
            >
              <Sparkles aria-hidden className="h-3 w-3" />
              skills
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void openPanel('cron')}
              className={cn(
                'h-7 gap-1.5 rounded-lg border-white/10 bg-white/[0.03] px-2.5 text-[10px] text-slate-300 hover:bg-white/[0.07]',
                panel === 'cron' && 'border-amber-400/30 bg-amber-400/10 text-amber-200'
              )}
            >
              <CalendarClock aria-hidden className="h-3 w-3" />
              cron
            </Button>
            {status?.cached ? (
              <span className="ml-auto font-mono text-[9px] text-slate-600">cached 60s</span>
            ) : null}
          </div>
          {panel !== 'none' ? (
            <div className="mt-2 max-h-44 overflow-y-auto mist-scroll rounded-lg border border-white/5 bg-black/20 p-2.5">
              {panelLoading ? (
                <p className="flex items-center justify-center py-3 text-[10px] text-slate-500" aria-hidden>
                  <Loader2 className="mr-1.5 h-3 w-3 animate-spin" /> asking Hermes…
                </p>
              ) : panel === 'skills' ? (
                skills.length > 0 ? (
                  <div className="flex flex-wrap gap-1.5">
                    {skills.map((s, i) => (
                      <MonoBadge key={`${s}-${i}`} className="border-amber-400/20 bg-amber-400/10 text-amber-200">
                        {s}
                      </MonoBadge>
                    ))}
                  </div>
                ) : (
                  <p className="text-[10px] text-slate-500">No skills reported.</p>
                )
              ) : cron.length > 0 ? (
                <ul className="space-y-1.5">
                  {cron.map((j, i) => (
                    <li key={`${j.name}-${i}`} className="flex items-center justify-between gap-2 text-[10px]">
                      <span className="truncate text-slate-300">{j.name ?? 'job'}</span>
                      <span className="shrink-0 font-mono text-slate-500">
                        {j.schedule ?? '—'} {j.enabled ? '' : '(paused)'}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-[10px] text-slate-500">No cron jobs reported.</p>
              )}
            </div>
          ) : null}
        </>
      )}
    </section>
  )
}
