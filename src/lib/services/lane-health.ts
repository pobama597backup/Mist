// M.I.S.T. lane health (Phase 4-b · R10) — the measured ladder above the
// cooldown table: per-lane latency EWMA, a consecutive-failure circuit
// breaker, warmth (for local-lane TTFT deadlines) and the hedge-pairing rule.
//
// WHAT THIS SOLVES (the mandate's words): the cascade walked lanes in STATIC
// order, so a lane that answers in 900ms sat behind a lane that answers in
// 12s every single turn. Now every attempt (success or fail, chat or internal
// brain) updates an EWMA (alpha 0.3) and the auto cascade orders lanes by
// EWMA ascending — measured lanes float to the front, never-attempted lanes
// keep their static order (unknown ≠ slow). Cooldowns still OVERRIDE: a
// cooling or circuit-open lane drops to the last-resort rungs exactly like
// orderWithCooldowns did ("refusing to connect is never the better answer" —
// when every lane is cooling/open the original order stands).
//
// CIRCUIT BREAKER: 3 consecutive failed attempts (any failure class,
// including TTFT breaches — a lane consistently too slow to first token IS
// failing its job) opens the circuit for 5 minutes; after the window the lane
// is HALF-OPEN and its next attempt is a probe — success closes the circuit,
// failure re-opens it for another window.
//
// TTFT DEADLINES are separate from the total budget: cloud lanes 8s, local
// lanes 20s cold / 5s warm (warm = a success within the last 60s — the
// process-local sticky-state idea, now feeding a deadline instead of order).
// All three are env-tunable (MIST_TTFT_*).
//
// HEDGING: only owner-keyed or local lanes may be hedged — a public keyless
// lane NEVER receives a second concurrent request (no fan-out amplification
// on free public services). pickHedgeLane therefore never returns a keyless
// lane, which makes "two keyless lanes in flight" structurally impossible.
//
// State is globalThis-guarded (one map per process, dev-HMR safe) — same
// discipline as lane-cooldowns.

import { laneCooling } from './lane-cooldowns'

export const EWMA_ALPHA = 0.3
export const BREAKER_FAILURE_THRESHOLD = 3
export const BREAKER_OPEN_MS = 5 * 60_000
export const WARM_AFTER_MS = 60_000

export type CircuitState = 'closed' | 'open' | 'half-open'

export interface LaneHealthState {
  /** latency EWMA in ms (null = never attempted this process). */
  ewmaMs: number | null
  /** consecutive failed attempts (reset on any success). */
  failStreak: number
  /** circuit breaker: epoch-ms until which the lane is skipped (null = closed). */
  openUntil: number | null
  /** epoch-ms of the last successful attempt (null = none this process). */
  lastSuccessAt: number | null
  /** TTFT breach count (diagnostics). */
  ttftBreaches: number
}

interface HealthStore {
  lanes: Map<string, LaneHealthState>
}

const STORE_KEY = '__mistLaneHealth'

function store(): HealthStore {
  const g = globalThis as Record<string, unknown>
  if (!g[STORE_KEY]) {
    g[STORE_KEY] = { lanes: new Map<string, LaneHealthState>() } satisfies HealthStore
  }
  return g[STORE_KEY] as HealthStore
}

function state(lane: string): LaneHealthState {
  const s = store()
  let st = s.lanes.get(lane)
  if (!st) {
    st = { ewmaMs: null, failStreak: 0, openUntil: null, lastSuccessAt: null, ttftBreaches: 0 }
    s.lanes.set(lane, st)
  }
  return st
}

/** Record one attempt outcome. EWMA always updates (success AND fail — a
 *  failure's duration is latency information too); the breaker counts
 *  consecutive failures; success resets the streak, closes the circuit and
 *  stamps warmth. */
export function noteLaneAttempt(
  lane: string,
  outcome: { ok: boolean; durationMs: number; ttftBreach?: boolean }
): void {
  const st = state(lane)
  const d = Number.isFinite(outcome.durationMs) && outcome.durationMs > 0 ? outcome.durationMs : 1
  st.ewmaMs = st.ewmaMs === null ? d : (1 - EWMA_ALPHA) * st.ewmaMs + EWMA_ALPHA * d
  if (outcome.ok) {
    st.failStreak = 0
    st.openUntil = null
    st.lastSuccessAt = Date.now()
    return
  }
  if (outcome.ttftBreach) st.ttftBreaches++
  st.failStreak++
  if (st.failStreak >= BREAKER_FAILURE_THRESHOLD) {
    st.openUntil = Date.now() + BREAKER_OPEN_MS
  }
}

/** Circuit state: closed → open (3 fails) → half-open (window elapsed, next
 *  attempt is the probe) → closed on probe success / open again on failure. */
export function circuitState(lane: string, nowMs: number = Date.now()): CircuitState {
  const st = store().lanes.get(lane)
  if (!st || st.openUntil === null) return 'closed'
  return nowMs < st.openUntil ? 'open' : 'half-open'
}

/** Warm = a successful attempt within the last 60s. */
export function laneWarm(lane: string, nowMs: number = Date.now()): boolean {
  const st = store().lanes.get(lane)
  return Boolean(st?.lastSuccessAt && nowMs - st.lastSuccessAt < WARM_AFTER_MS)
}

