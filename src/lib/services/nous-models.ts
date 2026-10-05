// M.I.S.T. nous-models — Nous Research / Hermes provider catalog, lane
// resolution and live reporting. Shared by llm-service (no service imports).
//
// HONESTY CONTRACT (same as the Qwen provider):
//   "Use Nous Research models in Mist" is only true when the model id sent is
//   one the SERVING ENDPOINT actually understands, and the attribution shown
//   is what the endpoint reports back — never an alias. Three real lanes:
//     • Nous Portal cloud — https://inference-api.nousresearch.com/v1
//       (Nous Research's official inference API; live-probed 2026-09-27: a
//       417-model aggregator incl. GPT-6 / Claude Opus / Gemini / DeepSeek /
//       GLM / Qwen, needs MIST_NOUS_API_KEY from portal.nousresearch.com)
//     • The user's local Hermes agent gateway — http://127.0.0.1:8642/v1
//       (NousResearch/hermes-agent exposes an OpenAI-compatible surface; the
//       Mist Bridge probes its /health — same lane the hermes_* tools use)
//     • Any local runtime serving Hermes weights — Ollama (hermes4, hermes3),
//       vLLM, LM Studio — via MIST_NOUS_BASE_URL
//   Hermes models also ride OpenRouter as nousresearch/hermes-4-405b etc.

import type { CoreModelOption, NousLane, NousModelsInfo } from '@/lib/types'

// ---------- catalog (cloud Nous Portal ids + local runtime ids) ----------

export interface NousModelOption extends CoreModelOption {
  /** Ollama/local-runtime model id for the same weights (e.g. 'hermes4:70b'). */
  localId?: string
  /** OpenRouter id for the same weights (documentation + routing hint). */
  openRouterId?: string
}

export const NOUS_TEXT_MODELS: NousModelOption[] = [
  { id: 'Hermes-4-405B', label: 'Hermes 4 405B', tier: 'flagship', live_verified: false, localId: 'hermes4:405b', openRouterId: 'nousresearch/hermes-4-405b' },
  { id: 'Hermes-4-70B', label: 'Hermes 4 70B', tier: 'flagship', live_verified: false, localId: 'hermes4:70b', openRouterId: 'nousresearch/hermes-4-70b' },
  { id: 'Hermes-3-Llama-3.1-405B', label: 'Hermes 3 405B', tier: 'flagship', live_verified: false, localId: 'hermes3:405b', openRouterId: 'nousresearch/hermes-3-llama-3.1-405b' },
  { id: 'Hermes-3-Llama-3.1-70B', label: 'Hermes 3 70B', tier: 'flagship', live_verified: false, localId: 'hermes3:70b', openRouterId: 'nousresearch/hermes-3-llama-3.1-70b' },
  { id: 'Hermes-3-Llama-3.1-8B', label: 'Hermes 3 8B', tier: 'light', live_verified: false, localId: 'hermes3:8b', openRouterId: 'nousresearch/hermes-3-llama-3.1-8b' },
  { id: 'DeepHermes-3-Llama-3-8B-Preview', label: 'DeepHermes 3 8B', tier: 'thinking', live_verified: false, localId: 'deephermes3' },
  { id: 'Hermes-2-Pro-Llama-3-8B', label: 'Hermes 2 Pro 8B', tier: 'legacy', live_verified: false, localId: 'hermespro' },
]

export const NOUS_VISION_MODELS: NousModelOption[] = [
  // Hermes model family is text-first; vision rides other lanes. The Nous
  // Portal aggregator serves multimodal models under their own ids — use
  // Discover in Settings to pick the real id for your lane.
  { id: 'Qwen/Qwen3.8-Omni-Flash', label: 'Qwen3.8 Omni Flash (portal)', tier: 'vision', live_verified: false },
]

// ---------- endpoint + lane resolution (read at call time so /config/env applies live) ----------

