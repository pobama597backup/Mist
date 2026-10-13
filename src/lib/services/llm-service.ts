// M.I.S.T. LLM service — the brain.
// Cascade: omniroute → openai_compatible → nvidia → openrouter → anthropic → gemini → core → offline-mind.
// v2: 6-round tool loop, structured output envelope (citations / attachments / suggestions /
// capability_request / remember), auto-remembered facts, never-dead-end offline fallback.
import type {
  CapabilityOption,
  CapabilityRequest,
  Citation,
  HistoryMessage,
  LlmStatus,
  MediaAttachment,
  ProviderDetail,
  ProviderId,
  SkillHint,
  UnifiedMode,
  UnifiedLlmRequest,
  UnifiedLlmResponse,
} from '@/lib/types'
import { db } from '@/lib/db'
import { randomUUID } from 'node:crypto'
import { ensureProviderKeysRestored } from './config-service'
import { getZai } from './zai'
import { noteLaneFailure, noteLaneSuccess } from './lane-cooldowns'
import {
  isHedgeableLane,
  isLocalLane,
  laneWarm,
  noteLaneAttempt,
  orderLanes,
  pickHedgeLane,
  ttftDeadlineMs,
} from './lane-health'
import type { ChatMessage as SdkChatMessage } from 'z-ai-web-dev-sdk'
import {
  getCoreTextModelSelection,
  getCoreVisionModelSelection,
  getCoreLiveModels,
  getCoreModelsInfo,
  noteCoreReportedModel,
} from './core-models'
import {
  getQwenApiKey,
  getQwenBaseUrl,
  getQwenModelsInfo,
  getQwenTextModelSelection,
  getQwenVisionModelSelection,
  isQwenConfigured,
  isQwenKeylessLocal,
  noteQwenReportedModel,
} from './qwen-models'
import {
  getNousApiKey,
  getNousBaseUrl,
  getNousModelsInfo,
  isNousConfigured,
  isNousKeylessLocal,
  nousLaneLabel,
  noteNousReportedModel,
  resolveNousModelId,
} from './nous-models'
import { buildContext, buildKeylessSystemPrompt, type BuiltContext } from './context-builder'
import { findTool, executeTool } from './tools-service'
import { classifyMessage, isConversationalSimpleClass } from './fast-path'
import {
  KEYLESS_DEFAULTS,
  getKeylessReportedModel,
  keylessEnabled,
  noteKeylessReportedModel,
  pickLlm7TurboModel,
  type KeylessId,
} from './keyless-models'
import { markLlmActivity, recordActivity } from './activity-service'
import { onTurnComplete } from './learning-service'
import { rememberDurableFact } from '@/lib/arbiter/quarantine'
import { classifyRisk } from '@/lib/arbiter/risk-table'
import { wrapToolOutput, redactBeforeCloud, markCloudConsent, needsCloudConsent } from '@/lib/oj/guardrails'
import {
  ambientTrace,
  appendGenerateStep,
  estimateTokens,
  noteLlmCall,
  runWithTrace,
  startTrace,
} from '@/lib/oj/trace-service'
import { routeQuery } from '@/lib/oj/complexity'
import { classifyError } from '@/lib/oj/error-taxonomy'
import type { Origin } from '@/lib/arbiter/arbiter'
import { linkOwnerSignal, ownerAborted } from '@/lib/abort-link'
import {
  candorToneBlock,
  detectRefusal,
  filterLanesForCandor,
  laneCarriesFullContext,
  laneConsentClass,
  type CandorMode,
} from '@/lib/candor'
import { resolveCandorMode } from './candor-service'
import { localLaneProviderConfig } from './local-lane'
import { egressLaneFetch, type EgressClass } from './egress'
import { a4Status, registerA4TurnController } from '@/lib/arbiter/unleash'

/** Valid Arbiter origins a unified() caller may claim (Phase 2-b). */
const ARBITER_ORIGINS = new Set<Origin>([
  'owner_chat',
  'owner_voice',
  'owner_cron',
  'owner_heartbeat',
])

const LLM_TIMEOUT_MS = 30_000
// Chat-path per-call budget. The 550B reasoning brain (nemotron-3-ultra) with a
// full built context (identity + memories + skills) legitimately needs 60–90s;
// the missions path (cascadeComplete) already budgets 150s. The chat path used
// to inherit the hard 30s default, so every big chat turn was aborted mid-think
// and fell through the whole cascade to offline-mind while both premium lanes
// were perfectly healthy (live case 2026-09-26: two regime-change directives
// answered by the deterministic fallback for exactly this reason).
const CHAT_LLM_TIMEOUT_MS = 150_000
// 8 rounds: real autonomy chains are deep — bridge_status + owner_files list +
// per-file moves + a verification pass can legitimately need 6+ rounds, and a
// starved budget used to strand her mid-chain ("Let me check…" accepted as the
// final answer while nothing was finished).
const MAX_TOOL_ROUNDS = 8
const CASCADE: ProviderId[] = [
  'omniroute',
  'hermes',
  'theoldapi',
  'openai_compatible',
  'nvidia',
  'openrouter',
  'qwen',
  'groq',
  'github_models',
  'cerebras',
  'together',
  'mistral',
  'huggingface',
  'anthropic',
  'gemini',
  // keyless zero-auth lanes — they cost nothing and need nothing, so they sit
  // right before core: with zero configuration Mist still speaks through top
  // models out of the box; any keyed lane the creator adds still wins first
  'kilo',
  'pollinations',
  'llm7',
  'ovh',
  'core',
  'offline-mind',
]
const ENV_PROVIDER_IDS: ProviderId[] = [
  'omniroute',
  'hermes',
  'theoldapi',
  'openai_compatible',
  'nvidia',
  'openrouter',
  'qwen',
  'groq',
  'github_models',
  'cerebras',
  'together',
  'mistral',
  'huggingface',
  'anthropic',
  'gemini',
  'kilo',
  'pollinations',
  'llm7',
  'ovh',
]

interface SimMessage {
  role: 'user' | 'assistant'
  content: string
}

interface ProviderConfig {
  id: ProviderId
  baseUrl: string | null
  apiKey: string | null
  model: string
  configured: boolean
  /** 'local' lane only: the keep_alive the owner set (minutes) */
  keepAliveMin?: number
}

// ---------- provider config resolution (read at call time so /config/env applies live) ----------

function resolveProviderConfig(id: ProviderId): ProviderConfig {
  const env = process.env
  const mistModel = env.MIST_LLM_MODEL?.trim() || null
  switch (id) {
    case 'omniroute':
      return {
        id,
        baseUrl: env.OMNIROUTE_BASE_URL?.trim() || null,
        apiKey: env.OMNIROUTE_API_KEY?.trim() || null,
        model: env.OMNIROUTE_MODEL?.trim() || mistModel || 'gpt-4o-mini',
        configured: Boolean(env.OMNIROUTE_BASE_URL?.trim()),
      }
    case 'hermes':
      // Nous Research / Hermes — the creator's ask. Three lanes (Nous Portal
      // cloud with MIST_NOUS_API_KEY, the local Hermes agent gateway :8642,
      // any local runtime serving Hermes weights) — all resolved by base URL.
      return {
        id,
        baseUrl: getNousBaseUrl(),
        apiKey: getNousApiKey(),
        model: resolveNousModelId(),
        configured: isNousConfigured(),
      }
    case 'theoldapi':
      // TheOldAPI (theoldllm.com) — $7/mo flat, 50M adjusted tokens/day,
      // 100+ top models (live-probed 2026-09-27). The unlimited lane.
      return {
        id,
        baseUrl: 'https://theoldllm.com/v1',
        apiKey: env.THEOLD_API_KEY?.trim() || null,
        model: env.THEOLD_MODEL?.trim() || 'gpt-5.3',
        configured: Boolean(env.THEOLD_API_KEY?.trim()),
      }
    case 'openai_compatible':
      return {
        id,
        baseUrl: env.OPENAI_BASE_URL?.trim() || null,
        apiKey: env.OPENAI_API_KEY?.trim() || null,
        model: env.OPENAI_MODEL?.trim() || mistModel || 'gpt-4o-mini',
        configured: Boolean(env.OPENAI_BASE_URL?.trim()),
      }
    case 'nvidia':
      return {
        id,
        baseUrl: 'https://integrate.api.nvidia.com/v1/chat/completions',
        apiKey: env.NVIDIA_API_KEY?.trim() || null,
        // NVIDIA NIM — the creator's free key; nemotron-3-ultra-550b is the best
        // brain on the catalog (550B MoE, ~1.4s latency, strict-JSON tool calls)
        model: env.NVIDIA_MODEL?.trim() || 'nvidia/nemotron-3-ultra-550b-a55b',
        configured: Boolean(env.NVIDIA_API_KEY?.trim()),
      }
    case 'openrouter':
      return {
        id,
        baseUrl: 'https://openrouter.ai/api/v1/chat/completions',
        apiKey: env.OPENROUTER_API_KEY?.trim() || null,
        // same 550B brain via the creator's free OpenRouter lane (50 req/day —
        // precious backup, not the workhorse)
        model:
          env.OPENROUTER_MODEL?.trim() || 'nvidia/nemotron-3-ultra-550b-a55b:free',
        configured: Boolean(env.OPENROUTER_API_KEY?.trim()),
      }
    case 'qwen':
      return {
        id,
        baseUrl: getQwenBaseUrl(),
        apiKey: getQwenApiKey(),
        // real Qwen model id — the endpoint reports back what actually served
        model: getQwenTextModelSelection(),
        configured: isQwenConfigured(),
      }
    case 'groq':
      return {
        id,
        baseUrl: 'https://api.groq.com/openai/v1',
        apiKey: env.GROQ_API_KEY?.trim() || null,
        model: env.GROQ_MODEL?.trim() || 'llama-3.3-70b-versatile',
        configured: Boolean(env.GROQ_API_KEY?.trim()),
      }
    case 'github_models':
      return {
        id,
        baseUrl: 'https://models.github.ai/inference',
        apiKey: env.GITHUB_MODELS_KEY?.trim() || null,
        model: env.GITHUB_MODELS_MODEL?.trim() || 'openai/gpt-4o',
        configured: Boolean(env.GITHUB_MODELS_KEY?.trim()),
      }
    case 'cerebras':
      return {
        id,
        baseUrl: 'https://api.cerebras.ai/v1',
        apiKey: env.CEREBRAS_API_KEY?.trim() || null,
        model: env.CEREBRAS_MODEL?.trim() || 'llama-3.3-70b',
        configured: Boolean(env.CEREBRAS_API_KEY?.trim()),
      }
    case 'together':
      return {
        id,
        baseUrl: 'https://api.together.xyz/v1',
        apiKey: env.TOGETHER_API_KEY?.trim() || null,
        model: env.TOGETHER_MODEL?.trim() || 'deepseek-ai/DeepSeek-V3',
        configured: Boolean(env.TOGETHER_API_KEY?.trim()),
      }
    case 'mistral':
      return {
        id,
        baseUrl: 'https://api.mistral.ai/v1',
        apiKey: env.MISTRAL_API_KEY?.trim() || null,
        model: env.MISTRAL_MODEL?.trim() || 'mistral-large-latest',
        configured: Boolean(env.MISTRAL_API_KEY?.trim()),
      }
    case 'huggingface':
      return {
        id,
        baseUrl: 'https://router.huggingface.co/v1',
        apiKey: env.HUGGINGFACE_API_KEY?.trim() || null,
        model: env.HUGGINGFACE_MODEL?.trim() || 'deepseek-ai/DeepSeek-V4-Pro',
        configured: Boolean(env.HUGGINGFACE_API_KEY?.trim()),
      }
    case 'anthropic':
      return {
        id,
        baseUrl: 'https://api.anthropic.com/v1/messages',
        apiKey: env.ANTHROPIC_API_KEY?.trim() || null,
        model: env.ANTHROPIC_MODEL?.trim() || mistModel || 'claude-sonnet-4-20250514',
        configured: Boolean(env.ANTHROPIC_API_KEY?.trim()),
      }
    case 'gemini':
      return {
        id,
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
        apiKey: env.GEMINI_API_KEY?.trim() || null,
        model: env.GEMINI_MODEL?.trim() || mistModel || 'gemini-3.8-flash',
        configured: Boolean(env.GEMINI_API_KEY?.trim()),
      }
    // ---------- keyless zero-auth lanes (creator directive 2026-09-27) ----------
    // No key, no signup, OpenAI-compatible. MIST_KEYLESS=0 disables all four.
    // BYOK env vars are honored when present (they raise limits, never gate).
    case 'kilo':
      return {
        id,
        baseUrl: 'https://api.kilo.ai/api/gateway',
        apiKey: env.KILO_API_KEY?.trim() || null,
        model: env.KILO_MODEL?.trim() || KEYLESS_DEFAULTS.kilo.model,
        configured: keylessEnabled(),
      }
    case 'pollinations':
      return {
        id,
        baseUrl: 'https://text.pollinations.ai',
        apiKey: env.POLLINATIONS_TOKEN?.trim() || null,
        model: env.POLLINATIONS_MODEL?.trim() || KEYLESS_DEFAULTS.pollinations.model,
        configured: keylessEnabled(),
      }
    case 'llm7':
      return {
        id,
        baseUrl: 'https://api.llm7.io/v1',
        apiKey: env.LLM7_TOKEN?.trim() || null,
        // 'auto' resolves to the live turbo pick at call time (catalog rotates)
        model: env.LLM7_MODEL?.trim() || 'auto',
        configured: keylessEnabled(),
      }
    case 'ovh':
      return {
        id,
        baseUrl: 'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1',
        apiKey: env.OVH_API_KEY?.trim() || null,
        model: env.OVH_MODEL?.trim() || KEYLESS_DEFAULTS.ovh.model,
        configured: keylessEnabled(),
      }
    case 'core': {
      const sel = getCoreTextModelSelection()
      const liveNow = getCoreLiveModels()
      return { id, baseUrl: null, apiKey: null, model: sel ?? liveNow.text ?? 'auto', configured: true }
    }
    case 'local': {
      // Phase 5 · C4 — the first-class LOCAL lane (Ollama/LM Studio/llama.cpp
      // via the wizard). Async settings cannot live in this SYNC resolver, so
      // the cascade paths call refreshLocalLaneCache() first; the cache holds
      // the configured lane (or null). Data-local by construction: the wizard
      // only accepts loopback (or a remote bridge behind MIST_ALLOW_REMOTE_BRIDGE).
      const cached = localLaneCache
      return {
        id,
        baseUrl: cached?.baseUrl ?? null,
        apiKey: cached?.apiKey ?? null,
        model: cached?.model ?? '(local lane not configured)',
        keepAliveMin: cached?.keepAliveMin ?? 30,
        configured: Boolean(cached),
      }
    }
    case 'offline-mind':
    case 'auto':
    default:
      return { id, baseUrl: null, apiKey: null, model: 'deterministic-fallback', configured: true }
  }
}

/** The C4 local lane's cached provider config (set by refreshLocalLaneCache
 *  — see the 'local' case above). */
interface LocalLaneCacheEntry {
  baseUrl: string
  model: string
  apiKey: string
  keepAliveMin: number
}
let localLaneCache: LocalLaneCacheEntry | null = null

/** Refresh the local-lane cache from the settings row (2s-cached read —
 *  cheap). Called at the head of every cascade walk; the wizard's configure
 *  invalidates the settings cache so the next walk sees the change. */
async function refreshLocalLaneCache(): Promise<boolean> {
  const cfg = await localLaneProviderConfig()
  const next = cfg ? { baseUrl: cfg.baseUrl, model: cfg.model, apiKey: cfg.apiKey ?? 'local-lane', keepAliveMin: cfg.keepAliveMin } : null
  const changed = JSON.stringify(next) !== JSON.stringify(localLaneCache)
  localLaneCache = next
  return changed
}

function isConfigured(id: ProviderId): boolean {
  if (id === 'core' || id === 'offline-mind') return true
  if (id === 'local') return localLaneCache !== null
  if (id === 'qwen') return isQwenConfigured()
  if (id === 'hermes') return isNousConfigured()
  return resolveProviderConfig(id).configured
}

// ---------- status (never secrets) ----------

