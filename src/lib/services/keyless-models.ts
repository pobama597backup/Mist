// M.I.S.T. keyless-models — the four ZERO-AUTH top-model lanes.
//
// RESEARCH LEDGER (live-probed 2026-09-27, re-probed 2026-09-28 from this machine, no key sent):
//   • Kilo Code (api.kilo.ai/api/gateway) — NO key, NO signup, 200 req/hr per
//     IP. 2026-09-28 re-probe: 14-model free pool; `kilo-auto/free` ROTATED
//     OUT; live-verified serving: cohere/north-mini-code:free, stepfun/
//     step-3.7-flash:free; nemotron-3-ultra-550b:free was upstream-overloaded
//     at probe time (503 — the model-rotation fallback covers exactly this).
//     The pool CHANGES frequently (their docs say the catalog can even lag
//     what actually serves) — so we re-discover it live and fall back across
//     models on failure. Catalog: GET /models is public.
//   • Pollinations (text.pollinations.ai) — NO key, OpenAI-compatible POST
//     /openai (plus a GET prompt API). Verified live keyless: openai-fast
//     (routes to gpt-oss-20b reasoning, tools). Anonymous tier is explicitly
//     NOT affected by their legacy-API deprecation. Catalog: GET /models is
//     public (anonymous-tier models carry tier:"anonymous").
//   • LLM7.io (api.llm7.io/v1) — NO key for `turbo`-tier models. 2026-09-28
//     re-probe: GLM-5.3-Flash ROTATED OUT (glm-5.3/glm-5.2 now exist but are
//     `pro` tier = NOT keyless). Live-verified keyless turbo today: minimax-
//     m2.7 (90%, served a real completion), plus codestral-latest (99.7%) and
//     mistral-Nemo-Instruct-2407 (99.7%); DeepSeek-V4-Flash-0731 is
//     usage_based_only. Anonymous: 1 RPS / 10 RPM / 60 req/hr / 500K tokens
//     per 24h. The catalog ROTATES frequently — we pick from the live list by
//     tier + availability. Catalog: GET /v1/models is public with availability %.
//   • OVHcloud AI Endpoints (oai.endpoints.kepler.ai.cloud.ovh.net/v1) — NO
//     key anonymous tier, 2 RPM per IP per model, EU-hosted. /v1/models is
//     public: Qwen2.5-VL-72B (vision), Mistral-Nemo, gpt-oss, Qwen3.x family.
//     2026-09-28 re-probe: anonymous quota saturated from our shared cloud IP
//     (429) — from a normal home IP it answers; on 429 we rotate the model
//     (each model has its own 2-RPM quota) and then cascade on.
//   • TRUTH ABOUT THE AMBIENT Z.AI SDK (probed 2026-09-28): the gateway
//     ACCEPTS model:'glm-5.3'/'glm-5.2'/… requests (HTTP 200, real text) but
//     REPORTS serving 'glm-4-plus' every time — it silently routes everything
//     to glm-4-plus. Mist Core therefore stays honestly attributed glm-4-plus;
//     requesting GLM-5.x names there is a mirage, not an upgrade.
//
// Why these four: zero auth (the creator's ask), top/new open-weight +
// frontier-adjacent models, generous limits, and every one exposes a PUBLIC
// live catalog — so when the provider rotates models (they do, frequently),
// Mist re-discovers and keeps working. MIST_KEYLESS=0 disables all four.

import type { ProviderId } from '@/lib/types'

export type KeylessId = 'kilo' | 'pollinations' | 'llm7' | 'ovh'

export const KEYLESS_IDS: KeylessId[] = ['kilo', 'pollinations', 'llm7', 'ovh']

/** All four are wired into the cascade as real ProviderIds. */
export function isKeylessProvider(id: ProviderId): id is KeylessId {
  return (KEYLESS_IDS as string[]).includes(id)
}

export interface KeylessModel {
  id: string
  context?: number
  note?: string
}

interface CatalogCache {
  fetchedAt: number
  models: KeylessModel[]
  /** llm7 turbo candidates computed at fetch time (tier+availability aware). */
  turboCandidates: string[]
  error?: string
}

const CATALOG_TTL_MS = 30 * 60_000 // re-discover every 30 min — providers rotate
const caches = new Map<KeylessId, CatalogCache>()

const CATALOG_URLS: Record<KeylessId, string> = {
  kilo: 'https://api.kilo.ai/api/gateway/models',
  pollinations: 'https://text.pollinations.ai/models',
  llm7: 'https://api.llm7.io/v1/models',
  ovh: 'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1/models',
}

/** Static defaults that always work today; live discovery refines these. */
export const KEYLESS_DEFAULTS: Record<KeylessId, { model: string; fallbacks: string[] }> = {
  kilo: {
    model: 'nvidia/nemotron-3-ultra-550b-a55b:free',
    // 2026-09-28 verified rotation: kilo-auto/free rotated OUT of the free
    // pool; north-mini-code:free and step-3.7-flash:free served real
    // completions keyless today (nemotron-ultra was upstream-overloaded).
    fallbacks: [
      'nvidia/nemotron-3-super-120b-a12b:free',
      'cohere/north-mini-code:free',
      'stepfun/step-3.7-flash:free',
    ],
  },
  pollinations: {
    model: 'openai-fast',
    fallbacks: ['openai'],
  },
  llm7: {
    // resolved live from the turbo tier when unset (catalog rotates)
    model: 'mistral-Nemo-Instruct-2407',
    fallbacks: ['minimax-m2.7', 'codestral-latest', 'mistral-Nemo-Instruct-2407'],
  },
  ovh: {
    model: 'Qwen3.5-397B-A17B',
    fallbacks: ['gpt-oss-120b', 'Qwen3.6-27B', 'Qwen3-Coder-30B-A3B-Instruct', 'Mistral-Small-3.2-24B-Instruct'],
  },
}

