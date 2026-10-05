// M.I.S.T. — OpenJarvis UX typed client (oj-face-5).
//
// Typed browser-side client for the wave-1 oj-* API surface: traces
// (list/detail + shared cache for the per-message XRay footers), efficiency,
// tiered approvals, operators, digests, upstream oj-sync and knowledge search.
//
// HOUSE RULES:
//  - RELATIVE fetch paths only (the gateway owns ports — never an absolute URL).
//  - Every call resolves to a typed result — {ok:true,data} | {ok:false,error}
//    — and NEVER throws unhandled; callers render honest error/empty states.
//  - Small shared caches (TTL + in-flight dedup) so dozens of XRay footers
//    share ONE traces request instead of stampeding the route.

'use client'

// ---------------------------------------------------------------- results

export type OjResult<T> = { ok: true; data: T } | { ok: false; error: string; status?: number }

function errResult(error: string, status?: number) {
  return { ok: false as const, error, ...(status !== undefined ? { status } : {}) }
}

async function fetchJson<T>(path: string, init?: RequestInit, timeoutMs = 10_000): Promise<OjResult<T>> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(path, {
      ...init,
      signal: ctrl.signal,
      headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    })
    const body: unknown = await res.json().catch(() => null)
    if (!res.ok) {
      const message =
        body && typeof body === 'object' && 'error' in body && typeof (body as { error: unknown }).error === 'string'
          ? (body as { error: string }).error
          : `request failed (${res.status})`
      return errResult(message, res.status)
    }
    return { ok: true, data: body as T }
  } catch (e) {
    const message = e instanceof DOMException && e.name === 'AbortError' ? 'request timed out' : 'network unreachable'
    return errResult(message)
  } finally {
    clearTimeout(timer)
  }
}

// ---------------------------------------------------------------- types (frozen wave-1 contracts)

export interface TraceListItem {
  id: string
  query: string
  agent: string
  model: string | null
  provider: string | null
  outcome: 'success' | 'failure' | 'degraded' | 'blocked' | 'running' | string
  tier: string
  complexity: number
  tokensIn: number
  tokensOut: number
  latencyMs: number
  /** Step COUNT in the list shape (number); full steps live on the detail. */
  steps: number
  createdAt: string
}

export interface TraceStep {
  idx: number
  type: string
  name: string
  ok: boolean
  durationMs: number
  tokens: number
  input: string
  output: string
  meta?: string
  createdAt?: string
}

export interface TraceDetail {
  id: string
  query: string
  agent: string
  model: string | null
  provider: string | null
  result?: string | null
  outcome: string
  tokensIn: number
  tokensOut: number
  latencyMs: number
  costUsd?: number
  complexity: number
  tier: string
  tokenBudget?: number
  meta?: Record<string, unknown> | string | null
  startedAt?: string
  endedAt?: string
  createdAt: string
  steps: TraceStep[]
}

export type ApprovalTier = 'auto' | 'standard' | 'destructive' | string
export type ApprovalStatus = 'pending' | 'approved' | 'denied' | 'expired' | string

export interface ApprovalItem {
  id: string
  actionType: string
  fingerprint: string
  title: string
  tier: ApprovalTier
  status: ApprovalStatus
  origin: string
  payload: Record<string, unknown>
  createdAt: string
  decidedAt?: string | null
  decidedBy?: string | null
}

export interface OperatorItem {
  slug: string
  name: string
  description?: string
  status: 'active' | 'paused' | string
  schedule: { type: string; value: number | string }
  humanSchedule: string
  budget?: { maxActionsPerRun: number; maxTokens: number }
  tools?: string[]
  enabled?: boolean
  lastRunAt?: string | null
  lastStatus?: string | null
  runCount?: number
  nextRunAt?: string | null
}

export interface DigestItem {
  id: string
  kind: string
  headline: string
  items: string[]
  tone: string
  degraded?: boolean
  content?: string
  speakText?: string
  createdAt?: string
}

export interface OjSyncStatusPayload {
  repo: string
  watching: boolean
  head: string
  local_head?: string
  merge_pending?: boolean
  last_head_at?: string
  last_sweep_at?: string
  next_sweep_at?: string
  interval_min?: number
  auto_patch?: boolean
  sweeps?: number
  error?: string | null
}

export interface OjSyncStatus {
  status: OjSyncStatusPayload
  mapping: { repo: string; branch: string; entries: number }
}