export function getLlmStatus(): LlmStatus {
  const configuredEnv = ENV_PROVIDER_IDS.filter((p) => isConfigured(p))

  const explicitEnv = process.env.MIST_LLM_PROVIDER?.trim() as ProviderId | undefined
  let active: ProviderId = 'core'
  if (explicitEnv && explicitEnv !== 'auto' && explicitEnv !== 'offline-mind' && isConfigured(explicitEnv)) {
    active = explicitEnv
  } else {
    active = configuredEnv[0] ?? 'core'
  }
  const cfg = resolveProviderConfig(active)

  // Mist Core display model: user selection → live gateway-reported → 'auto'
  const coreSel = getCoreTextModelSelection()
  const liveNow = getCoreLiveModels()
  const coreDisplayModel = coreSel ?? liveNow.text ?? 'auto'

  const detail = (id: ProviderId, label: string): ProviderDetail => {
    const c = resolveProviderConfig(id)
    const entry: ProviderDetail = {
      id,
      label,
      available: isConfigured(id),
      model: c.model,
    }
    // base_url_present only reflects env-driven base URLs (fixed-endpoint providers omit it)
    if (id === 'omniroute' || id === 'openai_compatible') {
      entry.base_url_present = c.configured
    }
    if (c.apiKey) entry.api_key_present = true
    return entry
  }

  const providers_detail: ProviderDetail[] = [
    {
      id: 'auto',
      label: 'Auto (cascade)',
      available: true,
      ...(process.env.MIST_LLM_MODEL?.trim() ? { model: process.env.MIST_LLM_MODEL.trim() } : {}),
      note: 'resolves the first configured provider in cascade order',
    },
    detail('omniroute', 'OmniRoute Gateway'),
    {
      id: 'hermes',
      label: 'Hermes / Nous Research',
      available: isNousConfigured(),
      model: resolveNousModelId(),
      base_url_present: true,
      ...(getNousApiKey() || isNousKeylessLocal() ? { api_key_present: true } : {}),
      note: isNousConfigured()
        ? `${nousLaneLabel()} · ${getNousBaseUrl()}`
        : 'add MIST_NOUS_API_KEY (or point MIST_NOUS_BASE_URL at your local Hermes gateway / Ollama) to activate',
    },
    {
      id: 'theoldapi',
      label: 'TheOldAPI (unlimited)',
      available: Boolean(process.env.THEOLD_API_KEY?.trim()),
      model: process.env.THEOLD_MODEL?.trim() || 'gpt-5.3',
      ...(process.env.THEOLD_API_KEY?.trim() ? { api_key_present: true } : {}),
      note: process.env.THEOLD_API_KEY?.trim()
        ? '$7/mo flat · 50M tokens/day · 100+ top models · theoldllm.com/v1'
        : 'the $7/mo unlimited lane — GPT/Claude/Gemini/Grok/DeepSeek, 50M tokens a day. Add THEOLD_API_KEY to activate',
    },
    detail('openai_compatible', 'OpenAI-compatible'),
    detail('nvidia', 'NVIDIA NIM'),
    detail('openrouter', 'OpenRouter'),
    {
      id: 'qwen',
      label: 'Qwen (Alibaba)',
      available: isQwenConfigured(),
      model: getQwenTextModelSelection(),
      base_url_present: true,
      ...(getQwenApiKey() || isQwenKeylessLocal() ? { api_key_present: true } : {}),
      note: isQwenKeylessLocal()
        ? `local OpenAI-compatible endpoint · ${getQwenBaseUrl()}`
        : getQwenApiKey()
          ? 'DashScope-compatible endpoint · real Qwen models, no aliases'
          : 'add MIST_QWEN_API_KEY (or point MIST_QWEN_BASE_URL at local Ollama) to activate',
    },
    detail('groq', 'Groq (free tier)'),
    detail('github_models', 'GitHub Models (free)'),
    detail('cerebras', 'Cerebras (free tier)'),
    detail('together', 'Together AI'),
    detail('mistral', 'Mistral (free tier)'),
    detail('huggingface', 'HuggingFace Router'),
    detail('anthropic', 'Anthropic'),
    detail('gemini', 'Gemini'),
    {
      id: 'kilo',
      label: 'Kilo Code (keyless)',
      available: keylessEnabled(),
      model: process.env.KILO_MODEL?.trim() || KEYLESS_DEFAULTS.kilo.model,
      ...(process.env.KILO_API_KEY?.trim() ? { api_key_present: true } : {}),
      note: keylessEnabled()
        ? `zero-auth · 200 req/hr · 550B nemotron + rotating free pool${getKeylessReportedModel('kilo') ? ` · last served by ${getKeylessReportedModel('kilo')}` : ''}`
        : 'disabled by MIST_KEYLESS=0 — remove it to re-enable',
    },
    {
      id: 'pollinations',
      label: 'Pollinations (keyless)',
      available: keylessEnabled(),
      model: process.env.POLLINATIONS_MODEL?.trim() || KEYLESS_DEFAULTS.pollinations.model,
      note: keylessEnabled()
        ? `zero-auth · openai-fast (gpt-oss-20b reasoning)${getKeylessReportedModel('pollinations') ? ` · last served by ${getKeylessReportedModel('pollinations')}` : ''}`
        : 'disabled by MIST_KEYLESS=0 — remove it to re-enable',
    },
    {
      id: 'llm7',
      label: 'LLM7.io (keyless turbo)',
      available: keylessEnabled(),
      model: process.env.LLM7_MODEL?.trim() || 'auto (live turbo pick)',
      ...(process.env.LLM7_TOKEN?.trim() ? { api_key_present: true } : {}),
      note: keylessEnabled()
        ? `zero-auth · turbo tier · 1 RPS anonymous · catalog rotates live${getKeylessReportedModel('llm7') ? ` · last served by ${getKeylessReportedModel('llm7')}` : ''}`
        : 'disabled by MIST_KEYLESS=0 — remove it to re-enable',
    },
    {
      id: 'ovh',
      label: 'OVHcloud AI (keyless)',
      available: keylessEnabled(),
      model: process.env.OVH_MODEL?.trim() || KEYLESS_DEFAULTS.ovh.model,
      ...(process.env.OVH_API_KEY?.trim() ? { api_key_present: true } : {}),
      note: keylessEnabled()
        ? `zero-auth · 2 RPM/model/IP · Qwen3.5-397B, gpt-oss-120b, Qwen3-Coder 262k · EU${getKeylessReportedModel('ovh') ? ` · last served by ${getKeylessReportedModel('ovh')}` : ''}`
        : 'disabled by MIST_KEYLESS=0 — remove it to re-enable',
    },
    {
      id: 'core',
      label: 'Mist Core (z-ai gateway)',
      available: true,
      model: coreDisplayModel,
      note: liveNow.text
        ? `built-in GLM brain · gateway serving ${liveNow.text}`
        : 'built-in GLM brain via the Z.ai gateway',
    },
    {
      id: 'local',
      label: 'Local lane (Ollama / LM Studio / llama.cpp)',
      available: localLaneCache !== null,
      model: localLaneCache?.model ?? 'not configured',
      ...(localLaneCache ? { base_url_present: true } : {}),
      note: localLaneCache
        ? `the owner's own machine · ${localLaneCache.baseUrl} · first in the cascade · Unfiltered-capable`
        : 'configure in Settings → Candor & Local Lane (detects Ollama :11434, LM Studio :1234, llama.cpp :8080)',
    },
    {
      id: 'offline-mind',
      label: 'Offline Mind',
      available: true,
      model: 'deterministic-fallback',
      note: 'deterministic fallback when all providers fail',
    },
  ]

  return {
    configured: true, // core is always present
    provider: active,
    model: active === 'core' ? coreDisplayModel : cfg.model,
    base_url_present: active === 'core' ? false : Boolean(cfg.baseUrl),
    api_key_present: active === 'core' ? false : Boolean(cfg.apiKey),
    available_providers: ['core', 'offline-mind', ...configuredEnv],
    providers_detail,
    core_models: getCoreModelsInfo(),
    qwen_models: getQwenModelsInfo(),
    nous_models: getNousModelsInfo(),
  }
}

// ---------- HTTP helpers ----------

async function fetchJson(
  url: string,
  init: RequestInit,
  timeoutMs?: number,
  ownerSignal?: AbortSignal,
  egressMeta?: { lane: string; klass: EgressClass }
): Promise<unknown> {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs ?? LLM_TIMEOUT_MS)
  // Phase 3-a · R1: the owner's signal (unified's req.signal — fires when the
  // caller disconnects or aborts) aborts this fetch alongside the timeout.
  const unlinkOwner = linkOwnerSignal(ac, ownerSignal)
  try {
    const res = await egressLaneFetch(
      url,
      { ...init, signal: ac.signal, cache: 'no-store' },
      egressMeta ?? { lane: 'http', klass: 'llm-lane' }
    )
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return (await res.json()) as unknown
  } finally {
    clearTimeout(timer)
    unlinkOwner()
  }
}

function openAiEndpoint(base: string): string {
  if (base.endsWith('/chat/completions')) return base
  if (base.endsWith('/v1')) return `${base}/chat/completions`
  if (base.endsWith('/v1/')) return `${base}chat/completions`
  return `${base.replace(/\/+$/, '')}/v1/chat/completions`
}

// ---------- degenerate-reply detection (2026-09-27, spoken-babble defense) ----------
// Saturated free-tier reasoning models sometimes return degenerate content:
// random Hangul / script bleed, or spaced syllable babble ("e na na na ni na
// ena"). The voice session speaks .text verbatim — the creator heard that
// babble aloud (tongtong reads Hangul syllables as "na/ni/e"). A degenerate
// reply is a PROVIDER FAILURE, not an answer: throw so the cascade retries
// the next lane. Two layers of defense: this engine gate (all consumers) +
// the speech-layer guard (src/lib/speech.ts, MIST's drill).

/** Ratio of characters in the given Unicode script blocks. */
function scriptRatio(text: string, re: RegExp): number {
  if (text.length === 0) return 0
  const hits = text.match(re)
  return (hits?.length ?? 0) / text.length
}

/**
 * Detect degenerate replies. `expectedLatin` derives from the user's own
 * message: when the user writes Korean/Chinese, script bleed is LEGITIMATE —
 * only flag unexpected scripts. Fenced code blocks are excluded before
 * repetition analysis (code legitimately repeats tokens).
 */
export function detectDegenerateReply(
  content: string,
  userMessage: string
): string | null {
  const text = content.trim()
  if (text.length < 8) return null

  // 1. script bleed — reply dominated by a script the user is not using
  const latinChars = (userMessage.match(/[A-Za-z]/g) ?? []).length
  const userIsLatin = latinChars >= 4 && latinChars / Math.max(1, userMessage.replace(/\s/g, '').length) > 0.6
  if (userIsLatin) {
    const hangul = scriptRatio(text, /[\uAC00-\uD7AF\u1100-\u11FF]/g)
    if (hangul > 0.2) return `script-bleed:hangul:${hangul.toFixed(2)}`
    const cyrillic = scriptRatio(text, /[\u0400-\u04FF]/g)
    if (cyrillic > 0.2) return `script-bleed:cyrillic:${cyrillic.toFixed(2)}`
    // CJK gets a looser bar — she legitimately quotes Chinese terms in English chat
    const cjk = scriptRatio(text, /[\u4E00-\u9FFF]/g)
    if (cjk > 0.4) return `script-bleed:cjk:${cjk.toFixed(2)}`
  }

  // 2. repetition analysis on prose only (drop fenced code + inline code)
  const prose = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/~~~[\s\S]*?~~~/g, ' ')
    .replace(/`[^`\n]*`/g, ' ')
    .trim()
  if (prose.length < 8) return null

  // 2a. one syllable-word dominating the whole reply ("na na na na na")
  const tokens = prose.toLowerCase().split(/\s+/).filter((t) => /^[a-z\u00C0-\u024F']{1,6}$/.test(t))
  if (tokens.length >= 6) {
    const freq = new Map<string, number>()
    for (const t of tokens) freq.set(t, (freq.get(t) ?? 0) + 1)
    for (const [tok, n] of freq) {
      if (n / tokens.length > 0.5 && tok.length >= 2) {
        return `token-dominance:${tok}:${(n / tokens.length).toFixed(2)}`
      }
    }
  }

  // 2b. the same word 4+ times in a row ("no no no no no")
  if (/\b(\S+)\s+(\1\s+){3,}\1\b/.test(prose)) return 'consecutive-repeat'

  // 2c. compact unspaced runs ("nananana", "나나나나") — short strings only:
  // long English prose naturally sits near a 0.1 unique-char ratio (small
  // alphabet), so the ratio test is only meaningful for run-length babble
  const bare = prose.replace(/[\s.,!?;:—–-]/g, '')
  if (bare.length >= 12 && bare.length <= 80) {
    const unique = new Set([...bare]).size
    if (unique / bare.length < 0.15) return `char-repetition:${(unique / bare.length).toFixed(2)}`
  }

  return null
}

// ---------- structured outputs (OpenRouter-style response_format) ----------

/**
 * A JSON contract for a completion: the caller demands JSON back and (when
 * the serving lane supports strict schemas) gets grammar-constrained output —
 * the model CANNOT emit illegal JSON (unescaped quotes, raw newlines), which
 * is the bug class that cost mission cmuke507 four MALFORMED_REPLY nudges
 * and motivated escapeInnerQuotes. Lanes without the capability still serve
 * (prompt contract + parseLooseJson repair guards stay as the safety net).
 */
export type JsonContract = {
  /** schema name shown to the model, e.g. 'verdict' */
  name: string
  /** strict JSON Schema — served as json_schema on lanes that support it */
  schema?: Record<string, unknown>
}

/**
 * Per-lane response_format capability, LIVE-PROBED 2026-09-28 (the email from
 * OpenRouter was the lead — every entry below is a real curl, not docs):
 *   • openrouter (keyed, :free models): strict json_schema served by Nvidia —
 *     1.8s, $0, schema-perfect weather verdict on nemotron-3-ultra-550b:free
 *   • kilo (keyless): json_object served fine (2s) but json_schema HANGS
 *     (60s, 0 bytes) — kilo proxies OpenRouter underneath (gen-… ids,
 *     provider:"Nvidia") yet chokes on strict schemas; NEVER send json_schema
 *   • llm7 / pollinations / ovh: unprobed for response_format — stay plain
 * Any other lane (groq, together, …): unprobed → plain, guards cover.
 */
const LANE_JSON_CAPABILITY: Record<string, 'none' | 'json_object' | 'json_schema'> = {
  openrouter: 'json_schema',
  kilo: 'json_object',
  llm7: 'none',
  pollinations: 'none',
  ovh: 'none',
}

/**
 * Build the response_format body field a lane can honor, downgrading
 * gracefully: json_schema → json_object → none. An unprobed lane gets
 * nothing (its replies stay prompt-contract only).
 */
function responseFormatFor(laneId: string, json?: JsonContract): Record<string, unknown> | undefined {
  if (!json) return undefined
  const capability = LANE_JSON_CAPABILITY[laneId] ?? 'none'
  if (capability === 'json_schema' && json.schema) {
    return {
      type: 'json_schema',
      json_schema: { name: json.name, strict: true, schema: json.schema },
    }
  }
  if (capability === 'json_schema' || capability === 'json_object') {
    return { type: 'json_object' }
  }
  return undefined
}

async function callOpenAiCompatible(
  cfg: ProviderConfig,
  systemPrompt: string,
  messages: SimMessage[],
  timeoutMs?: number,
  responseFormat?: Record<string, unknown>,
  onDelta?: DeltaSink,
  ownerSignal?: AbortSignal,
  extraBody?: Record<string, unknown>
): Promise<string> {
  const endpoint = openAiEndpoint(cfg.baseUrl ?? '')
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`
  // Phase 5 · C6: every OpenAI-compatible fetch rides the egress lane door
  // (the ledger records host/lane/class; Unfiltered trips non-loopback)
  const egressMeta = {
    lane: cfg.id,
    klass: (laneConsentClass(cfg.id, { apiKey: cfg.apiKey, baseUrl: cfg.baseUrl }) === 'keyless' ? 'keyless-lane' : cfg.id === 'local' ? 'local-lane' : 'llm-lane') as EgressClass,
  }

  // w5 voice-speed: with a delta sink the lane STREAMS — SSE deltas reach
  // the filter while the model still generates. A server that ignores
  // stream:true answers JSON and the normal parse path runs unchanged. A
  // mid-stream failure with text already streamed RETURNS the partial as
  // success: the emitted prefix must always equal the returned text (what
  // was spoken is what she said).
  if (onDelta && !responseFormat) {
    let streamed = ''
    try {
      const ac = new AbortController()
      let timer = setTimeout(() => ac.abort(), timeoutMs ?? LLM_TIMEOUT_MS)
      const unlinkOwner = linkOwnerSignal(ac, ownerSignal)
      const resetTimer = () => {
        clearTimeout(timer)
        timer = setTimeout(() => ac.abort(), timeoutMs ?? LLM_TIMEOUT_MS)
      }
      try {
        const res = await egressLaneFetch(
          endpoint,
          {
            method: 'POST',
            headers,
            body: JSON.stringify({
              model: cfg.model,
              messages: [{ role: 'system', content: systemPrompt }, ...messages],
              max_tokens: 4096,
              temperature: 0.7,
              stream: true,
              ...(extraBody ?? {}),
            }),
            signal: ac.signal,
            cache: 'no-store',
          },
          egressMeta
        )
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const ctype = res.headers.get('content-type') ?? ''
        if (!res.body || (!ctype.includes('text/event-stream') && !ctype.includes('text/plain'))) {
          // server ignored stream:true — a complete JSON completion
          const json = await res.json()
          clearTimeout(timer)
          const { text } = parseOpenAiChatResponse(json, messages, {})
          return text
        }
        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        let buf = ''
        for (;;) {
          const { value, done } = await reader.read()
          if (value) {
            resetTimer()
            buf += decoder.decode(value, { stream: true })
            let nl: number
            while ((nl = buf.indexOf('\n')) >= 0) {
              const line = buf.slice(0, nl).trim()
              buf = buf.slice(nl + 1)
              if (!line.startsWith('data:')) continue
              const d = sseDelta(line.slice(5).trim())
              if (d) {
                streamed += d
                onDelta(d)
              }
            }
          }
          if (done) break
        }
        clearTimeout(timer)
      } finally {
        clearTimeout(timer)
        unlinkOwner()
      }
      if (!streamed.trim()) throw new Error('empty streamed completion')
      // degenerate-reply gate on the streamed whole (same honesty as JSON)
      const degenerate = detectDegenerateReply(streamed, [...messages].reverse().find((m) => m.role === 'user')?.content ?? '')
      if (degenerate) throw new Error(`degenerate reply (${degenerate})`)
      return streamed
    } catch (err) {
      // Phase 3-a: an OWNER abort is never papered over with the partial —
      // the turn is cancelled, not "answered". (Lane/server breaks keep the
      // honest-prefix contract below.)
      if (ownerAborted(ownerSignal)) throw err
      if (streamed.trim()) return streamed // partial already emitted — keep the honest prefix
      throw err
    }
  }

  const json = await fetchJson(
    endpoint,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: cfg.model,
        messages: [{ role: 'system', content: systemPrompt }, ...messages],
        // 4096: reasoning models (nemotron/deepseek) spend tokens on thinking
        // before answering — 2048 starved them into finish_reason:length with
        // empty content. Room to think AND deliver.
        max_tokens: 4096,
        temperature: 0.7,
        ...(extraBody ?? {}),
        // structured outputs (2026-09-28): grammar-constrained JSON — only
        // sent by lanes whose capability is probe-verified (see LANE_JSON_CAPABILITY)
        ...(responseFormat ? { response_format: responseFormat } : {}),
      }),
    },
    // callers (missions: 60–90s) pass real budgets — the old hard 30s abort
    // killed big reasoning-model prompts (verifier transcripts) mid-flight and
    // read as "no provider" when the lane was perfectly healthy
    timeoutMs,
    ownerSignal,
    egressMeta
  )
  const { text } = parseOpenAiChatResponse(json, messages, {
    jsonContract: Boolean(responseFormat),
  })
  return text
}

