'use client'

// SettingsView — full-page preferences: LLM providers (env-presence aware),
// experience tuning, live telemetry sparklines, skills registry and about.

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { motion } from 'framer-motion'
import {
  Bot,
  Cable,
  Check,
  Copy,
  Download,
  FolderOpen,
  FolderSearch,
  Hand,
  Loader2,
  Mic,
  Minus,
  Monitor,
  Play,
  RotateCcw,
  RotateCw,
  Save,
  Sparkles,
  Terminal,
  Unplug,
  Zap,
  AudioLines,
} from 'lucide-react'
import { toast } from 'sonner'
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion'
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
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Slider } from '@/components/ui/slider'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { useTelemetry } from '@/hooks/use-telemetry'
import { mistApi } from '@/lib/mist-api'
import { useMistStore } from '@/lib/store'
import { TTS_VOICES } from '@/lib/mist-constants'
import { cn } from '@/lib/utils'
import { SectionLabel, Sparkline, StatusDot, MonoBadge, metricTextColor, relTime } from '@/components/mist/diagnostics/shared'
import { SkillsTab } from '@/components/mist/diagnostics/skills-tab'
import { CoreModelsSection } from '@/components/mist/settings/core-models-section'
import { QwenModelsSection } from '@/components/mist/settings/qwen-section'
import type { BridgeStatus, EnvPresenceResponse, LlmStatus, ProviderId, VaultStatus } from '@/lib/types'
import { mistSpeech } from '@/lib/speech'
import {
  checkLocalVoice,
  getLastLocalVoiceDetail,
  type LocalVoiceDetail,
} from '@/lib/services/voice-local'
import type { VoiceMode } from '@/lib/store'

// ---------- provider model (env names mirror .env.example) ----------

interface ProviderField {
  key: string
  label: string
  type: 'text' | 'password'
  placeholder: string
}

interface ProviderSpec {
  id: ProviderId
  label: string
  fields: ProviderField[]
}

const PROVIDER_SPECS: ProviderSpec[] = [
  {
    id: 'omniroute',
    label: 'OmniRoute',
    fields: [
      { key: 'OMNIROUTE_BASE_URL', label: 'Base URL', type: 'text', placeholder: 'http://localhost:20128/v1' },
      { key: 'OMNIROUTE_API_KEY', label: 'API key', type: 'password', placeholder: '••••••••' },
      { key: 'OMNIROUTE_MODEL', label: 'Model', type: 'text', placeholder: 'free-b' },
    ],
  },
  {
    id: 'openai_compatible',
    label: 'OpenAI-compatible',
    fields: [
      { key: 'OPENAI_BASE_URL', label: 'Base URL', type: 'text', placeholder: 'https://api.example.com/v1' },
      { key: 'OPENAI_API_KEY', label: 'API key', type: 'password', placeholder: '••••••••' },
      { key: 'OPENAI_MODEL', label: 'Model', type: 'text', placeholder: 'gpt-4o-mini' },
    ],
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    fields: [
      { key: 'OPENROUTER_API_KEY', label: 'API key', type: 'password', placeholder: '••••••••' },
      { key: 'OPENROUTER_MODEL', label: 'Model', type: 'text', placeholder: 'meta-llama/…' },
    ],
  },
  {
    id: 'qwen',
    label: 'Qwen (Alibaba)',
    fields: [
      { key: 'MIST_QWEN_API_KEY', label: 'API key', type: 'password', placeholder: 'sk-… DashScope key' },
      { key: 'MIST_QWEN_BASE_URL', label: 'Base URL', type: 'text', placeholder: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
    ],
  },
  {
    id: 'anthropic',
    label: 'Anthropic',
    fields: [
      { key: 'ANTHROPIC_API_KEY', label: 'API key', type: 'password', placeholder: '••••••••' },
      { key: 'ANTHROPIC_MODEL', label: 'Model', type: 'text', placeholder: 'claude-sonnet-4' },
    ],
  },
  {
    id: 'gemini',
    label: 'Gemini',
    fields: [
      { key: 'GEMINI_API_KEY', label: 'API key', type: 'password', placeholder: '••••••••' },
      { key: 'GEMINI_MODEL', label: 'Model', type: 'text', placeholder: 'gemini-2.0-flash' },
    ],
  },
]

/** Voice-mode choices for the local voice card (auto default). */
const VOICE_MODES: { id: VoiceMode; label: string; hint: string }[] = [
  { id: 'auto', label: 'Auto', hint: 'local offline engines when both are installed, cloud otherwise' },
  {
    id: 'local',
    label: 'Local',
    hint: 'always whisper + piper on this machine — falls back to cloud until both are installed',
  },
  { id: 'cloud', label: 'Cloud', hint: 'the built-in cloud voice, exactly as before' },
  {
    id: 'browser',
    label: 'Browser',
    hint: 'browser speech recognition for hearing + the cloud voice for speaking',
  },
]

function PresenceChip({ label, present }: { label: string; present: boolean | null }) {
  if (present === null) return null
  return (
    <span
      className={cn(
        'inline-flex items-center gap-0.5 rounded-full border px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wide',
        present ? 'border-emerald-400/30 bg-emerald-400/10 text-emerald-300' : 'border-white/10 bg-white/5 text-slate-500'
      )}
    >
      {present ? <Check className="h-2.5 w-2.5" aria-hidden="true" /> : <Minus className="h-2.5 w-2.5" aria-hidden="true" />}
      {label}
    </span>
  )
}

// ---------- provider item ----------

function ProviderItem({
  spec,
  envMap,
  llmMap,
  onSaved,
}: {
  spec: ProviderSpec
  envMap: Map<string, { present: boolean; value?: string }>
  llmMap: Map<ProviderId, { available: boolean; model?: string; base_url_present?: boolean; api_key_present?: boolean }>
  onSaved: () => void
}) {
  const [form, setForm] = useState<Record<string, string>>({})
  const [confirmSave, setConfirmSave] = useState(false)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)

  const keyField = spec.fields.find((f) => f.key.endsWith('_API_KEY'))
  const baseField = spec.fields.find((f) => f.key.endsWith('_BASE_URL'))
  const modelField = spec.fields.find((f) => f.key.endsWith('_MODEL'))

  const keyPresent = keyField ? (envMap.get(keyField.key)?.present ?? llmMap.get(spec.id)?.api_key_present ?? null) : null
  const basePresent = baseField ? (envMap.get(baseField.key)?.present ?? llmMap.get(spec.id)?.base_url_present ?? null) : null
  const modelPresent = modelField
    ? (envMap.get(modelField.key)?.present ?? (llmMap.get(spec.id)?.model != null && llmMap.get(spec.id)!.model !== '' ? true : null))
    : null

  const nonEmptyFields = spec.fields.filter((f) => (form[f.key] ?? '').trim().length > 0)
  const canSave = !saving && nonEmptyFields.length > 0

  const doSave = async () => {
    setSaving(true)
    try {
      const vars: Record<string, string> = {}
      for (const f of nonEmptyFields) vars[f.key] = (form[f.key] ?? '').trim()
      await mistApi.config.setEnv(vars, true)
      toast.success('Configuration saved')
      setForm({})
      onSaved()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to write configuration')
    } finally {
      setSaving(false)
      setConfirmSave(false)
    }
  }

  const doTest = async () => {
    setTesting(true)
    try {
      const res = await mistApi.llm.test('Reply with the single word READY.', spec.id)
      toast.success(`Responded via ${res.provider} (${res.fallback ? 'fallback' : res.model})`)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Connection test failed')
    } finally {
      setTesting(false)
    }
  }

  return (
    <AccordionItem value={spec.id} className="border-b border-white/5 last:border-b-0">
      <AccordionTrigger className="rounded-lg px-1 py-3 font-mono text-xs text-slate-200 hover:no-underline hover:text-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-400/60">
        <span className="flex min-w-0 flex-1 flex-wrap items-center gap-2 pr-2 text-left">
          <span className="shrink-0">{spec.label}</span>
          <span className="flex flex-wrap items-center gap-1">
            {keyPresent !== null ? <PresenceChip label="key" present={keyPresent} /> : null}
            {basePresent !== null ? <PresenceChip label="base" present={basePresent} /> : null}
            {modelPresent !== null ? <PresenceChip label="model" present={modelPresent} /> : null}
          </span>
        </span>
      </AccordionTrigger>
      <AccordionContent className="space-y-3 px-1 pb-4">
        <div className="grid gap-3 sm:grid-cols-2">
          {spec.fields.map((f) => (
            <div key={f.key} className={cn('space-y-1.5', f.type === 'password' && 'sm:col-span-2')}>
              <Label htmlFor={`${spec.id}-${f.key}`} className="font-mono text-[10px] uppercase tracking-widest text-slate-500">
                {f.label}
              </Label>
              <Input
                id={`${spec.id}-${f.key}`}
                type={f.type}
                value={form[f.key] ?? ''}
                onChange={(e) => setForm((m) => ({ ...m, [f.key]: e.target.value }))}
                placeholder={f.placeholder}
                autoComplete="off"
                className="h-9 border-white/10 bg-white/5 font-mono text-xs text-slate-200 placeholder:text-slate-500"
              />
            </div>
          ))}
        </div>
        <p className="font-mono text-[10px] leading-relaxed text-slate-500">
          Values are written to the local .env and never echoed back.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            size="sm"
            disabled={!canSave}
            onClick={() => setConfirmSave(true)}
            className="gap-1.5 bg-purple-400/90 font-mono text-[11px] text-slate-950 hover:bg-purple-300"
          >
            <Save className="h-3.5 w-3.5" aria-hidden="true" /> Save
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={testing}
            onClick={() => void doTest()}
            className="gap-1.5 border-white/15 bg-white/5 font-mono text-[11px] text-slate-300 hover:border-white/30 hover:bg-white/10"
          >
            {testing ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <Zap className="h-3.5 w-3.5" aria-hidden="true" />}
            Test connection
          </Button>
        </div>

        <AlertDialog open={confirmSave} onOpenChange={setConfirmSave}>
          <AlertDialogContent className="border-white/10 bg-slate-950/95 backdrop-blur-2xl sm:max-w-sm">
            <AlertDialogHeader>
              <AlertDialogTitle className="font-mono text-sm tracking-widest text-slate-200">
                WRITE PROVIDER SETTINGS TO .ENV?
              </AlertDialogTitle>
              <AlertDialogDescription className="font-mono text-[11px] leading-relaxed text-slate-400">
                {nonEmptyFields.length} field{nonEmptyFields.length === 1 ? '' : 's'} for {spec.label} will be written to
                the local .env file. Keys stay on this machine — they are never sent anywhere else.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter className="gap-2 sm:justify-end">
              <AlertDialogCancel className="font-mono text-xs">Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={(e) => {
                  e.preventDefault()
                  void doSave()
                }}
                disabled={saving}
                className="bg-purple-400/90 font-mono text-xs text-slate-950 hover:bg-purple-300"
              >
                {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : null}
                Write to .env
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </AccordionContent>
    </AccordionItem>
  )
}