// ---------- TTFT deadlines (separate from the total budget) ----------

export function ttftCloudMs(): number {
  const raw = Number(process.env.MIST_TTFT_CLOUD_MS ?? '')
  return Number.isFinite(raw) && raw >= 500 ? Math.floor(raw) : 8_000
}

export function ttftLocalColdMs(): number {
  const raw = Number(process.env.MIST_TTFT_LOCAL_COLD_MS ?? '')
  return Number.isFinite(raw) && raw >= 500 ? Math.floor(raw) : 20_000
}

export function ttftLocalWarmMs(): number {
  const raw = Number(process.env.MIST_TTFT_LOCAL_WARM_MS ?? '')
  return Number.isFinite(raw) && raw >= 500 ? Math.floor(raw) : 5_000
}

/** The lane's first-token deadline: local lanes get 20s cold / 5s warm,
 *  every other (cloud, keyed or keyless) gets 8s. */
export function ttftDeadlineMs(lane: string, local: boolean, nowMs: number = Date.now()): number {
  if (local) return laneWarm(lane, nowMs) ? ttftLocalWarmMs() : ttftLocalColdMs()
  return ttftCloudMs()
}

// ---------- lane classification ----------

/** The public keyless zero-auth lanes — never hedge targets, never two of
 *  them in flight at once. */
const KEYLESS_LANES: ReadonlySet<string> = new Set(['kilo', 'pollinations', 'llm7', 'ovh'])

function isLoopback(baseUrl: string | null | undefined): boolean {
  if (!baseUrl) return false
  try {
    const host = new URL(baseUrl).hostname.toLowerCase()
    return host === 'localhost' || host === '::1' || host === '0.0.0.0' || /^127\.\d+\.\d+\.\d+$/.test(host)
  } catch {
    return false
  }
}

/** Local lanes: Mist Core (the app's own gateway) and any OpenAI-compatible
 *  lane pointed at this machine (omniroute/hermes/openai_compatible on a
 *  loopback base URL). */
export function isLocalLane(lane: string, baseUrl: string | null | undefined): boolean {
  if (lane === 'core') return true
  if (lane === 'omniroute' || lane === 'hermes' || lane === 'openai_compatible') {
    return isLoopback(baseUrl)
  }
  return false
}

/** Hedgeable = owner-keyed or local. A public keyless lane is NEVER a hedge
 *  target — no fan-out amplification on free public services. (A keyless
 *  lane the owner added a BYOK key to is owner-keyed by definition.) */
export function isHedgeableLane(lane: string, cfg: { apiKey?: string | null; baseUrl?: string | null }): boolean {
  if (isLocalLane(lane, cfg.baseUrl)) return true
  if (KEYLESS_LANES.has(lane)) return Boolean(cfg.apiKey)
  return Boolean(cfg.apiKey)
}

/** Pick the hedge for a stalling primary: the FIRST later candidate in the
 *  walk order that is hedgeable and not the primary itself. Never returns a
 *  public keyless lane — the returned pair can never be two keyless lanes. */
export function pickHedgeLane<T extends string>(
  primary: string,
  candidates: ReadonlyArray<{ lane: T; hedgeable: boolean }>
): T | null {
  for (const c of candidates) {
    if (c.lane === primary) continue
    if (c.hedgeable) return c.lane
  }
  return null
}

// ---------- ordering ----------

/** The measured walk order: cooldowns and open circuits defer lanes to the
 *  last-resort rungs (kept in the order — the walk still reaches them when
 *  every fresh lane failed, matching lane-cooldowns' "never refuse to
 *  connect" doctrine); within the fresh lanes, measured (EWMA) lanes sort
 *  ascending and never-attempted lanes keep their static order behind them.
 *  When every lane is cooling/open the ORIGINAL order is returned untouched. */
export function orderLanes<T extends string>(order: readonly T[]): T[] {
  const fresh: T[] = []
  const deferred: T[] = []
  for (const lane of order) {
    if (laneCooling(lane) || circuitState(lane) === 'open') deferred.push(lane)
    else fresh.push(lane)
  }
  if (fresh.length === 0) return [...order]
  const measured = fresh.filter((l) => store().lanes.get(l)?.ewmaMs != null)
  const unmeasured = fresh.filter((l) => !(store().lanes.get(l)?.ewmaMs != null))
  measured.sort((a, b) => (store().lanes.get(a)!.ewmaMs ?? 0) - (store().lanes.get(b)!.ewmaMs ?? 0))
  return [...measured, ...unmeasured, ...deferred]
}

/** Snapshot for surfaces/tests. */
export function laneHealthSnapshot(): Array<LaneHealthState & { lane: string; circuit: CircuitState; warm: boolean }> {
  const out: Array<LaneHealthState & { lane: string; circuit: CircuitState; warm: boolean }> = []
  for (const [lane, st] of store().lanes) {
    out.push({ lane, ...st, circuit: circuitState(lane), warm: laneWarm(lane) })
  }
  out.sort((a, b) => a.lane.localeCompare(b.lane))
  return out
}

/** Test seam: wipe all lane-health state. */
export function __resetLaneHealthForTests(): void {
  store().lanes.clear()
}
