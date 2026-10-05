// M.I.S.T. core-models — Mist Core GLM model catalog, selection and live reporting.
// Shared by llm-service, tools-service and research-service (no service imports — no cycles).
//
// TRUTH ABOUT ROUTING (verified live against the Z.ai gateway):
//   • text calls  → the gateway currently serves `glm-4-plus` regardless of the requested model
//   • vision calls → the gateway currently serves `glm-5v-turbo` regardless of the requested model
// The client may REQUEST any catalog model (the param is forwarded), but the gateway decides
// final routing. Every core call captures what the gateway REPORTS back, and that reported name
// is what MIST displays (status, settings, message attribution) — never a guess.

import type { CoreModelOption, CoreModelsInfo } from '@/lib/types'

// ---------- catalog (newest → oldest) ----------

export const CORE_TEXT_MODELS: CoreModelOption[] = [
  { id: 'glm-5.3', label: 'GLM-5.3', tier: 'flagship', live_verified: false },
  { id: 'glm-5', label: 'GLM-5', tier: 'flagship', live_verified: false },
  { id: 'glm-5-turbo', label: 'GLM-5 Turbo', tier: 'fast', live_verified: false },
  { id: 'glm-5-air', label: 'GLM-5 Air', tier: 'light', live_verified: false },
  { id: 'glm-4.6', label: 'GLM-4.6', tier: 'flagship', live_verified: false },
  { id: 'glm-4.6-air', label: 'GLM-4.6 Air', tier: 'light', live_verified: false },
  { id: 'glm-4.5', label: 'GLM-4.5', tier: 'flagship', live_verified: false },
  { id: 'glm-4.5-air', label: 'GLM-4.5 Air', tier: 'light', live_verified: false },
  { id: 'glm-4.5-flash', label: 'GLM-4.5 Flash', tier: 'fast', live_verified: false },
  { id: 'glm-4-plus', label: 'GLM-4 Plus', tier: 'flagship', live_verified: true },
  { id: 'glm-4-air', label: 'GLM-4 Air', tier: 'light', live_verified: false },
  { id: 'glm-4-airx', label: 'GLM-4 AirX', tier: 'balanced', live_verified: false },
  { id: 'glm-4-flash', label: 'GLM-4 Flash', tier: 'fast', live_verified: false },
  { id: 'glm-4-flashx', label: 'GLM-4 FlashX', tier: 'fast', live_verified: false },
  { id: 'glm-4-long', label: 'GLM-4 Long', tier: 'long-context', live_verified: false },
  { id: 'glm-3-turbo', label: 'GLM-3 Turbo', tier: 'legacy', live_verified: false },
]

export const CORE_VISION_MODELS: CoreModelOption[] = [
  { id: 'glm-5v', label: 'GLM-5V', tier: 'flagship', live_verified: false },
  { id: 'glm-5v-turbo', label: 'GLM-5V Turbo', tier: 'fast', live_verified: true },
  { id: 'glm-4.6v', label: 'GLM-4.6V', tier: 'flagship', live_verified: false },
  { id: 'glm-4.5v', label: 'GLM-4.5V', tier: 'flagship', live_verified: false },
  { id: 'glm-4.5v-flash', label: 'GLM-4.5V Flash', tier: 'fast', live_verified: false },
  { id: 'glm-4v-plus-0111', label: 'GLM-4V Plus (0111)', tier: 'flagship', live_verified: false },
  { id: 'glm-4v-plus', label: 'GLM-4V Plus', tier: 'flagship', live_verified: false },
  { id: 'glm-4v-flash', label: 'GLM-4V Flash', tier: 'fast', live_verified: false },
  { id: 'glm-4v', label: 'GLM-4V', tier: 'legacy', live_verified: false },
]

// ---------- selection (read at call time so /config/env applies live) ----------

/** Selected text model id, or null when Auto (gateway routing). */
export function getCoreTextModelSelection(): string | null {
  const raw = process.env.MIST_CORE_TEXT_MODEL?.trim()
  if (!raw || raw === 'auto' || raw === 'none') return null
  return raw
}

/**
 * Resolved vision model id, or null when Auto.
 * Special value 'text' means "use the same model as text" (one model for everything).
 */
export function getCoreVisionModelSelection(): string | null {
  const raw = process.env.MIST_CORE_VISION_MODEL?.trim()
  if (!raw || raw === 'auto' || raw === 'none') return null
  if (raw === 'text') return getCoreTextModelSelection()
  return raw
}

/** Raw stored vision selection ('auto' | 'text' | model id) — for status display. */
export function getCoreVisionSelectionRaw(): string {
  return process.env.MIST_CORE_VISION_MODEL?.trim() || 'auto'
}

// ---------- live reported models (what the gateway actually served) ----------
// Stored on globalThis so every route bundle shares one instance (Next.js dev
// compiles each route with its own module registry — plain module state would
// reset per route, the same reason the prisma client uses a global singleton).

const liveGlobal = globalThis as unknown as {
  __mistCoreLive?: { text: string | null; vision: string | null }
}
const live = (liveGlobal.__mistCoreLive ??= { text: null, vision: null })

/** Record the model name the gateway REPORTED for a completed core call. */
export function noteCoreReportedModel(kind: 'text' | 'vision', model: unknown): void {
  if (typeof model !== 'string' || !model.trim()) return
  live[kind] = model.trim()
}

export function getCoreLiveModels(): { text: string | null; vision: string | null } {
  return { text: live.text, vision: live.vision }
}

// ---------- status block ----------

export function getCoreModelsInfo(): CoreModelsInfo {
  return {
    text: CORE_TEXT_MODELS,
    vision: CORE_VISION_MODELS,
    selected: {
      text: getCoreTextModelSelection() ?? 'auto',
      vision: getCoreVisionSelectionRaw(),
    },
    live: getCoreLiveModels(),
  }
}
