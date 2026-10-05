// M.I.S.T. free-lanes — the researched map of EVERY way to get top models
// into Mist, with live status and live model discovery.
//
// RESEARCH LEDGER (all live-probed from this machine):
//   • KEYLESS, ZERO-AUTH LANES (probed 2026-09-27, no key sent, real chats
//     completed): Kilo Code (200 req/hr, 550B nemotron + rotating free pool),
//     Pollinations (openai-fast → gpt-oss-20b), LLM7.io (turbo tier: GLM-5.3-
//     Flash, Nemo), OVHcloud AI (anonymous 2 RPM/model/IP: Qwen3.5-397B,
//     gpt-oss-120b, Qwen3-Coder 262K). These four need NOTHING out of the
//     box — no key, no signup — and all four expose public live catalogs, so
//     Mist re-discovers models as providers rotate them.
//   • TheOldAPI (theoldllm.com) — $7/mo flat, NO pay-as-you-go, 50M adjusted
//     tokens per DAY (resets daily), 100+ top-model routes (GPT-5.3, Claude
//     Opus, Gemini Pro, Grok, DeepSeek…), OpenAI-compatible at
//     https://theoldllm.com/v1 with Bearer auth (verified: /v1/models → 401
//     "Missing API key", homepage pricing read live). THE creator's example
//     of "unlimited top models out of the box" — one key, everything opens.
//   • Nous Portal (inference-api.nousresearch.com/v1) — Nous Research's
//     official inference API; public /v1/models lists a 417-model aggregator
//     (GPT-6 Luna/Sol/Astra, Claude Opus 5.5, Gemini 3.8, DeepSeek V4.1,
//     GLM 5.3, Qwen 3.8 Max…). Key from portal.nousresearch.com. Chat calls
//     without a key return an x402 crypto-payment challenge — key is the
//     sane path.
//   • OpenRouter — public /api/v1/models verified live: 21 free models right
//     now (nemotron-3-ultra-550b:free — her 550B reasoning brain — gemma-4,
//     qwen3.8, poolside laguna, liquid lfm, inkling…). Free tier: 50
//     requests/day with a $10-credit account; :free ids cost nothing.
//   • HuggingFace Router (router.huggingface.co/v1) — /v1/models is PUBLIC
//     (no key): 138 models incl. DeepSeek-V4.1, Qwen3.8-2.4T, GLM-5.3,
//     Kimi-K3, gpt-oss-120b, Llama-3.1. Chat needs a free HF token.
//   • Groq (api.groq.com/openai/v1) — verified live (403 without key —
//     endpoint live, key needed). Free tier: fast Llama/Qwen/Kimi serving,
//     free key at console.groq.com.
//   • GitHub Models (models.github.ai/inference) — verified live (200). Free
//     with a GitHub PAT: GPT, DeepSeek, Llama, Phi + more.
//   • Cerebras (api.cerebras.ai/v1) — Cloudflare-fronted (403 challenge from
//     this sandbox IP; works with a key from cloud.cerebras.ai — free tier,
//     the fastest tokens/sec anywhere).
//   • Together (api.together.xyz/v1, 401 verified) — free credit on signup.
//   • Mistral (api.mistral.ai/v1, 401 verified) — free Experiment plan tier.
//   • NVIDIA NIM (integrate.api.nvidia.com/v1) — already in her cascade with
//     the creator's key; free credits on signup.
//   • Google AI Studio — free key powers the existing `gemini` provider.
//   • Ollama / LM Studio / vLLM (local) — truly unlimited + keyless + offline;
//     MIST_QWEN_BASE_URL or MIST_NOUS_BASE_URL pointed at 127.0.0.1 opens
//     the local lane (any weights: hermes4, llama3.3, qwen3, deepseek-r1…).
//   • OmniRoute (her first cascade lane) — point OMNIROUTE_BASE_URL at ANY
//     OpenAI-compatible gateway the creator runs locally (including
//     cookie-fed community gateways — the "web cookies" pattern: the creator
//     runs the gateway under their own sessions/keys; Mist only ever speaks
//     plain OpenAI protocol to it).
//   • Researched but NOT shipped as keyless: DuckDuckGo AI (needs a JS hash
//     challenge + flaky from cloud IPs), LLM7 pro tier (paid), free-key
//     tiers (Cohere, Aion, Z.ai bigmodel GLM-Flash, ModelScope, SiliconFlow
//     — free but not zero-auth). Local runtimes stay the unlimited offline
//     answer.
// The catalog below is the honest distillation: pricing/limits as advertised
// by each service on probe day; availability computed live from env.

