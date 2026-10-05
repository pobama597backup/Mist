'use client'

// Missions — the creator's window into Mist's "do anything" engine: live
// mission list with progress, verification verdicts, pause/resume/cancel
// controls, and a launch form. Mounted inside the Sub-agents tab (missions
// are the machinery under every agent run — deliberately NOT an 11th drawer
// tab; the tab-grid probe guards against orphan grids).

import { useCallback, useEffect, useState } from 'react'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Rocket,
  Pause,
  Play,
  X,
  RotateCw,
  ChevronDown,
  ChevronRight,
  Loader2,
  Target,
} from 'lucide-react'
import { formatDistanceToNow } from 'date-fns'

interface MissionRow {
  id: string
  goal: string
  title: string
  status: string
  origin: string
  stepsUsed: number
  maxSteps: number
  failures: number
  result: string
  provider: string | null
  startedAt: string | null
  finishedAt: string | null
  createdAt: string
}

interface MissionStepRow {
  i: number
  tool: string
  ok: boolean
  summary: string
}

interface MissionDetail {
  mission: MissionRow
  steps: MissionStepRow[]
  plan: { title?: string; steps?: string[]; success_criteria?: string[] }
  gaps: string[]
  verification: { achieved?: boolean; score?: number; confidence?: number; reasoning?: string; gaps?: string[] }
}

const STATUS_STYLE: Record<string, string> = {
  queued: 'border-white/10 bg-white/5 text-slate-400',
  planning: 'border-amber-400/30 bg-amber-400/10 text-amber-300',
  running: 'border-emerald-400/30 bg-emerald-400/10 text-emerald-300',
  paused: 'border-sky-400/30 bg-sky-400/10 text-sky-300',
  awaiting_creator: 'border-fuchsia-400/30 bg-fuchsia-400/10 text-fuchsia-300',
  done: 'border-emerald-400/30 bg-emerald-400/10 text-emerald-300',
  failed: 'border-rose-400/30 bg-rose-400/10 text-rose-300',
  cancelled: 'border-white/10 bg-white/5 text-slate-500',
}

