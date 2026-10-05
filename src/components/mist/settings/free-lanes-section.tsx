'use client'

// FreeLanesSection — the researched map of EVERY way to get top models into
// Mist: subscription lanes (TheOldAPI), free tiers (Groq, GitHub Models,
// HuggingFace, Cerebras, Mistral…), credit lanes (NVIDIA, Together), local
// runtimes and gateways. Each card shows live activation status, lets the
// creator add a key inline, and can Discover the lane's REAL model list —
// picking a discovered id writes the lane's model env var directly.

import { useCallback, useEffect, useState } from 'react'
import { ChevronDown, ExternalLink, KeyRound, Loader2, RefreshCw, Sparkles, Telescope, Zap } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import { MonoBadge, SectionLabel } from '@/components/mist/diagnostics/shared'
import { mistApi } from '@/lib/mist-api'
import { cn } from '@/lib/utils'
import type { FreeLaneInfo } from '@/lib/types'

interface DiscoveredModel {
  id: string
  owned_by?: string
  context_length?: number
}

const KIND_STYLES: Record<FreeLaneInfo['kind'], string> = {
  local: 'border-emerald-400/30 bg-emerald-400/10 text-emerald-300',
  'free-tier': 'border-teal-400/30 bg-teal-400/10 text-teal-300',
  subscription: 'border-violet-400/30 bg-violet-400/10 text-violet-300',
  credits: 'border-amber-400/30 bg-amber-400/10 text-amber-300',
  gateway: 'border-white/15 bg-white/5 text-slate-400',
  keyless: 'border-purple-400/30 bg-purple-400/10 text-purple-300',
}

const KIND_LABELS: Record<FreeLaneInfo['kind'], string> = {
  local: 'local',
  'free-tier': 'free tier',
  subscription: 'subscription',
  credits: 'credits',
  gateway: 'gateway',
  keyless: 'keyless',
}

