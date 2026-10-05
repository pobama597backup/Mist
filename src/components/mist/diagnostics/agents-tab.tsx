'use client'

// M.I.S.T. agents tab — external CLI coding agent bridge (Claude Code, Codex,
// Gemini CLI, Aider). Shows what's installed on THIS machine and delegates
// headless tasks without the user ever opening the agent.
// Honest by design: not-installed agents say so, with install hints.

import { useEffect, useState, type FormEvent } from 'react'
import { Bot, Loader2, Play, RefreshCw, Terminal } from 'lucide-react'
import { toast } from 'sonner'
import { mistApi } from '@/lib/mist-api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'
import { MonoBadge, StatusDot } from './shared'
import { HermesCard } from './hermes-card'

interface AgentRow {
  id: string
  label: string
  cmd: string
  installed: boolean
  version: string | null
  delegate: 'headless' | 'interactive-only'
  install_hint: string
}

interface DelegateState {
  running: boolean
  output: string
  error: string | null
  durationMs: number | null
}

export function AgentsTab() {
  const [agents, setAgents] = useState<AgentRow[] | null>(null)
  const [loadError, setLoadError] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)
  const [agentsStatus, setAgentsStatus] = useState<'online' | 'offline' | 'unknown'>('unknown')
  const [selected, setSelected] = useState<string>('claude-code')
  const [task, setTask] = useState('')
  const [result, setResult] = useState<DelegateState>({ running: false, output: '', error: null, durationMs: null })

  useEffect(() => {
    let alive = true
    Promise.resolve()
      .then(() => {
        if (!alive) return undefined
        setAgents(null)
        setLoadError(false)
        return mistApi.agents.list()
      })
      .then((r) => {
        if (!alive || !r) return
        setAgents(r.agents)
      })
      .catch(() => {
        if (alive) {
          setLoadError(true)
          setAgentsStatus('offline')
        }
      })
    return () => {
      alive = false
    }
  }, [reloadKey])

  const installedAgents = (agents ?? []).filter((a) => a.installed && a.delegate === 'headless')
  const selectedAgent = (agents ?? []).find((a) => a.id === selected) ?? null

  const onDelegate = async (e: FormEvent) => {
    e.preventDefault()
    const t = task.trim()
    if (!t || result.running) return
    setResult({ running: true, output: '', error: null, durationMs: null })
    try {
      const r = await mistApi.agents.delegate(selected, t, 120000)
      setResult({
        running: false,
        output: r.output || '(no output)',
        error: r.error ?? (r.ok ? null : `exit code ${r.exit_code ?? 'unknown'}`),
        durationMs: r.duration_ms,
      })
      if (!r.installed) toast.warning(`${selectedAgent?.label ?? selected} is not installed on this machine`)
      else if (r.ok) toast.success('Agent task complete')
    } catch {
      setResult({ running: false, output: '', error: 'delegation request failed', durationMs: null })
      toast.error('Delegation failed')
    }
  }

  return (
    <div className="space-y-4">
      {/* hermes — the creator's business agent (command center, w4) */}
      <HermesCard />

      {/* registry */}
      <section aria-labelledby="agents-registry-heading">
        <div className="mb-2 flex items-center justify-between">
          <h3 id="agents-registry-heading" className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.25em] text-slate-500">
            <Bot aria-hidden className="h-3.5 w-3.5" />
            agent bridge · this machine
          </h3>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Re-probe installed agents"
            onClick={() => setReloadKey((k) => k + 1)}
            className="h-7 w-7 rounded-lg text-slate-500 hover:bg-white/5 hover:text-slate-300"
          >
            <RefreshCw aria-hidden className="h-3.5 w-3.5" />
          </Button>
        </div>

        {agents === null && !loadError ? (
          <div className="space-y-2" aria-hidden>
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-14 w-full rounded-xl bg-white/5" />
            ))}
          </div>
        ) : loadError ? (
          <div className="mist-glass-soft rounded-xl p-4 text-center">
            <p className="text-xs text-slate-400">Agent bridge unreachable.</p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setReloadKey((k) => k + 1)}
              className="mt-2 rounded-lg border-white/10 bg-white/5 text-[11px] text-slate-300 hover:bg-white/10"
            >
              retry
            </Button>
          </div>
        ) : (
          <div className="space-y-2">
            {(agents ?? []).map((a) => (
              <div key={a.id} className="mist-glass-soft rounded-xl p-3">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-2">
                    <StatusDot className={a.installed ? 'bg-emerald-400' : 'bg-rose-400'} pulse={a.installed} />
                    <div className="min-w-0">
                      <p className="truncate text-xs font-medium text-slate-200">{a.label}</p>
                      <p className="truncate font-mono text-[10px] text-slate-500">
                        {a.cmd}
                        {a.version ? ` · ${a.version}` : ''}
                      </p>
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    {a.delegate === 'interactive-only' ? (
                      <MonoBadge className="border-slate-400/25 bg-slate-400/5 text-slate-400">interactive</MonoBadge>
                    ) : (
                      <MonoBadge className="border-purple-300/25 bg-purple-300/5 text-purple-300/80">headless</MonoBadge>
                    )}
                    <MonoBadge
                      className={cn(
                        a.installed
                          ? 'border-emerald-300/25 bg-emerald-300/5 text-emerald-300/80'
                          : 'border-rose-300/25 bg-rose-300/5 text-rose-300/70'
                      )}
                    >
                      {a.installed ? 'installed' : 'not installed'}
                    </MonoBadge>
                  </div>
                </div>
                {!a.installed ? (
                  <p className="mt-1.5 font-mono text-[10px] text-slate-500">install: {a.install_hint}</p>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </section>

      {/* delegate */}
      <section aria-labelledby="agents-delegate-heading">
        <h3 id="agents-delegate-heading" className="mb-2 flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.25em] text-slate-500">
          <Terminal aria-hidden className="h-3.5 w-3.5" />
          delegate a task
        </h3>
        <form onSubmit={onDelegate} className="mist-glass-soft space-y-3 rounded-xl p-3">
          <Select value={selected} onValueChange={setSelected}>
            <SelectTrigger
              aria-label="Agent"
              className="w-full border-white/10 bg-white/5 font-mono text-xs text-slate-200 focus-visible:ring-purple-400/60"
            >
              <SelectValue placeholder="agent" />
            </SelectTrigger>
            <SelectContent className="border-white/10 bg-slate-900/95 font-mono text-xs backdrop-blur-xl">
              {(agents ?? []).map((a) => (
                <SelectItem key={a.id} value={a.id} className="text-slate-300 focus:bg-purple-400/15 focus:text-purple-100">
                  {a.label} {a.installed ? '' : '(not installed)'}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Textarea
            value={task}
            onChange={(e) => setTask(e.target.value)}
            rows={3}
            placeholder="e.g. Refactor src/lib/utils.ts to remove unused exports, then summarize the changes"
            aria-label="Task for the agent"
            className="min-h-16 border-white/10 bg-white/5 text-xs text-slate-100 placeholder:text-slate-500 focus-visible:ring-purple-400/60"
          />
          <Button
            type="submit"
            disabled={!task.trim() || result.running}
            className="w-full gap-2 rounded-lg border border-purple-400/40 bg-purple-400/20 text-xs text-purple-100 hover:bg-purple-400/30 focus-visible:ring-purple-400/60 disabled:opacity-40"
          >
            {result.running ? (
              <Loader2 aria-hidden className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Play aria-hidden className="h-3.5 w-3.5" />
            )}
            {result.running ? 'agent working…' : 'run headless task'}
          </Button>
          {installedAgents.length === 0 && agents !== null ? (
            <p className="text-center font-mono text-[10px] leading-relaxed text-slate-500">
              no headless agents installed here — M.I.S.T. will honestly say so and offer alternatives.
              deploy M.I.S.T. on a machine with Claude Code installed and delegation runs for real.
            </p>
          ) : null}
        </form>

        {result.running || result.output || result.error ? (
          <div className="mist-glass-soft mt-3 rounded-xl p-3" role="status">
            <div className="mb-1.5 flex items-center justify-between">
              <span className="font-mono text-[10px] uppercase tracking-widest text-slate-500">output</span>
              {result.durationMs !== null ? (
                <span className="font-mono text-[10px] text-slate-500">{(result.durationMs / 1000).toFixed(1)}s</span>
              ) : null}
            </div>
            {result.error ? (
              <p className="mb-2 rounded-lg border border-rose-300/25 bg-rose-300/5 px-2 py-1.5 font-mono text-[10px] text-rose-300/90">
                {result.error}
              </p>
            ) : null}
            <pre className="mist-scroll max-h-56 overflow-auto whitespace-pre-wrap break-words font-mono text-[10px] leading-relaxed text-slate-300">
              {result.output || (result.running ? 'waiting for agent…' : '')}
            </pre>
          </div>
        ) : null}
      </section>
    </div>
  )
}
