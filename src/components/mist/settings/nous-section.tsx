'use client'

// NousSection — the Hermes / Nous Research provider: one provider, three real
// lanes (Nous Portal cloud, the local Hermes agent gateway, any local runtime
// like Ollama). Honest by design: the model id sent is one the serving lane
// actually understands, and the "last served" line shows what the endpoint
// reported back — never an alias. Mirrors qwen-section's structure and save
// flow exactly (POST /api/mist/config/env with {vars, confirmed:true}).

import { useEffect, useMemo, useState } from 'react'
import { Loader2, Save, Sparkles, Telescope } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { SectionLabel } from '@/components/mist/diagnostics/shared'
import { mistApi } from '@/lib/mist-api'
import { cn } from '@/lib/utils'
import type { LlmStatus, NousLane } from '@/lib/types'

const AUTO = 'auto'
const DEFAULT_BASE = 'https://inference-api.nousresearch.com/v1'

/** The three real lanes — clicking a preset just edits the base URL input. */
const LANE_PRESETS: { label: string; url: string; hint: string }[] = [
  { label: 'Nous Portal cloud', url: 'https://inference-api.nousresearch.com/v1', hint: '417-model aggregator — needs a portal key' },
  { label: 'Local Hermes agent (:8642)', url: 'http://127.0.0.1:8642/v1', hint: 'keyless — your Hermes agent gateway' },
  { label: 'Local runtime / Ollama (:11434)', url: 'http://127.0.0.1:11434/v1', hint: 'keyless — any local weights' },
]

const LANE_LABELS: Record<NousLane, string> = {
  'nous-portal': 'Nous Portal cloud',
  'hermes-gateway': 'Local Hermes agent (:8642)',
  local: 'Local runtime (Ollama / vLLM / LM Studio)',
  custom: 'Custom OpenAI-compatible endpoint',
}

/** Which lane does a base URL point at? (mirrors getNousLane in nous-models.ts) */
function resolveLane(url: string): NousLane {
  try {
    const u = new URL(url.trim())
    const port = Number(u.port) || (u.protocol === 'https:' ? 443 : 80)
    if (u.hostname === 'inference-api.nousresearch.com') return 'nous-portal'
    if ((u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '::1') && port === 8642)
      return 'hermes-gateway'
    if (u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '0.0.0.0' || u.hostname === '::1')
      return 'local'
    return 'custom'
  } catch {
    return 'custom'
  }
}

/** What 'auto' resolves to on a lane (mirrors resolveNousModelId in nous-models.ts). */
function autoModelForLane(lane: NousLane): string {
  if (lane === 'hermes-gateway') return 'hermes4'
  if (lane === 'local') return 'hermes4:405b'
  return 'Hermes-4-405B'
}

interface DiscoveredModel {
  id: string
  owned_by?: string
  context_length?: number
}