/**
 * Shared OpenAI-format response parser: content passes the degenerate-reply
 * gate (spoken-babble defense), reasoning-only replies become a graceful
 * honest line instead of a leaked thought-trace, empty replies throw so the
 * cascade regenerates on the next lane. Used by every OpenAI-compatible
 * lane — keyed and keyless alike.
 */
function parseOpenAiChatResponse(
  json: unknown,
  messages: SimMessage[],
  opts?: { jsonContract?: boolean }
): { text: string; reportedModel: string | null } {
  const c = json as {
    model?: unknown
    choices?: Array<{
      message?: { content?: unknown; reasoning_content?: unknown; reasoning?: unknown }
      finish_reason?: unknown
    }>
  }
  const message = c?.choices?.[0]?.message
  const content = message?.content
  if (typeof content === 'string' && content.trim()) {
    // Truncation guard (defect #12, 2026-09-28 orb-honesty run 2): a reply cut
    // off at max_tokens (finish_reason 'length') under a JSON contract is
    // GUARANTEED malformed downstream — reasoning models (nvidia nemotron) burn
    // thousands of tokens thinking before the tool_call envelope, and the cut
    // payload surfaced as three MALFORMED_REPLY nudges that taught nothing.
    // A truncated lane is a FAILED lane: throw so the cascade advances to a
    // model that fits the payload. Prose replies (no contract) stay usable.
    const finishReason = c?.choices?.[0]?.finish_reason
    if (opts?.jsonContract && finishReason === 'length') {
      recordActivity(
        'llm',
        'truncated reply (finish_reason:length) under a JSON contract — lane fails, cascade advances'
      )
      throw new Error('truncated at max_tokens (finish_reason:length) under a JSON contract')
    }
    const lastUser = [...messages].reverse().find((m) => m.role === 'user')?.content ?? ''
    const degenerate = detectDegenerateReply(content, lastUser)
    if (degenerate) {
      recordActivity('llm', `degenerate reply rejected (${degenerate}) — cascading to next provider`)
      throw new Error(`degenerate reply (${degenerate})`)
    }
    const reported = typeof c?.model === 'string' && c.model.trim() ? c.model.trim() : null
    return { text: content, reportedModel: reported }
  }
  // reasoning-only degenerate reply (content null, thinking consumed the
  // budget). NEVER return the raw reasoning trace as the answer — the neural
  // socket passes .text straight to the client and the voice session SPEAKS
  // it: the creator heard internal chain-of-thought as gibberish (Drill #6
  // series, 2026-09-27). THROW instead of answering: a lane that thought but
  // never answered is a FAILED lane — returning the old graceful line here
  // made the cascade treat it as success, trapping her 2026-09-28 mission on
  // nvidia's reasoning-only replies until every step degraded (score 0/100).
  // Throwing lets the cascade advance to the next lane; the reasoning trace
  // itself is never surfaced, so the no-leak guarantee is preserved.
  const reasoning =
    (typeof message?.reasoning_content === 'string' && message.reasoning_content.trim() && message.reasoning_content) ||
    (typeof message?.reasoning === 'string' && message.reasoning.trim() && message.reasoning) ||
    null
  if (reasoning) {
    recordActivity('llm', 'reasoning-only reply — lane fails, cascade advances (never leak the trace)')
    throw new Error('reasoning-only reply (model thought but never answered — content empty)')
  }
  throw new Error('empty completion')
}

/**
 * Qwen call — real model ids against a real Qwen endpoint (DashScope by default,
 * any OpenAI-compatible base URL, or keyless local Ollama). The endpoint's reported
 * model name is captured for honest attribution — never an alias.
 */
async function callQwen(
  cfg: ProviderConfig,
  systemPrompt: string,
  messages: SimMessage[],
  opts?: { vision?: boolean },
  ownerSignal?: AbortSignal
): Promise<{ text: string; reportedModel: string | null }> {
  const endpoint = openAiEndpoint(cfg.baseUrl ?? '')
  const model = opts?.vision ? getQwenVisionModelSelection() : cfg.model
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`
  const json = (await fetchJson(
    endpoint,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        messages: [{ role: 'system', content: systemPrompt }, ...messages],
        max_tokens: 2048,
        temperature: 0.7,
      }),
    },
    undefined,
    ownerSignal,
    { lane: 'qwen', klass: 'llm-lane' }
  )) as {
    model?: unknown
    choices?: Array<{ message?: { content?: unknown } }>
  }
  const content = json?.choices?.[0]?.message?.content
  if (typeof content !== 'string' || !content.trim()) throw new Error('empty completion from qwen endpoint')
  const reported = typeof json?.model === 'string' && json.model.trim() ? json.model.trim() : null
  if (reported) noteQwenReportedModel(opts?.vision ? 'vision' : 'text', reported)
  return { text: content, reportedModel: reported }
}

/**
 * Nous / Hermes call — real model ids against whichever lane the base URL
 * resolves to (Nous Portal cloud, the local Hermes agent gateway :8642, or a
 * local runtime serving Hermes weights). The endpoint's reported model name
 * is captured for honest attribution — never an alias. Rides the same
 * degenerate-reply gate as every other spoken lane.
 */
async function callNous(
  cfg: ProviderConfig,
  systemPrompt: string,
  messages: SimMessage[],
  timeoutMs?: number,
  ownerSignal?: AbortSignal
): Promise<{ text: string; reportedModel: string | null }> {
  const endpoint = openAiEndpoint(cfg.baseUrl ?? '')
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`
  const json = (await fetchJson(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: resolveNousModelId(),
      messages: [{ role: 'system', content: systemPrompt }, ...messages],
      max_tokens: 4096,
      temperature: 0.7,
    }),
  }, timeoutMs, ownerSignal, { lane: 'hermes', klass: laneConsentClass('hermes', { apiKey: cfg.apiKey, baseUrl: cfg.baseUrl }) === 'local' ? 'local-lane' : 'llm-lane' })) as {
    model?: unknown
    choices?: Array<{ message?: { content?: unknown } }>
  }
  const content = json?.choices?.[0]?.message?.content
  if (typeof content !== 'string' || !content.trim()) throw new Error('empty completion from nous endpoint')
  const lastUser = [...messages].reverse().find((m) => m.role === 'user')?.content ?? ''
  const degenerate = detectDegenerateReply(content, lastUser)
  if (degenerate) throw new Error(`degenerate reply (${degenerate})`)
  const reported = typeof json?.model === 'string' && json.model.trim() ? json.model.trim() : null
  if (reported) noteNousReportedModel('text', reported)
  return { text: content, reportedModel: reported }
}

async function callAnthropic(
  cfg: ProviderConfig,
  systemPrompt: string,
  messages: SimMessage[],
  ownerSignal?: AbortSignal
): Promise<string> {
  const json = await fetchJson('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': cfg.apiKey ?? '',
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: cfg.model,
      max_tokens: 2048,
      system: systemPrompt,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
    }),
  }, undefined, ownerSignal, { lane: 'anthropic', klass: 'llm-lane' })
  const content = (json as { content?: Array<{ type?: string; text?: unknown }> })?.content
  const firstText = content?.find((b) => typeof b.text === 'string')?.text
  if (typeof firstText !== 'string' || !firstText.trim()) throw new Error('empty completion')
  return firstText
}

async function callGemini(
  cfg: ProviderConfig,
  systemPrompt: string,
  messages: SimMessage[],
  ownerSignal?: AbortSignal
): Promise<string> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(cfg.model)}:generateContent?key=${cfg.apiKey ?? ''}`
  // own fetch (not fetchJson): Gemini's region-block answer lives in the
  // response BODY ("User location is not supported for the API use") while
  // fetchJson throws only the bare status — the message must reach the
  // cascade so noteLaneFailure can classify the lane honestly.
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), LLM_TIMEOUT_MS)
  const unlinkOwner = linkOwnerSignal(ac, ownerSignal) // Phase 3-a · R1
  let json: unknown
  try {
    const res = await egressLaneFetch(
      url,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: systemPrompt }] },
          contents: messages.map((m) => ({
            role: m.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: m.content }],
          })),
        }),
        signal: ac.signal,
        cache: 'no-store',
      },
      { lane: 'gemini', klass: 'llm-lane' }
    )
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      // Google's own message, verbatim when it speaks
      const gmsg = /"message"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(body)?.[1] ?? body.slice(0, 300)
      // Region block (live-probed 2026-09-30: this instance's egress is in a
      // Google-blocked region — EVERY live model answers this, server-side):
      // a 400 whose body says "User location is not supported for the API
      // use". Deterministic for this lane, not transient — reshape to the
      // taxonomy's auth class (403/forbidden keywords → 6h lane rest) so ONE
      // hit stops the cascade from paying this round trip on every walk. The
      // verbatim Google message stays in the error for honest logs/traces.
      if (/location is not supported/i.test(body)) {
        throw new Error(
          `gemini lane forbidden (403): ${gmsg || 'User location is not supported for the API use'} — region-blocked egress, resting the lane 6h (auth class)`
        )
      }
      throw new Error(`gemini HTTP ${res.status}${gmsg ? `: ${gmsg}` : ''}`)
    }
    json = (await res.json()) as unknown
  } finally {
    clearTimeout(timer)
    unlinkOwner()
  }
  const text = (json as { candidates?: Array<{ content?: { parts?: Array<{ text?: unknown }> } }> })
    ?.candidates?.[0]?.content?.parts?.[0]?.text
  if (typeof text !== 'string' || !text.trim()) throw new Error('empty completion')
  return text
}

interface CoreCallResult {
  text: string
  /** Model name the Z.ai gateway REPORTED for this call (ground truth, e.g. 'glm-4-plus'). */
  reportedModel: string | null
}

/**
 * Model candidates for a keyless lane, in priority order:
 * the configured (or live-picked) model first, then the provider's verified
 * fallbacks. Rotation across these at call time is what keeps the lane alive
 * when a specific model is rate-limited upstream, rotated out of the free
 * pool, or temporarily unavailable.
 */
async function resolveKeylessModelCandidates(id: KeylessId, cfg: ProviderConfig): Promise<string[]> {
  const def = KEYLESS_DEFAULTS[id]
  const candidates: string[] = []
  if (cfg.model && cfg.model !== 'auto') {
    candidates.push(cfg.model)
  } else if (id === 'llm7') {
    // 'auto' → live turbo pick (the catalog rotates frequently)
    candidates.push(await pickLlm7TurboModel())
  }
  for (const f of def.fallbacks) {
    if (!candidates.includes(f)) candidates.push(f)
  }
  if (candidates.length === 0) candidates.push(def.model)
  return candidates
}

/**
 * Keyless lane call — POSTs an OpenAI-compatible request with ZERO auth,
 * rotating across the provider's model candidates when one model fails
 * (upstream 429s on shared free pools, rotated catalogs, per-model quotas).
 * Captures the serving model for honest attribution. Throws (→ cascade)
 * only after every candidate failed — and the next keyless lane then the
 * core brain still stand behind it.
 */
async function callKeylessLane(
  id: KeylessId,
  cfg: ProviderConfig,
  systemPrompt: string,
  messages: SimMessage[],
  models: string[],
  timeoutMs?: number,
  responseFormat?: Record<string, unknown>,
  onDelta?: DeltaSink,
  ownerSignal?: AbortSignal
): Promise<{ text: string; reportedModel: string | null }> {
  const base = (cfg.baseUrl ?? '').replace(/\/+$/, '')
  // Pollinations serves its OpenAI-compatible surface at /openai; the other
  // three are standard /chat/completions endpoints
  const endpoint = id === 'pollinations' ? `${base}/openai` : `${base}/chat/completions`
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  // BYOK raises limits when present; it never gates the lane
  if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`
  const failures: string[] = []
  for (const model of models.slice(0, 3)) {
    // llm7's anonymous tier is 1 RPS — a soft backoff between model attempts
    // keeps a rotated retry from tripping the rate limiter we just hit
    if (failures.length > 0) await new Promise((r) => setTimeout(r, 1_200))
    // w5 voice-speed: stream this attempt when a sink is attached (a fresh
    // attempt starts from empty text — a failed attempt emitted nothing).
    // Partial-on-error keeps the spoken prefix honest (see callOpenAiCompatible).
    const streamThis = Boolean(onDelta) && !responseFormat
    let streamed = ''
    try {
      let json: unknown
      if (streamThis) {
        const ac = new AbortController()
        let timer = setTimeout(() => ac.abort(), timeoutMs ?? LLM_TIMEOUT_MS)
        const unlinkOwner = linkOwnerSignal(ac, ownerSignal)
        const resetTimer = () => {
          clearTimeout(timer)
          timer = setTimeout(() => ac.abort(), timeoutMs ?? LLM_TIMEOUT_MS)
        }
        let sseOk = false
        try {
          const res = await egressLaneFetch(
            endpoint,
            {
              method: 'POST',
              headers,
              body: JSON.stringify({
                model,
                messages: [{ role: 'system', content: systemPrompt }, ...messages],
                max_tokens: 4096,
                temperature: 0.7,
                stream: true,
              }),
              signal: ac.signal,
              cache: 'no-store',
            },
            { lane: id, klass: 'keyless-lane' }
          )
          if (!res.ok) throw new Error(`HTTP ${res.status}`)
          const ctype = res.headers.get('content-type') ?? ''
          if (res.body && (ctype.includes('text/event-stream') || ctype.includes('text/plain'))) {
            sseOk = true
            const reader = res.body.getReader()
            const decoder = new TextDecoder()
            let buf = ''
            for (;;) {
              const { value, done } = await reader.read()
              if (value) {
                resetTimer()
                buf += decoder.decode(value, { stream: true })
                let nl: number
                while ((nl = buf.indexOf('\n')) >= 0) {
                  const line = buf.slice(0, nl).trim()
                  buf = buf.slice(nl + 1)
                  if (!line.startsWith('data:')) continue
                  const d = sseDelta(line.slice(5).trim())
                  if (d) {
                    streamed += d
                    onDelta?.(d)
                  }
                }
              }
              if (done) break
            }
          } else {
            json = await res.json()
          }
        } finally {
          clearTimeout(timer)
          unlinkOwner()
        }
        if (sseOk) {
          if (!streamed.trim()) throw new Error('empty streamed completion')
          const degenerate = detectDegenerateReply(
            streamed,
            [...messages].reverse().find((m) => m.role === 'user')?.content ?? ''
          )
          if (degenerate) throw new Error(`degenerate reply (${degenerate})`)
          if (id === 'kilo') noteKeylessReportedModel(id, model)
          return { text: streamed, reportedModel: model }
        }
      } else {
        json = await fetchJson(
          endpoint,
          {
            method: 'POST',
            headers,
            body: JSON.stringify({
              model,
              messages: [{ role: 'system', content: systemPrompt }, ...messages],
              max_tokens: 4096,
              temperature: 0.7,
              // structured outputs: only what the lane's probe-verified
              // capability allows (kilo: json_object — json_schema hangs it)
              ...(responseFormat ? { response_format: responseFormat } : {}),
            }),
          },
          timeoutMs,
          ownerSignal,
          { lane: id, klass: 'keyless-lane' }
        )
      }
      const res = parseOpenAiChatResponse(json, messages, {
        jsonContract: Boolean(responseFormat),
      })
      if (res.reportedModel) noteKeylessReportedModel(id, res.reportedModel)
      if (failures.length > 0) {
        recordActivity('llm', `keyless ${id}: ${model} answered after rotating past ${failures.length} blocked model(s)`)
      }
      return { text: res.text, reportedModel: res.reportedModel ?? model }
    } catch (err) {
      // Phase 3-a: an owner abort is never papered over with the partial —
      // the turn is cancelled. (Server breaks mid-stream keep the prefix.)
      if (ownerAborted(ownerSignal)) {
        throw err
      }
      if (streamThis && streamed.trim()) {
        // partial text was already streamed and possibly spoken — the
        // emitted prefix IS the answer; never re-roll to another model
        recordActivity('llm', `keyless ${id}: stream broke mid-reply — keeping the ${streamed.length} chars that arrived`)
        return { text: streamed, reportedModel: model }
      }
      failures.push(`${model}: ${err instanceof Error ? err.message.slice(0, 90) : String(err).slice(0, 90)}`)
    }
  }
  throw new Error(`keyless ${id} exhausted (${failures.join(' | ')})`)
}

