// M.I.S.T. LLM service — the brain.
// Cascade: omniroute → openai_compatible → openrouter → anthropic → gemini → core → offline-mind.
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
import { getZai } from './zai'
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
import { buildContext, type BuiltContext } from './context-builder'
import { findTool, executeTool } from './tools-service'
import { upsertFact } from './memory-service'
import { markLlmActivity, recordActivity } from './activity-service'
import { onTurnComplete } from './learning-service'

const LLM_TIMEOUT_MS = 30_000
// 8 rounds: real autonomy chains are deep — bridge_status + owner_files list +
// per-file moves + a verification pass can legitimately need 6+ rounds, and a
// starved budget used to strand her mid-chain ("Let me check…" accepted as the
// final answer while nothing was finished).
const MAX_TOOL_ROUNDS = 8
const CASCADE: ProviderId[] = [
  'omniroute',
  'openai_compatible',
  'openrouter',
  'qwen',
  'anthropic',
  'gemini',
  'core',
  'offline-mind',
]
const ENV_PROVIDER_IDS: ProviderId[] = [
  'omniroute',
  'openai_compatible',
  'openrouter',
  'qwen',
  'anthropic',
  'gemini',
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
    case 'openai_compatible':
      return {
        id,
        baseUrl: env.OPENAI_BASE_URL?.trim() || null,
        apiKey: env.OPENAI_API_KEY?.trim() || null,
        model: env.OPENAI_MODEL?.trim() || mistModel || 'gpt-4o-mini',
        configured: Boolean(env.OPENAI_BASE_URL?.trim()),
      }
    case 'openrouter':
      return {
        id,
        baseUrl: 'https://openrouter.ai/api/v1/chat/completions',
        apiKey: env.OPENROUTER_API_KEY?.trim() || null,
        model: env.OPENROUTER_MODEL?.trim() || mistModel || 'openrouter/auto',
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
        model: env.GEMINI_MODEL?.trim() || mistModel || 'gemini-2.0-flash',
        configured: Boolean(env.GEMINI_API_KEY?.trim()),
      }
    case 'core': {
      const sel = getCoreTextModelSelection()
      const liveNow = getCoreLiveModels()
      return { id, baseUrl: null, apiKey: null, model: sel ?? liveNow.text ?? 'auto', configured: true }
    }
    case 'offline-mind':
    case 'auto':
    default:
      return { id, baseUrl: null, apiKey: null, model: 'deterministic-fallback', configured: true }
  }
}

function isConfigured(id: ProviderId): boolean {
  if (id === 'core' || id === 'offline-mind') return true
  if (id === 'qwen') return isQwenConfigured()
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
    detail('openai_compatible', 'OpenAI-compatible'),
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
    detail('anthropic', 'Anthropic'),
    detail('gemini', 'Gemini'),
    {
      id: 'core',
      label: 'Mist Core (local)',
      available: true,
      model: coreDisplayModel,
      note: liveNow.text
        ? `built-in GLM brain · gateway serving ${liveNow.text}`
        : 'built-in GLM brain via the Z.ai gateway',
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
  }
}

// ---------- HTTP helpers ----------

async function fetchJson(url: string, init: RequestInit): Promise<unknown> {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), LLM_TIMEOUT_MS)
  try {
    const res = await fetch(url, { ...init, signal: ac.signal, cache: 'no-store' })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return (await res.json()) as unknown
  } finally {
    clearTimeout(timer)
  }
}

function openAiEndpoint(base: string): string {
  if (base.endsWith('/chat/completions')) return base
  if (base.endsWith('/v1')) return `${base}/chat/completions`
  if (base.endsWith('/v1/')) return `${base}chat/completions`
  return `${base.replace(/\/+$/, '')}/v1/chat/completions`
}

async function callOpenAiCompatible(
  cfg: ProviderConfig,
  systemPrompt: string,
  messages: SimMessage[]
): Promise<string> {
  const endpoint = openAiEndpoint(cfg.baseUrl ?? '')
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`
  const json = await fetchJson(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: cfg.model,
      messages: [{ role: 'system', content: systemPrompt }, ...messages],
      max_tokens: 2048,
      temperature: 0.7,
    }),
  })
  const content = (json as { choices?: Array<{ message?: { content?: unknown } }> })?.choices?.[0]
    ?.message?.content
  if (typeof content !== 'string' || !content.trim()) throw new Error('empty completion')
  return content
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
  opts?: { vision?: boolean }
): Promise<{ text: string; reportedModel: string | null }> {
  const endpoint = openAiEndpoint(cfg.baseUrl ?? '')
  const model = opts?.vision ? getQwenVisionModelSelection() : cfg.model
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`
  const json = (await fetchJson(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model,
      messages: [{ role: 'system', content: systemPrompt }, ...messages],
      max_tokens: 2048,
      temperature: 0.7,
    }),
  })) as {
    model?: unknown
    choices?: Array<{ message?: { content?: unknown } }>
  }
  const content = json?.choices?.[0]?.message?.content
  if (typeof content !== 'string' || !content.trim()) throw new Error('empty completion from qwen endpoint')
  const reported = typeof json?.model === 'string' && json.model.trim() ? json.model.trim() : null
  if (reported) noteQwenReportedModel(opts?.vision ? 'vision' : 'text', reported)
  return { text: content, reportedModel: reported }
}