/** Kill switch: MIST_KEYLESS=0 disables all four keyless lanes. */
export function keylessEnabled(): boolean {
  return process.env.MIST_KEYLESS !== '0'
}

async function fetchJson(url: string, timeoutMs: number): Promise<unknown> {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: ac.signal,
      cache: 'no-store',
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return (await res.json()) as unknown
  } finally {
    clearTimeout(timer)
  }
}

interface NormalizedCatalog {
  models: KeylessModel[]
  turboCandidates: string[]
}

function normalizeCatalog(id: KeylessId, raw: unknown): NormalizedCatalog {
  if (id === 'pollinations') {
    // plain array: [{name, description, tier, aliases…}]
    const arr = Array.isArray(raw) ? raw : []
    const models = arr
      .filter((m): m is Record<string, unknown> => typeof m?.name === 'string' && m.name.trim().length > 0)
      .map((m) => ({
        id: String(m.name),
        note: [typeof m.description === 'string' ? m.description : '', m.tier === 'anonymous' ? 'anonymous tier' : '']
          .filter(Boolean)
          .join(' · ')
          .slice(0, 80),
      }))
    // anonymous-tier models are the ones reachable keylessly
    const anonymous = arr
      .filter((m): m is Record<string, unknown> => m?.tier === 'anonymous' && typeof m?.name === 'string')
      .map((m) => String(m.name))
    return { models, turboCandidates: anonymous }
  }
  const data = (raw as { data?: unknown })?.data
  if (!Array.isArray(data)) throw new Error('unexpected catalog response')
  const models: KeylessModel[] = []
  const turboCandidates: string[] = []
  for (const m of data.slice(0, 500)) {
    if (typeof m?.id !== 'string' || !m.id.trim()) continue
    const ctx =
      typeof m.context_length === 'number'
        ? m.context_length
        : typeof (m.context_window as { tokens?: unknown } | undefined)?.tokens === 'number'
          ? (m.context_window as { tokens: number }).tokens
          : undefined
    const note = id === 'llm7' && typeof m.tier === 'string' ? `${m.tier} tier` : undefined
    models.push({ id: String(m.id), ...(ctx ? { context: ctx } : {}), ...(note ? { note } : {}) })
    if (
      id === 'llm7' &&
      m.tier === 'turbo' &&
      m.usage_based_only !== true &&
      typeof m.availability_last_hour_percent === 'number' &&
      m.availability_last_hour_percent >= 90
    ) {
      turboCandidates.push(String(m.id))
    }
  }
  return { models, turboCandidates }
}

/**
 * Live model catalog for a keyless provider (30-min TTL, in-memory).
 * Never throws: on failure the last good cache (or the static defaults)
 * keep the lane alive — a catalog outage must never take the lane down.
 */
export async function getKeylessCatalog(id: KeylessId, force = false): Promise<KeylessModel[]> {
  const cached = caches.get(id)
  if (!force && cached && Date.now() - cached.fetchedAt < CATALOG_TTL_MS) return cached.models
  try {
    const raw = await fetchJson(CATALOG_URLS[id], 20_000)
    const { models, turboCandidates } = normalizeCatalog(id, raw)
    caches.set(id, { fetchedAt: Date.now(), models, turboCandidates })
    return models
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    if (cached) {
      caches.set(id, { ...cached, error: reason })
      return cached.models
    }
    caches.set(id, {
      fetchedAt: 0,
      models: KEYLESS_DEFAULTS[id].fallbacks.concat(KEYLESS_DEFAULTS[id].model).map((m) => ({ id: m })),
      turboCandidates: [],
      error: reason,
    })
    return caches.get(id)!.models
  }
}

/** When the catalog was last refreshed (for status display). */
export function keylessCatalogAge(id: KeylessId): { fetchedAt: number | null; error?: string } {
  const cached = caches.get(id)
  if (!cached) return { fetchedAt: null }
  return { fetchedAt: cached.fetchedAt || null, ...(cached.error ? { error: cached.error } : {}) }
}

/**
 * Pick the best llm7 turbo model RIGHT NOW: turbo tier, not usage-based-only,
 * availability ≥ 90% in the last hour, preferring our verified order.
 * Falls back to the static default when the catalog is unreachable.
 */
export async function pickLlm7TurboModel(): Promise<string> {
  await getKeylessCatalog('llm7')
  // 2026-09-28: GLM-5.3-Flash rotated to pro tier (not keyless) — dropped;
  // minimax-m2.7 live-verified keyless today. Live candidates always win.
  const prefer = ['minimax-m2.7', 'mistral-Nemo-Instruct-2407', 'codestral-latest']
  const candidates = caches.get('llm7')?.turboCandidates ?? []
  for (const p of prefer) {
    if (candidates.includes(p)) return p
  }
  if (candidates.length > 0) return candidates[0]
  return KEYLESS_DEFAULTS.llm7.model
}

// ---------- honest attribution (the model that actually served) ----------

const reportedModels = new Map<KeylessId, { model: string; at: number }>()

export function noteKeylessReportedModel(id: KeylessId, model: string): void {
  if (!model.trim()) return
  reportedModels.set(id, { model: model.trim(), at: Date.now() })
}

export function getKeylessReportedModel(id: KeylessId): string | null {
  return reportedModels.get(id)?.model ?? null
}