// ---------- companions (v7 — the owner's local agent stack, via the bridge) ----------

/** Local, defensive mirror of the bridge daemon's companions payload (all keys optional). */
interface CompanionHermesInfo {
  installed?: boolean
  version?: string | null
  cliOnPath?: boolean
  home?: string
  repoPath?: string | null
  gatewayUp?: boolean
  skillsCount?: number
}

interface CompanionDirInfo {
  installed?: boolean
  path?: string | null
  hasVenv?: boolean
  configured?: boolean
  faces?: string[]
}

interface CompanionCliInfo {
  installed?: boolean
  version?: string | null
}

interface CompanionSignalInfo {
  dir?: string
  source?: string
}

interface CompanionMcpInfo {
  registerCommand?: string
}

interface CompanionsPayload {
  ok?: boolean
  hermes?: CompanionHermesInfo
  backtalk?: CompanionDirInfo
  aiVisualizer?: CompanionDirInfo
  barehands?: CompanionDirInfo
  claudeCode?: CompanionCliInfo
  signal?: CompanionSignalInfo
  mcp?: CompanionMcpInfo
}

/** One row of the companion stack list — icon, name, one-line description and a status slot. */
function CompanionRow({
  icon: Icon,
  name,
  desc,
  installed,
  detail,
  children,
}: {
  icon: typeof Bot
  name: string
  desc: string
  installed?: boolean
  detail?: string | null
  children?: ReactNode
}) {
  const on = Boolean(installed)
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1.5 py-2.5 first:pt-0 last:pb-0">
      <span
        className={cn(
          'flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-white/5',
          on ? 'bg-white/5 text-slate-300' : 'text-slate-600'
        )}
      >
        <Icon className="h-3.5 w-3.5" aria-hidden="true" />
      </span>
      <div className="min-w-0 flex-1">
        <p className={cn('font-mono text-[11px]', on ? 'text-slate-200' : 'text-slate-500')}>{name}</p>
        <p className="font-mono text-[10px] leading-relaxed text-slate-500">{desc}</p>
        {on && detail ? (
          <p className="mt-0.5 truncate font-mono text-[9px] text-slate-600" title={detail}>
            {detail}
          </p>
        ) : null}
      </div>
      <div className="flex max-w-full flex-wrap items-center justify-end gap-1.5">
        {on ? children : <span className="font-mono text-[10px] text-slate-600">not detected</span>}
      </div>
    </li>
  )
}

// ---------- main view ----------