async function callAnthropic(
  cfg: ProviderConfig,
  systemPrompt: string,
  messages: SimMessage[]
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
  })
  const content = (json as { content?: Array<{ type?: string; text?: unknown }> })?.content
  const firstText = content?.find((b) => typeof b.text === 'string')?.text
  if (typeof firstText !== 'string' || !firstText.trim()) throw new Error('empty completion')
  return firstText
}

async function callGemini(
  cfg: ProviderConfig,
  systemPrompt: string,
  messages: SimMessage[]
): Promise<string> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(cfg.model)}:generateContent?key=${cfg.apiKey ?? ''}`
  const json = await fetchJson(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents: messages.map((m) => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }],
      })),
    }),
  })
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
 * Mist Core call through the z-ai SDK.
 * - forwards the selected text/vision model when one is set (gateway decides final routing)
 * - vision/video mode rides the vision endpoint (serves the vision model),
 *   falling back to the text endpoint if the gateway rejects the call
 * - always captures the model the gateway reports back
 */
async function callCore(
  systemPrompt: string,
  messages: SimMessage[],
  opts?: { vision?: boolean }
): Promise<CoreCallResult> {
  const zai = await getZai()
  const chatMessages: SdkChatMessage[] = [{ role: 'assistant', content: systemPrompt }, ...messages]
  const textModel = getCoreTextModelSelection()
  const visionModel = getCoreVisionModelSelection()
  let timer: ReturnType<typeof setTimeout> | undefined

  const arm = () =>
    new Promise<never>((_, reject) => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => reject(new Error('core timeout')), LLM_TIMEOUT_MS)
    })

  const runText = async (): Promise<{ completion: unknown; kind: 'text' | 'vision' }> => ({
    completion: await Promise.race([
      zai.chat.completions.create({
        ...(textModel ? { model: textModel } : {}),
        messages: chatMessages,
        thinking: { type: 'disabled' },
      }),
      arm(),
    ]),
    kind: 'text',
  })

  const runVision = async (): Promise<{ completion: unknown; kind: 'text' | 'vision' }> => ({
    completion: await Promise.race([
      // model is required by SDK types but omitted from the JSON body when unset → gateway routing
      zai.chat.completions.createVision({
        model: (visionModel ?? undefined) as string,
        messages: chatMessages,
        thinking: { type: 'disabled' },
      }),
      arm(),
    ]),
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
  }
}

async function callProvider(
  id: ProviderId,
  cfg: ProviderConfig,
  systemPrompt: string,
  messages: SimMessage[],
  opts?: { vision?: boolean }
): Promise<{ text: string; reportedModel: string | null }> {
  switch (id) {
    case 'omniroute':
    case 'openai_compatible':
      return { text: await callOpenAiCompatible(cfg, systemPrompt, messages), reportedModel: null }
    case 'openrouter':
      return { text: await callOpenAiCompatible(cfg, systemPrompt, messages), reportedModel: null }
    case 'qwen':
      return callQwen(cfg, systemPrompt, messages, opts)
    case 'anthropic':
      return { text: await callAnthropic(cfg, systemPrompt, messages), reportedModel: null }
    case 'gemini':
      return { text: await callGemini(cfg, systemPrompt, messages), reportedModel: null }
    case 'core':
      return callCore(systemPrompt, messages, opts)
    default:
      throw new Error(`provider ${id} cannot serve completions`)
  }
}

/**
 * Raw cascade completion for internal brains (evolution drafting, dream
 * composition): runs the active provider order with a system+user pair — no
 * tool loop, no envelope parsing. Falls through the cascade exactly like chat
 * (user provider → core → …) so internal brains never die with a single
 * provider outage. Throws when every configured provider fails.
 */
export async function cascadeComplete(
  system: string,
  user: string,
  opts?: { timeoutMs?: number }
): Promise<{ text: string; provider: ProviderId; model: string }> {
  const messages: SimMessage[] = [{ role: 'user', content: user }]
  const timeoutMs = opts?.timeoutMs ?? 150_000
  for (const p of providerOrder()) {
    if (p === 'offline-mind') continue
    const cfg = resolveProviderConfig(p)
    if (!cfg.configured) continue
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const res = await Promise.race([
        callProvider(p, cfg, system, messages),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`cascade ${p} timeout`)), timeoutMs)
        }),
      ])
      return { text: res.text.trim(), provider: p, model: res.reportedModel ?? cfg.model }
    } catch {
      // provider failed — cascade to the next one
    } finally {
      if (timer) clearTimeout(timer)
    }
  }
  throw new Error('no provider in the cascade could serve the completion')
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
const INTENT_OPENERS =
  /^\s*(?:sure|certainly|of course|absolutely|right away|on it|i'?m on it|consider it done|consider it handled|yes|yeah|yep|ok(?:ay)?|going to|i(?:'| a)m going to|i'll|i shall|i will|i can do that|i'd be happy to|let me|allow me|affirmative|as you wish|very good|at once|at your service)\b/i
// verb STEMS (prefix-match): covers list/listing/running/getting/making/…
const ACTION_VERBS =
  /\b(?:list|check|get|fetch|find|grab|pull|look|search|scan|show|display|open|launch|start|run|execut|move|copi|copy|transfer|delet|remov|renam|creat|mak|writ|read|inspect|sort|organiz|clean|count|summar|analyz|monitor|watch|track|notif|remind|updat|install|download|upload|send|prepar|handl|take care of|go through|dig)/i

function looksLikeIntentNarration(text: string): boolean {
  const trimmed = text.trim()
  if (trimmed.length === 0 || trimmed.length > 260) return false
  // a clarifying question back to the user is a legitimate turn, not narration
  if (trimmed.endsWith('?')) return false
  // structured payload (markdown list/table/code block) reads like real output
  if (/^[-*•]\s|\n\s*[-*•]\s|\n\s*\d+\.\s|\|.*\||```/m.test(trimmed)) return false
  return INTENT_OPENERS.test(trimmed) && ACTION_VERBS.test(trimmed)
}