export interface OjSyncCheckResult {
  ok: boolean
  changed: boolean
  head: string
  message: string
}

export interface KnowledgeHit {
  id: string
  source: string
  title: string
  content: string
  score: number
  bm25: number
  vector: number
}

export interface EfficiencyTotals {
  requests: number
  tokensIn: number
  tokensOut: number
  avgLatencyMs: number
  costUsd: number
}

export interface EfficiencyReport {
  totals: EfficiencyTotals
  perProvider: Array<{ provider: string } & EfficiencyTotals>
  perAgent: Array<{ agent: string; provider?: string } & EfficiencyTotals>
  perDay: Array<{ day: string; requests: number; tokens: number }>
}

// ---------------------------------------------------------------- traces

export async function listTraces(opts?: {
  agent?: string
  outcome?: string
  limit?: number
}): Promise<OjResult<TraceListItem[]>> {
  const params = new URLSearchParams()
  if (opts?.agent) params.set('agent', opts.agent)
  if (opts?.outcome) params.set('outcome', opts.outcome)
  if (opts?.limit) params.set('limit', String(opts.limit))
  const qs = params.toString()
  const res = await fetchJson<{ traces: TraceListItem[] }>(`/api/mist/traces${qs ? `?${qs}` : ''}`)
  return res.ok ? { ok: true, data: Array.isArray(res.data.traces) ? res.data.traces : [] } : res
}

/**
 * Shared recent-traces cache for the per-message XRay footers — one request
 * per TTL window (30s) shared by every footer on screen, with in-flight
 * dedup so a 50-message history mounts exactly one network round-trip.
 */
const TRACE_LIST_TTL = 30_000
let traceListCache: { at: number; promise: Promise<OjResult<TraceListItem[]>> } | null = null

export function getRecentTracesCached(limit = 50): Promise<OjResult<TraceListItem[]>> {
  const now = Date.now()
  if (traceListCache && now - traceListCache.at < TRACE_LIST_TTL) return traceListCache.promise
  const promise = listTraces({ limit }).finally(() => {
    // drop a failed cache entry so the next footer can retry sooner
    if (traceListCache && traceListCache.promise === promise) {
      // keep it — the TTL still bounds retries; failures are cheap to hold
    }
  })
  traceListCache = { at: now, promise }
  return promise
}

export async function getTraceDetail(id: string): Promise<OjResult<TraceDetail>> {
  const res = await fetchJson<{ trace: TraceDetail }>(`/api/mist/traces/${encodeURIComponent(id)}`)
  if (!res.ok) return res
  if (!res.data.trace || typeof res.data.trace !== 'object') {
    return errResult('trace detail missing', 404)
  }
  return { ok: true, data: { ...res.data.trace, steps: Array.isArray(res.data.trace.steps) ? res.data.trace.steps : [] } }
}

/** Detail cache for expanded XRay footers (TTL 15s, per-id). */
const TRACE_DETAIL_TTL = 15_000
const traceDetailCache = new Map<string, { at: number; promise: Promise<OjResult<TraceDetail>> }>()

export function getTraceDetailCached(id: string): Promise<OjResult<TraceDetail>> {
  const hit = traceDetailCache.get(id)
  if (hit && Date.now() - hit.at < TRACE_DETAIL_TTL) return hit.promise
  const promise = getTraceDetail(id)
  traceDetailCache.set(id, { at: Date.now(), promise })
  if (traceDetailCache.size > 40) {
    // trim the oldest entries — footers are ephemeral
    const oldest = traceDetailCache.keys().next().value
    if (oldest) traceDetailCache.delete(oldest)
  }
  return promise
}

// ---------------------------------------------------------------- approvals

export async function listApprovals(status?: 'pending' | 'approved' | 'denied' | 'expired' | 'all'): Promise<OjResult<ApprovalItem[]>> {
  const qs = status ? `?status=${encodeURIComponent(status)}` : ''
  const res = await fetchJson<{ approvals: ApprovalItem[] }>(`/api/mist/approvals${qs}`)
  return res.ok ? { ok: true, data: Array.isArray(res.data.approvals) ? res.data.approvals : [] } : res
}

export async function decideApproval(
  id: string,
  decision: 'approve' | 'deny',
  remember?: 'always_approve' | 'always_deny'
): Promise<OjResult<{ ok: boolean }>> {
  return fetchJson<{ ok: boolean }>(`/api/mist/approvals/${encodeURIComponent(id)}`, {
    method: 'POST',
    body: JSON.stringify({ decision, ...(remember ? { remember } : {}) }),
  })
}