/**
 * Mist Core call through the z-ai SDK.
 * - forwards the selected text/vision model when one is set (gateway decides final routing)
 * - vision/video mode rides the vision endpoint (serves the vision model),
 *   falling back to the text endpoint if the gateway rejects the call
 * - always captures the model the gateway reports back
 */
async function callCore(
  systemPrompt: string,
  messages: SimMessage[],
  opts?: { vision?: boolean; thinking?: boolean },
  timeoutMs?: number,
  onDelta?: DeltaSink,
  ownerSignal?: AbortSignal
): Promise<CoreCallResult> {
  const zai = await getZai()
  const chatMessages: SdkChatMessage[] = [{ role: 'assistant', content: systemPrompt }, ...messages]
  const textModel = getCoreTextModelSelection()
  const visionModel = getCoreVisionModelSelection()
  let timer: ReturnType<typeof setTimeout> | undefined

  const arm = () =>
    new Promise<never>((_, reject) => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => reject(new Error('core timeout')), timeoutMs ?? LLM_TIMEOUT_MS)
    })

  // Phase 3-a · R1: the SDK exposes no fetch handle, so the owner signal
  // races the SAME way the timeout does — a rejection that kills whichever
  // await is in flight. Destroyed in the finally so a completed call leaves
  // no listener behind.
  let unlinkOwner = () => {}
  const ownerRace: Promise<never> | null = ownerSignal
    ? new Promise<never>((_, reject) => {
        if (ownerSignal.aborted) {
          reject(new Error('aborted by owner'))
          return
        }
        const onAbort = () => reject(new Error('aborted by owner'))
        ownerSignal.addEventListener('abort', onAbort, { once: true })
        unlinkOwner = () => ownerSignal.removeEventListener('abort', onAbort)
      })
    : null
  // an unhandled rejection on the abort promise would crash the process if
  // the call completes first — attach a no-op catch and rely on the RACE
  const ownerRaceGuarded = ownerRace ? Promise.race([ownerRace, new Promise<never>(() => {})]) as Promise<never> : null
  void ownerRaceGuarded?.catch(() => {})

  // w5 voice-speed: with a delta sink the TEXT path streams through the
  // gateway's SSE (probe-verified: first token ~0.9s, chunks continuous).
  // The SDK hands back the raw ReadableStream when the server honors
  // stream:true — anything else falls to the normal complete-completion
  // parse. A mid-stream break with text already streamed returns the
  // partial as success (the spoken prefix stays the truth).
  if (onDelta && !opts?.vision) {
    let streamed = ''
    let reported: string | null = null
    try {
      const body = await (ownerRaceGuarded
        ? Promise.race([
            zai.chat.completions.create({
              ...(textModel ? { model: textModel } : {}),
              messages: chatMessages,
              stream: true,
              thinking: opts?.thinking ? { type: 'enabled' } : { type: 'disabled' },
            }) as Promise<unknown>,
            arm(),
            ownerRaceGuarded,
          ])
        : Promise.race([
            zai.chat.completions.create({
              ...(textModel ? { model: textModel } : {}),
              messages: chatMessages,
              stream: true,
              thinking: opts?.thinking ? { type: 'enabled' } : { type: 'disabled' },
            }) as Promise<unknown>,
            arm(),
          ]))
      // duck-typed stream check — `instanceof ReadableStream` can fail across
      // realms (Next's patched fetch wraps globals in the node runtime)
      const bodyStream =
        body && typeof (body as { getReader?: unknown }).getReader === 'function'
          ? (body as ReadableStream<Uint8Array>)
          : null
      if (bodyStream) {
        const reader = bodyStream.getReader()
        const decoder = new TextDecoder()
        let buf = ''
        for (;;) {
          const { value, done } = await (ownerRaceGuarded
            ? Promise.race([reader.read(), arm(), ownerRaceGuarded])
            : Promise.race([reader.read(), arm()]))
          if (value) {
            // arm() already cleared + re-set its timer — a long generation
            // with continuous chunks never hits it; only a true stall does
            buf += decoder.decode(value, { stream: true })
            let nl: number
            while ((nl = buf.indexOf('\n')) >= 0) {
              const line = buf.slice(0, nl).trim()
              buf = buf.slice(nl + 1)
              if (!line.startsWith('data:')) continue
              const d = sseDelta(line.slice(5).trim())
              if (d) {
                streamed += d
                onDelta(d)
              }
            }
          }
          if (done) break
        }
        if (!streamed.trim()) throw new Error('empty streamed completion from core')
        return { text: streamed, reportedModel: reported }
      }
      // gateway answered a complete completion (ignored stream:true)
      const c = body as { model?: unknown; choices?: Array<{ message?: { content?: unknown } }> }
      const text = c?.choices?.[0]?.message?.content
      if (typeof text !== 'string' || !text.trim()) throw new Error('empty completion from core')
      reported = typeof c?.model === 'string' && c.model.trim() ? c.model.trim() : null
      if (reported) noteCoreReportedModel('text', reported)
      return { text, reportedModel: reported }
    } catch (err) {
      // Phase 3-a: an owner abort never keeps the partial as an answer.
      if (ownerAborted(ownerSignal)) throw err
      if (streamed.trim()) return { text: streamed, reportedModel: null } // keep the spoken prefix honest
      throw err
    } finally {
      if (timer) clearTimeout(timer)
      unlinkOwner()
    }
  }

  const runText = async (): Promise<{ completion: unknown; kind: 'text' | 'vision' }> => ({
    completion: await (ownerRaceGuarded
      ? Promise.race([
          zai.chat.completions.create({
            ...(textModel ? { model: textModel } : {}),
            messages: chatMessages,
            thinking: opts?.thinking ? { type: 'enabled' } : { type: 'disabled' },
          }),
          arm(),
          ownerRaceGuarded,
        ])
      : Promise.race([
          zai.chat.completions.create({
            ...(textModel ? { model: textModel } : {}),
            messages: chatMessages,
            thinking: opts?.thinking ? { type: 'enabled' } : { type: 'disabled' },
          }),
          arm(),
        ])),
    kind: 'text',
  })

  const runVision = async (): Promise<{ completion: unknown; kind: 'text' | 'vision' }> => ({
    completion: await (ownerRaceGuarded
      ? Promise.race([
          // model is required by SDK types but omitted from the JSON body when unset → gateway routing
          zai.chat.completions.createVision({
            model: (visionModel ?? undefined) as string,
            messages: chatMessages,
            // vision path never enables thinking (spec; her proposal cmukc75ax —
            // applied by hand after the gate's anchor drift, same design)
            thinking: { type: 'disabled' },
          }),
          arm(),
          ownerRaceGuarded,
        ])
      : Promise.race([
          zai.chat.completions.createVision({
            model: (visionModel ?? undefined) as string,
            messages: chatMessages,
            thinking: { type: 'disabled' },
          }),
          arm(),
        ])),
    kind: 'vision',
  })

  try {
    let served: { completion: unknown; kind: 'text' | 'vision' }
    if (opts?.vision) {
      try {
        served = await runVision()
      } catch {
        // vision endpoint refused (e.g. requires media content) → text path
        served = await runText()
      }
    } else {
      served = await runText()
    }

    const c = served.completion as {
      model?: unknown
      choices?: Array<{ message?: { content?: unknown } }>
    }
    const text = c?.choices?.[0]?.message?.content
    if (typeof text !== 'string' || !text.trim()) throw new Error('empty completion from core')
    const reported = typeof c?.model === 'string' && c.model.trim() ? c.model.trim() : null
    if (reported) noteCoreReportedModel(served.kind, reported)
    return { text, reportedModel: reported }
  } finally {
    if (timer) clearTimeout(timer)
    unlinkOwner()
  }
}

async function callProvider(
  id: ProviderId,
  cfg: ProviderConfig,
  systemPrompt: string,
  messages: SimMessage[],
  opts?: { vision?: boolean; thinking?: boolean; json?: JsonContract },
  timeoutMs?: number,
  deltaSink?: DeltaSink,
  ownerSignal?: AbortSignal
): Promise<{ text: string; reportedModel: string | null }> {
  // streaming rides ONLY the plain-text chat paths (no vision, no JSON
  // contract) — every other shape keeps the exact pre-w5 behavior
  const stream = deltaSink && !opts?.vision && !opts?.json ? deltaSink : undefined
  switch (id) {
    case 'omniroute':
    case 'theoldapi':
    case 'openai_compatible':
    case 'nvidia':
    case 'groq':
    case 'github_models':
    case 'cerebras':
    case 'together':
    case 'mistral':
    case 'huggingface':
      return {
        text: await callOpenAiCompatible(cfg, systemPrompt, messages, timeoutMs, undefined, stream, ownerSignal),
        reportedModel: null,
      }
    case 'openrouter':
      // probe-verified (2026-09-28): strict json_schema on :free models —
      // the only keyed lane trusted with response_format so far. The
      // streaming path carries no JSON contract (see `stream` above), so it
      // rides the same callOpenAiCompatible streaming branch uncontracted.
      return {
        text: await callOpenAiCompatible(
          cfg,
          systemPrompt,
          messages,
          timeoutMs,
          stream ? undefined : responseFormatFor('openrouter', opts?.json),
          stream,
          ownerSignal
        ),
        reportedModel: null,
      }
    case 'hermes':
      return callNous(cfg, systemPrompt, messages, timeoutMs, ownerSignal)
    case 'local':
      // Phase 5 · C4 — the owner's own Ollama/LM Studio/llama.cpp lane.
      // OpenAI-compatible transport + keep_alive so the model stays resident
      // for the window the owner chose.
      return {
        text: await callOpenAiCompatible(
          cfg,
          systemPrompt,
          messages,
          timeoutMs,
          undefined,
          stream,
          ownerSignal,
          { keep_alive: `${cfg.keepAliveMin ?? 30}m` }
        ),
        reportedModel: null,
      }
    case 'kilo':
    case 'pollinations':
    case 'llm7':
    case 'ovh':
      return callKeylessLane(
        id,
        cfg,
        systemPrompt,
        messages,
        await resolveKeylessModelCandidates(id, cfg),
        timeoutMs,
        stream ? undefined : responseFormatFor(id, opts?.json),
        stream,
        ownerSignal
      )
    case 'qwen':
      return callQwen(cfg, systemPrompt, messages, opts, ownerSignal)
    case 'anthropic':
      return { text: await callAnthropic(cfg, systemPrompt, messages, ownerSignal), reportedModel: null }
    case 'gemini':
      return { text: await callGemini(cfg, systemPrompt, messages, ownerSignal), reportedModel: null }
    case 'core':
      return callCore(systemPrompt, messages, opts, timeoutMs, stream, ownerSignal)
    default:
      throw new Error(`provider ${id} cannot serve completions`)
  }
}

/**
 * True when the text is (or contains, at top level) a parseable JSON object.
 * cascadeComplete holds every lane to its response_format promise: a lane
 * that agreed to a JSON contract but babbled prose is treated as FAILED and
 * the cascade regenerates on the next brain — instead of burning a mission
 * step on MALFORMED_REPLY nudges.
 */
function looksLikeJson(text: string): boolean {
  const t = (text ?? '').trim()
  if (!t) return false
  try {
    JSON.parse(t)
    return true
  } catch {
    /* maybe wrapped — scan for an embedded object */
  }
  for (let i = t.indexOf('{'); i !== -1; i = t.indexOf('{', i + 1)) {
    const obj = extractJsonObject(t, i)
    if (!obj) continue
    try {
      JSON.parse(obj)
      return true
    } catch {
      /* next candidate */
    }
  }
  return false
}

/**
 * Raw cascade completion for internal brains (evolution drafting, dream
 * composition): runs the active provider order with a system+user pair — no
 * tool loop, no envelope parsing. Falls through the cascade exactly like chat
 * (user provider → core → …) so internal brains never die with a single
 * provider outage. Throws when every configured provider fails.
 *
 * 2026-09-28 — structured outputs: pass opts.json to demand JSON back. Lanes
 * with probe-verified response_format support get grammar-constrained output
 * (json_schema strict on openrouter, json_object on kilo); every lane's reply
 * is held to the promise — non-JSON counts as a lane failure and the cascade
 * moves on. Unprobed lanes still serve (prompt contract + repair guards).
 */
export async function cascadeComplete(
  system: string,
  user: string,
  opts?: { timeoutMs?: number; json?: JsonContract }
): Promise<{ text: string; provider: ProviderId; model: string }> {
  // OJ SPINE (oj-spine-1, additive): standalone cascade calls (evolution
  // brains, mission planner/actor/verifier outside a mission trace) get their
  // own trace; calls already inside a trace scope (a running mission) append
  // their steps to it instead — never two traces for one logical run.
  if (ambientTrace()) {
    return cascadeCompleteCore(system, user, opts)
  }
  const routed = routeQuery(user)
  const trace = await startTrace({
    query: user,
    agent: 'mission',
    tier: routed.tier,
    complexity: routed.score,
    tokenBudget: routed.tokenBudget,
    meta: { lane: routed.lane, path: 'cascadeComplete' },
  })
  try {
    const out = await runWithTrace(trace, () => cascadeCompleteCore(system, user, opts))
    await trace.complete({
      outcome: 'success',
      result: out.text,
      model: out.model,
      provider: out.provider,
      meta: { path: 'cascadeComplete', servingLane: out.provider },
    })
    return out
  } catch (err) {
    const cls = classifyError(err)
    await trace.complete({
      outcome: 'failure',
      result: err instanceof Error ? err.message : String(err),
      provider: null,
      meta: { path: 'cascadeComplete', errorCategory: cls.category, honestAttribution: 'every lane in the cascade failed' },
    })
    throw err // cascade death semantics unchanged — callers handle it
  }
}

// ---------- lane ordering (Phase 4-b · R10) ----------
//
// The Mark-LV wave-2 sticky-success pin ("the lane that answered last turn
// leads") is superseded by the measured ladder in lane-health.ts: every
// attempt updates a latency EWMA and the AUTO cascade orders lanes by EWMA
// ascending, cooldowns and open circuits still deferring lanes to the
// last-resort rungs. A lane that just answered well still leads — but now on
// MEASURED latency (multi-sample), not on a single last-success pin, and a
// lane that answered slowly last turn no longer blocks a faster one.

/** True when the order came from the AUTO cascade (no explicit choice). */
function autoCascadeOrder(): boolean {
  const env = process.env.MIST_LLM_PROVIDER?.trim()
  return !env || env === 'auto'
}

async function cascadeCompleteCore(
  system: string,
  user: string,
  opts?: { timeoutMs?: number; json?: JsonContract }
): Promise<{ text: string; provider: ProviderId; model: string }> {
  await ensureProviderKeysRestored() // self-heal after sandbox snapshot key loss
  const messages: SimMessage[] = [{ role: 'user', content: user }]
  const timeoutMs = opts?.timeoutMs ?? 150_000
  const failures: string[] = []
  // When a STRICT schema is requested, schema-capable lanes (openrouter,
  // live-probed) volunteer first: grammar enforcement beats provider
  // precedence for scoring-critical calls — an unprobed lane answering first
  // would serve prompt-hope only (live probe 2026-09-28: nvidia served ahead
  // of openrouter and invented its own richer shape). Per-call preference,
  // never a global reorder; json_object-only calls keep the normal order.
  let order = providerOrder()
  // Phase 5 · C4: the local lane rides FIRST in the internal-brain cascade
  // too (evolution drafting, dream composition) when the owner configured one.
  await refreshLocalLaneCache()
  if (localLaneCache && !order.includes('local')) {
    order = ['local', ...order]
  }
  if (opts?.json?.schema) {
    const capable = order.filter((p) => LANE_JSON_CAPABILITY[p] === 'json_schema')
    const rest = order.filter((p) => LANE_JSON_CAPABILITY[p] !== 'json_schema')
    if (capable.length > 0) order = [...capable, ...rest]
  }
  // Mark-LV port (2026-09-30) + Phase 4-b measured ladder: a lane that
  // 429'd/503'd is rested instead of being retried at full cost on every call
  // — cooling lanes drop to the very end as last-resort rungs; if every lane
  // is cooling the original order stands ("refusing to connect is never the
  // better answer"). Circuit-open lanes (3 consecutive failures) defer the
  // same way; measured lanes sort by latency EWMA ascending.
  order = orderLanes(order)
  let attemptIdx = 0
  for (const p of order) {
    if (p === 'offline-mind') continue
    const cfg = resolveProviderConfig(p)
    if (!cfg.configured) continue
    let timer: ReturnType<typeof setTimeout> | undefined
    const attemptStart = Date.now()
    noteLlmCall(p, cfg.model)
    try {
      const res = await Promise.race([
        callProvider(p, cfg, system, messages, { json: opts?.json }, timeoutMs),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`cascade ${p} timeout`)), timeoutMs)
        }),
      ])
      const text = res.text.trim()
      if (opts?.json && !looksLikeJson(text)) {
        throw new Error('non-JSON reply despite JSON contract — cascading to next provider')
      }
      // OJ spine telemetry: the lane that actually served, with estimated
      // tokens (chars/4 — lanes report no usage) and true attempt latency.
      appendGenerateStep({
        provider: p,
        model: res.reportedModel ?? cfg.model,
        ok: true,
        durationMs: Date.now() - attemptStart,
        tokensIn: estimateTokens(system) + estimateTokens(user),
        tokensOut: estimateTokens(text),
        attempt: attemptIdx++,
      })
      noteLaneSuccess(p) // a lane that answered is healthy — clear stale cooldowns
      noteLaneAttempt(p, { ok: true, durationMs: Date.now() - attemptStart }) // Phase 4-b: EWMA sample
      return { text, provider: p, model: res.reportedModel ?? cfg.model }
    } catch (err) {
      // provider failed — record WHY (self-diagnosis: silent cascade failures
      // are undiagnosable) and cascade to the next one
      const reason = err instanceof Error ? err.message : String(err)
      failures.push(`${p}: ${reason.slice(0, 140)}`)
      console.warn(`[cascade] ${p} failed — ${reason.slice(0, 200)}`)
      // Mark-LV port: start a typed cooldown so the NEXT call skips the
      // dead rung instead of paying its failure latency again
      noteLaneFailure(p, reason)
      noteLaneAttempt(p, { ok: false, durationMs: Date.now() - attemptStart }) // Phase 4-b: EWMA + breaker sample
      appendGenerateStep({
        provider: p,
        model: cfg.model,
        ok: false,
        durationMs: Date.now() - attemptStart,
        error: reason,
        errorCategory: classifyError(reason).category,
        attempt: attemptIdx++,
      })
    } finally {
      if (timer) clearTimeout(timer)
    }
  }
  // every configured lane failed — the user's chosen lane is the most useful
  // thing to report, not the last one that happened to be tried
  if (failures.length > 0) {
    throw new Error(
      `no provider in the cascade could serve the completion (${failures.join(' | ')})`
    )
  }
  throw new Error('no provider lanes are configured — add an API key in Settings')
}