export const NOUS_PORTAL_BASE_URL = 'https://inference-api.nousresearch.com/v1'
export const HERMES_GATEWAY_BASE_URL = 'http://127.0.0.1:8642/v1'

export function getNousBaseUrl(): string {
  const raw = process.env.MIST_NOUS_BASE_URL?.trim()
  return raw || NOUS_PORTAL_BASE_URL
}

export function getNousApiKey(): string | null {
  const raw = process.env.MIST_NOUS_API_KEY?.trim()
  return raw || null
}

/** Which lane does the current base URL point at? */
export function getNousLane(): NousLane {
  let host = ''
  let port = 0
  try {
    const u = new URL(getNousBaseUrl())
    host = u.hostname
    port = Number(u.port) || (u.protocol === 'https:' ? 443 : 80)
  } catch {
    return 'custom'
  }
  if (host === 'inference-api.nousresearch.com') return 'nous-portal'
  if ((host === '127.0.0.1' || host === 'localhost' || host === '::1') && port === 8642) return 'hermes-gateway'
  if (host === '127.0.0.1' || host === 'localhost' || host === '0.0.0.0' || host === '::1') return 'local'
  return 'custom'
}

/** True when the base URL points at a local runtime (Hermes gateway, Ollama, vLLM) — keyless by design. */
export function isNousKeylessLocal(): boolean {
  const lane = getNousLane()
  return lane === 'hermes-gateway' || lane === 'local'
}

export function isNousConfigured(): boolean {
  return isNousKeylessLocal() || Boolean(getNousApiKey())
}

/**
 * Resolve the model id for a call. Explicit MIST_NOUS_MODEL wins verbatim
 * (any lane, any id — including aggregator ids discovered in Settings).
 * 'auto' maps the flagship to the right id per lane.
 */
export function resolveNousModelId(): string {
  const raw = process.env.MIST_NOUS_MODEL?.trim()
  if (raw && raw !== 'auto') return raw
  const lane = getNousLane()
  if (lane === 'hermes-gateway') return 'hermes4' // the Hermes agent's own model naming
  if (lane === 'local') return NOUS_TEXT_MODELS[0].localId ?? 'hermes4:405b'
  return NOUS_TEXT_MODELS[0].id // cloud flagship id
}

/** Raw stored selection — for status display. */
export function getNousSelection(): string {
  return process.env.MIST_NOUS_MODEL?.trim() || 'auto'
}

// ---------- live reported models (what the endpoint actually served) ----------

const liveGlobal = globalThis as unknown as {
  __mistNousLive?: { text: string | null; vision: string | null }
}
const live = (liveGlobal.__mistNousLive ??= { text: null, vision: null })

/** Record the model name the Nous endpoint REPORTED for a completed call. */
export function noteNousReportedModel(kind: 'text' | 'vision', model: unknown): void {
  if (typeof model !== 'string' || !model.trim()) return
  live[kind] = model.trim()
}

export function getNousLiveModels(): { text: string | null; vision: string | null } {
  return { text: live.text, vision: live.vision }
}

// ---------- status block ----------

const LANE_LABELS: Record<NousLane, string> = {
  'nous-portal': 'Nous Portal cloud (417-model aggregator)',
  'hermes-gateway': 'Local Hermes agent gateway (:8642)',
  local: 'Local runtime (Ollama / vLLM / LM Studio)',
  custom: 'Custom OpenAI-compatible endpoint',
}

export function getNousModelsInfo(): NousModelsInfo {
  const lane = getNousLane()
  return {
    configured: isNousConfigured(),
    base_url: getNousBaseUrl(),
    keyless_local: isNousKeylessLocal(),
    lane,
    text: NOUS_TEXT_MODELS,
    vision: NOUS_VISION_MODELS,
    selected: { text: getNousSelection(), vision: 'auto' },
    live: getNousLiveModels(),
  }
}

/** Human label for the active lane (status lines + settings). */
export function nousLaneLabel(): string {
  return LANE_LABELS[getNousLane()]
}