export function NousSection({
  status,
  apiKeyPresent,
  baseUrlValue,
  onSaved,
}: {
  status: LlmStatus | null
  apiKeyPresent: boolean
  baseUrlValue: string | null
  onSaved: () => void
}) {
  const info = status?.nous_models

  const [modelSel, setModelSel] = useState<string>(AUTO)
  const [apiKey, setApiKey] = useState('')
  const [baseUrl, setBaseUrl] = useState(DEFAULT_BASE)
  const [saving, setSaving] = useState(false)
  const [discovering, setDiscovering] = useState(false)
  const [discovered, setDiscovered] = useState<DiscoveredModel[] | null>(null)
  const [discoverError, setDiscoverError] = useState<string | null>(null)

  useEffect(() => {
    if (!info) return
    setModelSel(info.selected.text)
    setBaseUrl(baseUrlValue || info.base_url || DEFAULT_BASE)
  }, [info, baseUrlValue])

  const savedBase = baseUrlValue || info?.base_url || DEFAULT_BASE
  const dirty = useMemo(
    () =>
      Boolean(
        info &&
          (modelSel !== info.selected.text ||
            apiKey.trim().length > 0 ||
            baseUrl.trim() !== savedBase)
      ),
    [info, modelSel, apiKey, baseUrl, savedBase]
  )

  // lane derived from the INPUT (instant preset feedback); saved lane from the server
  const inputLane = resolveLane(baseUrl)
  const savedLane: NousLane = info?.lane ?? 'custom'
  const configured = info?.configured ?? false
  const autoModel = autoModelForLane(inputLane)

  const doSave = async () => {
    setSaving(true)
    try {
      const vars: Record<string, string> = {
        MIST_NOUS_MODEL: modelSel,
        MIST_NOUS_BASE_URL: baseUrl.trim() || DEFAULT_BASE,
      }
      if (apiKey.trim()) vars.MIST_NOUS_API_KEY = apiKey.trim()
      await mistApi.config.setEnv(vars, true)
      setApiKey('')
      toast.success('Hermes / Nous configuration saved')
      onSaved()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to save Hermes / Nous configuration')
    } finally {
      setSaving(false)
    }
  }

  const doDiscover = async () => {
    if (discovering) return
    setDiscovering(true)
    setDiscoverError(null)
    setDiscovered(null)
    try {
      const res = await fetch('/api/mist/llm/lanes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'discover', lane: 'nous' }),
      })
      const body = (await res.json()) as { lane?: string; models?: DiscoveredModel[]; error?: string }
      if (!res.ok || !Array.isArray(body.models)) {
        throw new Error(body.error ?? `discovery failed (HTTP ${res.status})`)
      }
      // guard: empty ids would break the Select and mean nothing — drop them honestly
      setDiscovered(body.models.filter((m) => typeof m.id === 'string' && m.id.trim().length > 0))
    } catch (e) {
      setDiscoverError(e instanceof Error ? e.message : 'discovery failed')
    } finally {
      setDiscovering(false)
    }
  }

  const catalogIds = useMemo(() => new Set((info?.text ?? []).map((m) => m.id)), [info])
  // a discovered / custom id selected outside the catalog still needs a SelectItem to render
  const extraItem =
    modelSel !== AUTO && !catalogIds.has(modelSel) ? (
      <SelectItem value={modelSel} className="font-mono text-xs text-slate-200">
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate">{modelSel}</span>
          <span className="shrink-0 text-[9px] uppercase tracking-wide text-purple-300/80">discovered / custom</span>
        </span>
      </SelectItem>
    ) : null

  const openRouterHint =
    modelSel === 'Hermes-4-405B' ? 'Also on OpenRouter as nousresearch/hermes-4-405b' : null

  return (
    <div className="mist-glass p-5 sm:p-6">
      <SectionLabel
        right={
          <span
            className={cn(
              'inline-flex items-center gap-1.5 font-mono text-[10px]',
              configured ? 'text-emerald-300/70' : 'text-amber-300/70'
            )}
          >
            <span
              className={cn('h-1.5 w-1.5 rounded-full', configured ? 'bg-emerald-300/80' : 'bg-amber-300/80')}
              aria-hidden="true"
            />
            {LANE_LABELS[savedLane]}
            {configured ? '' : ' · not configured'}
          </span>
        }
      >
        hermes / nous research
      </SectionLabel>
      <p className="mt-1.5 font-mono text-[10px] leading-relaxed text-slate-500">
        use Nous Research models (Hermes 4 / Hermes 3 / DeepHermes) as Mist&apos;s brain — via the Nous
        Portal cloud API, the local Hermes agent gateway on :8642, or any local runtime serving the
        weights (Ollama, vLLM, LM Studio).
      </p>

      {/* lane presets + custom base URL */}
      <div className="mt-4 space-y-2">
        <Label className="text-xs text-slate-300">Serving lane</Label>
        <div className="grid gap-2 sm:grid-cols-3">
          {LANE_PRESETS.map((p) => {
            const active = baseUrl.trim() === p.url
            return (
              <button
                key={p.url}
                type="button"
                onClick={() => setBaseUrl(p.url)}
                aria-pressed={active}
                title={p.hint}
                className={cn(
                  'rounded-xl border px-3 py-2 text-left font-mono text-[10px] leading-relaxed transition-colors',
                  active
                    ? 'border-purple-400/50 bg-purple-400/10 text-purple-200'
                    : 'border-white/10 bg-white/5 text-slate-400 hover:border-white/20 hover:text-slate-300'
                )}
              >
                <span className="block truncate">{p.label}</span>
                <span className={cn('block truncate text-[9px]', active ? 'text-purple-300/70' : 'text-slate-600')}>
                  {p.hint}
                </span>
              </button>
            )
          })}
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="nous-base-url" className="sr-only">
            Custom base URL
          </Label>
          <Input
            id="nous-base-url"
            type="text"
            autoComplete="off"
            spellCheck={false}
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder={DEFAULT_BASE}
            className="h-9 border-white/10 bg-white/5 font-mono text-xs text-slate-200"
          />
          <p className="font-mono text-[9px] text-slate-500">
            custom: any OpenAI-compatible endpoint · active input lane: {LANE_LABELS[inputLane]}
          </p>
        </div>
      </div>

      {/* key + model */}
      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="nous-api-key" className="text-xs text-slate-300">
            API key {apiKeyPresent ? <span className="text-emerald-300/70">· set</span> : null}
          </Label>
          <Input
            id="nous-api-key"
            type="password"
            autoComplete="off"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={
              apiKeyPresent
                ? '•••••••• (leave blank to keep)'
                : 'free/portal key from portal.nousresearch.com'
            }
            className="h-9 border-white/10 bg-white/5 font-mono text-xs text-slate-200"
          />
          <p className="font-mono text-[9px] text-slate-500">
            from portal.nousresearch.com — not needed for local lanes (Hermes gateway / Ollama)
          </p>
        </div>

        <div className="space-y-2">
          <Label htmlFor="nous-model" className="text-xs text-slate-300">
            Hermes model
          </Label>
          <Select value={modelSel} onValueChange={setModelSel}>
            <SelectTrigger
              id="nous-model"
              aria-label="Hermes / Nous model"
              className="h-9 w-full min-w-0 border-white/10 bg-white/5 font-mono text-xs text-slate-200"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="max-h-72 border-white/10 bg-slate-950/95 backdrop-blur-xl">
              <SelectItem value={AUTO} className="font-mono text-xs text-slate-200">
                <span className="flex items-center gap-2">
                  Auto — flagship per lane
                  <span className="text-[9px] uppercase tracking-wide text-slate-500">{autoModel}</span>
                </span>
              </SelectItem>
              {(info?.text ?? []).map((m) => (
                <SelectItem key={m.id} value={m.id} className="font-mono text-xs text-slate-200">
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="truncate">{m.label}</span>
                    <span className="shrink-0 text-[9px] uppercase tracking-wide text-slate-500">{m.tier}</span>
                  </span>
                </SelectItem>
              ))}
              {extraItem}
              <SelectItem value="__none__" disabled className="font-mono text-[10px] text-slate-500">
                {(info?.text ?? []).length} catalog models · Hermes 4 → Hermes 2
              </SelectItem>
            </SelectContent>
          </Select>
          <p className="font-mono text-[9px] text-slate-500">
            auto → <span className="text-slate-400">{autoModel}</span> on the {LANE_LABELS[inputLane]}
          </p>
          {openRouterHint ? (
            <p className="font-mono text-[9px] text-purple-300/70">{openRouterHint}</p>
          ) : null}
          {info?.live.text ? (
            <span className="inline-flex items-center gap-1 font-mono text-[10px] text-emerald-300/80">
              <Sparkles className="h-3 w-3" aria-hidden="true" />
              last served: {info.live.text}
            </span>
          ) : null}
        </div>
      </div>

      {/* live discovery */}
      <div className="mt-4 rounded-xl border border-white/5 bg-white/[0.02] p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="font-mono text-[10px] leading-relaxed text-slate-500">
            ask the Nous Portal which models it really serves right now — discovered ids can be picked
            above even when they are not in the catalog.
          </p>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={discovering}
            onClick={() => void doDiscover()}
            className="gap-1.5 border border-white/10 font-mono text-[10px] text-slate-300 hover:text-slate-100"
          >
            {discovering ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
            ) : (
              <Telescope className="h-3.5 w-3.5" aria-hidden="true" />
            )}
            Discover live models
          </Button>
        </div>
        {discoverError ? (
          <p className="mt-2 font-mono text-[10px] leading-relaxed text-slate-500">{discoverError}</p>
        ) : null}
        {discovered ? (
          <div className="mt-2">
            <p className="font-mono text-[9px] uppercase tracking-wide text-slate-600">
              {discovered.length} live models · click one to set it
            </p>
            <div className="mist-scroll mt-1.5 max-h-64 overflow-y-auto rounded-lg border border-white/5 bg-slate-950/60 p-1">
              {discovered.length === 0 ? (
                <p className="p-2 font-mono text-[10px] text-slate-600">empty catalog — nothing served</p>
              ) : (
                discovered.map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    onClick={() => setModelSel(m.id)}
                    className="flex w-full items-center justify-between gap-2 rounded-md px-2 py-1 text-left font-mono text-[10px] text-slate-400 transition-colors hover:bg-white/5 hover:text-slate-200"
                  >
                    <span className="min-w-0 truncate">{m.id}</span>
                    <span className="shrink-0 text-[9px] text-slate-600">
                      {m.owned_by ? `${m.owned_by} · ` : ''}
                      {m.context_length ? `${Math.round(m.context_length / 1000)}k ctx` : ''}
                    </span>
                  </button>
                ))
              )}
            </div>
          </div>
        ) : null}
      </div>

      {/* save */}
      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-md font-mono text-[10px] leading-relaxed text-slate-500">
          {configured
            ? 'Local lanes are keyless by design; the portal lane needs its key. The model name the endpoint reports is stamped on every reply.'
            : 'Pick a lane preset (local lanes need no key) or add a portal key to activate Hermes in the cascade.'}
        </p>
        <Button
          type="button"
          size="sm"
          disabled={!dirty || saving}
          onClick={() => void doSave()}
          className="gap-1.5 bg-purple-400/90 font-mono text-[11px] text-slate-950 hover:bg-purple-300"
        >
          {saving ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
          ) : (
            <Save className="h-3.5 w-3.5" aria-hidden="true" />
          )}
          Save Hermes config
        </Button>
      </div>
    </div>
  )
}