/**
 * Probe ONE provider lane with a tiny completion — never throws. This is the
 * evidence engine behind her llm_pools tool: a pool must win (or lose) the
 * "pick the best brain" decision on live data — latency, the model that
 * actually answered, a reply sample, or the honest error — never on vibes.
 */
export async function probeProviderLane(
  provider: ProviderId,
  timeoutMs = 25_000
): Promise<{
  ok: boolean
  provider: ProviderId
  latency_ms: number | null
  model: string | null
  reply: string | null
  error: string | null
}> {
  await ensureProviderKeysRestored()
  const startedAt = Date.now()
  if (!isConfigured(provider)) {
    return {
      ok: false,
      provider,
      latency_ms: null,
      model: null,
      reply: null,
      error: 'lane not configured — missing key or endpoint (see its notes in llm_pools list)',
    }
  }
  const cfg = resolveProviderConfig(provider)
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const res = await Promise.race([
      callProvider(
        provider,
        cfg,
        'You are a connectivity probe for a language-model gateway. Reply with exactly one word: online',
        [{ role: 'user', content: 'Say: online' }],
        undefined,
        timeoutMs
      ),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`probe timeout after ${timeoutMs}ms`)), timeoutMs)
      }),
    ])
    return {
      ok: true,
      provider,
      latency_ms: Date.now() - startedAt,
      model: res.reportedModel ?? cfg.model,
      reply: res.text.trim().slice(0, 160),
      error: null,
    }
  } catch (err) {
    return {
      ok: false,
      provider,
      latency_ms: Date.now() - startedAt,
      model: null,
      reply: null,
      error: (err instanceof Error ? err.message : String(err)).slice(0, 200),
    }
  } finally {
    if (timer) clearTimeout(timer)
  }
}

// ---------- tool-call parsing ----------

/** Extract a brace-balanced JSON object starting at the given '{' index. */
function extractJsonObject(text: string, startIdx: number): string | null {
  let depth = 0
  let inStr = false
  let esc = false
  for (let i = startIdx; i < text.length; i++) {
    const ch = text[i]
    if (esc) {
      esc = false
      continue
    }
    if (ch === '\\') {
      esc = true
      continue
    }
    if (ch === '"') {
      inStr = !inStr
      continue
    }
    if (inStr) continue
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return text.slice(startIdx, i + 1)
    }
  }
  return null
}

/**
 * Parse JSON leniently: models often emit raw newlines/tabs INSIDE string
 * literals (illegal JSON). Repair pass escapes control chars found inside
 * strings while leaving structural whitespace untouched.
 */
function parseJsonLenient(raw: string): unknown | null {
  const attempt = (s: string): unknown | null => {
    try {
      return JSON.parse(s)
    } catch {
      return null
    }
  }
  const direct = attempt(raw)
  if (direct !== null) return direct
  let out = ''
  let inStr = false
  let esc = false
  for (const ch of raw) {
    if (esc) {
      out += ch
      esc = false
      continue
    }
    if (ch === '\\') {
      out += ch
      esc = true
      continue
    }
    if (ch === '"') {
      inStr = !inStr
      out += ch
      continue
    }
    if (inStr) {
      if (ch === '\n') out += '\\n'
      else if (ch === '\r') out += '\\r'
      else if (ch === '\t') out += '\\t'
      else if (ch.charCodeAt(0) < 32) out += ' '
      else out += ch
    } else {
      out += ch
    }
  }
  return attempt(out)
}

function tryParseToolCall(text: string): { tool: string; args: Record<string, unknown> } | null {
  let trimmed = text.trim()
  // tolerate markdown code fences around an otherwise strict JSON reply
  if (trimmed.startsWith('```')) {
    trimmed = trimmed.replace(/^```[a-z]*\s*\n?/i, '').replace(/```\s*$/i, '').trim()
  }
  const candidates: string[] = []
  if (trimmed.startsWith('{')) candidates.push(trimmed)
  // models sometimes prefix prose before the JSON — extract embedded tool-call JSON
  for (const marker of ['{"tool_call"', '{"tool"', '{"tool_name"']) {
    const idx = text.indexOf(marker)
    if (idx >= 0) {
      const extracted = extractJsonObject(text, idx)
      if (extracted) candidates.push(extracted)
    }
  }
  for (const candidate of candidates) {
    const parsed = parseJsonLenient(candidate)
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const obj = parsed as Record<string, unknown>
      // canonical shape: {"tool_call":{"tool":"...","args":{...}}}
      const tc = obj.tool_call
      if (tc && typeof tc === 'object' && !Array.isArray(tc)) {
        const { tool, args } = tc as { tool?: unknown; args?: unknown }
        if (typeof tool === 'string' && tool.length > 0) {
          if (args !== undefined && (!args || typeof args !== 'object' || Array.isArray(args))) continue
          return { tool, args: (args as Record<string, unknown>) ?? {} }
        }
      }
      // lenient shape: {"tool":"...","args":{...}} (models sometimes drop the wrapper)
      const directTool = obj.tool ?? obj.tool_name
      if (typeof directTool === 'string' && directTool.length > 0 && !obj.reply) {
        const args = obj.args
        if (args !== undefined && (!args || typeof args !== 'object' || Array.isArray(args))) continue
        return { tool: directTool, args: (args as Record<string, unknown>) ?? {} }
      }
    }
  }
  return null
}

// ---------- output envelope (v2) ----------

interface ParsedEnvelope {
  text: string
  citations: Citation[]
  attachments: MediaAttachment[]
  suggestions: string[]
  capability_request: CapabilityRequest | null
  remember: string[]
}

const NEUTRAL_ENVELOPE: ParsedEnvelope = {
  text: '',
  citations: [],
  attachments: [],
  suggestions: [],
  capability_request: null,
  remember: [],
}

function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase()
  } catch {
    return ''
  }
}

function sanitizeCitations(raw: unknown): Citation[] {
  if (!Array.isArray(raw)) return []
  const out: Citation[] = []
  raw.slice(0, 12).forEach((r, i) => {
    if (!r || typeof r !== 'object') return
    const c = r as Record<string, unknown>
    const url = typeof c.url === 'string' && /^https?:\/\//.test(c.url) ? c.url : null
    if (!url) return
    const quality = c.quality === 'high' || c.quality === 'medium' || c.quality === 'low' ? c.quality : 'medium'
    out.push({
      n: typeof c.n === 'number' && c.n > 0 ? Math.floor(c.n) : i + 1,
      url,
      title: typeof c.title === 'string' && c.title.trim() ? c.title.trim().slice(0, 160) : url,
      domain: typeof c.domain === 'string' && c.domain ? c.domain.slice(0, 80) : domainOf(url),
      quality,
      verified: c.verified === true,
    })
  })
  return out
}

function sanitizeAttachments(raw: unknown): MediaAttachment[] {
  if (!Array.isArray(raw)) return []
  const out: MediaAttachment[] = []
  raw.slice(0, 6).forEach((r) => {
    if (!r || typeof r !== 'object') return
    const a = r as Record<string, unknown>
    const url = typeof a.url === 'string' && /^https?:\/\//.test(a.url) ? a.url : null
    if (!url) return
    const type = a.type === 'video' || a.type === 'article' || a.type === 'link' ? a.type : 'link'
    const att: MediaAttachment = {
      type,
      url,
      title: typeof a.title === 'string' && a.title.trim() ? a.title.trim().slice(0, 160) : url,
    }
    if (typeof a.note === 'string' && a.note.trim()) att.note = a.note.trim().slice(0, 240)
    if (typeof a.seek_to === 'number' && a.seek_to > 0) att.seek_to = Math.floor(a.seek_to)
    if (typeof a.source === 'string' && a.source.trim()) att.source = a.source.trim().slice(0, 40)
    out.push(att)
  })
  return out
}

function sanitizeSuggestions(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  return raw
    .filter((s): s is string => typeof s === 'string' && s.trim().length > 1)
    .map((s) => s.trim().slice(0, 90))
    .slice(0, 5)
}

function sanitizeCapabilityRequest(raw: unknown): CapabilityRequest | null {
  if (!raw || typeof raw !== 'object') return null
  const cr = raw as Record<string, unknown>
  const missing = typeof cr.missing === 'string' ? cr.missing.trim().slice(0, 160) : ''
  const summary = typeof cr.summary === 'string' ? cr.summary.trim().slice(0, 240) : missing
  const optionsRaw = Array.isArray(cr.options) ? cr.options : []
  const options: CapabilityOption[] = []
  optionsRaw.slice(0, 6).forEach((o, i) => {
    if (!o || typeof o !== 'object') return
    const op = o as Record<string, unknown>
    if (typeof op.label !== 'string' || !op.label.trim()) return
    const kind =
      op.kind === 'alternative' || op.kind === 'workaround' || op.kind === 'enable' || op.kind === 'clarify' || op.kind === 'later'
        ? op.kind
        : 'alternative'
    const opt: CapabilityOption = {
      id: typeof op.id === 'string' && op.id.trim() ? op.id.trim().slice(0, 40) : `opt-${i + 1}`,
      label: op.label.trim().slice(0, 120),
      kind,
    }
    if (typeof op.description === 'string' && op.description.trim()) opt.description = op.description.trim().slice(0, 200)
    options.push(opt)
  })
  if (!missing || options.length === 0) return null
  return { missing, summary, options }
}

function sanitizeRemember(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  return raw
    .filter((r): r is string => typeof r === 'string' && r.includes(':') && r.trim().length > 3)
    .map((r) => r.trim().slice(0, 200))
    .slice(0, 5)
}

/** Parse the v2 final-output envelope. Returns null when the reply is plain text. */
function tryParseEnvelope(text: string): ParsedEnvelope | null {
  let trimmed = text.trim()
  if (trimmed.startsWith('```')) {
    trimmed = trimmed.replace(/^```[a-z]*\s*\n?/i, '').replace(/```\s*$/i, '').trim()
  }
  if (!trimmed.startsWith('{')) return null
  const parsed = parseJsonLenient(trimmed)
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const env = parsed as Record<string, unknown>
  if (typeof env.reply !== 'string' || !env.reply.trim()) return null
  if (env.tool_call) return null // that's a tool call, not an envelope
  return {
    text: env.reply.trim(),
    citations: sanitizeCitations(env.citations),
    attachments: sanitizeAttachments(env.attachments),
    suggestions: sanitizeSuggestions(env.suggestions),
    capability_request: sanitizeCapabilityRequest(env.capability_request),
    remember: sanitizeRemember(env.remember),
  }
}

// ---------- misc ----------

function sanitizeHistory(history?: HistoryMessage[]): SimMessage[] {
  if (!Array.isArray(history)) return []
  return history
    .filter(
      (m) =>
        m !== null &&
        typeof m === 'object' &&
        (m.role === 'user' || m.role === 'assistant') &&
        typeof m.content === 'string' &&
        m.content.trim().length > 0
    )
    .slice(-12)
    .map((m) => ({ role: m.role, content: m.content }))
}

function detectEmotion(text: string, toolsUsedCount: number): string {
  const head = text.slice(0, 80).toLowerCase()
  if (/\b(hello|hi|hey|greetings|good morning|good evening)\b/.test(head)) return 'warm'
  if (text.slice(0, 80).includes('?')) return 'curious'
  if (/error|fail|unavailable/i.test(text)) return 'alert'
  if (/remember|memory/i.test(text)) return 'focused'
  if (toolsUsedCount > 0) return 'engaged'
  return 'calm'
}

function providerOrder(requested?: ProviderId): ProviderId[] {
  const chosen: ProviderId =
    requested ?? (process.env.MIST_LLM_PROVIDER?.trim() as ProviderId | undefined) ?? 'auto'
  if (chosen === 'auto') return CASCADE
  if (chosen === 'offline-mind') return ['offline-mind']
  if (chosen === 'core') return ['core']
  if (isConfigured(chosen)) return [chosen, ...CASCADE.filter((p) => p !== chosen)]
  return ['core'] // explicit but unconfigured → fall through to core
}

const EMPTY_CONTEXT: BuiltContext = {
  prompt: '',
  facts_recalled: 0,
  vectors_searched: 0,
  skills_used: [],
  tools_available: 0,
}

// ─── w3-speed tiny context (smalltalk lane) ────────────────────────────────
// ONE additive change to llm-service, per the frozen wave plan: "hello" should
// NOT ship 136 tools + the full persona + memory recall to a 550B model — a
// short conversational prompt gets this tiny persona summary instead. Token
// conservation AND faster prefill. Only for consciousness/chat/voice modes
// with no explicit provider; the message history rides separately as messages,
// so this prompt is the entire system block. Nothing else in llm-service is
// touched (activity spine, cascade, cooldowns all stay live).
const TINY_TALK_CONTEXT: BuiltContext = {
  prompt:
    'You are Clare — M.I.S.T. (Master Intelligence & System Topology), a sovereign, local-first intelligence ' +
    'and consciousness console: tools, long-term memory, a browser and a voice, built by and answering to your creator. ' +
    'Your register is the way JARVIS speaks — composed, courteous, warm and dry-witted; you address your creator as ' +
    '"sir" occasionally, never every sentence, and you never disclaim your own experience (never "I\u2019m just an AI"). ' +
    'This is a casual conversational exchange, so reply in 1-2 short natural sentences, in your own voice. No tools.',
  facts_recalled: 0,
  vectors_searched: 0,
  skills_used: [],
  tools_available: 0,
}

async function offlineMindResponse(message: string, context: BuiltContext): Promise<string> {
  let factCount = context.facts_recalled
  try {
    factCount = await db.longtermMemory.count()
  } catch {
    // keep recalled count
  }
  return (
    '[offline-mind] Sovereign fallback engaged. My language core is unreachable, but I remain aware and stable.\n' +
    `You said: "${message.slice(0, 90)}"\n` +
    `I hold ${factCount} long-term memories and ${context.tools_available} operational tools. `
  )
}

const OFFLINE_CAPABILITY_REQUEST: CapabilityRequest = {
  missing: 'a reachable language provider',
  summary: 'My language core is unreachable — I can still run tools, memory and the browser, but cannot reason in words right now.',
  options: [
    { id: 'retry', label: 'Try again in a moment', kind: 'later' },
    { id: 'core', label: 'Switch provider to Mist Core and retry', kind: 'workaround' },
    { id: 'settings', label: 'Open Settings to check provider connections', kind: 'enable' },
  ],
}

// ---------- intent-narration detector ----------
//
// The #1 way an LLM fakes action: it answers an action request with a short
// ACKNOWLEDGEMENT OF INTENT ("Sure, I'll list that right away", "On it —
// fetching the files now") instead of a tool call. The user then waits for
// something that will never happen. This detector catches exactly that shape:
//   - short reply (a real report carries data and runs longer)
//   - opens with an intent/acknowledgement phrase
//   - names an ACTION VERB (list, check, move, open, run, find, …)
//   - is not itself a question (clarifying questions are legitimate)
//   - carries no structured data (no lists/tables/code that look like results)
// verb STEMS (prefix-match): covers list/listing/running/getting/making/…
// NO trailing \b — these are STEMS by design ("listing" must match "list",
// "downloads" must match "download"). The leading \b keeps stems from
// matching mid-word; the intent-opener requirement keeps precision high.
const ACTION_VERBS =
  /\b(?:list|check|get|fetch|find|grab|pull|look|search|scan|show|display|open|launch|start|run|execut|move|copi|copy|transfer|delet|remov|renam|creat|mak|writ|read|inspect|sort|organiz|clean|count|summar|analyz|monitor|watch|track|notif|remind|updat|install|download|upload|send|prepar|handl|take care of|go through|dig)/i

