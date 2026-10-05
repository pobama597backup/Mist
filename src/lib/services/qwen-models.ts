// M.I.S. qwen-models — Qwen provider catalog, selection and live reporting.
// Shared by llm-service (no service imports — no cycles).
//
// HONESTY CONTRACT (why this provider exists):
//   The Z.ai gateway that powers Mist Core CANNOT serve Qwen — live probes show
//   every request (even model:'qwen-max') is routed to glm-4-plus. Relabeling
//   that as "Qwen" would be an alias and a lie. So the Qwen provider talks to
//   REAL Qwen serving endpoints instead:
//     • DashScope (Alibaba's official OpenAI-compatible API) — needs MIST_QWEN_API_KEY
//     • Any OpenAI-compatible endpoint via MIST_QWEN_BASE_URL (OpenRouter, vLLM, …)
//     • Local Ollama at http://127.0.0.1:11434/v1 — keyless and fully local
//   The model id sent is the REAL catalog id, and the attribution shown is the
//   model name the endpoint REPORTS back — never an alias.

import type { CoreModelOption, QwenModelsInfo } from '@/lib/types'

// ---------- catalog (newest → oldest, real DashScope/Qwen model ids) ----------

export const QWEN_TEXT_MODELS: CoreModelOption[] = [
  { id: 'qwen3-max', label: 'Qwen3 Max', tier: 'flagship', live_verified: false },
  { id: 'qwen3-235b-a22b-instruct-2507', label: 'Qwen3 235B A22B Instruct', tier: 'flagship', live_verified: false },
  { id: 'qwen3-235b-a22b-thinking-2507', label: 'Qwen3 235B A22B Thinking', tier: 'thinking', live_verified: false },
  { id: 'qwen3-coder-plus', label: 'Qwen3 Coder Plus', tier: 'coding', live_verified: false },
  { id: 'qwen3-coder-30b-a3b-instruct', label: 'Qwen3 Coder 30B A3B', tier: 'coding', live_verified: false },
  { id: 'qwen3-32b', label: 'Qwen3 32B', tier: 'thinking', live_verified: false },
  { id: 'qwen3-30b-a3b-instruct-2507', label: 'Qwen3 30B A3B Instruct', tier: 'balanced', live_verified: false },
  { id: 'qwen3-30b-a3b', label: 'Qwen3 30B A3B', tier: 'thinking', live_verified: false },
  { id: 'qwen3-14b', label: 'Qwen3 14B', tier: 'light', live_verified: false },
  { id: 'qwen3-8b', label: 'Qwen3 8B', tier: 'light', live_verified: false },
  { id: 'qwen2.5-max', label: 'Qwen2.5 Max', tier: 'flagship', live_verified: false },
  { id: 'qwen2.5-72b-instruct', label: 'Qwen2.5 72B Instruct', tier: 'flagship', live_verified: false },
  { id: 'qwen2.5-coder-32b-instruct', label: 'Qwen2.5 Coder 32B', tier: 'coding', live_verified: false },
  { id: 'qwen2.5-32b-instruct', label: 'Qwen2.5 32B Instruct', tier: 'balanced', live_verified: false },
  { id: 'qwen2.5-14b-instruct', label: 'Qwen2.5 14B Instruct', tier: 'light', live_verified: false },
  { id: 'qwen2.5-7b-instruct', label: 'Qwen2.5 7B Instruct', tier: 'light', live_verified: false },
  { id: 'qwen-max', label: 'qwen-max (rolling)', tier: 'rolling', live_verified: false },
  { id: 'qwen-plus', label: 'qwen-plus (rolling)', tier: 'rolling', live_verified: false },
  { id: 'qwen-turbo', label: 'qwen-turbo (rolling)', tier: 'rolling', live_verified: false },
]