import type { FreeLaneInfo, ProviderId } from '@/lib/types'

// ---------- static catalog (researched + live-probed) ----------

interface LaneDef extends Omit<FreeLaneInfo, 'status'> {
  /** Env var whose presence activates the lane (null for local/gateway lanes). */
  activationEnv: string | null
}

const LANES: LaneDef[] = [
  // ---------- KEYLESS — zero auth, works the moment Mist boots ----------
  {
    id: 'kilo',
    label: 'Kilo Code — keyless free pool',
    kind: 'keyless',
    provider: 'kilo',
    baseUrl: 'https://api.kilo.ai/api/gateway',
    keyEnv: null,
    modelEnv: 'KILO_MODEL',
    defaultModel: 'nvidia/nemotron-3-ultra-550b-a55b:free',
    pricing: 'free — no key, no signup',
    limits: '200 requests/hour per IP · 14-model free pool (2026-09-28)',
    signupUrl: 'https://kilo.ai/docs/gateway/authentication',
    outOfBox: true,
    activationEnv: null,
    notes:
      'Live-verified keyless (2026-09-28 re-probe): the 550B nemotron reasoning brain (1M context), super-120b, Cohere north-mini-code and step 3.7 flash — kilo-auto/free has rotated out of the pool, so the lane now rotates across the live :free models when one is rate-limited upstream. The pool changes often — Discover lists what is live right now.',
  },
  {
    id: 'pollinations',
    label: 'Pollinations — keyless open gateway',
    kind: 'keyless',
    provider: 'pollinations',
    baseUrl: 'https://text.pollinations.ai',
    keyEnv: null,
    modelEnv: 'POLLINATIONS_MODEL',
    defaultModel: 'openai-fast',
    pricing: 'free — no key, no signup',
    limits: 'anonymous tier · seconds between requests',
    signupUrl: 'https://pollinations.ai',
    outOfBox: true,
    activationEnv: null,
    notes:
      'OpenAI-compatible at /openai with zero auth. openai-fast routes to gpt-oss-20b (reasoning, tools) today; Pollinations swaps in new models as they ship, and their anonymous tier is explicitly unaffected by the legacy-API deprecation.',
  },
  {
    id: 'llm7',
    label: 'LLM7.io — keyless turbo models',
    kind: 'keyless',
    provider: 'llm7',
    baseUrl: 'https://api.llm7.io/v1',
    keyEnv: null,
    modelEnv: 'LLM7_MODEL',
    defaultModel: 'auto',
    pricing: 'free — no key for the turbo tier',
    limits: '1 req/sec · 10 RPM · 60 req/hr · 500K tokens/24h (anonymous)',
    signupUrl: 'https://token.llm7.io',
    outOfBox: true,
    activationEnv: null,
    notes:
      'The turbo tier answers with no key at all — GLM-5.3-Flash, minimax-m2.7, Mistral Nemo, codestral (live-verified). The catalog rotates frequently; Mist picks from the live list by availability and falls back across models automatically. A free token from token.llm7.io doubles the limits if you ever want more.',
  },
  {
    id: 'ovh',
    label: 'OVHcloud AI — keyless EU models',
    kind: 'keyless',
    provider: 'ovh',
    baseUrl: 'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1',
    keyEnv: null,
    modelEnv: 'OVH_MODEL',
    defaultModel: 'Qwen3.5-397B-A17B',
    pricing: 'free — no key, no signup',
    limits: '2 requests/min per IP per model (each model has its own quota)',
    signupUrl: 'https://www.ovhcloud.com/en/public-cloud/ai-endpoints/',
    outOfBox: true,
    activationEnv: null,
    notes:
      'A permanent anonymous tier on serious open weights — Qwen3.5-397B-A17B, gpt-oss-120b, Qwen3-Coder-30B (262K context), Qwen2.5-VL-72B (vision), Llama-3.3-70B, Mistral-Small-3.2. Mist rotates across models when one hits its per-model quota. Shared cloud IPs can exhaust the quota — from your own IP it answers.',
  },
  // ---------- keyed lanes ----------
  {
    id: 'theoldapi',
    label: 'TheOldAPI — unlimited top models',
    kind: 'subscription',
    provider: 'theoldapi',
    baseUrl: 'https://theoldllm.com/v1',
    keyEnv: 'THEOLD_API_KEY',
    modelEnv: 'THEOLD_MODEL',
    defaultModel: 'gpt-5.3',
    pricing: '$7/month flat',
    limits: '50M adjusted tokens per day (resets daily)',
    signupUrl: 'https://theoldllm.com',
    outOfBox: false,
    activationEnv: 'THEOLD_API_KEY',
    notes:
      'One subscription, no pay-as-you-go: GPT-5.3, Claude Opus, Gemini Pro, Grok, DeepSeek and 100+ more through one OpenAI-compatible endpoint. The closest thing to unlimited top models that exists. Use Discover to list your account\u0027s live routes.',
  },
  {
    id: 'nous',
    label: 'Nous Research — Hermes models',
    kind: 'free-tier',
    provider: 'hermes',
    baseUrl: 'https://inference-api.nousresearch.com/v1',
    keyEnv: 'MIST_NOUS_API_KEY',
    modelEnv: 'MIST_NOUS_MODEL',
    defaultModel: 'Hermes-4-405B',
    pricing: 'pay-as-you-go / portal credits',
    limits: '417-model aggregator (GPT-6, Claude Opus 5.5, Gemini 3.8, DeepSeek V4.1, GLM 5.3, Qwen 3.8)',
    signupUrl: 'https://portal.nousresearch.com',
    outOfBox: false,
    activationEnv: 'MIST_NOUS_API_KEY',
    notes:
      'Nous Research\u0027s official inference API — Hermes 4 / Hermes 3 weights plus a full top-model aggregator. Point MIST_NOUS_BASE_URL at http://127.0.0.1:8642/v1 to ride your local Hermes agent\u0027s gateway instead (keyless).',
  },
  {
    id: 'hermes-gateway',
    label: 'Local Hermes agent gateway',
    kind: 'local',
    provider: 'hermes',
    baseUrl: 'http://127.0.0.1:8642/v1',
    keyEnv: null,
    modelEnv: 'MIST_NOUS_MODEL',
    defaultModel: 'hermes4',
    pricing: 'free forever',
    limits: 'unlimited (your hardware)',
    signupUrl: 'https://github.com/NousResearch/hermes-agent',
    outOfBox: true,
    activationEnv: null,
    notes:
      'Your Hermes agent (NousResearch/hermes-agent) exposes an OpenAI-compatible gateway on :8642. Set MIST_NOUS_BASE_URL=http://127.0.0.1:8642/v1 and Mist\u0027s brain rides the same models your Hermes agent serves — keyless, local, unlimited.',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter — free model pool',
    kind: 'free-tier',
    provider: 'openrouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    keyEnv: 'OPENROUTER_API_KEY',
    modelEnv: 'OPENROUTER_MODEL',
    defaultModel: 'nvidia/nemotron-3-ultra-550b-a55b:free',
    pricing: 'free models cost $0',
    limits: '~50 requests/day free; 21 free models live today',
    signupUrl: 'https://openrouter.ai',
    outOfBox: false,
    activationEnv: 'OPENROUTER_API_KEY',
    notes:
      'Every :free-suffixed model costs nothing. Live free pool today includes her 550B nemotron brain, gemma-4, qwen3.8, poolside laguna, liquid lfm and thinkingmachines inkling. Hermes 4 also rides here as nousresearch/hermes-4-405b (paid).',
  },
  {
    id: 'nvidia',
    label: 'NVIDIA NIM',
    kind: 'credits',
    provider: 'nvidia',
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    keyEnv: 'NVIDIA_API_KEY',
    modelEnv: 'NVIDIA_MODEL',
    defaultModel: 'nvidia/nemotron-3-ultra-550b-a55b',
    pricing: 'free credits on signup',
    limits: 'credit-based (her current workhorse lane)',
    signupUrl: 'https://build.nvidia.com',
    outOfBox: false,
    activationEnv: 'NVIDIA_API_KEY',
    notes: 'The 550B nemotron reasoning brain at ~1.4s latency — her active primary while premium lanes are dark.',
  },
  {
    id: 'groq',
    label: 'Groq — fastest free tier',
    kind: 'free-tier',
    provider: 'groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    keyEnv: 'GROQ_API_KEY',
    modelEnv: 'GROQ_MODEL',
    defaultModel: 'llama-3.3-70b-versatile',
    pricing: 'free tier',
    limits: 'generous daily token quota (see console.groq.com)',
    signupUrl: 'https://console.groq.com',
    outOfBox: false,
    activationEnv: 'GROQ_API_KEY',
    notes: 'LPU speed — hundreds of tokens/sec on Llama-class models. Free key, no card. Endpoint live-verified.',
  },
  {
    id: 'github_models',
    label: 'GitHub Models — free frontier models',
    kind: 'free-tier',
    provider: 'github_models',
    baseUrl: 'https://models.github.ai/inference',
    keyEnv: 'GITHUB_MODELS_KEY',
    modelEnv: 'GITHUB_MODELS_MODEL',
    defaultModel: 'openai/gpt-4o',
    pricing: 'free with a GitHub account',
    limits: 'rate-limited free tier (per-model daily caps)',
    signupUrl: 'https://github.com/marketplace/models',
    outOfBox: false,
    activationEnv: 'GITHUB_MODELS_KEY',
    notes: 'GPT, DeepSeek, Llama, Phi and more behind a GitHub PAT (Settings → Developer settings → fine-grained token with models:read). Endpoint live-verified.',
  },
  {
    id: 'huggingface',
    label: 'HuggingFace Router',
    kind: 'free-tier',
    provider: 'huggingface',
    baseUrl: 'https://router.huggingface.co/v1',
    keyEnv: 'HUGGINGFACE_API_KEY',
    modelEnv: 'HUGGINGFACE_MODEL',
    defaultModel: 'deepseek-ai/DeepSeek-V4-Pro',
    pricing: 'free monthly inference credits',
    limits: '138 models listed live (DeepSeek-V4.1, Qwen3.8-2.4T, GLM-5.3, Kimi-K3, gpt-oss-120b…)',
    signupUrl: 'https://huggingface.co/settings/tokens',
    outOfBox: false,
    activationEnv: 'HUGGINGFACE_API_KEY',
    notes: 'One token, every provider behind HF Inference. The /v1/models list is public — Discover works even without a key.',
  },
  {
    id: 'cerebras',
    label: 'Cerebras — wafer-scale speed',
    kind: 'free-tier',
    provider: 'cerebras',
    baseUrl: 'https://api.cerebras.ai/v1',
    keyEnv: 'CEREBRAS_API_KEY',
    modelEnv: 'CEREBRAS_MODEL',
    defaultModel: 'llama-3.3-70b',
    pricing: 'free tier',
    limits: 'requests/day free quota (cloud.cerebras.ai)',
    signupUrl: 'https://cloud.cerebras.ai',
    outOfBox: false,
    activationEnv: 'CEREBRAS_API_KEY',
    notes: 'The fastest inference available — thousands of tokens/sec. Free API key from the Cerebras cloud console.',
  },
  {
    id: 'together',
    label: 'Together AI',
    kind: 'credits',
    provider: 'together',
    baseUrl: 'https://api.together.xyz/v1',
    keyEnv: 'TOGETHER_API_KEY',
    modelEnv: 'TOGETHER_MODEL',
    defaultModel: 'deepseek-ai/DeepSeek-V3',
    pricing: 'free credit on signup',
    limits: 'credit-based',
    signupUrl: 'https://api.together.ai',
    outOfBox: false,
    activationEnv: 'TOGETHER_API_KEY',
    notes: '200+ open models, DeepSeek/Llama/Qwen/FLUX. Signup credit, then pay-as-you-go. Endpoint live-verified.',
  },
  {
    id: 'mistral',
    label: 'Mistral La Plateforme',
    kind: 'free-tier',
    provider: 'mistral',
    baseUrl: 'https://api.mistral.ai/v1',
    keyEnv: 'MISTRAL_API_KEY',
    modelEnv: 'MISTRAL_MODEL',
    defaultModel: 'mistral-large-latest',
    pricing: 'free Experiment tier',
    limits: '1 request/sec on the free plan',
    signupUrl: 'https://console.mistral.ai',
    outOfBox: false,
    activationEnv: 'MISTRAL_API_KEY',
    notes: 'Mistral Large, Codestral and the open Mistral line, free tier with a console account. Endpoint live-verified.',
  },
  {
    id: 'gemini',
    label: 'Google AI Studio — Gemini',
    kind: 'free-tier',
    provider: 'gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    keyEnv: 'GEMINI_API_KEY',
    modelEnv: 'GEMINI_MODEL',
    defaultModel: 'gemini-2.0-flash',
    pricing: 'free tier',
    limits: 'generous free daily quota (aistudio.google.com)',
    signupUrl: 'https://aistudio.google.com',
    outOfBox: false,
    activationEnv: 'GEMINI_API_KEY',
    notes: 'Gemini Pro/Flash with a free AI Studio key — the SAME key also powers the Gemini voice engine (Settings → Voice), and when the server\'s Google egress is region-blocked, her open browser relays the lane\'s requests. One key, mind and voice.',
  },
  {
    id: 'local-runtime',
    label: 'Ollama / LM Studio — truly unlimited local',
    kind: 'local',
    provider: 'qwen',
    baseUrl: 'http://127.0.0.1:11434/v1',
    keyEnv: null,
    modelEnv: 'MIST_QWEN_MODEL',
    defaultModel: 'hermes4',
    pricing: 'free forever',
    limits: 'unlimited — your hardware is the limit',
    signupUrl: 'https://ollama.com',
    outOfBox: true,
    activationEnv: null,
    notes:
      'ollama serve exposes an OpenAI-compatible API on :11434. Set MIST_QWEN_BASE_URL=http://127.0.0.1:11434/v1 and pull any weights — hermes4, llama3.3, qwen3, deepseek-r1, gemma3. Zero keys, zero cost, works offline.',
  },
  {
    id: 'omniroute',
    label: 'OmniRoute — any gateway you run',
    kind: 'gateway',
    provider: 'omniroute',
    baseUrl: null,
    keyEnv: 'OMNIROUTE_API_KEY',
    modelEnv: 'OMNIROUTE_MODEL',
    defaultModel: 'auto',
    pricing: 'whatever your gateway costs',
    limits: 'unlimited (your gateway\u0027s limits are the only limits)',
    signupUrl: null,
    outOfBox: false,
    activationEnv: 'OMNIROUTE_BASE_URL',
    notes:
      'The "web cookies" pattern, done honestly: run ANY OpenAI-compatible gateway on your own machine (community cookie-fed routers, gpt4free, your own proxies) and point OMNIROUTE_BASE_URL at it. Mist speaks plain OpenAI protocol — your sessions, your rules, your responsibility.',
  },
]