// ---------------------------------------------------------------- operators

export async function listOperators(): Promise<OjResult<OperatorItem[]>> {
  const res = await fetchJson<{ operators: OperatorItem[] }>('/api/mist/operators')
  return res.ok ? { ok: true, data: Array.isArray(res.data.operators) ? res.data.operators : [] } : res
}

export async function operatorAction(
  id: string,
  action: 'run' | 'pause' | 'resume'
): Promise<OjResult<{ ok: boolean }>> {
  return fetchJson<{ ok: boolean }>(`/api/mist/operators/${encodeURIComponent(id)}`, {
    method: 'POST',
    body: JSON.stringify({ action }),
  })
}

// ---------------------------------------------------------------- digests

export async function getDigests(): Promise<OjResult<{ digests: DigestItem[]; latest?: DigestItem }>> {
  const res = await fetchJson<{ digests: DigestItem[]; latest?: DigestItem }>('/api/mist/digest')
  return res.ok ? { ok: true, data: { digests: Array.isArray(res.data.digests) ? res.data.digests : [], latest: res.data.latest } } : res
}

export async function generateDigest(speak?: boolean): Promise<OjResult<DigestItem>> {
  // digest generation runs several collectors + one LLM synthesis — allow the long haul
  const res = await fetchJson<{ digest: DigestItem }>(
    '/api/mist/digest',
    { method: 'POST', body: JSON.stringify(speak ? { speak: true } : {}) },
    120_000
  )
  return res.ok
    ? res.data.digest && typeof res.data.digest === 'object'
      ? { ok: true, data: res.data.digest }
      : errResult('digest response missing', 500)
    : res
}

// ---------------------------------------------------------------- upstream oj-sync

export async function getOjSyncStatus(): Promise<OjResult<OjSyncStatus>> {
  return fetchJson<OjSyncStatus>('/api/mist/oj/sync')
}

export async function checkOjSync(): Promise<OjResult<OjSyncCheckResult>> {
  return fetchJson<OjSyncCheckResult>('/api/mist/oj/sync', {
    method: 'POST',
    body: JSON.stringify({ action: 'check' }),
  })
}

// ---------------------------------------------------------------- knowledge

export async function searchKnowledge(query: string, topK?: number): Promise<OjResult<KnowledgeHit[]>> {
  const res = await fetchJson<{ results: KnowledgeHit[] }>('/api/mist/knowledge/search', {
    method: 'POST',
    body: JSON.stringify({ query, ...(topK ? { topK } : {}) }),
  })
  return res.ok ? { ok: true, data: Array.isArray(res.data.results) ? res.data.results : [] } : res
}

// ---------------------------------------------------------------- efficiency

export async function getEfficiency(): Promise<OjResult<EfficiencyReport>> {
  return fetchJson<EfficiencyReport>('/api/mist/analytics/efficiency')
}

// ---------------------------------------------------------------- formatting helpers (shared by the surfaces)

/** 12345 → "12.3k" · 34 → "34" — compact token counts. */
export function fmtTokens(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—'
  if (n < 1000) return String(Math.round(n))
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`
  return `${(n / 1_000_000).toFixed(1)}M`
}

/** 23619 → "23.6s" · 617 → "617ms". */
export function fmtDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—'
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const m = Math.floor(ms / 60_000)
  const s = Math.round((ms % 60_000) / 1000)
  return `${m}m${s.toString().padStart(2, '0')}s`
}

/** 0 → "$0.00" · 0.0142 → "$0.0142" (trim trailing zeros, keep 4 decimals max). */
export function fmtCost(usd: number | null | undefined): string {
  if (usd === null || usd === undefined || !Number.isFinite(usd)) return '—'
  if (usd === 0) return '$0.00'
  if (usd < 0.01) return `$${usd.toFixed(4).replace(/0+$/, '').replace(/\.$/, '')}`
  return `$${usd.toFixed(3).replace(/0+$/, '').replace(/\.$/, '')}`
}

/** "2026-09-29T20:09:36.597Z" → "20:09" (local). */
export function fmtClock(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

/** Relative age — "12s ago" · "3m ago" · "2h ago" · "4d ago". */
export function relAge(iso: string | null | undefined): string {
  if (!iso) return ''
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return ''
  const s = Math.max(0, Math.floor((Date.now() - then) / 1000))
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}