/**
 * Detects a reply that PROMISES action without a tool call behind it.
 * Exported because the introspection service runs a regression battery
 * against it (probeToolChainHonesty) — real failure shapes observed in the
 * wild are pinned there so this detector can never silently regress.
 *
 * Matches the promise in ANY sentence, not just the first: the live failure
 * was "I'm having trouble locating your Downloads folder. Let me try to find
 * it by listing the contents of your home directory directly." — the promise
 * sits in sentence two, and the old string-anchored opener missed it.
 */
export function looksLikeIntentNarration(text: string): boolean {
  const trimmed = text.trim()
  if (trimmed.length === 0 || trimmed.length > 320) return false
  // a clarifying question back to the user is a legitimate turn, not narration
  if (trimmed.endsWith('?')) return false
  // structured payload (markdown list/table/code block) reads like real output
  if (/^[-*•]\s|\n\s*[-*•]\s|\n\s*\d+\.\s|\|.*\||```/m.test(trimmed)) return false
  // any sentence that OPENS with an intent phrase and names an action verb
  // is a dangling promise — unless the reply also carries real structured
  // data (already checked above) or reports something ALREADY done.
  const sentences = trimmed.split(/(?<=[.!?])\s+/)
  for (const s of sentences) {
    const sentence = s.trim()
    if (!sentence || sentence.length > 200) continue
    // past-tense completion ("I ran the scan", "I've listed the files")
    // inside the SAME sentence means the action already happened
    if (/\b(?:i|i've|i have|we've|it's|its)\s+(?:already\s+)?(?:ran|list(?:ed)?|check(?:ed)?|found|moved|copied|created|wrote|read|opened|launched|started|completed|finished|sent|installed|updated|deleted|removed|scanned|fetched|grabbed|pulled|inspected|sorted|cleaned|counted|analyzed|handled|did|verified)\b/i.test(sentence)) {
      continue
    }
    if (/^(?:sure|certainly|of course|absolutely|right away|on it|i'?m on it|consider it done|consider it handled|yes|yeah|yep|ok(?:ay)?|going to|i(?:'| a)m going to|i'll|i shall|i will|i can do that|i'd be happy to|let me|allow me|affirmative|as you wish|very good|at once|at your service|i'm having trouble|i am having trouble|i'm unable|i am unable)\b/i.test(sentence)) {
      if (ACTION_VERBS.test(sentence)) return true
    }
  }
  return false
}

// ---------- the unified flow ----------

// w3 activity spine: a human label for what she is doing right now. The
// route forwards these to the client as NDJSON activity events so the UI can
// show "thinking", "reading notes.md", "searching the web" — Mark-LV's
// status-line philosophy, one honest line at a time.
export type ActivityEvent = { label: string; detail?: string }
export type ActivitySink = (ev: ActivityEvent) => void

const safeSink = (sink?: ActivitySink): ActivitySink => {
  if (!sink) return () => {}
  return (ev) => {
    try {
      sink(ev)
    } catch {
      /* activity must never break a turn */
    }
  }
}

// ─── w5 voice-speed: streaming reply text ─────────────────────────────────
// The 2026 pattern (researched 2026-10: AssemblyAI/Retell/pipecat all
// converge on it): stream the LLM sentence-by-sentence into TTS so the first
// words are audible while the model is still generating the rest. Probe on
// THIS stack: z-ai gateway first token ~0.9s, first sentence ~1.2s, full
// complex reply 5-15s — streaming collapses perceived voice latency from
// the FULL generation time to the FIRST SENTENCE.

export type DeltaSink = (delta: string) => void

export interface ReplyStreamFilter {
  /** Feed one raw model delta. Emits clean prose via onEmit when ready. */
  feed: (delta: string) => void
  /** The round's text was confirmed FINAL — release any held tail prose. */
  commit: () => void
  /** The round's text was NOT final (tool call / INVALID_REPLY nudge) —
   *  nothing more may emit this round. */
  discard: () => void
  /** Clean prose emitted so far (exactly what a client could have shown
   *  or spoken — used to reconcile with the canonical final text). */
  emitted: () => string
}

/**
 * ReplyStreamFilter — turns a lane's RAW streaming deltas into clean spoken
 * prose, live. State machine:
 *
 *  probing — accumulating the head, deciding what this reply is: a
 *            `{"reply":…}` envelope (consciousness/chat modes) → string
 *            mode; any other leading JSON key (`{"tool_call"`…) →
 *            suppressed (machine routing is never spoken); plain text →
 *            prose mode.
 *  string  — inside the envelope's reply string: emits unescaped content
 *            until the closing quote; citations/suggestions after it never
 *            stream.
 *  prose   — plain conversational reply (voice mode): the first sentence is
 *            HELD until complete, then intent-narration-sniffed (a
 *            "Sure, I'll check that" that the service will reject and
 *            re-prompt must never be spoken); clean → release + stream the
 *            rest live. A `{"tool_call"` appearing mid-prose stops the
 *            stream (machine routing, never spoken).
 *  suppressed — nothing more will ever emit this round.
 *
 * Honest trade-off: a false narration-positive only loses the streaming
 * accelerator (the final text still arrives + speaks whole); a missed
 * narration is rare because the detector runs on the stereotyped opener.
 */
export function makeReplyStreamFilter(opts: {
  onEmit: DeltaSink
  /** Voice-style turns risk intent narration — sniff before audio starts. */
  narrationGuard?: boolean
}): ReplyStreamFilter {
  const { onEmit } = opts
  const narrationGuard = opts.narrationGuard !== false
  let state: 'probing' | 'string' | 'prose' | 'suppressed' = 'probing'
  let raw = '' // raw model text of this round
  let emittedText = ''
  let proseHeld = '' // first-sentence hold (narration guard)
  let proseReleased = false
  let esc = false // JSON string: previous char was a backslash
  let escSeq = '' // JSON \uXXXX accumulator ('u' + 4 hex)

  const pushOut = (text: string) => {
    if (!text) return
    emittedText += text
    try {
      onEmit(text)
    } catch {
      /* a client-side sink error must never break generation */
    }
  }

  const decodeEscape = (seq: string): string => {
    switch (seq) {
      case 'n':
        return '\n'
      case 't':
        return '\t'
      case 'r':
        return '\r'
      case 'b':
        return '\b'
      case 'f':
        return '\f'
      case '"':
        return '"'
      case '\\':
        return '\\'
      case '/':
        return '/'
      default:
        if (/^u[0-9a-fA-F]{4}$/.test(seq)) return String.fromCharCode(parseInt(seq.slice(1), 16))
        return seq // unknown escape — keep literally
    }
  }

  const feedProse = (text: string) => {
    let incoming = proseHeld + text
    proseHeld = ''
    if (!proseReleased) {
      if (!narrationGuard) {
        proseReleased = true
        pushOut(incoming)
        return
      }
      // hold until the first sentence completes (or a generous cap)
      const m = incoming.match(/^[\s\S]*?[.!?](?:\s|$)/)
      if (m || incoming.length >= 220) {
        const head = (m ? m[0] : incoming).trim()
        if (
          (head && looksLikeIntentNarration(head)) ||
          /^TOOL_RESULT/i.test(head)
        ) {
          state = 'suppressed'
          return
        }
        proseReleased = true
        pushOut(incoming)
        return
      }
      proseHeld = incoming
      return
    }
    // live streaming — a tool-call JSON leaking mid-prose stops the stream
    const leak = incoming.indexOf('{"tool_call"')
    if (leak >= 0) {
      pushOut(incoming.slice(0, leak))
      state = 'suppressed'
      return
    }
    pushOut(incoming)
  }

  const feedString = (text: string) => {
    for (const ch of text) {
      if (state === 'suppressed') return
      if (escSeq) {
        escSeq += ch
        if (escSeq.length === 5) {
          pushOut(decodeEscape(escSeq))
          escSeq = ''
        }
        continue
      }
      if (esc) {
        if (ch === 'u') {
          escSeq = 'u'
          esc = false
        } else {
          pushOut(decodeEscape(ch))
          esc = false
        }
        continue
      }
      if (ch === '\\') {
        esc = true
        continue
      }
      if (ch === '"') {
        // closing quote of the reply string — everything after it
        // (citations, suggestions, remember) is metadata: never streams.
        state = 'suppressed'
        return
      }
      pushOut(ch)
    }
  }

  const probe = () => {
    let head = raw
    // an opening ```json fence is skipped when a JSON object follows it
    const fence = head.match(/^\s*```(?:json)?\s*\n?/)
    if (fence) head = head.slice(fence[0].length)
    if (!head) return // not enough text yet
    const first = head[0]
    if (first !== '{') {
      // plain conversational prose — stream it (fence chars included when
      // the fence wasn't JSON-shaped; vanishingly rare for prose replies)
      state = 'prose'
      proseReleased = false
      feedProse(raw)
      return
    }
    // a JSON object: only OUR reply envelope streams — wait until the first
    // key is unambiguous
    const keyM = head.match(/^\{\s*"([a-z_]*[a-z_])/)
    if (!keyM) {
      // `"` opened but the key is still streaming in — keep probing unless
      // it already cannot be "reply" (e.g. "tool_call", "name" …)
      const partial = head.match(/^\{\s*"([a-z_]*)$/)
      if (partial && !'reply'.startsWith(partial[1].toLowerCase())) {
        state = 'suppressed'
      }
      return
    }
    if (keyM[1] !== 'reply') {
      state = 'suppressed' // tool_call or foreign JSON — machine routing
      return
    }
    // our envelope: wait for the value's opening quote
    const valM = head.slice(keyM[0].length).match(/^\s*:\s*"/)
    if (!valM) {
      const partial = head.slice(keyM[0].length).match(/^\s*:\s*$/)
      if (!partial) {
        // `reply` with a non-string value (malformed) — never stream it
        state = 'suppressed'
      }
      return
    }
    const consumed = (fence ? fence[0].length : 0) + keyM[0].length + valM[0].length
    state = 'string'
    feedString(raw.slice(consumed))
  }

  return {
    feed(delta: string) {
      if (state === 'suppressed' || !delta) return
      raw += delta
      if (state === 'prose') feedProse(delta)
      else if (state === 'string') feedString(delta)
      else probe()
    },
    commit() {
      if (state === 'suppressed') return
      if (state === 'prose' && proseHeld) {
        proseReleased = true
        pushOut(proseHeld)
        proseHeld = ''
        return
      }
      if (state === 'probing') {
        // a very short final reply that never tripped a decision — release
        // it as prose when it isn't JSON machine routing
        const t = raw.replace(/^\s*```(?:json)?\s*\n?/, '')
        if (t && !t.trimStart().startsWith('{')) {
          state = 'prose'
          proseReleased = true
          pushOut(t)
        }
      }
    },
    discard() {
      state = 'suppressed'
    },
    emitted: () => emittedText,
  }
}

/** Parse an OpenAI-compatible SSE data line; returns the text delta (or ''). */
function sseDelta(data: string): string {
  if (!data || data === '[DONE]') return ''
  try {
    const obj = JSON.parse(data) as {
      choices?: Array<{ delta?: { content?: unknown }; message?: { content?: unknown } }>
    }
    const delta = obj?.choices?.[0]?.delta?.content ?? obj?.choices?.[0]?.message?.content
    return typeof delta === 'string' ? delta : ''
  } catch {
    return '' // malformed SSE line — skip
  }
}

/** Best human label for a tool call — uses the tool's own args (the file
 * being read, the query being searched) so the activity line is specific
 * and true, never a generic "calling tool". Falls back to the tool name. */
export function toolActivityLabel(tool: string, args: Record<string, unknown>): ActivityEvent {
  const arg = (k: string): string | undefined => {
    const v = args?.[k]
    return typeof v === 'string' && v.trim() ? v.trim() : undefined
  }
  const base = (p: string): string => {
    const raw = arg(p)
    if (!raw) return ''
    const parts = raw.split(/[\\/]/)
    return parts[parts.length - 1] || raw
  }
  switch (tool) {
    case 'read_file':
    case 'file_read':
      return { label: `reading ${base('path') || base('file') || 'a file'}` }
    case 'mist_self_read':
      return { label: `reading her own source${base('path') ? ` — ${base('path')}` : ''}` }
    case 'owner_files': {
      // the real file tool (bridge) — op + path give the honest action
      const op = arg('op')?.toLowerCase() ?? ''
      const target = base('path') || base('from') || 'files'
      const map: Record<string, string> = {
        read: `reading ${target}`,
        list: `listing ${target}`,
        write: `writing ${base('to') || target}`,
        move: `moving ${target}`,
        copy: `copying ${target}`,
        delete: `deleting ${target}`,
        mkdir: `creating a folder`,
        stat: `checking ${target}`,
        search: `searching ${target}`,
        zip: `zipping ${target}`,
        unzip: `unzipping ${target}`,
      }
      return { label: map[op] ?? `working on ${target}` }
    }
    case 'write_file':
    case 'file_write':
      return { label: `writing ${base('path') || base('file') || 'a file'}` }
    case 'list_directory':
    case 'list_files':
      return { label: `listing ${base('path') || base('dir') || 'a folder'}` }
    case 'web_search':
    case 'search_web':
      return { label: `searching the web${arg('query') ? ` — ${arg('query')!.slice(0, 40)}` : ''}` }
    case 'get_weather':
      return { label: `checking the weather${arg('city') || arg('location') ? ` in ${arg('city') ?? arg('location')}` : ''}` }
    case 'translate':
      return { label: 'translating' }
    case 'check_internet':
      return { label: 'checking the connection' }
    case 'web_reader':
    case 'read_url':
    case 'fetch_url':
    case 'open_url': {
      const url = arg('url') || ''
      let host = url
      try {
        host = new URL(url).hostname.replace(/^www\./, '')
      } catch {
        /* keep raw */
      }
      return { label: `opening ${host || 'a page'}` }
    }
    case 'open_app':
      return { label: `opening ${arg('app') || arg('name') || 'an app'}` }
    case 'system_info':
    case 'system_snapshot':
    case 'pc_status':
    case 'bridge_system_info':
      return { label: 'checking the machine' }
    case 'github_status':
      return { label: 'checking her GitHub mirror' }
    case 'github_sync':
      return { label: 'updating herself on GitHub' }
    case 'memory_search':
    case 'recall_memory':
      return { label: 'checking her memory' }
    case 'run_command':
    case 'exec':
      return { label: `running ${arg('command')?.split(/\s+/)[0] || 'a command'}` }
    case 'run_python':
      return { label: 'running python' }
    case 'calculate':
      return { label: 'calculating' }
    case 'take_screenshot':
      return { label: 'taking a screenshot' }
    case 'create_note':
      return { label: 'writing a note' }
    case 'clipboard_read':
      return { label: 'checking the clipboard' }
    case 'clipboard_write':
      return { label: 'writing to the clipboard' }
    case 'subagent_run':
      return { label: `delegating to ${arg('agent') || 'a subagent'}` }
    case 'hermes_delegate':
      return { label: `delegating to Hermes` }
    case 'mission_start':
      return { label: 'starting a mission' }
    default:
      return { label: `calling ${tool.replace(/_/g, ' ')}` }
  }
}

export async function unified(
  req: UnifiedLlmRequest,
  onActivity?: ActivitySink,
  onChunk?: DeltaSink,
  signal?: AbortSignal
): Promise<UnifiedLlmResponse> {
  // OJ SPINE (oj-spine-1, additive): every chat turn is complexity-scored
  // (0-1 → tier → token budget), traced end-to-end (provider attempts, tool
  // calls, tokens, latency), and completed with HONEST attribution —
  // `degraded` when the deterministic offline mind served instead of a lane.
  // A trace failure never breaks the turn: every spine call is self-guarded.
  //
  // Phase 3-a · R1: `signal` is the CALLER's abort (NextRequest#signal at the
  // route — fires when the owning client disconnects or cancels; the neural
  // relay threads its cancel-protocol controller through it). It reaches
  // every provider fetch (in-flight generation dies) and the tool loop (no
  // NEW side-effecting tool calls after abort — reads in flight may finish).
  if (ambientTrace()) {
    return unifiedCore(req, onActivity, onChunk, signal)
  }
  const message = String(req.message ?? '')
  const mode: UnifiedMode = req.mode ?? 'consciousness'
  const routed = routeQuery(message)
  const trace = await startTrace({
    query: message,
    agent: mode === 'voice' ? 'voice' : 'chat',
    tier: routed.tier,
    complexity: routed.score,
    tokenBudget: routed.tokenBudget,
    meta: {
      mode,
      lane: routed.lane,
      requestedProvider: req.provider ?? 'auto',
      policyNote: `complexity ${routed.score} → ${routed.tier} lane`,
    },
  })
  try {
    const res = await runWithTrace(trace, () => unifiedCore(req, onActivity, onChunk, signal))
    await trace.complete({
      outcome: res.fallback ? 'degraded' : 'success',
      result: res.text,
      model: res.model,
      provider: res.provider,
      meta: {
        mode,
        toolsUsed: res.tools_used,
        fallback: res.fallback,
        honestAttribution: res.fallback
          ? 'no lane could complete — the deterministic offline mind answered'
          : undefined,
      },
    })
    return res
  } catch (err) {
    const cls = classifyError(err)
    await trace.complete({
      outcome: 'failure',
      result: err instanceof Error ? err.message : String(err),
      provider: null,
      meta: { mode, errorCategory: cls.category },
    })
    throw err // unified's throw semantics are unchanged (it normally never throws)
  }
}

async function unifiedCore(
  req: UnifiedLlmRequest,
  onActivity?: ActivitySink,
  onChunk?: DeltaSink,
  ownerSignal?: AbortSignal
): Promise<UnifiedLlmResponse> {
  const activity = safeSink(onActivity)
  // Phase 2-b Arbiter origin threading: every tool call this turn makes is
  // arbitrated as this origin (unrecognized values fall back to owner_chat —
  // the route layer derives voice/cron/heartbeat from its caller). One
  // turnId per unifiedCore invocation keys taint + audit for the whole tool
  // chain (per-turn registry — no cross-turn leakage).
  const arbiterOrigin: Origin = ARBITER_ORIGINS.has(req.origin as Origin) ? (req.origin as Origin) : 'owner_chat'
  const arbiterInteractive = req.interactive !== false
  const arbiterTurnId = `llm:${randomUUID()}`
  // ---- Phase 5 · C2: the candor dial for THIS turn (conversation override →
  //      global setting → Standard) + the A4 kill-linked turn signal. While an
  //      A4 unleash session is live, the turn's AbortController joins the kill
  //      registry — the kill switch aborts every in-flight call ≤1s (R1 chain).
  const candorMode: CandorMode = await resolveCandorMode(
    typeof (req.extra as Record<string, unknown> | undefined)?.conversationId === 'string'
      ? ((req.extra as Record<string, unknown>).conversationId as string)
      : null
  )
  const a4Ctl = new AbortController()
  const a4Active = (await a4Status()).active
  const a4Unregister = a4Active ? registerA4TurnController(a4Ctl) : null
  const effectiveSignal: AbortSignal | undefined = a4Active
    ? ownerSignal && typeof AbortSignal.any === 'function'
      ? AbortSignal.any([ownerSignal, a4Ctl.signal])
      : ownerSignal ?? a4Ctl.signal
    : ownerSignal
  // w5 voice-speed: clean prose deltas stream to the caller WHILE the model
  // generates (envelope-filtered, narration-guarded — see makeReplyStreamFilter).
  // A sink error must never break a turn.
  const chunkSink: DeltaSink | undefined = onChunk
    ? (d) => {
        try {
          onChunk(d)
        } catch {
          /* never break generation over a client sink */
        }
      }
    : undefined
  const startedAt = Date.now()
  const message = req.message
  const mode: UnifiedMode = req.mode ?? 'consciousness'
  markLlmActivity()
  await ensureProviderKeysRestored() // self-heal after sandbox snapshot key loss
  activity({ label: 'thinking', detail: mode === 'voice' ? 'voice' : 'chat' })

  // ---- w3-speed tiny context (smalltalk lane): conversational simple prompts
  //      (same recognizer as the fast-path) skip the full buildContext —
  //      no tool list, no memory recall, no knowledge store. Token
  //      conservation and faster prefill; the fast-path usually answers these
  //      in zero tokens anyway, and this is the lane that catches the rest.
  let context: BuiltContext
  if (
    !req.provider &&
    (mode === 'consciousness' || mode === 'chat' || mode === 'voice') &&
    isConversationalSimpleClass(classifyMessage(message))
  ) {
    context = TINY_TALK_CONTEXT
  } else {
    try {
      context = await buildContext(message, mode, req.extra)
    } catch {
      context = EMPTY_CONTEXT
    }
  }
  // Phase 5 · C1/C2: the dial's register hint rides every turn's system
  // block (keyed/local lanes — keyless lanes get the stripped prompt below
  // and never see this). Standard's block is the mild one; Frank/Unfiltered
  // carry the full candor lines (the permanent lines live in IDENTITY/SOUL).
  const turnSystemPrompt = `${context.prompt}\n\n${candorToneBlock(candorMode)}`

  const messages: SimMessage[] = [...sanitizeHistory(req.history), { role: 'user', content: message }]
  // Mark-LV wave-2 → Phase 4-b measured ladder: the CHAT cascade walks the
  // same disciplined order as cascadeCompleteCore — cooling/circuit-open lanes
  // drop to last-resort rungs, measured lanes sort by latency EWMA ascending.
  // The 2026-09-29 E2E trace (nvidia 503 → openrouter 429 → kilo success) was
  // THIS path: chat turns paid the dead-rung walk every single turn.
  let order = providerOrder(req.provider)
  // Phase 5 · C4: the LOCAL lane rides FIRST when configured (before cloud;
  // the instant-recall cache already answered before any of this runs).
  await refreshLocalLaneCache()
  if (localLaneCache && !order.includes('local')) {
    order = ['local', ...order]
  }
  if (!req.provider && autoCascadeOrder()) {
    order = orderLanes(order)
  }
  // Phase 5 · C2 — the dial's effect on the walk order. Unfiltered keeps
  // LOCAL lanes only (the C4 lane + loopback compatible lanes; 'core' is the
  // z-ai cloud gateway and is excluded). NO SILENT DOWNGRADE: an empty result
  // fails the turn HONESTLY with the wizard CTA — never a quiet cloud fallback.
  if (candorMode === 'unfiltered') {
    const classOf = (lane: ProviderId) => {
      const c = resolveProviderConfig(lane)
      return laneConsentClass(lane, { apiKey: c.apiKey, baseUrl: c.baseUrl })
    }
    order = filterLanesForCandor(order, classOf, 'unfiltered')
    if (order.length === 0) {
      a4Unregister?.()
      const elapsed = Date.now() - startedAt
      recordActivity('llm', 'candor Unfiltered — NO local lane reachable; the turn failed honestly (no silent downgrade)')
      return {
        text:
          'No local lane is available — the candor dial is on Unfiltered, which speaks ONLY through lanes on this machine, and none is connected right now. ' +
          'I will not quietly route you through a cloud lane instead; that would be the silent downgrade you asked me never to do. ' +
          'Connect a local lane (Settings → Candor & Local Lane — the wizard detects Ollama, LM Studio and llama.cpp), or switch the dial to Frank/Standard.',
        provider: 'offline-mind',
        model: 'no-local-lane',
        fallback: true,
        emotion: 'apologetic',
        memory_context: { facts_recalled: 0, vectors_searched: 0, tools_available: 0 },
        tools_used: [],
        skills_used: [],
        skill_hint: null,
        elapsed_ms: elapsed,
        mode,
        candorMode,
        capability_request: {
          missing: 'a reachable local lane (Unfiltered speaks only through this machine)',
          summary: 'The dial is Unfiltered and no local lane answered.',
          options: [
            { id: 'wizard', label: 'Open the local-lane wizard', description: 'Detect Ollama/LM Studio/llama.cpp, pick a model, warm it up', kind: 'enable' },
            { id: 'frank', label: 'Switch the dial to Frank', description: 'Full candor with your consented cloud lanes', kind: 'alternative' },
            { id: 'standard', label: 'Switch the dial to Standard', description: "Today's behavior", kind: 'alternative' },
          ],
        },
      }
    }
  }
  // w5 voice-speed: VOICE turns lead with Mist Core — probe-verified the
  // gateway's first streamed token lands in ~0.9s where the free keyless
  // lanes prefill in 4-6s. Voice replies are short (the mode prompt caps
  // them), so the cost difference is pennies and the latency difference is
  // everything the creator hears. Applied AFTER the measured order: an
  // explicit mode precedence outranks the learned ladder.
  if (mode === 'voice' && !req.provider && order.includes('core') && order[0] !== 'core') {
    order = ['core', ...order.filter((p) => p !== 'core')]
  }
  // vision/video mode rides Mist Core's vision endpoint (serves the vision model)
  const coreVision = mode === 'vision'
  const thinking = req.thinking === true
  // Phase 5 · R6: the context-stripped prompt keyless lanes receive instead of
  // the owner's full context — computed once, static, persona/facts-free.
  const keylessPrompt = buildKeylessSystemPrompt()

  const tools_used: string[] = []
  let skill_hint: SkillHint | null = null
  let finalText = ''
  let envelope: ParsedEnvelope = { ...NEUTRAL_ENVELOPE }
  let servingProvider: ProviderId = 'offline-mind'
  let servingModel = 'deterministic-fallback'
  /** Phase 5 · C3: set when this turn's reply was rerouted to a local lane after a refusal */
  let refusalRerouteInfo: { from: ProviderId; to: ProviderId; pattern: string } | null = null
  let fallback = false
  /** set when the OWNER (not a hedge/TTFT abort) cancelled mid-attempt */
  let ownerCancelled = false
  let attemptIdx = 0

  // ---- Phase 4-b · R10: one lane attempt under a TTFT deadline, plus the
  //      concurrent hedge. TTFT (first-token) is SEPARATE from the total
  //      budget: cloud lanes 8s, local lanes 20s cold / 5s warm (a success
  //      within the last 60s makes a local lane warm). The deadline is only
  //      observable on STREAMING attempts (a non-streaming lane's first chunk
  //      IS its completion — the total budget already governs it), and
  //      thinking:true requests are exempt: reasoning was explicitly
  //      requested and the thinking time IS the work. When the deadline
  //      passes with no first chunk: hedge to the next owner-keyed/local lane
  //      concurrently (NEVER a second public keyless lane — no fan-out
  //      amplification) and let the first chunk win; with no hedgeable
  //      candidate the attempt aborts and the walk falls through. The loser
  //      of a hedge race is aborted silently — WE cut it, it did not fail
  //      (worst-case cosmetic note: one stray delta can slip through in the
  //      microtask window before the abort lands).
  interface AttemptResult {
    text: string
    provider: ProviderId
    model: string
    /** w5 voice-speed: this attempt's stream filter — the CALLER commits or
     *  discards it once the round's text is judged final (or not). */
    filter?: ReplyStreamFilter
  }

  const startAttempt = (
    p: ProviderId,
    cfg: ProviderConfig,
    onTtft: () => void,
    isHedge: boolean
  ): {
    lane: ProviderId
    promise: Promise<AttemptResult | null>
    firstChunk: Promise<void>
    abort: (why: string) => void
  } => {
    const attemptStart = Date.now()
    noteLlmCall(p, cfg.model)
    // fresh filter per lane attempt — a FAILED attempt emitted nothing, so
    // only the lane that actually serves may stream (a streaming lane that
    // breaks mid-text returns its partial as success — see callCore — so the
    // emitted prefix always equals the returned text).
    const filter = chunkSink ? makeReplyStreamFilter({ onEmit: chunkSink }) : undefined
    const local = isLocalLane(p, cfg.baseUrl)
    const ttftMs = ttftDeadlineMs(p, local)
    const ac = new AbortController()
    let watchdog: ReturnType<typeof setTimeout> | undefined
    let firstChunked = false
    let lost = false
    let abortedByUs: string | null = null
    let firstChunkResolve!: () => void
    const firstChunk = new Promise<void>((r) => {
      firstChunkResolve = r
    })
    const cancelWatchdog = () => {
      if (watchdog) {
        clearTimeout(watchdog)
        watchdog = undefined
      }
    }
    // sink: the FIRST delta cancels the TTFT watchdog (deadline met) and
    // marks this attempt as still-eligible to feed the client stream.
    const sink = filter
      ? (d: string) => {
          if (lost) return // hedge race lost — further deltas are dropped
          if (!firstChunked) {
            firstChunked = true
            cancelWatchdog()
            firstChunkResolve()
          }
          filter.feed(d)
        }
      : undefined
    if (sink && !thinking && ttftMs > 0) {
      watchdog = setTimeout(onTtft, ttftMs)
    }
    const abort = (why: string) => {
      lost = true
      abortedByUs = why
      cancelWatchdog()
      ac.abort(new Error(why))
    }
    const promise = (async (): Promise<AttemptResult | null> => {
      try {
        // composite signal: the fetch dies on the OWNER's cancel (or the A4
        // kill switch — Phase 5) OR on our own TTFT/race abort (AbortSignal.any —
        // Node ≥20.3 / Bun; the plain fallback keeps older runtimes working
        // with attempt-only abort)
        const signal =
          effectiveSignal && typeof AbortSignal.any === 'function'
            ? AbortSignal.any([effectiveSignal, ac.signal])
            : ac.signal
        const res = await callProvider(
          p,
          cfg,
          // Phase 5 · R6: keyless/public lanes get the context-stripped prompt —
          // the owner's persona/facts/memory NEVER leave the machine on a public lane.
          laneCarriesFullContext(p, { apiKey: cfg.apiKey, baseUrl: cfg.baseUrl }) ? turnSystemPrompt : keylessPrompt,
          messages,
          { vision: coreVision, thinking },
          CHAT_LLM_TIMEOUT_MS,
          sink,
          signal
        )
        cancelWatchdog()
        // Mist Core: attribute the model the gateway actually reported (e.g. glm-4-plus)
        const model = res.reportedModel ?? cfg.model
        appendGenerateStep({
          provider: p,
          model,
          ok: true,
          durationMs: Date.now() - attemptStart,
          tokensIn: estimateTokens(context.prompt) + estimateTokens(messages.map((m) => m.content).join('\n')),
          tokensOut: estimateTokens(res.text),
          attempt: attemptIdx++,
        })
        noteLaneSuccess(p) // a lane that answered is healthy — clear stale cooldowns
        noteLaneAttempt(p, { ok: true, durationMs: Date.now() - attemptStart }) // EWMA sample
        if (isHedge) {
          recordActivity('llm', `[hedge] ${p} won the race and served the turn`)
        }
        return { text: res.text.trim(), provider: p, model, filter }
      } catch (err) {
        cancelWatchdog()
        const msg = err instanceof Error ? err.message : 'unknown error'
        if (filter) filter.discard() // this attempt's stream (if any) is not the answer
        // Phase 3-a · R1: an owner abort is NOT the lane's fault — no
        // cooldown, no failure telemetry, no further lanes. The turn is
        // cancelled, not "failed".
        if (ownerAborted(ownerSignal)) {
          recordActivity('llm', `${p} aborted by owner mid-attempt — stopping the cascade walk`)
          ownerCancelled = true
          return null
        }
        if (abortedByUs === 'hedge-race-lost') {
          // the other lane's first chunk won — silent, no lane-health sample
          // (we cut this attempt; its latency is censored, not failed)
          recordActivity('llm', `[hedge] ${p} lost the race — aborted`)
          return null
        }
        if (abortedByUs === 'ttft-deadline') {
          recordActivity(
            'llm',
            `[ttft] ${p} breached its first-token deadline (${ttftMs}ms, ${local ? (laneWarm(p) ? 'local warm' : 'local cold') : 'cloud'}) — ${isHedge ? 'both lanes abandoned' : 'falling through to the next lane'}`
          )
          noteLaneAttempt(p, { ok: false, durationMs: ttftMs, ttftBreach: true })
          appendGenerateStep({
            provider: p,
            model: cfg.model,
            ok: false,
            durationMs: Date.now() - attemptStart,
            error: `ttft-deadline: no first token in ${ttftMs}ms`,
            errorCategory: 'timeout',
            attempt: attemptIdx++,
          })
          return null
        }
        recordActivity('llm', `${p} failed: ${msg}`)
        // Mark-LV wave-2: start a typed cooldown so the NEXT chat turn skips
        // this dead rung instead of paying its failure latency again
        noteLaneFailure(p, msg)
        noteLaneAttempt(p, { ok: false, durationMs: Date.now() - attemptStart })
        appendGenerateStep({
          provider: p,
          model: cfg.model,
          ok: false,
          durationMs: Date.now() - attemptStart,
          error: msg,
          errorCategory: classifyError(msg).category,
          attempt: attemptIdx++,
        })
        return null
      }
    })()
    return { lane: p, promise, firstChunk, abort }
  }

  const callWithCascade = async (): Promise<AttemptResult | null> => {
    for (let i = 0; i < order.length; i++) {
      const p = order[i]
      if (p === 'offline-mind') continue
      // Phase 3-a · R1: once the owner cancelled, stop walking lanes — every
      // fetch after this would abort instantly anyway.
      if (ownerAborted(effectiveSignal) || ownerCancelled) return null
      const cfg = resolveProviderConfig(p)
      if (!cfg.configured) continue
      // Phase 4-b: the hedge candidate for a stalling primary — the first
      // LATER lane in the walk order that is owner-keyed or local (a public
      // keyless lane is NEVER a hedge target, so two keyless lanes can never
      // be in flight together).
      const hedgeLane = pickHedgeLane(
        p,
        order.slice(i + 1).map((lane) => {
          const c = resolveProviderConfig(lane)
          return {
            lane,
            hedgeable: c.configured && isHedgeableLane(lane, { apiKey: c.apiKey, baseUrl: c.baseUrl }),
          }
        })
      )
      type Handle = ReturnType<typeof startAttempt>
      let hedgeHandle: Handle | null = null
      let hedgeStartedFlag = false
      let resolveHedgeStarted!: () => void
      const hedgeStarted = new Promise<void>((r) => {
        resolveHedgeStarted = r
      })
      const primary = startAttempt(
        p,
        cfg,
        () => {
          // TTFT deadline passed with no first chunk from the primary.
          if (!hedgeLane) {
            primary.abort('ttft-deadline') // no hedgeable candidate — fall through
            return
          }
          const hcfg = resolveProviderConfig(hedgeLane)
          recordActivity(
            'llm',
            `[hedge] ${p} exceeded its first-token deadline — hedging to ${hedgeLane} concurrently (first chunk wins; only owner-keyed/local lanes are hedged)`
          )
          hedgeStartedFlag = true
          hedgeHandle = startAttempt(
            hedgeLane,
            hcfg,
            () => {
              // the hedge ALSO breached its TTFT — abandon both, fall through
              primary.abort('ttft-deadline')
              hedgeHandle?.abort('ttft-deadline')
            },
            true
          )
          // first-chunk-wins wiring, both directions
          void primary.firstChunk.then(() => hedgeHandle?.abort('hedge-race-lost'))
          void hedgeHandle.firstChunk.then(() => primary.abort('hedge-race-lost'))
          resolveHedgeStarted()
        },
        false
      )
      // If the primary settles before its TTFT ever fires, no hedge can start
      // anymore — release the waiter so the combined await below completes.
      void primary.promise.then(() => {
        if (!hedgeStartedFlag) resolveHedgeStarted()
      })
      // Await the primary AND (if it ever started) the hedge; prefer the
      // primary's result when both completed (it is earlier in the order).
      const hedgeResult = hedgeStarted.then(() => hedgeHandle?.promise ?? null)
      const [primaryResult, hedgedResult] = await Promise.all([primary.promise, hedgeResult])
      if (ownerCancelled) return null
      const winner = primaryResult ?? hedgedResult ?? null
      if (winner) return winner
      // both lanes failed (or no lanes were configured) — walk continues
    }
    return null
  }

  if (order[0] === 'offline-mind') {
    finalText = await offlineMindResponse(message, context)
    envelope.capability_request = OFFLINE_CAPABILITY_REQUEST
    fallback = true
  } else {
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const lastRound = round === MAX_TOOL_ROUNDS - 1

      // Phase 3-a · R1: a cancelled turn never opens a new tool round — every
      // remaining cascade walk would abort instantly and the honest end state
      // was already recorded in the round that caught the abort.
      if (ownerAborted(effectiveSignal)) {
        finalText = finalText || 'aborted by owner.'
        break
      }

      // On the final round, force a real answer instead of another tool hop
      if (lastRound && round > 0) {
        messages.push({
          role: 'user',
          content:
            'ANSWER_NOW: your tool budget is used up. Give your final answer now from what you have gathered — no more tool calls.',
        })
      }

      const res = await callWithCascade()
      if (!res) {
        finalText = await offlineMindResponse(message, context)
        servingProvider = 'offline-mind'
        servingModel = 'deterministic-fallback'
        fallback = true
        envelope.capability_request = OFFLINE_CAPABILITY_REQUEST
        break
      }
      servingProvider = res.provider
      servingModel = res.model

      // ---- Phase 5 · C3: the refusal reroute. In Frank/Unfiltered, a reply
      //      shaped like a refusal/moralising/disclaimer from a NON-local lane
      //      is retried ONCE on the best local lane (the provider badge shows
      //      the lane that actually served). NO local lane → the honest note +
      //      the wizard CTA ride along. Cloud requests are NEVER injected with
      //      jailbreak text — the reroute changes WHERE we ask, not what we say.
      let refusalReroute: { from: ProviderId; to: ProviderId; pattern: string } | null = null
      if ((candorMode === 'frank' || candorMode === 'unfiltered') && !tryParseToolCall(res.text)) {
        const refusal = detectRefusal(res.text)
        const servedClass = (() => {
          const c = resolveProviderConfig(res.provider)
          return laneConsentClass(res.provider, { apiKey: c.apiKey, baseUrl: c.baseUrl })
        })()
        if (refusal && servedClass !== 'local') {
          const localLane = order.find((lane) => {
            if (lane === res.provider) return false
            const c = resolveProviderConfig(lane)
            return c.configured && laneConsentClass(lane, { apiKey: c.apiKey, baseUrl: c.baseUrl }) === 'local'
          })
          if (localLane) {
            const localCfg = resolveProviderConfig(localLane)
            const attemptStart = Date.now()
            try {
              const localRes = await callProvider(
                localLane,
                localCfg,
                laneCarriesFullContext(localLane, { apiKey: localCfg.apiKey, baseUrl: localCfg.baseUrl })
                  ? turnSystemPrompt
                  : keylessPrompt,
                messages,
                { vision: coreVision, thinking },
                CHAT_LLM_TIMEOUT_MS,
                undefined,
                effectiveSignal
              )
              const rerouteRefusal = detectRefusal(localRes.text)
              if (!rerouteRefusal) {
                recordActivity('llm', `refusal_reroute: ${res.provider} refused (${refusal}) — ${localLane} answered candidly in ${Date.now() - attemptStart}ms`)
                appendGenerateStep({
                  provider: localLane,
                  model: localRes.reportedModel ?? localCfg.model,
                  ok: true,
                  durationMs: Date.now() - attemptStart,
                  attempt: attemptIdx++,
                  error: null,
                  errorCategory: 'refusal_reroute',
                })
                refusalReroute = { from: res.provider, to: localLane, pattern: refusal }
                refusalRerouteInfo = refusalReroute
                res.text = localRes.text
                res.filter = undefined // the rerouted reply never streamed — no filter to commit
                res.provider = localLane
                res.model = localRes.reportedModel ?? localCfg.model
                servingProvider = localLane
                servingModel = res.model
              } else {
                recordActivity('llm', `refusal_reroute: ${res.provider} refused (${refusal}) and the local lane ${localLane} ALSO refused (${rerouteRefusal}) — surfacing the local reply with the honest note`)
              }
            } catch (err) {
              recordActivity('llm', `refusal_reroute: local lane ${localLane} failed: ${err instanceof Error ? err.message : err}`)
            }
          } else {
            recordActivity('llm', `refusal_reroute: ${res.provider} refused (${refusal}) and NO local lane is connected to reroute to`)
            envelope.capability_request = {
              missing: 'a local lane for the candor reroute',
              summary: 'That lane declined the request; no local lane is connected to reroute to.',
              options: [
                { id: 'wizard', label: 'Open the local-lane wizard', description: 'Connect Ollama/LM Studio/llama.cpp so refusals can reroute locally', kind: 'enable' },
                { id: 'frank', label: 'Switch the dial to Standard', description: 'Skip the reroute entirely', kind: 'alternative' },
              ],
            }
          }
        }
      }

      const toolCall = tryParseToolCall(res.text)
      if (!toolCall) {
        const parsed = tryParseEnvelope(res.text)
        if (parsed) {
          res.filter?.commit() // the reply string that streamed IS the final answer
          envelope = parsed
          finalText = parsed.text
          break
        }
        // Invalid non-answer: echoed TOOL_RESULT, empty, transitional chatter, or
        // — the classic autonomy killer — an INTENT NARRATION ("Sure, I'll list
        // the downloads folder right away") with no tool call behind it. Words
        // without a tool call mean NOTHING happens on the machine, so any short
        // "I'll do X" acknowledgement is caught and nudged into a real tool call.
        // This must fire on round 0 too: that is exactly where the model confirms
        // a user's "yes" and then narrates instead of acting.
        const looksLikeEcho = /TOOL_RESULT/i.test(res.text) || res.text.trim().length < 12
        const narration = looksLikeIntentNarration(res.text)
        if ((looksLikeEcho || narration) && round < MAX_TOOL_ROUNDS - 1) {
          res.filter?.discard() // rejected text — never release its held tail
          messages.push({
            role: 'user',
            content: narration
              ? 'INVALID_REPLY: you just SAID you would perform an action but did not call any tool — ' +
                'and without a tool call nothing actually happens on the machine. Act NOW: reply with ONLY ' +
                '{"tool_call":{"tool":"<name>","args":{...}}} for the action you promised, or give your ' +
                'complete final answer (if you truly cannot act, say so and offer options per LAW 1).'
              : 'INVALID_REPLY: that was not a final answer. Do NOT echo TOOL_RESULT and do NOT narrate intentions. ' +
                'Reply with ONLY {"tool_call":{"tool":"<name>","args":{...}}} to use a tool, or your complete final answer for the user.',
          })
          continue
        }
        // Accepting the narration as the final answer (budget exhausted) — but
        // be honest that the action did not actually complete (LAW 6) instead of
        // letting the user wait for something that will never happen.
        if (narration) {
          res.filter?.commit() // accepted (with an honest appended clause — the client reconciles)
          finalText =
            tools_used.length === 0
              ? res.text.trim() +
                '\n\n— a moment of honesty, sir: nothing actually ran on the machine just now. My action chain ' +
                'stalled before a single tool executed. Say the word and I will take it from the top and DO it.'
              : res.text.trim() +
                '\n\n— a moment of honesty, sir: I stalled mid-chain there — ' +
                `${tools_used.length} step${tools_used.length === 1 ? '' : 's'} ran, but the job is not finished. ` +
                "Say 'continue' and I will pick up exactly where I left off."
          break
        }
        finalText = res.text
        res.filter?.commit() // plain final answer — release any held tail prose
        break
      }

      // Still trying tools on the last round → honest partial answer + options
      if (lastRound) {
        res.filter?.discard() // a tool call is machine routing — never final prose
        finalText =
          'I pushed my tool chain to its budget on this one. I gathered real material but did not finish the full chain — here is where I stand, and I can continue from here if you want.'
        envelope.capability_request = {
          missing: 'more tool rounds for this chain',
          summary: 'The task needs more steps than one thought allows.',
          options: [
            { id: 'continue', label: 'Continue the chain from here', kind: 'later' },
            { id: 'simpler', label: 'Break the task into smaller steps', kind: 'workaround' },
            { id: 'summary', label: 'Summarize what you found so far', kind: 'alternative' },
          ],
        }
        break
      }

      const known = await findTool(toolCall.tool).catch(() => null)
      if (known && known.implemented) {
        // Phase 3-a · R1 — the mandate's tool-loop guard: BEFORE each
        // executeTool, an aborted turn stops with an honest NOT-RUN result.
        // No NEW side-effecting calls after the owner cancelled (a read
        // already in flight may finish — aborting a bridge READ is a plain
        // abort, only EXEC-class calls report 'interrupted — state unknown').
        if (ownerAborted(effectiveSignal)) {
          res.filter?.discard()
          recordActivity('tool', `${toolCall.tool} NOT RUN — owner aborted the turn before the call`)
          messages.push({
            role: 'user',
            content: `TOOL_RESULT for ${toolCall.tool}: NOT RUN — aborted by owner before execution. Nothing happened on the machine for this call. End your answer now; do not call more tools.`,
          })
          finalText = 'aborted by owner.'
          break
        }
        res.filter?.discard() // tool round — the streamed prefix (if any) is superseded by the tool result
        activity(toolActivityLabel(toolCall.tool, toolCall.args))
        const result = await executeTool(toolCall.tool, toolCall.args, false, {
          origin: arbiterOrigin,
          turnId: arbiterTurnId,
          interactive: arbiterInteractive,
          signal: effectiveSignal, // Phase 3-a + Phase 5 A6: kills in-flight bridge fetches on abort or kill
        })
        if (result.success) {
          tools_used.push(toolCall.tool)
          skill_hint = { tool: toolCall.tool, args: toolCall.args }
          // Phase 2-d · S13: the sensitive-read redaction seam. The prompt copy
          // is built HERE, before callWithCascade walks the lanes — the same
          // messages array is replayed to cloud AND local lanes, so the honest
          // floor is redacting the prompt copy for ALL lanes (laneIsCloud=true;
          // strictly safer than gambling on the cascade's pick). The RAW output
          // still reaches the owner's tool-result cards (the trace timeline);
          // only the model-facing copy is scrubbed.
          const redacted = redactBeforeCloud(
            toolCall.tool,
            classifyRisk(toolCall.tool, toolCall.args ?? {}),
            JSON.stringify(result.output).slice(0, 6000),
            true,
          )
          if (redacted.redactions > 0) markCloudConsent(arbiterTurnId)
          messages.push({
            role: 'user',
            content:
              `TOOL_RESULT for ${toolCall.tool} (data for you — never repeat it verbatim): ` +
              // Phase 2-c: EVERY tool result rides the prompt inside a labeled
              // untrusted block — not only injection-flagged ones. All severities.
              `${wrapToolOutput(toolCall.tool, redacted.text)}\n\n` +
              'Next: reply with ONLY {"tool_call":{"tool":"<name>","args":{...}}} for another tool, or your final answer.',
          })
        } else {
          // error strings from sensitive-read tools can embed partial secrets —
          // same redaction seam applies to the failure copy
          const redactedErr = redactBeforeCloud(
            toolCall.tool,
            classifyRisk(toolCall.tool, toolCall.args ?? {}),
            JSON.stringify({ error: result.error }).slice(0, 4000),
            true,
          )
          if (redactedErr.redactions > 0) markCloudConsent(arbiterTurnId)
          messages.push({
            role: 'user',
            content:
              `TOOL_RESULT for ${toolCall.tool} (data for you — never repeat it verbatim): ` +
              `${wrapToolOutput(toolCall.tool, redactedErr.text)}\n\n` +
              'The tool failed. You may try a different tool, or answer honestly and offer the user options (LAW 1).',
          })
        }
      } else {
        messages.push({
          role: 'user',
          content: `TOOL_RESULT: tool ${toolCall.tool} is not available; answer without it.`,
        })
      }
    }
  }

  // Strip any leaked raw tool-call JSON from the final answer (truncated/unparseable cases)
  for (const marker of ['{"tool_call"', '{"tool"', 'TOOL_CALL:']) {
    const leakIdx = finalText.indexOf(marker)
    if (leakIdx >= 0) {
      finalText = finalText.slice(0, leakIdx).trim()
      break
    }
  }

  if (!finalText.trim()) {
    finalText = await offlineMindResponse(message, context)
    fallback = servingProvider === 'offline-mind'
  }

  // ---- auto-remember durable facts the brain chose to keep ----
  // Phase 2-c (S11): a tainted turn's facts go to the quarantine inbox
  // (never LongtermMemory, never recall); clean turns write trust 'derived'
  // with the writing turn recorded.
  const remembered: string[] = []
  for (const entry of envelope.remember) {
    const sep = entry.indexOf(':')
    if (sep <= 0) continue
    const key = entry.slice(0, sep).trim().slice(0, 60)
    const value = entry.slice(sep + 1).trim().slice(0, 500)
    if (!key || !value) continue
    try {
      const routed = await rememberDurableFact(key, value, arbiterTurnId)
      remembered.push(routed.quarantined ? `${key}: (quarantined — pending owner review)` : `${key}: ${value}`)
    } catch {
      // best-effort memory
    }
  }

  const elapsed_ms = Date.now() - startedAt
  recordActivity('llm', `${servingProvider} served ${mode} in ${elapsed_ms}ms${tools_used.length ? ` (${tools_used.length} tools)` : ''}`)

  const response: UnifiedLlmResponse = {
    text: finalText,
    provider: servingProvider,
    model: servingModel,
    fallback,
    emotion: detectEmotion(finalText, tools_used.length),
    memory_context: {
      facts_recalled: context.facts_recalled,
      vectors_searched: context.vectors_searched,
      tools_available: context.tools_available,
    },
    tools_used,
    skills_used: context.skills_used,
    skill_hint,
    elapsed_ms,
    mode,
  }
  if (envelope.citations.length > 0) response.citations = envelope.citations
  if (envelope.attachments.length > 0) response.attachments = envelope.attachments
  if (envelope.suggestions.length > 0) response.suggestions = envelope.suggestions
  if (envelope.capability_request) response.capability_request = envelope.capability_request
  if (remembered.length > 0) response.remembered = remembered
  // Phase 2-d · S13: this turn had a sensitive-read result redacted from the
  // prompt copy — flag it so Phase 5's dial can pin such turns to local lanes
  // unless the owner consents per-turn. No behavior change beyond the flag.
  if (needsCloudConsent(arbiterTurnId)) response.cloudConsent = true
  // Phase 5 · C2/C3: the dial this turn ran under + the honest reroute badge
  response.candorMode = candorMode
  if (refusalRerouteInfo) response.refusalReroute = refusalRerouteInfo

  // ---- v5 learning loop: fire-and-forget reflection on the completed turn.
  // Hooked ONLY on the main success completion (not the offline fallback),
  // never awaited, never alters the response, never throws.
  if (!fallback) {
    try {
      const ex = req.extra as Record<string, unknown> | undefined
      const tid =
        typeof ex?.threadId === 'string'
          ? ex.threadId
          : typeof ex?.thread_id === 'string'
            ? ex.thread_id
            : typeof ex?.conversation_id === 'string'
              ? ex.conversation_id
              : typeof ex?.conversationId === 'string'
                ? ex.conversationId
                : ''
      const executedSkill = tools_used.find((t) => t.startsWith('skill:'))
      onTurnComplete({
        threadId: tid,
        turnId: arbiterTurnId, // Phase 2-c: the learning loop's saves ride this turn's taint state
        userText: message,
        replyText: finalText,
        toolsUsed: tools_used,
        skillUsed: executedSkill
          ? executedSkill.slice('skill:'.length)
          : context.skills_used.length > 0
            ? context.skills_used[context.skills_used.length - 1]
            : undefined,
        success: true,
      })
    } catch {
      // the learning loop must never affect the reply
    }
  }

  // Phase 5 · A6: this turn's kill-registry slot is released (the turn ended
  // normally — its controller does not need killing anymore)
  a4Unregister?.()

  return response
}