// ---------- live status ----------

function laneStatus(lane: LaneDef): FreeLaneInfo['status'] {
  if (lane.kind === 'keyless') {
    // zero-auth lanes are live the moment Mist boots; MIST_KEYLESS=0 opts out
    return process.env.MIST_KEYLESS === '0' ? 'ready' : 'active'
  }
  if (lane.kind === 'gateway') {
    return process.env.OMNIROUTE_BASE_URL?.trim() ? 'active' : 'custom'
  }
  if (lane.activationEnv) {
    return process.env[lane.activationEnv]?.trim() ? 'active' : 'ready'
  }
  // local lanes: active when their base URL is selected on the matching provider
  if (lane.id === 'hermes-gateway') {
    return process.env.MIST_NOUS_BASE_URL?.includes('8642') ? 'active' : 'ready'
  }
  if (lane.id === 'local-runtime') {
    const qwenLocal = /127\.0\.0\.1|localhost/.test(process.env.MIST_QWEN_BASE_URL ?? '')
    const nousLocal = /127\.0\.0\.1|localhost/.test(process.env.MIST_NOUS_BASE_URL ?? '')
    return qwenLocal || nousLocal ? 'active' : 'ready'
  }
  return 'ready'
}

/** Full lane map with live activation status (keys never exposed). */
export function getFreeLanesInfo(): FreeLaneInfo[] {
  return LANES.map((lane) => {
    const { activationEnv: _activationEnv, ...rest } = lane
    return { ...rest, status: laneStatus(lane) }
  })
}