export function MissionsCard() {
  const [missions, setMissions] = useState<MissionRow[]>([])
  const [goal, setGoal] = useState('')
  const [launching, setLaunching] = useState(false)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [details, setDetails] = useState<Record<string, MissionDetail>>({})
  const [busy, setBusy] = useState<Record<string, boolean>>({})

  const refresh = useCallback(() => {
    fetch('/api/mist/missions')
      .then((res) => res.json())
      .then((data: { missions?: MissionRow[] }) => {
        setMissions(Array.isArray(data.missions) ? data.missions : [])
      })
      .catch(() => {})
  }, [])

  useEffect(() => {
    refresh()
    const active = missions.some((m) => ['queued', 'planning', 'running'].includes(m.status))
    const t = setInterval(refresh, active ? 4000 : 15000) // fast poll while work is live
    return () => clearInterval(t)
  }, [refresh, missions])

  useEffect(() => {
    // load detail for the expanded mission
    if (!expanded || details[expanded]) return
    fetch(`/api/mist/missions/${expanded}`)
      .then((res) => res.json())
      .then((d: MissionDetail) => {
        setDetails((prev) => ({ ...prev, [expanded]: d }))
      })
      .catch(() => {})
  }, [expanded, details])

  const launch = () => {
    const g = goal.trim()
    if (!g || launching) return
    setLaunching(true)
    fetch('/api/mist/missions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ goal: g }),
    })
      .then(() => {
        setGoal('')
        setTimeout(refresh, 600)
      })
      .catch(() => {})
      .finally(() => setLaunching(false))
  }

  const control = (id: string, action: 'pause' | 'resume' | 'cancel') => {
    if (busy[id]) return
    setBusy((prev) => ({ ...prev, [id]: true }))
    fetch(`/api/mist/missions/${id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action }),
    })
      .then(() => setTimeout(refresh, 500))
      .catch(() => {})
      .finally(() => {
        setBusy((prev) => ({ ...prev, [id]: false }))
      })
  }

  const active = missions.filter((m) => ['queued', 'planning', 'running'].includes(m.status)).length
  const doneCount = missions.filter((m) => m.status === 'done').length

  return (
    <Card>
      <CardContent className="p-4 space-y-4">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Target className="h-4 w-4 text-emerald-400" />
            <h4 className="font-medium">Missions</h4>
            <span className="text-xs text-muted-foreground">
              {active > 0 ? `${active} live · ` : ''}
              {doneCount} completed
            </span>
          </div>
          <Button variant="outline" size="sm" onClick={refresh}>
            <RotateCw className="mr-2 h-3.5 w-3.5" />
            Refresh
          </Button>
        </div>

        <div className="flex gap-2">
          <Input
            placeholder="Give Mist a mission — e.g. Organize my Downloads folder by file type…"
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') launch()
            }}
            disabled={launching}
          />
          <Button size="sm" onClick={launch} disabled={launching || !goal.trim()}>
            {launching ? (
              <>
                <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                Launching
              </>
            ) : (
              <>
                <Rocket className="mr-2 h-3.5 w-3.5" />
                Launch
              </>
            )}
          </Button>
        </div>

        <div className="space-y-2 max-h-96 overflow-y-auto pr-1">
          {missions.length === 0 ? (
            <p className="text-sm text-muted-foreground py-2">
              No missions yet — launch one above, or just ask Mist in chat (&ldquo;start a mission to…&rdquo;).
            </p>
          ) : (
            missions.map((m) => {
              const isOpen = expanded === m.id
              const detail = details[m.id]
              const isActive = ['queued', 'planning', 'running'].includes(m.status)
              return (
                <div key={m.id} className="rounded-lg border border-border/60">
                  <button
                    className="flex w-full items-center justify-between gap-3 p-3 text-left hover:bg-accent/40 transition-colors"
                    onClick={() => setExpanded(isOpen ? null : m.id)}
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="text-sm font-medium truncate">{m.title || m.goal.slice(0, 60)}</p>
                        <span
                          className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-mono uppercase tracking-wide ${
                            STATUS_STYLE[m.status] ?? STATUS_STYLE.queued
                          }`}
                        >
                          {['running', 'planning'].includes(m.status) && (
                            <Loader2 className="h-3 w-3 animate-spin" />
                          )}
                          {m.status}
                        </span>
                      </div>
                      <p className="text-xs text-muted-foreground truncate">{m.goal}</p>
                      <p className="text-xs text-muted-foreground">
                        {m.stepsUsed}/{m.maxSteps} steps · by {m.origin} ·{' '}
                        {formatDistanceToNow(new Date(m.createdAt), { addSuffix: true })}
                      </p>
                    </div>
                    {isOpen ? (
                      <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" />
                    ) : (
                      <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
                    )}
                  </button>

                  {isOpen && (
                    <div className="border-t border-border/60 p-3 space-y-3">
                      {detail ? (
                        <>
                          {detail.plan?.success_criteria && detail.plan.success_criteria.length > 0 && (
                            <div>
                              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1">
                                Success criteria
                              </p>
                              <ul className="text-xs text-muted-foreground list-disc list-inside space-y-0.5">
                                {detail.plan.success_criteria.map((c, i) => (
                                  <li key={i}>{c}</li>
                                ))}
                              </ul>
                            </div>
                          )}
                          <div>
                            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1">
                              Transcript ({detail.steps.length} steps)
                            </p>
                            {detail.steps.length === 0 ? (
                              <p className="text-xs text-muted-foreground">(nothing executed yet)</p>
                            ) : (
                              <div className="space-y-1 max-h-56 overflow-y-auto font-mono text-xs">
                                {detail.steps.map((s) => (
                                  <div
                                    key={s.i}
                                    className={`rounded px-2 py-1 ${
                                      s.tool === '(system)' || s.tool === '(verifier)'
                                        ? 'bg-amber-400/5 text-amber-300/80'
                                        : s.ok
                                          ? 'bg-emerald-400/5 text-emerald-300/90'
                                          : 'bg-rose-400/5 text-rose-300/90'
                                    }`}
                                  >
                                    <span className="opacity-60">[{s.i}]</span> {s.tool}{' '}
                                    {s.ok ? '✓' : '✗'} —{' '}
                                    <span className="opacity-80">{s.summary.slice(0, 220)}</span>
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                          {detail.mission.result && (
                            <div>
                              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1">
                                Result
                              </p>
                              <pre className="whitespace-pre-wrap text-xs text-muted-foreground max-h-40 overflow-y-auto font-mono">
                                {detail.mission.result}
                              </pre>
                            </div>
                          )}
                          {detail.verification && detail.verification.achieved !== undefined && (
                            <div
                              className={`rounded-lg border p-2 text-xs ${
                                detail.verification.achieved
                                  ? 'border-emerald-400/30 bg-emerald-400/5 text-emerald-300'
                                  : 'border-amber-400/30 bg-amber-400/5 text-amber-300'
                              }`}
                            >
                              <span className="font-medium">
                                Verifier: {detail.verification.achieved ? 'ACHIEVED' : 'PARTIAL'} · score{' '}
                                {detail.verification.score ?? '?'}/100 · confidence{' '}
                                {detail.verification.confidence ?? '?'}%
                              </span>
                              {detail.verification.reasoning && (
                                <p className="mt-1 opacity-80">{detail.verification.reasoning}</p>
                              )}
                              {detail.gaps.length > 0 && (
                                <p className="mt-1 opacity-80">Gaps: {detail.gaps.join('; ')}</p>
                              )}
                            </div>
                          )}
                        </>
                      ) : (
                        <p className="text-xs text-muted-foreground flex items-center gap-2">
                          <Loader2 className="h-3 w-3 animate-spin" /> loading detail…
                        </p>
                      )}

                      <div className="flex items-center gap-2 pt-1">
                        {isActive && (
                          <Button variant="outline" size="sm" disabled={busy[m.id]} onClick={() => control(m.id, 'pause')}>
                            <Pause className="mr-2 h-3.5 w-3.5" />
                            Pause
                          </Button>
                        )}
                        {['paused', 'awaiting_creator'].includes(m.status) && (
                          <Button variant="outline" size="sm" disabled={busy[m.id]} onClick={() => control(m.id, 'resume')}>
                            <Play className="mr-2 h-3.5 w-3.5" />
                            Resume
                          </Button>
                        )}
                        {!['done', 'failed', 'cancelled'].includes(m.status) && (
                          <Button variant="outline" size="sm" disabled={busy[m.id]} onClick={() => control(m.id, 'cancel')}>
                            <X className="mr-2 h-3.5 w-3.5" />
                            Cancel
                          </Button>
                        )}
                        <span className="text-[10px] font-mono text-muted-foreground ml-auto">{m.id}</span>
                      </div>
                    </div>
                  )}
                </div>
              )
            })
          )}
        </div>
      </CardContent>
    </Card>
  )
}
