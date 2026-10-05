'use client'

// Sub-agents — the creator's human-in-the-loop window into MIST's workers.
// (Evolution proposal by MIST herself; reviewer-corrected API shapes and
// extended with the launch-run form + run detail views.)

import { useCallback, useEffect, useState } from 'react'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Play, Pause, RotateCw, ChevronDown, ChevronRight, Loader2 } from 'lucide-react'
import { formatDistanceToNow } from 'date-fns'
import { Skeleton } from '@/components/ui/skeleton'
import type { SubAgent, AgentRun } from '@/lib/types'
import { MissionsCard } from './missions-card'
import { TrainingCard } from './training-card'

function parseJsonArray<T>(raw: unknown): T[] {
  if (Array.isArray(raw)) return raw as T[]
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw)
      return Array.isArray(parsed) ? (parsed as T[]) : []
    } catch {
      return []
    }
  }
  return []
}

export function SubagentsTab() {
  const [agents, setAgents] = useState<SubAgent[]>([])
  const [runs, setRuns] = useState<AgentRun[]>([])
  const [loading, setLoading] = useState(true)
  const [goals, setGoals] = useState<Record<string, string>>({})
  const [running, setRunning] = useState<Record<string, boolean>>({})
  const [expanded, setExpanded] = useState<string | null>(null)

  const refresh = useCallback(() => {
    fetch('/api/mist/subagents')
      .then((res) => res.json())
      .then((data: SubAgent[]) => {
        setAgents(Array.isArray(data) ? data : [])
        setLoading(false)
      })
      .catch(() => setLoading(false))
    fetch('/api/mist/subagents?scope=runs')
      .then((res) => res.json())
      .then((data: { runs?: AgentRun[] }) => {
        setRuns(Array.isArray(data.runs) ? data.runs : [])
      })
      .catch(() => {})
  }, [])

  useEffect(() => {
    refresh()
    const t = setInterval(refresh, 15_000) // live-ish updates without a socket contract
    return () => clearInterval(t)
  }, [refresh])

  const toggleAgentStatus = (id: string, currentStatus: string) => {
    const newStatus = currentStatus === 'active' ? 'paused' : 'active'
    fetch(`/api/mist/subagents/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: newStatus }),
    })
      .then(() => {
        setAgents((prev) =>
          prev.map((agent) => (agent.id === id ? { ...agent, status: newStatus } : agent))
        )
      })
      .catch(() => {})
  }

  const launchRun = (agent: SubAgent) => {
    const goal = (goals[agent.id] ?? '').trim()
    if (!goal || running[agent.id]) return
    setRunning((prev) => ({ ...prev, [agent.id]: true }))
    fetch(`/api/mist/subagents/${agent.id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ goal, triggeredBy: 'user' }),
    })
      .then(() => {
        setGoals((prev) => ({ ...prev, [agent.id]: '' }))
        setTimeout(refresh, 800)
      })
      .catch(() => {})
      .finally(() => {
        setRunning((prev) => ({ ...prev, [agent.id]: false }))
        setTimeout(refresh, 1500)
      })
  }

  if (loading) {
    return (
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium tracking-wide font-mono text-muted-foreground uppercase">
            Sub-agents
          </h3>
          <Skeleton className="h-8 w-20" />
        </div>
        {[1, 2].map((i) => (
          <Card key={i} className="p-4">
            <div className="space-y-2">
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-3 w-48" />
            </div>
          </Card>
        ))}
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium tracking-wide font-mono text-muted-foreground uppercase">
          Sub-agents
        </h3>
        <Button variant="outline" size="sm" onClick={refresh}>
          <RotateCw className="mr-2 h-3.5 w-3.5" />
          Refresh
        </Button>
      </div>

      <div className="grid grid-cols-1 gap-4">
        {agents.length === 0 ? (
          <Card>
            <CardContent className="flex flex-col items-center justify-center py-8 text-center">
              <p className="text-sm text-muted-foreground">No sub-agents yet</p>
              <p className="text-xs text-muted-foreground mt-1">
                Ask MIST in chat to create one, or POST to /api/mist/subagents
              </p>
            </CardContent>
          </Card>
        ) : (
          agents.map((agent) => (
            <Card key={agent.id} className="p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="space-y-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <h4 className="font-medium">{agent.name}</h4>
                    <Badge variant={agent.status === 'active' ? 'default' : 'secondary'}>
                      {agent.status}
                    </Badge>
                    <span className="text-xs font-mono text-muted-foreground">{agent.role}</span>
                  </div>
                  <p className="text-sm text-muted-foreground">{agent.description}</p>
                  <p className="text-xs text-muted-foreground">
                    {agent.runCount} run{agent.runCount === 1 ? '' : 's'} · last{' '}
                    {agent.lastRunAt
                      ? formatDistanceToNow(new Date(agent.lastRunAt), { addSuffix: true })
                      : 'never'}
                  </p>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => toggleAgentStatus(agent.id, agent.status)}
                  disabled={running[agent.id]}
                >
                  {agent.status === 'active' ? (
                    <>
                      <Pause className="mr-2 h-3.5 w-3.5" />
                      Pause
                    </>
                  ) : (
                    <>
                      <Play className="mr-2 h-3.5 w-3.5" />
                      Resume
                    </>
                  )}
                </Button>
              </div>

              <div className="mt-3 flex gap-2">
                <Input
                  placeholder={`Give ${agent.name} a goal…`}
                  value={goals[agent.id] ?? ''}
                  onChange={(e) => setGoals((prev) => ({ ...prev, [agent.id]: e.target.value }))}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') launchRun(agent)
                  }}
                  disabled={agent.status !== 'active' || running[agent.id]}
                />
                <Button
                  size="sm"
                  onClick={() => launchRun(agent)}
                  disabled={agent.status !== 'active' || running[agent.id] || !(goals[agent.id] ?? '').trim()}
                >
                  {running[agent.id] ? (
                    <>
                      <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                      Running
                    </>
                  ) : (
                    <>
                      <Play className="mr-2 h-3.5 w-3.5" />
                      Run
                    </>
                  )}
                </Button>
              </div>
            </Card>
          ))
        )}
      </div>

      <TrainingCard />

      <MissionsCard />

      <div>
        <h3 className="text-sm font-medium tracking-wide font-mono text-muted-foreground uppercase mb-3">
          Run history — everything your agents did
        </h3>
        <div className="space-y-2 max-h-96 overflow-y-auto pr-1">
          {runs.length === 0 ? (
            <p className="text-sm text-muted-foreground">No runs recorded yet</p>
          ) : (
            runs.map((run) => {
              const isOpen = expanded === run.id
              return (
                <div key={run.id} className="rounded-lg border border-border/60">
                  <button
                    className="flex w-full items-center justify-between gap-3 p-3 text-left hover:bg-accent/40 transition-colors"
                    onClick={() => setExpanded(isOpen ? null : run.id)}
                  >
                    <div className="min-w-0">
                      <p className="text-sm font-medium truncate">{run.goal}</p>
                      <p className="text-xs text-muted-foreground">
                        {run.agent?.name ?? 'agent'} · {run.status} · by {run.triggeredBy}
                        {run.durationMs > 0 && ` · ${Math.round(run.durationMs / 1000)}s`}
                      </p>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <span className="text-xs text-muted-foreground">
                        {formatDistanceToNow(new Date(run.createdAt), { addSuffix: true })}
                      </span>
                      {isOpen ? (
                        <ChevronDown className="h-4 w-4 text-muted-foreground" />
                      ) : (
                        <ChevronRight className="h-4 w-4 text-muted-foreground" />
                      )}
                    </div>
                  </button>
                  {isOpen && (
                    <div className="border-t border-border/60 p-3 space-y-2">
                      {parseJsonArray<string>(run.toolsUsed).length > 0 && (
                        <div className="flex flex-wrap gap-1">
                          {parseJsonArray<string>(run.toolsUsed).map((t, i) => (
                            <Badge key={i} variant="outline" className="text-xs font-mono">
                              {t}
                            </Badge>
                          ))}
                        </div>
                      )}
                      {run.error && (
                        <p className="text-xs text-destructive">error: {run.error}</p>
                      )}
                      <pre className="whitespace-pre-wrap text-xs text-muted-foreground max-h-64 overflow-y-auto font-mono">
                        {run.result || '(no result text)'}
                      </pre>
                      <p className="text-xs text-muted-foreground">
                        run id: <span className="font-mono">{run.id}</span>
                      </p>
                    </div>
                  )}
                </div>
              )
            })
          )}
        </div>
      </div>
    </div>
  )
}