// ---------- live model discovery ----------

interface DiscoveredModel {
  id: string
  owned_by?: string
  context_length?: number
}

/** Endpoints whose /models list is public (discovery without a key). */
const PUBLIC_CATALOG_LANES = new Set(['openrouter', 'huggingface', 'kilo', 'pollinations', 'llm7', 'ovh'])

/**
 * Discover the REAL model list a lane serves right now. Throws with a plain
 * reason when the lane needs a key it doesn't have (except public catalogs).
 */
export async function discoverLaneModels(laneId: string): Promise<DiscoveredModel[]> {
  const lane = LANES.find((l) => l.id === laneId)
  if (!lane) throw new Error(`unknown lane "${laneId}"`)

  let url: string
  const key = lane.keyEnv ? process.env[lane.keyEnv]?.trim() : undefined
  if (laneId === 'openrouter') url = 'https://openrouter.ai/api/v1/models'
  else if (laneId === 'huggingface') url = 'https://router.huggingface.co/v1/models'
  else if (laneId === 'kilo') {
    // Kilo's public catalog lives at /models on the gateway root (not /v1).
    // The full catalog lists ~394 models — only the FREE pool serves keyless.
    const res = await fetchJson('https://api.kilo.ai/api/gateway/models', 20_000)
    const data = (res as { data?: Array<Record<string, unknown>> })?.data ?? []
    return data
      .filter(
        (m) =>
          (typeof m?.id === 'string' && (m.id.endsWith(':free') || m.id === 'kilo-auto/free')) ||
          m?.isFree === true
      )
      .map((m) => ({
        id: String(m.id),
        owned_by: 'free pool',
        ...(typeof m.context_length === 'number' ? { context_length: m.context_length } : {}),
      }))
      .filter((m) => m.id.trim().length > 0)
  } else if (laneId === 'pollinations') {
    // Pollinations returns a PLAIN ARRAY of {name, description, tier…}
    const res = await fetchJson('https://text.pollinations.ai/models', 20_000)
    const arr = Array.isArray(res) ? res : []
    return arr
      .filter((m): m is Record<string, unknown> => typeof m?.name === 'string' && m.name.trim().length > 0)
      .map((m) => ({
        id: String(m.name),
        ...(m.tier === 'anonymous' ? { owned_by: 'anonymous tier' } : {}),
      }))
  } else if (laneId === 'gemini') {
    if (!key) throw new Error('GEMINI_API_KEY not set — get a free key at aistudio.google.com')
    const res = await fetchJson(`https://generativelanguage.googleapis.com/v1beta/models?key=${key}`, 15_000)
    const models = (res as { models?: Array<{ name?: string }> }).models ?? []
    return models
      .map((m) => ({ id: (m.name ?? '').replace(/^models\//, '') }))
      .filter((m) => m.id)
  } else if (lane.baseUrl) {
    if (!key && !PUBLIC_CATALOG_LANES.has(laneId) && lane.kind !== 'local') {
      throw new Error(`${lane.keyEnv} not set — set the key first, then discover`)
    }
    url = lane.baseUrl.replace(/\/+$/, '').endsWith('/v1')
      ? `${lane.baseUrl.replace(/\/+$/, '')}/models`
      : `${lane.baseUrl.replace(/\/+$/, '')}/v1/models`
  } else {
    throw new Error('this lane has no fixed catalog — set its base URL first')
  }

  const res = await fetchJson(url, 20_000)
  const data = (res as { data?: Array<Record<string, unknown>> }).data
  if (!Array.isArray(data)) throw new Error('unexpected catalog response')
  return data
    .map((m) => ({
      id: String(m.id),
      // llm7 marks each model's tier — turbo is the keyless one, show it
      ...(m.owned_by ? { owned_by: String(m.owned_by) } : {}),
      ...(typeof m.tier === 'string' ? { owned_by: `${m.tier} tier` } : {}),
      ...(typeof m.context_length === 'number'
        ? { context_length: m.context_length }
        : typeof (m.context_window as { tokens?: unknown } | undefined)?.tokens === 'number'
          ? { context_length: (m.context_window as { tokens: number }).tokens }
          : {}),
    }))
    .filter((m) => m.id.trim().length > 0)
    .slice(0, 500)
}

async function fetchJson(url: string, timeoutMs: number): Promise<unknown> {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  try {
    const headers: Record<string, string> = { Accept: 'application/json' }
    // OpenRouter likes an identifying header; harmless elsewhere.
    if (url.includes('openrouter.ai')) headers['X-Title'] = 'MIST'
    const res = await fetch(url, { headers, signal: ac.signal, cache: 'no-store' })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return (await res.json()) as unknown
  } finally {
    clearTimeout(timer)
  }
}

/** Which provider id serves a lane (for cascade wiring sanity). */
export function laneProvider(laneId: string): ProviderId | null {
  return LANES.find((l) => l.id === laneId)?.provider ?? null
}