export function SettingsView() {
  const animationIntensity = useMistStore((s) => s.animationIntensity)
  const setAnimationIntensity = useMistStore((s) => s.setAnimationIntensity)
  const reducedMotion = useMistStore((s) => s.reducedMotion)
  const setReducedMotion = useMistStore((s) => s.setReducedMotion)
  const ttsEnabled = useMistStore((s) => s.ttsEnabled)
  const setTtsEnabled = useMistStore((s) => s.setTtsEnabled)
  const voice = useMistStore((s) => s.voice)
  const setVoice = useMistStore((s) => s.setVoice)
  // The user's explicit M.I.S.T. preference wins over the OS signal.
  const noMotion = reducedMotion

  const [env, setEnv] = useState<EnvPresenceResponse | null>(null)
  const [llmStatus, setLlmStatus] = useState<LlmStatus | null>(null)
  const [presenceError, setPresenceError] = useState<string | null>(null)
  const [presenceKey, setPresenceKey] = useState(0)

  // knowledge vault (Obsidian) — 10-e2
  const [vault, setVault] = useState<VaultStatus | null>(null)
  const [vaultError, setVaultError] = useState(false)
  const [vaultFound, setVaultFound] = useState<Array<{ path: string; noteCount: number }> | null>(null)
  const [vaultBusy, setVaultBusy] = useState<string | null>(null)
  const [vaultKey, setVaultKey] = useState(0)

  // identity & directives (v6) — the owner-written core identity override
  const [identity, setIdentity] = useState<string | null>(null) // null = still loading
  const [identityStored, setIdentityStored] = useState(false)
  const [identitySaving, setIdentitySaving] = useState(false)

  // local bridge (v6) — owner-side system control via the Mist Bridge daemon
  const [bridge, setBridge] = useState<BridgeStatus | null>(null)
  const [bridgeError, setBridgeError] = useState(false)
  const [bridgeUrl, setBridgeUrl] = useState('')
  const [bridgeBusy, setBridgeBusy] = useState<'save' | 'test' | null>(null)

  // companions (v7) — the owner's local agent stack, scanned through the bridge
  const [companionsLoading, setCompanionsLoading] = useState(false)
  const [companionsData, setCompanionsData] = useState<CompanionsPayload | null>(null)
  const [companionsError, setCompanionsError] = useState<string | null>(null)
  const [companionsScanAt, setCompanionsScanAt] = useState<Date | null>(null)
  const companionsAutoScannedRef = useRef(false)
  const [signalPerforming, setSignalPerforming] = useState(false)
  const [mcpCopied, setMcpCopied] = useState(false)

  // voice wake word (v6) — store-bound
  const wakeWordEnabled = useMistStore((s) => s.wakeWordEnabled)
  const setWakeWordEnabled = useMistStore((s) => s.setWakeWordEnabled)

  // local voice (v3) — offline whisper.cpp hearing + piper speaking via the bridge
  const voiceMode = useMistStore((s) => s.voiceMode)
  const setVoiceMode = useMistStore((s) => s.setVoiceMode)
  const [voiceDetail, setVoiceDetail] = useState<LocalVoiceDetail | null>(null)
  const [voiceOffline, setVoiceOffline] = useState(false)
  const [voiceChecking, setVoiceChecking] = useState(true)
  const [voiceSetupBusy, setVoiceSetupBusy] = useState<'stt' | 'tts' | null>(null)
  const [voiceTesting, setVoiceTesting] = useState(false)
  const localVoiceScannedRef = useRef(false)

  useEffect(() => {
    let alive = true
    mistApi.memory.longterm
      .list()
      .then((facts) => {
        if (!alive) return
        const stored = facts.find((f) => f.key === 'mist:identity')
        setIdentity(stored?.value ?? '')
        setIdentityStored(Boolean(stored?.value))
      })
      .catch(() => {
        if (alive) setIdentity('')
      })
    return () => {
      alive = false
    }
  }, [])

  useEffect(() => {
    let alive = true
    mistApi.bridge
      .status()
      .then((r) => {
        if (!alive) return
        setBridge(r.status)
        setBridgeUrl(r.status.url)
        setBridgeError(false)
      })
      .catch(() => {
        if (alive) setBridgeError(true)
      })
    return () => {
      alive = false
    }
  }, [])

  useEffect(() => {
    let alive = true
    mistApi.obsidian
      .status()
      .then((s) => {
        if (alive) {
          setVault(s)
          setVaultError(false)
        }
      })
      .catch(() => {
        if (alive) setVaultError(true)
      })
    return () => {
      alive = false
    }
  }, [vaultKey])

  useEffect(() => {
    let alive = true
    const run = async () => {
      try {
        const [e, l] = await Promise.all([mistApi.config.env(), mistApi.llm.status()])
        if (!alive) return
        setEnv(e)
        setLlmStatus(l)
        setPresenceError(null)
      } catch {
        if (alive) setPresenceError('presence unreadable — is the core running?')
      }
    }
    void run()
    return () => {
      alive = false
    }
  }, [presenceKey])

  const envMap = useMemo(() => {
    const m = new Map<string, { present: boolean; value?: string }>()
    for (const v of env?.vars ?? []) m.set(v.name, { present: v.present, value: v.value })
    return m
  }, [env])

  const llmMap = useMemo(() => {
    const m = new Map<ProviderId, { available: boolean; model?: string; base_url_present?: boolean; api_key_present?: boolean }>()
    for (const p of llmStatus?.providers_detail ?? [])
      m.set(p.id, { available: p.available, model: p.model, base_url_present: p.base_url_present, api_key_present: p.api_key_present })
    return m
  }, [llmStatus])

  const { data: t, history } = useTelemetry(true, 2000)

  const vaultScan = () => {
    setVaultBusy('scan')
    mistApi.obsidian
      .discover()
      .then((r) => {
        setVaultFound(r.found)
        if (r.found.length === 0)
          toast.info('No vaults found nearby — use the demo vault, or connect by path in Diagnostics → Vault')
      })
      .catch((e) => toast.error(e instanceof Error ? e.message : 'Vault discovery failed'))
      .finally(() => setVaultBusy(null))
  }

  const vaultConnect = (path: string) => {
    setVaultBusy(path)
    mistApi.obsidian
      .setPath(path)
      .then((s) => {
        if (s.connected) {
          toast.success(path === 'demo' ? 'Demo vault connected' : `Vault connected — ${s.noteCount} notes`)
          setVault(s)
          setVaultFound(null)
          setVaultKey((k) => k + 1)
        } else {
          toast.error('Could not open that vault — is it an Obsidian directory?')
        }
      })
      .catch((e) => toast.error(e instanceof Error ? e.message : 'Connect failed'))
      .finally(() => setVaultBusy(null))
  }

  const vaultDisconnect = () => {
    setVaultBusy('disconnect')
    mistApi.obsidian
      .setPath(null)
      .then((s) => {
        setVault(s)
        toast.success('Vault disconnected')
        setVaultKey((k) => k + 1)
      })
      .catch((e) => toast.error(e instanceof Error ? e.message : 'Disconnect failed'))
      .finally(() => setVaultBusy(null))
  }

  const identitySave = () => {
    const value = (identity ?? '').trim()
    if (!value) return
    setIdentitySaving(true)
    mistApi.memory.longterm
      .set('mist:identity', value)
      .then(() => {
        toast.success("Identity saved — she'll speak as this from the next message")
        setIdentityStored(true)
      })
      .catch((e) => toast.error(e instanceof Error ? e.message : 'Could not save the identity'))
      .finally(() => setIdentitySaving(false))
  }

  const identityReset = () => {
    setIdentitySaving(true)
    mistApi.memory.longterm
      .remove('mist:identity')
      .then(() => {
        setIdentity('')
        setIdentityStored(false)
        toast.success('Back to the built-in identity')
      })
      .catch((e) => toast.error(e instanceof Error ? e.message : 'Could not reset the identity'))
      .finally(() => setIdentitySaving(false))
  }

  const bridgeSave = () => {
    const url = bridgeUrl.trim()
    if (!url) return
    setBridgeBusy('save')
    mistApi.bridge
      .setUrl(url)
      .then((r) => {
        setBridge(r.status)
        setBridgeError(false)
        toast.success(
          r.status.connected
            ? 'Bridge URL saved — daemon connected'
            : 'Bridge URL saved — daemon not responding yet (is it running?)'
        )
      })
      .catch((e) => toast.error(e instanceof Error ? e.message : 'Invalid bridge URL'))
      .finally(() => setBridgeBusy(null))
  }

  const bridgeTest = () => {
    setBridgeBusy('test')
    mistApi.bridge
      .status()
      .then((r) => {
        setBridge(r.status)
        setBridgeError(false)
        if (r.status.connected) {
          toast.success(`Bridge connected — ${r.status.platform ?? 'unknown platform'} · ${r.status.hostname ?? ''}`)
        } else {
          toast.info(`Bridge offline — no daemon answering at ${r.status.url}`)
        }
      })
      .catch((e) => toast.error(e instanceof Error ? e.message : 'Bridge check failed'))
      .finally(() => setBridgeBusy(null))
  }

  // ---- companions (v7) — derived payload views + scan / signal / mcp wiring ----

  const companionsHermes = companionsData?.hermes
  const companionsBacktalk = companionsData?.backtalk
  const companionsVisualizer = companionsData?.aiVisualizer
  const companionsBarehands = companionsData?.barehands
  const companionsClaude = companionsData?.claudeCode
  const companionsSignal = companionsData?.signal
  const companionsMcp = companionsData?.mcp
  const visualizerFacesRaw = companionsVisualizer?.faces
  const visualizerFaces = Array.isArray(visualizerFacesRaw)
    ? visualizerFacesRaw.filter((f): f is string => typeof f === 'string')
    : []

  const scanCompanions = useCallback(() => {
    setCompanionsLoading(true)
    setCompanionsError(null)
    mistApi.companions
      .get()
      .then((r) => {
        if (r.connected && r.companions) {
          setCompanionsData(r.companions as CompanionsPayload)
          setCompanionsScanAt(new Date())
        } else {
          setCompanionsData(null)
          setCompanionsScanAt(null)
          if (!r.connected) toast.info('bridge offline — start the daemon above, then refresh')
        }
      })
      .catch((e) => {
        setCompanionsData(null)
        setCompanionsScanAt(null)
        setCompanionsError(e instanceof Error ? e.message : 'companion scan failed')
      })
      .finally(() => setCompanionsLoading(false))
  }, [])

  // auto-scan once the bridge is known connected (the refresh button always re-scans);
  // the once-guard is a ref and the scan is deferred off the effect's synchronous path
  useEffect(() => {
    if (companionsAutoScannedRef.current) return
    if (bridge === null || !bridge.connected) return
    companionsAutoScannedRef.current = true
    const t = window.setTimeout(() => void scanCompanions(), 0)
    return () => window.clearTimeout(t)
  }, [bridge, scanCompanions])

  const performSignalTest = () => {
    if (signalPerforming) return
    setSignalPerforming(true)
    mistApi.companions
      .signalTest()
      .then((r) => {
        if (r.ok) {
          toast.success(r.performed ? `performed on faces — ${r.performed}` : 'performed on faces')
        } else {
          toast.error(r.error ?? 'signal test failed')
        }
      })
      .catch((e) => toast.error(e instanceof Error ? e.message : 'signal test failed'))
      .finally(() => setSignalPerforming(false))
  }

  const copyMcpCommand = async () => {
    const cmd = companionsMcp?.registerCommand
    if (!cmd) return
    try {
      await navigator.clipboard.writeText(cmd)
      setMcpCopied(true)
      toast.success('Copied')
      window.setTimeout(() => setMcpCopied(false), 2000)
    } catch {
      toast.error('clipboard unavailable — copy the command manually')
    }
  }

  // ---- local voice (v3): status probe / installs / mode selector / test ----

  const refreshLocalVoice = useCallback((force = true) => {
    setVoiceChecking(true)
    void checkLocalVoice(force)
      .then(() => {
        const detail = getLastLocalVoiceDetail()
        setVoiceDetail(detail)
        setVoiceOffline(!detail)
      })
      .catch(() => {
        setVoiceDetail(null)
        setVoiceOffline(true)
      })
      .finally(() => setVoiceChecking(false))
  }, [])

  // probe once on mount; re-probe automatically when the bridge is known connected
  useEffect(() => {
    if (localVoiceScannedRef.current) return
    if (bridge === null) return
    localVoiceScannedRef.current = true
    refreshLocalVoice(true)
  }, [bridge, refreshLocalVoice])

  const installVoiceEngine = (engine: 'stt' | 'tts') => {
    if (voiceSetupBusy !== null) return
    setVoiceSetupBusy(engine)
    mistApi.voice
      .localSetup(engine)
      .then((r) => {
        if (r.result?.ok) {
          toast.success(
            engine === 'stt'
              ? 'Whisper hearing installed — offline and ready'
              : 'Piper voice installed — offline and ready'
          )
          refreshLocalVoice(true)
        } else {
          toast.error(r.result?.error ?? 'install failed')
        }
      })
      .catch((e) => toast.error(e instanceof Error ? e.message : 'install failed'))
      .finally(() => setVoiceSetupBusy(null))
  }

  const testLocalVoice = async () => {
    if (voiceTesting) return
    setVoiceTesting(true)
    try {
      await mistSpeech.speak('Local voice online.', { force: true })
    } finally {
      setVoiceTesting(false)
    }
  }

  const sectionMotion = (i: number) => ({
    initial: noMotion ? false : { opacity: 0, y: 12 },
    animate: { opacity: 1, y: 0 },
    transition: { duration: noMotion ? 0 : 0.35, delay: noMotion ? 0 : i * 0.05, ease: 'easeOut' as const },
  })

  return (
    <div className="mx-auto w-full min-w-0 max-w-3xl space-y-6 py-2">
      {/* header */}
      <header className="px-1">
        <h1 className="text-xl font-semibold text-slate-100">Settings</h1>
        <p className="mt-1 font-mono text-[11px] text-slate-400">sovereign · local-first · zero cloud lock-in</p>
      </header>

      {/* ---- providers ---- */}
      <motion.section {...sectionMotion(0)} aria-label="Providers" className="mist-glass p-5 sm:p-6">
        <SectionLabel>providers</SectionLabel>
        <p className="mt-1.5 font-mono text-[10px] leading-relaxed text-slate-500">
          presence is detected from the local .env — secrets are never displayed, only shown as configured.
        </p>
        {presenceError ? (
          <p className="mt-1.5 font-mono text-[10px] text-amber-300/70">{presenceError}</p>
        ) : null}
        <Accordion type="single" collapsible className="mt-3 w-full">
          {PROVIDER_SPECS.map((spec) => (
            <ProviderItem key={spec.id} spec={spec} envMap={envMap} llmMap={llmMap} onSaved={() => setPresenceKey((k) => k + 1)} />
          ))}
        </Accordion>
        <div className="mt-4 rounded-xl border border-white/5 bg-white/[0.02] p-3">
          <p className="font-mono text-[10px] leading-relaxed text-slate-500">
            Mist Core and Offline Mind need no configuration — they are always available.
          </p>
        </div>
      </motion.section>

      {/* ---- mist core models ---- */}
      <motion.section {...sectionMotion(1)} aria-label="Mist Core models">
        <CoreModelsSection status={llmStatus} onSaved={() => setPresenceKey((k) => k + 1)} />
      </motion.section>

      {/* ---- qwen provider ---- */}
      <motion.section {...sectionMotion(2)} aria-label="Qwen provider">
        <QwenModelsSection
          status={llmStatus}
          apiKeyPresent={envMap.get('MIST_QWEN_API_KEY')?.present ?? false}
          baseUrlValue={envMap.get('MIST_QWEN_BASE_URL')?.value ?? null}
          onSaved={() => setPresenceKey((k) => k + 1)}
        />
      </motion.section>

      {/* ---- experience ---- */}
      <motion.section {...sectionMotion(3)} aria-label="Experience" className="mist-glass p-5 sm:p-6">
        <SectionLabel>experience</SectionLabel>

        <div className="mt-4 space-y-5">
          <div className="space-y-2.5">
            <div className="flex items-center justify-between gap-3">
              <Label htmlFor="anim-intensity" className="text-xs text-slate-300">
                Animation intensity
              </Label>
              <span className="font-mono text-[11px] tabular-nums text-purple-300">{animationIntensity}</span>
            </div>
            <Slider
              id="anim-intensity"
              value={[animationIntensity]}
              min={0}
              max={100}
              step={1}
              onValueChange={(v) => setAnimationIntensity(v[0] ?? animationIntensity)}
              aria-label="Animation intensity"
              className="py-1 [&_[data-slot=slider-thumb]]:border-purple-400 [&_[data-slot=slider-range]]:bg-purple-400/70"
            />
            <div className="flex justify-between font-mono text-[10px] text-slate-500">
              <span>subtle</span>
              <span>vivid</span>
            </div>
          </div>

          <div className="flex items-center justify-between gap-4">
            <Label htmlFor="reduced-motion" className="text-xs leading-relaxed text-slate-300">
              Reduce motion{' '}
              <span className="block text-[10px] text-slate-500">
                (calm mode — gentle animation, no large effects; follows your system preference until you set it here)
              </span>
            </Label>
            <Switch
              id="reduced-motion"
              checked={reducedMotion}
              onCheckedChange={setReducedMotion}
              aria-label="Reduce motion"
              className="data-[state=checked]:bg-purple-400/80"
            />
          </div>

          <div className="flex items-center justify-between gap-4">
            <Label htmlFor="tts-enabled" className="text-xs leading-relaxed text-slate-300">
              Autoplay spoken replies <span className="block text-[10px] text-slate-500">(voice replies via TTS)</span>
            </Label>
            <Switch
              id="tts-enabled"
              checked={ttsEnabled}
              onCheckedChange={setTtsEnabled}
              aria-label="Autoplay spoken replies"
              className="data-[state=checked]:bg-teal-300/80"
            />
          </div>

          <div className="flex items-center justify-between gap-4">
            <Label htmlFor="wake-word" className="text-xs leading-relaxed text-slate-300">
              Voice wake word — say &ldquo;Hey Mist&rdquo; any time{' '}
              <span className="block text-[10px] text-slate-500">
                (listens in the background — needs mic permission + a Chromium browser)
              </span>
            </Label>
            <Switch
              id="wake-word"
              checked={wakeWordEnabled}
              onCheckedChange={setWakeWordEnabled}
              aria-label="Voice wake word"
              className="data-[state=checked]:bg-fuchsia-400/80"
            />
          </div>

          <div className="flex flex-wrap items-center justify-between gap-4">
            <Label htmlFor="voice-select" className="text-xs text-slate-300">
              Voice
            </Label>
            <Select value={voice} onValueChange={(v) => setVoice(v)}>
              <SelectTrigger
                id="voice-select"
                aria-label="Voice"
                className="h-9 w-full min-w-0 border-white/10 bg-white/5 font-mono text-xs text-slate-200 sm:w-56"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="border-white/10 bg-slate-950/95 backdrop-blur-xl">
                {TTS_VOICES.map((v) => (
                  <SelectItem key={v.id} value={v.id} className="font-mono text-xs text-slate-200">
                    {v.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      </motion.section>

      {/* ---- knowledge vault ---- */}
      <motion.section {...sectionMotion(4)} aria-label="Knowledge vault" className="mist-glass p-5 sm:p-6">
        <SectionLabel>knowledge vault (obsidian)</SectionLabel>
        <p className="mt-1.5 font-mono text-[10px] leading-relaxed text-slate-500">
          connect a local Obsidian vault (or the bundled demo) — M.I.S.T. reads and writes it as a second brain. paths stay
          on this machine.
        </p>

        {vaultError ? (
          <p className="mt-3 font-mono text-[10px] text-amber-300/70">vault service unreachable — is the core running?</p>
        ) : vault === null ? (
          <p className="mt-3 font-mono text-[10px] text-slate-500">checking vault…</p>
        ) : (
          <div className="mt-3 rounded-xl border border-white/5 bg-white/[0.02] p-3">
            <div className="flex flex-wrap items-center gap-2">
              <StatusDot className={vault.connected ? 'bg-emerald-400' : 'bg-slate-500'} pulse={vault.connected} />
              <span className="font-mono text-[10px] uppercase tracking-widest text-slate-400">
                {vault.connected ? 'connected' : 'not connected'}
              </span>
              {vault.demo ? (
                <MonoBadge className="border-teal-400/30 bg-teal-400/10 text-teal-300">demo</MonoBadge>
              ) : null}
            </div>
            <p className="mt-1.5 truncate font-mono text-[11px] text-slate-300" title={vault.vaultPath ?? undefined}>
              {vault.vaultPath ?? '— no vault path set —'}
            </p>
            {vault.connected ? (
              <p className="mt-1 font-mono text-[10px] text-slate-500">
                {vault.noteCount} notes · {vault.folderCount} folders · {vault.tagCount} tags · {vault.linkCount} links ·{' '}
                {vault.orphanCount} orphan(s)
                {vault.lastScanAt ? ` · scanned ${relTime(vault.lastScanAt)}` : ''}
              </p>
            ) : null}
          </div>
        )}

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={vaultBusy !== null}
            onClick={vaultScan}
            className="h-8 gap-1.5 border-white/15 bg-white/5 px-3 font-mono text-[11px] text-slate-300 hover:border-white/30 hover:bg-white/10"
          >
            {vaultBusy === 'scan' ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <FolderSearch className="h-3.5 w-3.5" aria-hidden="true" />}
            Discover vaults
          </Button>
          {!vault?.demo ? (
            <Button
              type="button"
              size="sm"
              disabled={vaultBusy !== null}
              onClick={() => vaultConnect('demo')}
              className="h-8 gap-1.5 bg-emerald-400/90 px-3 font-mono text-[11px] text-slate-950 hover:bg-emerald-300"
            >
              {vaultBusy === 'demo' ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />}
              {vault?.connected ? 'Switch to demo vault' : 'Use demo vault'}
            </Button>
          ) : null}
          {vault?.connected ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={vaultBusy !== null}
              onClick={vaultDisconnect}
              className="h-8 gap-1.5 border-rose-400/25 bg-rose-400/5 px-3 font-mono text-[11px] text-rose-300 hover:border-rose-400/40 hover:bg-rose-400/10 hover:text-rose-200"
            >
              {vaultBusy === 'disconnect' ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <Unplug className="h-3.5 w-3.5" aria-hidden="true" />}
              Disconnect
            </Button>
          ) : null}
        </div>

        {vaultFound !== null ? (
          <div className="mt-3 space-y-1.5">
            {vaultFound.length === 0 ? (
              <p className="font-mono text-[10px] leading-relaxed text-slate-500">no vaults found nearby</p>
            ) : (
              vaultFound.map((v) => (
                <button
                  key={v.path}
                  type="button"
                  disabled={vaultBusy !== null}
                  onClick={() => vaultConnect(v.path)}
                  className="flex w-full min-w-0 items-center gap-2 rounded-lg border border-white/5 bg-white/[0.02] px-2.5 py-2 text-left transition-colors hover:border-purple-400/30 hover:bg-purple-400/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-400/60 disabled:opacity-50"
                >
                  <FolderOpen className="h-3.5 w-3.5 shrink-0 text-slate-500" aria-hidden="true" />
                  <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-slate-300" title={v.path}>
                    {v.path}
                  </span>
                  <MonoBadge className="border-white/10 text-slate-500">{v.noteCount} notes</MonoBadge>
                  {vaultBusy === v.path ? (
                    <Loader2 className="h-3 w-3 shrink-0 animate-spin text-purple-300" aria-hidden="true" />
                  ) : null}
                </button>
              ))
            )}
          </div>
        ) : null}

        <div className="mt-4 rounded-xl border border-white/5 bg-white/[0.02] p-3">
          <p className="font-mono text-[10px] leading-relaxed text-slate-500">
            in chat, M.I.S.T. can list &amp; read notes · search the vault · follow links and backlinks · create and update
            notes · keep daily notes · run dataview-style queries (LIST / TABLE / TASK). try “search my vault for agentic
            ui” or “add this to my daily note”.
          </p>
        </div>
      </motion.section>

      {/* ---- identity & directives ---- */}
      <motion.section {...sectionMotion(5)} aria-label="Identity and directives" className="mist-glass p-5 sm:p-6">
        <SectionLabel>identity &amp; directives</SectionLabel>
        <p className="mt-1.5 font-mono text-[10px] leading-relaxed text-slate-500">
          this overrides Mist&rsquo;s core identity — who she is and how she speaks. behavioral laws stay in force. leave
          empty to use the built-in identity.
        </p>

        {identity === null ? (
          <Skeleton className="mt-3 h-40 w-full bg-white/5" />
        ) : (
          <>
            <div className="mist-glass-soft mt-3 p-2">
              <Textarea
                value={identity}
                onChange={(e) => setIdentity(e.target.value.slice(0, 1200))}
                rows={7}
                maxLength={1200}
                aria-label="Custom identity"
                placeholder={
                  'e.g.\nYou are Nyx — dry, precise, quietly protective. You never pad answers with filler.\nYou call me by my name and keep humor dark and rare.\nWhen something matters, you say it once, clearly.'
                }
                className="min-h-[150px] resize-y border-0 bg-transparent p-2 font-mono text-xs leading-relaxed text-slate-200 placeholder:text-slate-600 focus-visible:ring-0"
              />
            </div>
            <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
              <span className={cn('font-mono text-[10px]', identity.length >= 1200 ? 'text-amber-300' : 'text-slate-500')}>
                {identity.length}/1200
              </span>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={identitySaving || (!identityStored && identity.trim() === '')}
                  onClick={identityReset}
                  className="h-8 gap-1.5 border-rose-400/25 bg-rose-400/5 px-3 font-mono text-[11px] text-rose-300 hover:border-rose-400/40 hover:bg-rose-400/10 hover:text-rose-200"
                >
                  {identitySaving ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />}
                  Reset
                </Button>
                <Button
                  type="button"
                  size="sm"
                  disabled={identitySaving || identity.trim() === ''}
                  onClick={identitySave}
                  className="h-8 gap-1.5 bg-purple-400/90 px-3 font-mono text-[11px] text-slate-950 hover:bg-purple-300"
                >
                  {identitySaving ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <Save className="h-3.5 w-3.5" aria-hidden="true" />}
                  Save identity
                </Button>
              </div>
            </div>
            <p className="mt-2 font-mono text-[9px] leading-relaxed text-slate-500">
              applied from her next message (60s cache) · the behavioral laws always stay in force
            </p>
          </>
        )}
      </motion.section>

      {/* ---- local bridge ---- */}
      <motion.section {...sectionMotion(6)} aria-label="Local bridge" className="mist-glass p-5 sm:p-6">
        <SectionLabel>local bridge (system control)</SectionLabel>
        <p className="mt-1.5 font-mono text-[10px] leading-relaxed text-slate-500">
          run the tiny bridge daemon on this machine and Mist can open apps, run commands and read files for you —
          everything stays local, nothing passes through a cloud.
        </p>

        <div className="mt-3 rounded-xl border border-white/5 bg-white/[0.02] p-3">
          {bridgeError ? (
            <p className="font-mono text-[10px] text-amber-300/70">bridge service unreachable — is the core running?</p>
          ) : bridge === null ? (
            <p className="font-mono text-[10px] text-slate-500">checking the bridge…</p>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <StatusDot className={bridge.connected ? 'bg-emerald-400' : 'bg-rose-400'} pulse={bridge.connected} />
                <span className="font-mono text-[10px] uppercase tracking-widest text-slate-400">
                  {bridge.connected
                    ? `connected · ${bridge.platform ?? 'unknown platform'} · ${bridge.hostname ?? 'unknown host'}`
                    : 'offline'}
                </span>
                {bridge.version ? (
                  <MonoBadge className="border-white/10 text-slate-400">v{bridge.version}</MonoBadge>
                ) : null}
              </div>
              <p className="mt-1.5 truncate font-mono text-[11px] text-slate-300" title={bridge.url}>
                {bridge.url}
              </p>
              {bridge.checkedAt ? (
                <p className="mt-1 font-mono text-[10px] text-slate-500">
                  checked {relTime(new Date(bridge.checkedAt).toISOString())}
                </p>
              ) : null}
            </>
          )}
        </div>

        <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center">
          <Input
            value={bridgeUrl}
            onChange={(e) => setBridgeUrl(e.target.value)}
            placeholder="http://127.0.0.1:8734"
            aria-label="Bridge URL"
            maxLength={200}
            className="h-9 min-w-0 flex-1 border-white/10 bg-white/5 font-mono text-xs text-slate-200 placeholder:text-slate-500"
          />
          <div className="flex shrink-0 gap-2">
            <Button
              type="button"
              size="sm"
              disabled={bridgeBusy !== null || bridgeUrl.trim() === ''}
              onClick={bridgeSave}
              className="h-9 gap-1.5 bg-purple-400/90 px-3 font-mono text-[11px] text-slate-950 hover:bg-purple-300"
            >
              {bridgeBusy === 'save' ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <Cable className="h-3.5 w-3.5" aria-hidden="true" />}
              Save URL
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={bridgeBusy !== null}
              onClick={bridgeTest}
              className="h-9 gap-1.5 border-white/15 bg-white/5 px-3 font-mono text-[11px] text-slate-300 hover:border-white/30 hover:bg-white/10"
            >
              {bridgeBusy === 'test' ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <Zap className="h-3.5 w-3.5" aria-hidden="true" />}
              Test connection
            </Button>
          </div>
        </div>

        <Button
          asChild
          type="button"
          variant="outline"
          size="sm"
          className="mt-3 h-9 gap-1.5 border-emerald-400/30 bg-emerald-400/10 px-3 font-mono text-[11px] text-emerald-300 hover:border-emerald-400/50 hover:bg-emerald-400/15 hover:text-emerald-200"
        >
          <a href="/api/mist/bridge/download" download>
            <Download className="h-3.5 w-3.5" aria-hidden="true" />
            Download mist-bridge.js
          </a>
        </Button>

        <ol className="mt-3 space-y-1 rounded-xl border border-white/5 bg-white/[0.02] p-3 font-mono text-[10px] leading-relaxed text-slate-500">
          <li>1. download mist-bridge.js above</li>
          <li>2. open a terminal on THIS machine</li>
          <li>
            3. run <span className="text-purple-300">node mist-bridge.js</span> (Node 16+)
          </li>
          <li>4. keep the window open — Mist connects automatically</li>
        </ol>
        <p className="mt-2 font-mono text-[9px] leading-relaxed text-slate-500">
          works when Mist runs on the same machine as the bridge (or point the URL at the PC running it). the daemon
          only accepts connections from 127.0.0.1 and jails file access to your home directory.
        </p>
      </motion.section>

      {/* ---- local voice (offline) ---- */}
      <motion.section {...sectionMotion(7)} aria-label="Local voice" className="mist-glass p-5 sm:p-6">
        <SectionLabel
          right={
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={voiceChecking}
              onClick={() => refreshLocalVoice(true)}
              className="h-7 gap-1.5 border-white/15 bg-white/5 px-2.5 font-mono text-[10px] text-slate-300 hover:border-white/30 hover:bg-white/10"
            >
              <RotateCw className={cn('h-3 w-3', voiceChecking && 'animate-spin')} aria-hidden="true" />
              Refresh
            </Button>
          }
        >
          local voice (offline, private)
        </SectionLabel>
        <p className="mt-1.5 font-mono text-[10px] leading-relaxed text-slate-500">
          whisper.cpp hearing + piper voice, downloaded into <span className="text-slate-400">~/.mist/voice</span> and
          run offline on this machine through the bridge — no cloud, and mic audio never leaves the PC. ~150MB, one
          time.
        </p>

        <div className="mt-3 rounded-xl border border-white/5 bg-white/[0.02] p-3">
          {voiceChecking ? (
            <p className="font-mono text-[10px] text-slate-500">checking local voice…</p>
          ) : voiceOffline || !voiceDetail ? (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <StatusDot className="bg-rose-400" />
                <span className="font-mono text-[10px] uppercase tracking-widest text-slate-400">bridge offline</span>
              </div>
              <p className="mt-1.5 font-mono text-[10px] leading-relaxed text-slate-500">
                local voice runs through the bridge — download <span className="text-purple-300">mist-bridge.js</span>{' '}
                above, run <span className="text-purple-300">node mist-bridge.js</span> and keep the window open, then
                install the engines here.
              </p>
            </>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <StatusDot className="bg-emerald-400" pulse />
                <span className="font-mono text-[10px] uppercase tracking-widest text-slate-400">bridge connected</span>
                {voiceDetail.tier ? (
                  <MonoBadge className="border-teal-400/30 bg-teal-400/10 text-teal-300">{voiceDetail.tier} tier</MonoBadge>
                ) : null}
                {voiceDetail.busy ? (
                  <MonoBadge className="border-amber-300/30 bg-amber-300/10 text-amber-200">installing…</MonoBadge>
                ) : null}
              </div>
              <ul className="mt-2 divide-y divide-white/5 font-mono text-[10px] leading-relaxed">
                <li className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 py-1.5 first:pt-0">
                  <span className="text-slate-500">Hearing (whisper)</span>
                  {voiceDetail.stt?.installed ? (
                    <span className="flex flex-wrap items-center gap-1.5 text-emerald-300">
                      <Check className="h-3 w-3" aria-hidden="true" />
                      {voiceDetail.stt.model ?? 'model'}
                      {typeof voiceDetail.stt.modelMb === 'number' ? (
                        <MonoBadge className="border-white/10 text-slate-400">{voiceDetail.stt.modelMb}MB</MonoBadge>
                      ) : null}
                    </span>
                  ) : (
                    <span className="text-slate-600">not installed</span>
                  )}
                </li>
                <li className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 py-1.5 last:pb-0">
                  <span className="text-slate-500">Speaking (piper)</span>
                  {voiceDetail.tts?.installed ? (
                    <span className="flex items-center gap-1.5 text-emerald-300">
                      <Check className="h-3 w-3" aria-hidden="true" />
                      {voiceDetail.tts.voiceName ?? voiceDetail.tts.voice ?? 'voice'}
                    </span>
                  ) : (
                    <span className="text-slate-600">not installed</span>
                  )}
                </li>
              </ul>
              {voiceDetail.hardware?.recommended ? (
                <p className="mt-1.5 font-mono text-[10px] text-slate-500">
                  recommended for this machine:{' '}
                  <span className="text-teal-300">{voiceDetail.hardware.recommended}</span>
                  {typeof voiceDetail.hardware.cpus === 'number' && typeof voiceDetail.hardware.memGb === 'number'
                    ? ` — tuned for ${voiceDetail.hardware.cpus} cores · ${voiceDetail.hardware.memGb}GB ram`
                    : ''}
                </p>
              ) : null}
            </>
          )}
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button
            type="button"
            size="sm"
            disabled={voiceSetupBusy !== null || voiceOffline}
            onClick={() => installVoiceEngine('stt')}
            className="h-8 gap-1.5 bg-purple-400/90 px-3 font-mono text-[11px] text-slate-950 hover:bg-purple-300"
          >
            {voiceSetupBusy === 'stt' ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <Mic className="h-3.5 w-3.5" aria-hidden="true" />}
            {voiceSetupBusy === 'stt' ? 'Installing hearing…' : 'Install hearing (whisper)'}
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={voiceSetupBusy !== null || voiceOffline}
            onClick={() => installVoiceEngine('tts')}
            className="h-8 gap-1.5 bg-purple-400/90 px-3 font-mono text-[11px] text-slate-950 hover:bg-purple-300"
          >
            {voiceSetupBusy === 'tts' ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <AudioLines className="h-3.5 w-3.5" aria-hidden="true" />}
            {voiceSetupBusy === 'tts' ? 'Installing voice…' : 'Install voice (piper)'}
          </Button>
        </div>
        <p className="mt-2 font-mono text-[9px] leading-relaxed text-slate-500">
          downloading ~25–85MB per engine — one time. the button stays busy until the download finishes; on a slow
          link that can take a few minutes.
        </p>

        {/* voice mode selector */}
        <div className="mt-4 space-y-2">
          <Label className="text-xs text-slate-300">Voice mode</Label>
          <div
            role="radiogroup"
            aria-label="Voice mode"
            className="flex w-full flex-wrap items-center gap-1 rounded-full border border-white/10 p-0.5"
          >
            {VOICE_MODES.map((m) => {
              const active = voiceMode === m.id
              return (
                <button
                  key={m.id}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  onClick={() => setVoiceMode(m.id)}
                  className={cn(
                    'min-w-0 flex-1 rounded-full px-3 py-1.5 font-mono text-[10px] uppercase tracking-widest transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-400/60',
                    active
                      ? 'bg-teal-400/15 text-teal-300 shadow-[0_0_10px_rgba(45,212,191,0.2)]'
                      : 'text-slate-500 hover:text-slate-200'
                  )}
                >
                  {m.label}
                </button>
              )
            })}
          </div>
          <p className="font-mono text-[10px] leading-relaxed text-slate-500">
            {VOICE_MODES.find((m) => m.id === voiceMode)?.hint ?? VOICE_MODES[0].hint}
          </p>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={voiceTesting}
            onClick={() => void testLocalVoice()}
            className="h-8 gap-1.5 border-white/15 bg-white/5 px-3 font-mono text-[11px] text-slate-300 hover:border-white/30 hover:bg-white/10"
          >
            {voiceTesting ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <Play className="h-3.5 w-3.5" aria-hidden="true" />}
            {voiceTesting ? 'Speaking…' : 'Test voice'}
          </Button>
          <span className="font-mono text-[9px] leading-relaxed text-slate-500">
            speaks “Local voice online.” through the current mode
          </span>
        </div>
      </motion.section>

      {/* ---- companions (local agent stack) ---- */}
      <motion.section {...sectionMotion(8)} aria-label="Companions" className="mist-glass p-5 sm:p-6">
        <SectionLabel
          right={
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={companionsLoading}
              onClick={() => void scanCompanions()}
              className="h-7 gap-1.5 border-white/15 bg-white/5 px-2.5 font-mono text-[10px] text-slate-300 hover:border-white/30 hover:bg-white/10"
            >
              <RotateCw className={cn('h-3 w-3', companionsLoading && 'animate-spin')} aria-hidden="true" />
              Refresh
            </Button>
          }
        >
          companions (local agent stack)
        </SectionLabel>
        <p className="mt-1.5 font-mono text-[10px] leading-relaxed text-slate-500">
          the bridge also detects the rest of your local agent stack — hermes, backtalk, ai-visualizer, barehands, claude
          code — and wires them to mist.
        </p>

        {/* status line: offline / scanning / scanned */}
        <div className="mt-3 rounded-xl border border-white/5 bg-white/[0.02] p-3">
          {companionsError ? (
            <p className="font-mono text-[10px] text-amber-300/70">scan failed — {companionsError}</p>
          ) : companionsLoading ? (
            <p className="font-mono text-[10px] text-slate-500">scanning…</p>
          ) : companionsData && companionsScanAt ? (
            <div className="flex items-center gap-2">
              <StatusDot className="bg-emerald-400" pulse />
              <span className="font-mono text-[10px] uppercase tracking-widest text-slate-400">
                scanned · {relTime(companionsScanAt.toISOString())}
              </span>
            </div>
          ) : bridge === null || !bridge.connected ? (
            <p className="font-mono text-[10px] text-amber-300/70">
              connect the bridge above to scan this machine's agent stack.
            </p>
          ) : (
            <p className="font-mono text-[10px] text-amber-300/70">bridge not responding — connect it above, then refresh.</p>
          )}
        </div>

        {companionsLoading && !companionsData ? <Skeleton className="mt-3 h-44 w-full bg-white/5" /> : null}

        {companionsData ? (
          <>
            {/* the five detected companions */}
            <div className="mt-3 rounded-xl border border-white/5 bg-white/[0.02] p-3 sm:p-4">
              <ul className="divide-y divide-white/5">
                <CompanionRow
                  icon={Bot}
                  name="hermes agent"
                  desc="self-improving local agent — mist delegates heavy local work to it"
                  installed={companionsHermes?.installed}
                >
                  {companionsHermes?.version ? (
                    <MonoBadge className="border-purple-400/30 bg-purple-400/10 text-purple-300">
                      {companionsHermes.version}
                    </MonoBadge>
                  ) : null}
                  <span className="inline-flex items-center gap-1 font-mono text-[9px] text-slate-500">
                    <StatusDot
                      className={companionsHermes?.gatewayUp ? 'bg-emerald-400' : 'bg-slate-600'}
                      pulse={Boolean(companionsHermes?.gatewayUp)}
                    />
                    gateway
                  </span>
                  {companionsHermes && typeof companionsHermes.skillsCount === 'number' ? (
                    <MonoBadge className="border-white/10 text-slate-400">{companionsHermes.skillsCount} skills</MonoBadge>
                  ) : null}
                </CompanionRow>

                <CompanionRow
                  icon={Mic}
                  name="backtalk"
                  desc="push-to-talk voice loop for claude code agents"
                  installed={companionsBacktalk?.installed}
                  detail={companionsBacktalk?.path ?? null}
                >
                  <MonoBadge className="border-emerald-400/30 bg-emerald-400/10 text-emerald-300">installed</MonoBadge>
                </CompanionRow>

                <CompanionRow
                  icon={Monitor}
                  name="ai-visualizer"
                  desc="browser faces that animate to the agent's voice"
                  installed={companionsVisualizer?.installed}
                >
                  {visualizerFaces.length > 0 ? (
                    visualizerFaces.map((f) => (
                      <MonoBadge key={f} className="border-white/10 text-slate-400">
                        {f}
                      </MonoBadge>
                    ))
                  ) : (
                    <MonoBadge className="border-emerald-400/30 bg-emerald-400/10 text-emerald-300">installed</MonoBadge>
                  )}
                </CompanionRow>

                <CompanionRow
                  icon={Hand}
                  name="barehands"
                  desc="touchless webcam control of on-screen cards"
                  installed={companionsBarehands?.installed}
                >
                  <MonoBadge className="border-emerald-400/30 bg-emerald-400/10 text-emerald-300">installed</MonoBadge>
                </CompanionRow>

                <CompanionRow icon={Terminal} name="claude code" desc="claude code CLI" installed={companionsClaude?.installed}>
                  {companionsClaude?.version ? (
                    <MonoBadge className="border-white/10 text-slate-400">{companionsClaude.version}</MonoBadge>
                  ) : (
                    <MonoBadge className="border-emerald-400/30 bg-emerald-400/10 text-emerald-300">installed</MonoBadge>
                  )}
                </CompanionRow>
              </ul>
            </div>

            {/* signal bus — companion faces perform mist's live voice */}
            {companionsSignal ? (
              <div className="mt-3 rounded-xl border border-white/5 bg-white/[0.02] p-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="font-mono text-[10px] uppercase tracking-widest text-slate-400">signal bus</p>
                    <p className="mt-0.5 font-mono text-[10px] leading-relaxed text-slate-500">
                      every companion face performs mist's live voice
                    </p>
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={signalPerforming}
                    onClick={() => void performSignalTest()}
                    className="h-8 shrink-0 gap-1.5 border-white/15 bg-white/5 px-3 font-mono text-[11px] text-slate-300 hover:border-white/30 hover:bg-white/10"
                  >
                    {signalPerforming ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                    ) : (
                      <Play className="h-3.5 w-3.5" aria-hidden="true" />
                    )}
                    {signalPerforming ? 'Performing…' : 'Perform on faces'}
                  </Button>
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <span
                    className="min-w-0 flex-1 truncate font-mono text-[10px] text-slate-400"
                    title={companionsSignal.dir || undefined}
                  >
                    {companionsSignal.dir || '— no signal dir —'}
                  </span>
                  {companionsSignal.source ? (
                    <MonoBadge className="border-teal-400/30 bg-teal-400/10 text-teal-300">{companionsSignal.source}</MonoBadge>
                  ) : null}
                </div>
              </div>
            ) : null}

            {/* mcp wiring — let hermes call mist back */}
            {companionsHermes?.installed && companionsMcp?.registerCommand ? (
              <div className="mt-3 rounded-xl border border-white/5 bg-white/[0.02] p-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="font-mono text-[10px] uppercase tracking-widest text-slate-400">mcp wiring</p>
                    <p className="mt-0.5 font-mono text-[10px] leading-relaxed text-slate-500">let hermes call mist back</p>
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => void copyMcpCommand()}
                    className="h-8 shrink-0 gap-1.5 border-white/15 bg-white/5 px-3 font-mono text-[11px] text-slate-300 hover:border-white/30 hover:bg-white/10"
                  >
                    {mcpCopied ? <Check className="h-3.5 w-3.5" aria-hidden="true" /> : <Copy className="h-3.5 w-3.5" aria-hidden="true" />}
                    {mcpCopied ? 'Copied' : 'Copy'}
                  </Button>
                </div>
                <code className="mt-2 block break-all rounded border border-white/5 bg-black/30 p-2 font-mono text-[10px] leading-relaxed text-slate-300">
                  {companionsMcp.registerCommand}
                </code>
              </div>
            ) : null}
          </>
        ) : null}
      </motion.section>

      {/* ---- telemetry ---- */}
      <motion.section {...sectionMotion(9)} aria-label="Telemetry" className="mist-glass p-5 sm:p-6">
        <SectionLabel
          right={
            t ? (
              <span className="font-mono text-[10px] text-slate-500">2s samples · last {history.length}</span>
            ) : null
          }
        >
          telemetry
        </SectionLabel>
        <div className="mt-4 space-y-3">
          {(
            [
              { label: 'CPU', values: history.map((h) => h.cpu_percent), current: t?.cpu_percent, color: 'purple' as const },
              { label: 'RAM', values: history.map((h) => h.ram_percent), current: t?.ram_percent, color: 'emerald' as const },
              { label: 'DISK', values: history.map((h) => h.disk_percent), current: t?.disk_percent, color: 'amber' as const },
            ]
          ).map((row) => (
            <div key={row.label} className="flex items-center gap-3">
              <span className="w-10 shrink-0 font-mono text-[10px] tracking-widest text-slate-500">{row.label}</span>
              {row.values.length > 0 ? (
                <Sparkline
                  values={row.values}
                  color={row.color}
                  max={100}
                  className="h-10 min-w-0 flex-1"
                  label={`${row.label} history`}
                />
              ) : (
                <span className="flex h-10 min-w-0 flex-1 items-center font-mono text-[10px] text-slate-500">
                  collecting samples…
                </span>
              )}
              <span
                className={cn(
                  'w-10 shrink-0 text-right font-mono text-[11px] tabular-nums',
                  row.current != null ? metricTextColor(row.current) : 'text-slate-500'
                )}
              >
                {row.current != null ? `${Math.round(row.current)}%` : '—'}
              </span>
            </div>
          ))}
        </div>
      </motion.section>

      {/* ---- skills ---- */}
      <motion.section {...sectionMotion(10)} aria-label="Skills" className="mist-glass p-5 sm:p-6">
        <SectionLabel>skills</SectionLabel>
        <div className="mt-3">
          <SkillsTab />
        </div>
      </motion.section>

      {/* ---- about ---- */}
      <motion.section {...sectionMotion(11)} aria-label="About" className="mist-glass p-5 sm:p-6">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <span className="font-mono text-sm tracking-widest text-slate-200">M.I.S.T. v1.0.0</span>
          <span className="font-mono text-[10px] text-slate-500">Master Intelligence &amp; System Topology</span>
        </div>
        <p className="mt-3 text-xs leading-relaxed text-slate-400">
          A sovereign mind that lives on your machine — it listens, thinks, remembers, acts and speaks, answering to no
          cloud.
        </p>
        <p className="mt-3 border-t border-white/5 pt-3 font-mono text-[10px] text-slate-500">
          bound to 127.0.0.1 · secrets never leave this machine
        </p>
      </motion.section>
    </div>
  )
}