function StatusChip({ lane }: { lane: FreeLaneInfo }) {
  if (lane.status === 'active') {
    return (
      <span className="inline-flex items-center gap-1 font-mono text-[10px] text-emerald-300/80">
        <span className="h-1.5 w-1.5 rounded-full bg-emerald-300/80" aria-hidden="true" />
        active
      </span>
    )
  }
  if (lane.status === 'custom') {
    return (
      <span className="inline-flex items-center gap-1 font-mono text-[10px] text-slate-400">
        <span className="h-1.5 w-1.5 rounded-full bg-slate-500" aria-hidden="true" />
        custom
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-1 font-mono text-[10px] text-amber-300/80">
      <span className="h-1.5 w-1.5 rounded-full bg-amber-300/80" aria-hidden="true" />
      {lane.keyEnv ? 'needs key — one key away' : 'one switch away'}
    </span>
  )
}

function LaneCard({ lane, onSaved }: { lane: FreeLaneInfo; onSaved: () => void }) {
  const [keyInput, setKeyInput] = useState('')
  const [modelInput, setModelInput] = useState('')
  const [savingKey, setSavingKey] = useState(false)
  const [discovering, setDiscovering] = useState(false)
  const [discovered, setDiscovered] = useState<DiscoveredModel[] | null>(null)
  const [discoverError, setDiscoverError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState(false)
  const [busyModelId, setBusyModelId] = useState<string | null>(null)

  const showKeyRow = lane.status === 'ready' && Boolean(lane.keyEnv)
  const showModelRow = lane.id === 'theoldapi' && Boolean(lane.modelEnv)

  const canSaveKey = !savingKey && (keyInput.trim().length > 0 || (showModelRow && modelInput.trim().length > 0))

  const doSaveKey = async () => {
    if (!canSaveKey) return
    setSavingKey(true)
    try {
      const vars: Record<string, string> = {}
      if (keyInput.trim() && lane.keyEnv) vars[lane.keyEnv] = keyInput.trim()
      if (showModelRow && modelInput.trim() && lane.modelEnv) vars[lane.modelEnv] = modelInput.trim()
      await mistApi.config.setEnv(vars, true)
      setKeyInput('')
      setModelInput('')
      toast.success(`${lane.label.split('—')[0]?.trim() || lane.label} — key stored, lane activated`)
      onSaved()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to store the key')
    } finally {
      setSavingKey(false)
    }
  }

  const doDiscover = async () => {
    if (discovering) return
    setDiscovering(true)
    setDiscoverError(null)
    try {
      const res = await fetch('/api/mist/llm/lanes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'discover', lane: lane.id }),
      })
      const body = (await res.json()) as { lane?: string; models?: DiscoveredModel[]; error?: string }
      if (!res.ok || !Array.isArray(body.models)) {
        throw new Error(body.error ?? `discovery failed (HTTP ${res.status})`)
      }
      // guard: empty ids mean nothing and must never reach an env var — drop them honestly
      setDiscovered(body.models.filter((m) => typeof m.id === 'string' && m.id.trim().length > 0))
      setExpanded(true)
    } catch (e) {
      setDiscoverError(e instanceof Error ? e.message : 'discovery failed')
    } finally {
      setDiscovering(false)
    }
  }

  const doUseModel = async (id: string) => {
    if (!lane.modelEnv || busyModelId) return
    setBusyModelId(id)
    try {
      await mistApi.config.setEnv({ [lane.modelEnv]: id }, true)
      toast.success(`${lane.modelEnv} = ${id}`)
      onSaved()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to set the model')
    } finally {
      setBusyModelId(null)
    }
  }

  return (
    <div className="mist-glass-soft flex h-full flex-col gap-2.5 p-3.5">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-xs font-medium leading-snug text-slate-200">{lane.label}</p>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <MonoBadge className={KIND_STYLES[lane.kind]} title={`${KIND_LABELS[lane.kind]} lane`}>
              {KIND_LABELS[lane.kind]}
            </MonoBadge>
            <StatusChip lane={lane} />
          </div>
        </div>
        {lane.signupUrl ? (
          <a
            href={lane.signupUrl}
            target="_blank"
            rel="noreferrer"
            aria-label={`Open ${lane.label} in a new tab`}
            title={lane.signupUrl}
            className="shrink-0 rounded-md p-1.5 text-slate-500 transition-colors hover:bg-white/5 hover:text-slate-300"
          >
            <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
          </a>
        ) : null}
      </div>

      <div className="space-y-0.5">
        <p className="font-mono text-[10px] text-slate-400">{lane.pricing}</p>
        <p className="font-mono text-[9px] leading-relaxed text-slate-500">{lane.limits}</p>
      </div>

      <p className="line-clamp-3 font-mono text-[9px] leading-relaxed text-slate-500" title={lane.notes}>
        {lane.notes}
      </p>

      {showKeyRow ? (
        <div className="space-y-1.5">
          <div className="flex items-center gap-1.5">
            <KeyRound className="h-3 w-3 shrink-0 text-amber-300/70" aria-hidden="true" />
            <Input
              id={`lane-key-${lane.id}`}
              type="password"
              autoComplete="off"
              value={keyInput}
              onChange={(e) => setKeyInput(e.target.value)}
              placeholder={lane.keyEnv ?? 'API key'}
              aria-label={`${lane.label} API key`}
              className="h-8 min-w-0 border-white/10 bg-white/5 font-mono text-[10px] text-slate-200"
            />
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={!canSaveKey}
              onClick={() => void doSaveKey()}
              className="h-8 shrink-0 gap-1 border-white/10 bg-white/5 px-2.5 font-mono text-[10px] text-slate-300 hover:bg-white/10 hover:text-slate-100"
            >
              {savingKey ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" /> : null}
              Set key
            </Button>
          </div>
          {showModelRow ? (
            <Input
              id={`lane-model-${lane.id}`}
              type="text"
              autoComplete="off"
              spellCheck={false}
              value={modelInput}
              onChange={(e) => setModelInput(e.target.value)}
              placeholder={`${lane.modelEnv} — e.g. ${lane.defaultModel}`}
              aria-label={`${lane.label} model`}
              className="h-8 border-white/10 bg-white/5 font-mono text-[10px] text-slate-200"
            />
          ) : null}
        </div>
      ) : null}

      <div className="mt-auto space-y-1.5">
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={discovering}
          onClick={() => void doDiscover()}
          aria-label={`Discover live models on ${lane.label}`}
          className="gap-1.5 px-2 font-mono text-[10px] text-slate-400 hover:text-slate-200"
        >
          {discovering ? (
            <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
          ) : (
            <Telescope className="h-3 w-3" aria-hidden="true" />
          )}
          Discover
        </Button>

        {discoverError ? (
          <p className="font-mono text-[9px] leading-relaxed text-slate-500">{discoverError}</p>
        ) : null}

        {discovered ? (
          <Collapsible open={expanded} onOpenChange={setExpanded}>
            <div className="flex items-center justify-between gap-2">
              <MonoBadge className="border-white/10 bg-white/5 text-slate-400">
                {discovered.length} live models
              </MonoBadge>
              <CollapsibleTrigger asChild>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  aria-label={expanded ? 'Hide discovered models' : 'Show discovered models'}
                  className="h-6 gap-1 px-1.5 font-mono text-[9px] text-slate-500 hover:text-slate-300"
                >
                  {expanded ? 'hide' : 'show'}
                  <ChevronDown
                    className={cn('h-3 w-3 transition-transform', expanded && 'rotate-180')}
                    aria-hidden="true"
                  />
                </Button>
              </CollapsibleTrigger>
            </div>
            <CollapsibleContent>
              <div className="mist-scroll mt-1.5 max-h-64 overflow-y-auto rounded-lg border border-white/5 bg-slate-950/60 p-1">
                {discovered.length === 0 ? (
                  <p className="p-2 font-mono text-[10px] text-slate-600">empty catalog — nothing served</p>
                ) : (
                  discovered.map((m) => (
                    <div
                      key={m.id}
                      className="flex items-center justify-between gap-2 rounded-md px-2 py-1 transition-colors hover:bg-white/5"
                    >
                      <span className="min-w-0 truncate font-mono text-[10px] text-slate-400" title={m.id}>
                        {m.id}
                      </span>
                      <span className="flex shrink-0 items-center gap-2">
                        <span className="font-mono text-[9px] text-slate-600">
                          {m.owned_by ? `${m.owned_by} · ` : ''}
                          {m.context_length ? `${Math.round(m.context_length / 1000)}k` : ''}
                        </span>
                        {lane.modelEnv ? (
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            disabled={busyModelId !== null}
                            onClick={() => void doUseModel(m.id)}
                            aria-label={`Use ${m.id} as the ${lane.label} model`}
                            className="h-5 px-1.5 font-mono text-[9px] text-purple-300/80 hover:text-purple-200"
                          >
                            {busyModelId === m.id ? (
                              <Loader2 className="h-2.5 w-2.5 animate-spin" aria-hidden="true" />
                            ) : (
                              'use'
                            )}
                          </Button>
                        ) : null}
                      </span>
                    </div>
                  ))
                )}
              </div>
            </CollapsibleContent>
          </Collapsible>
        ) : null}
      </div>
    </div>
  )
}

export function FreeLanesSection({
  refreshKey,
  onSaved,
}: {
  /** Bump to refetch the lane map (the parent's presenceKey pattern). */
  refreshKey?: number
  onSaved: () => void
}) {
  const [lanes, setLanes] = useState<FreeLaneInfo[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const fetchLanes = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/mist/llm/lanes', { cache: 'no-store' })
      const body = (await res.json()) as { lanes?: FreeLaneInfo[]; error?: string }
      if (!res.ok || !Array.isArray(body.lanes)) {
        throw new Error(body.error ?? `lane map unreadable (HTTP ${res.status})`)
      }
      setLanes(body.lanes)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'lane map unreadable')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void fetchLanes()
  }, [fetchLanes, refreshKey])

  return (
    <div className="mist-glass p-5 sm:p-6">
      <SectionLabel
        right={
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={loading}
            onClick={() => void fetchLanes()}
            aria-label="Refresh lane statuses"
            className="h-6 gap-1 px-1.5 font-mono text-[9px] text-slate-500 hover:text-slate-300"
          >
            {loading ? (
              <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
            ) : (
              <RefreshCw className="h-3 w-3" aria-hidden="true" />
            )}
            refresh
          </Button>
        }
      >
        free lanes — unlimited &amp; top-model access
      </SectionLabel>
      <p className="mt-1.5 font-mono text-[10px] leading-relaxed text-slate-500">
        lanes higher in the cascade serve first; active lanes are used in order until one answers.
        unconfigured lanes are skipped instantly — every lane you key becomes another brain Mist can
        fall back on.
      </p>

      <div className="mt-3 flex items-start gap-2 rounded-xl border border-purple-400/25 bg-purple-400/5 p-2.5">
        <Sparkles className="mt-0.5 h-3.5 w-3.5 shrink-0 text-purple-300/80" aria-hidden="true" />
        <p className="font-mono text-[10px] leading-relaxed text-purple-200/70">
          the four KEYLESS lanes work the moment Mist boots — no key, no signup, nothing to configure.
          kilo code serves the 550B nemotron reasoning brain (200 req/hr), pollinations serves gpt-oss-20b,
          llm7 rotates turbo models live, and OVHcloud serves Qwen3.5-397B from the EU. they sit right
          before Mist Core in the cascade and re-discover catalogs every 30 minutes as providers rotate
          models — so they keep working. MIST_KEYLESS=0 turns them all off.
        </p>
      </div>

      <div className="mt-2.5 flex items-start gap-2 rounded-xl border border-amber-400/20 bg-amber-400/5 p-2.5">
        <Zap className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-300/80" aria-hidden="true" />
        <p className="font-mono text-[10px] leading-relaxed text-amber-200/70">
          the $7/mo TheOldAPI lane is the closest thing to unlimited top models — 50M adjusted tokens
          per day (reset daily) across 100+ top-model routes through one OpenAI-compatible endpoint.
        </p>
      </div>

      {error ? (
        <p className="mt-3 font-mono text-[10px] leading-relaxed text-amber-300/70">{error}</p>
      ) : null}

      <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2">
        {loading && !lanes
          ? [0, 1, 2, 3, 4, 5].map((i) => <Skeleton key={i} className="h-44 rounded-xl bg-white/5" />)
          : (lanes ?? []).map((lane) => <LaneCard key={lane.id} lane={lane} onSaved={onSaved} />)}
      </div>
    </div>
  )
}
