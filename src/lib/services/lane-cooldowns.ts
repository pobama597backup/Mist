// M.I.S.T. lane cooldowns — ported from Mark-LV core/gemini.py (FatihMakes).
//
// THE PROBLEM THIS SOLVES (Mark-LV's measured words, still true here):
//   "A rung that answered 429 is out of quota... Retrying it on every single
//    call is a wasted round trip in front of every request the assistant
//    makes. Remembering that for a few minutes turns the ladder from a cost
//    into a saving."
//   and the worst one: "the fourteen-second wait is paid on every call"
//    when a 503/504 lane was never rested at all.
//
// M.I.S.T.'s cascade had the same shape: every call walked every configured
// lane in order, so a lane that 503'd at 12s cost every subsequent request
// that same 12s until it happened to recover. The 2026-09-29 E2E trace showed
// it live (nvidia 503 · openrouter 429 · kilo success — retries paid in full
// each turn).
//
// THE COOLDOWN TABLE (Mark-LV's measured values, categories from oj spine):
//   rate_limit (429 / quota)      →  5 minutes   (quotas refill)
//   upstream (503/504 unavailable)→ 30 minutes   (an outage outlasts a retry)
//   timeout                      → 30 minutes   (same cost as upstream)
//   network                      →  5 minutes   (usually passes quickly)
//   auth (401/403/bad key)       →  6 hours     (a key that is wrong will
//                                                 not fix itself in minutes)
//   context_length / parse /
//   tool_error / guardrail /
//   unknown                      → no cooldown  (call-specific, not the
//                                                 lane's health)
//
// "REFUSING TO CONNECT IS NEVER THE BETTER ANSWER" (Mark-LV) — if EVERY lane
// is cooling, callers ignore the cooldowns and try the normal order anyway.
//
// State is globalThis-guarded (one map per process, dev-HMR safe).

import { classifyError } from '../oj/error-taxonomy'

export type CooldownReason = 'rate_limit' | 'upstream' | 'timeout' | 'network' | 'auth'

export interface LaneCooldownState {
  /** monotonic ms timestamp until which the lane is skipped */
  until: number
  reason: CooldownReason
  /** the error that triggered it (truncated) */
  detail: string
  at: number
}

const STORE_KEY = '__mistLaneCooldowns'

interface CooldownStore {
  lanes: Map<string, LaneCooldownState>
  /** total times a lane was skipped instead of retried (the saved round trips) */
  skipsSaved: number
}

function store(): CooldownStore {
  const g = globalThis as Record<string, unknown>
  if (!g[STORE_KEY]) {
    g[STORE_KEY] = { lanes: new Map<string, LaneCooldownState>(), skipsSaved: 0 } satisfies CooldownStore
  }
  return g[STORE_KEY] as CooldownStore
}

const COOLDOWN_MS: Record<CooldownReason, number> = {
  rate_limit: 5 * 60_000,
  upstream: 30 * 60_000,
  timeout: 30 * 60_000,
  network: 5 * 60_000,
  auth: 6 * 60 * 60_000,
}

/** Record a lane failure and start its cooldown. Returns the cooldown state
 *  (or null when the error category does not implicate the lane's health). */
export function noteLaneFailure(lane: string, err: string | Error | unknown): LaneCooldownState | null {
  const msg = err instanceof Error ? err.message : String(err ?? '')
  const { category } = classifyError(msg)
  let reason: CooldownReason | null = null
  if (category === 'rate_limit') reason = 'rate_limit'
  else if (category === 'upstream') reason = 'upstream'
  else if (category === 'timeout') reason = 'timeout'
  else if (category === 'network') reason = 'network'
  else if (category === 'auth') reason = 'auth'
  if (!reason) return null

  const state: LaneCooldownState = {
    until: Date.now() + COOLDOWN_MS[reason],
    reason,
    detail: msg.slice(0, 200),
    at: Date.now(),
  }
  store().lanes.set(lane, state)
  console.warn(
    `[lane-cooldown] ${lane} rested ${COOLDOWN_MS[reason] / 60_000}min (${reason}): ${msg.slice(0, 140)}`
  )
  return state
}

/** A lane that ANSWERED is healthy — clear any stale cooldown. */
export function noteLaneSuccess(lane: string): void {
  store().lanes.delete(lane)
}

/** True while the lane should be skipped. Expired entries clean themselves. */
export function laneCooling(lane: string): boolean {
  const s = store().lanes.get(lane)
  if (!s) return false
  if (Date.now() >= s.until) {
    store().lanes.delete(lane)
    return false
  }
  return true
}

/** The cooldown view (if any) for a lane — for status surfaces. */
export function laneCooldownInfo(lane: string): LaneCooldownState | null {
  const s = store().lanes.get(lane)
  if (!s) return null
  if (Date.now() >= s.until) {
    store().lanes.delete(lane)
    return null
  }
  return s
}

/** Filter a lane order: cooling lanes drop to the end (kept as last-resort
 *  fallback — Mark-LV: "a model that is unwell today is a real rung
 *  tomorrow"), unless EVERY lane is cooling, in which case the original
 *  order is returned untouched (refusing to connect is never better). */
export function orderWithCooldowns<T extends string>(order: readonly T[]): T[] {
  const s = store()
  const fresh = order.filter((lane) => {
    if (laneCooling(lane)) {
      s.skipsSaved++
      return false
    }
    return true
  })
  if (fresh.length === 0) return [...order] // all cooling — try anyway
  const cooling = order.filter((lane) => !fresh.includes(lane))
  return [...fresh, ...cooling]
}

/** Cooldown snapshot for her llm_pools / self-status surfaces. */
export function laneCooldownSnapshot(): {
  lanes: Array<LaneCooldownState & { lane: string; remainingMin: number }>
  skipsSaved: number
} {
  const s = store()
  const now = Date.now()
  const lanes: Array<LaneCooldownState & { lane: string; remainingMin: number }> = []
  for (const [lane, state] of s.lanes) {
    if (now >= state.until) {
      s.lanes.delete(lane)
      continue
    }
    lanes.push({ lane, ...state, remainingMin: Math.ceil((state.until - now) / 60_000) })
  }
  lanes.sort((a, b) => a.until - b.until)
  return { lanes, skipsSaved: s.skipsSaved }
}