// ---------- the unified flow ----------

export async function unified(req: UnifiedLlmRequest): Promise<UnifiedLlmResponse> {
  const startedAt = Date.now()
  const message = req.message
  const mode: UnifiedMode = req.mode ?? 'consciousness'
  markLlmActivity()

  let context: BuiltContext
  try {
    context = await buildContext(message, mode, req.extra)
  } catch {
    context = EMPTY_CONTEXT
  }

  const messages: SimMessage[] = [...sanitizeHistory(req.history), { role: 'user', content: message }]
  const order = providerOrder(req.provider)
  // vision/video mode rides Mist Core's vision endpoint (serves the vision model)
  const coreVision = mode === 'vision'

  const tools_used: string[] = []
  let skill_hint: SkillHint | null = null
  let finalText = ''
  let envelope: ParsedEnvelope = { ...NEUTRAL_ENVELOPE }
  let servingProvider: ProviderId = 'offline-mind'
  let servingModel = 'deterministic-fallback'
  let fallback = false

  const callWithCascade = async (): Promise<{ text: string; provider: ProviderId; model: string } | null> => {
    for (const p of order) {
      if (p === 'offline-mind') continue
      const cfg = resolveProviderConfig(p)
      if (!cfg.configured) continue
      try {
        const res = await callProvider(p, cfg, context.prompt, messages, { vision: coreVision })
        // Mist Core: attribute the model the gateway actually reported (e.g. glm-4-plus)
        return { text: res.text.trim(), provider: p, model: res.reportedModel ?? cfg.model }
      } catch (err) {
        recordActivity('llm', `${p} failed: ${err instanceof Error ? err.message : 'unknown error'}`)
      }
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

      const toolCall = tryParseToolCall(res.text)
      if (!toolCall) {
        const parsed = tryParseEnvelope(res.text)
        if (parsed) {
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
        break
      }

      // Still trying tools on the last round → honest partial answer + options
      if (lastRound) {
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
        const result = await executeTool(toolCall.tool, toolCall.args, false)
        if (result.success) {
          tools_used.push(toolCall.tool)
          skill_hint = { tool: toolCall.tool, args: toolCall.args }
          messages.push({
            role: 'user',
            content:
              `TOOL_RESULT for ${toolCall.tool} (data for you — never repeat it verbatim): ` +
              `${JSON.stringify(result.output).slice(0, 6000)}\n\n` +
              'Next: reply with ONLY {"tool_call":{"tool":"<name>","args":{...}}} for another tool, or your final answer.',
          })
        } else {
          messages.push({
            role: 'user',
            content:
              `TOOL_RESULT for ${toolCall.tool} (data for you — never repeat it verbatim): ` +
              `${JSON.stringify({ error: result.error }).slice(0, 4000)}\n\n` +
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
  const remembered: string[] = []
  for (const entry of envelope.remember) {
    const sep = entry.indexOf(':')
    if (sep <= 0) continue
    const key = entry.slice(0, sep).trim().slice(0, 60)
    const value = entry.slice(sep + 1).trim().slice(0, 500)
    if (!key || !value) continue
    try {
      await upsertFact(key, value)
      remembered.push(`${key}: ${value}`)
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

  return response
}