export const QWEN_VISION_MODELS: CoreModelOption[] = [
  { id: 'qwen3-vl-max', label: 'Qwen3 VL Max', tier: 'flagship', live_verified: false },
  { id: 'qwen3-vl-plus', label: 'Qwen3 VL Plus', tier: 'fast', live_verified: false },
  { id: 'qvq-max', label: 'QVQ Max', tier: 'thinking', live_verified: false },
  { id: 'qwen2.5-vl-72b-instruct', label: 'Qwen2.5 VL 72B', tier: 'flagship', live_verified: false },
  { id: 'qwen2.5-vl-32b-instruct', label: 'Qwen2.5 VL 32B', tier: 'balanced', live_verified: false },
  { id: 'qwen2.5-vl-7b-instruct', label: 'Qwen2.5 VL 7B', tier: 'light', live_verified: false },
  { id: 'qwen-vl-max', label: 'qwen-vl-max (rolling)', tier: 'rolling', live_verified: false },
  { id: 'qwen-vl-plus', label: 'qwen-vl-plus (rolling)', tier: 'rolling', live_verified: false },
]

// ---------- endpoint + selection (read at call time so /config/env applies live) ----------

/** Default: Alibaba DashScope's OpenAI-compatible endpoint. */
export const QWEN_DEFAULT_BASE_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1'

export function getQwenBaseUrl(): string {
  const raw = process.env.MIST_QWEN_BASE_URL?.trim()
  return raw || QWEN_DEFAULT_BASE_URL
}

export function getQwenApiKey(): string | null {
  const raw = process.env.MIST_QWEN_API_KEY?.trim()
  return raw || null
}

/** True when the base URL points at a local runtime (Ollama/vLLM/LM Studio) — keyless by design. */
export function isQwenKeylessLocal(): boolean {
  try {
    const host = new URL(getQwenBaseUrl()).hostname
    return host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0' || host === '::1'
  } catch {
    return false
  }
}

export function isQwenConfigured(): boolean {
  return isQwenKeylessLocal() || Boolean(getQwenApiKey())
}

/** Selected text model id, or the catalog default. */
export function getQwenTextModelSelection(): string {
  const raw = process.env.MIST_QWEN_MODEL?.trim()
  if (!raw || raw === 'auto') return 'qwen3-max'
  return raw
}

/**
 * Resolved vision model id. Special value 'text' means "use the same model as text".
 * 'auto' falls back to the default vision model (qwen3-vl-plus).
 */
export function getQwenVisionModelSelection(): string {
  const raw = process.env.MIST_QWEN_VISION_MODEL?.trim()
  if (!raw || raw === 'auto') return 'qwen3-vl-plus'
  if (raw === 'text') return getQwenTextModelSelection()
  return raw
}

/** Raw stored selections — for status display. */
export function getQwenSelections(): { text: string; vision: string } {
  return {
    text: process.env.MIST_QWEN_MODEL?.trim() || 'auto',
    vision: process.env.MIST_QWEN_VISION_MODEL?.trim() || 'auto',
  }
}

// ---------- live reported models (what the endpoint actually served) ----------

const liveGlobal = globalThis as unknown as {
  __mistQwenLive?: { text: string | null; vision: string | null }
}
const live = (liveGlobal.__mistQwenLive ??= { text: null, vision: null })

/** Record the model name the Qwen endpoint REPORTED for a completed call. */
export function noteQwenReportedModel(kind: 'text' | 'vision', model: unknown): void {
  if (typeof model !== 'string' || !model.trim()) return
  live[kind] = model.trim()
}

export function getQwenLiveModels(): { text: string | null; vision: string | null } {
  return { text: live.text, vision: live.vision }
}

// ---------- status block ----------

export function getQwenModelsInfo(): QwenModelsInfo {
  return {
    configured: isQwenConfigured(),
    base_url: getQwenBaseUrl(),
    keyless_local: isQwenKeylessLocal(),
    text: QWEN_TEXT_MODELS,
    vision: QWEN_VISION_MODELS,
    selected: getQwenSelections(),
    live: getQwenLiveModels(),
  }
}
