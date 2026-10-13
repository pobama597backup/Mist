// M.I.S.T. perimeter rate limits — Phase 1 · S12 remainder (commit 5).
//
// In-memory fixed-window counters per (bucket × caller), process-local (the
// dev server is one process; the platform sandbox is single-instance).
// Caller identity: the mist_session cookie value first (auto-paired by
// proxy.ts — not forgeable without the machine secret, and a valid cookie's
// value cannot be rotated by an outsider, so buckets can't be sprayed), then
// the best client-IP signal we have, then 'unknown'. Internal service calls
// (x-mist-service, no cookie) share one machine-local bucket per lane —
// deliberate: a runaway loop is a runaway loop whoever drives it.
//
// Limits are generous by design — a busy owner hour must NEVER trip them.
// They exist so a hijacked tab, a retry-storm, or a stolen session cannot
// hammer the LLM cascade, the tool executor, or the export tarball.
// MIST_RATE_LIMIT_OFF=1 disables every bucket (PC owners who want zero
// friction); Phase 2 Arbiter decisions are NOT affected by these counters.
import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { sessionBucketKey } from './shared'

export type RateBucket = 'llm' | 'tools' | 'voice' | 'export' | 'config'

const WINDOW_MS = 60_000

const POLICIES: Record<RateBucket, number> = {
  llm: 30, // /api/mist/llm/unified — the whole cascade
  tools: 60, // /api/mist/tools/execute
  voice: 60, // /api/mist/voice/stt + tts + tts/stream
  export: 5, // /api/mist/bridge/export (tarball + scrypt work)
  config: 10, // /api/mist/config/env + bridge set_url
}

interface WindowState {
  windowStart: number
  count: number
}

interface RateGlobal {
  __mistRateBuckets?: Map<string, WindowState>
}
const g = globalThis as unknown as RateGlobal
const buckets: Map<string, WindowState> = (g.__mistRateBuckets ??= new Map())

/** Best-effort client IP. Through the Caddy gateway X-Real-IP is set from the
 * socket; direct callers can spoof these headers, but cookieless direct
 * callers are already blocked by the proxy.ts session gate on non-GET
 * routes — this fallback mainly serves GET lanes and open-API mode. */
function clientIp(req: NextRequest): string {
  const real = req.headers.get('x-real-ip')
  if (real) return real.trim()
  const xff = req.headers.get('x-forwarded-for')
  if (xff) return xff.split(',')[0].trim()
  return 'unknown'
}

/** Opportunistic sweep — one pass per check, dropping expired windows so the
 * map never grows beyond (buckets × recent callers). */
function sweep(now: number): void {
  if (buckets.size < 512) return
  for (const [key, state] of buckets) {
    if (now - state.windowStart >= WINDOW_MS) buckets.delete(key)
  }
}

export interface RateLimitResult {
  ok: boolean
  /** Seconds until the window resets (present when refused). */
  retryAfter?: number
}

/** Count one request against a bucket. Pure check-and-increment — call at the
 * TOP of the handler, before any work. */
export function checkRateLimit(bucket: RateBucket, req: NextRequest): RateLimitResult {
  if (process.env.MIST_RATE_LIMIT_OFF === '1') return { ok: true }
  const limit = POLICIES[bucket]
  const identity = sessionBucketKey(req.headers.get('cookie')) ?? clientIp(req)
  const key = `${bucket}:${identity}`
  const now = Date.now()
  sweep(now)
  let state = buckets.get(key)
  if (!state || now - state.windowStart >= WINDOW_MS) {
    state = { windowStart: now, count: 0 }
    buckets.set(key, state)
  }
  if (state.count >= limit) {
    return {
      ok: false,
      retryAfter: Math.max(1, Math.ceil((state.windowStart + WINDOW_MS - now) / 1000)),
    }
  }
  state.count++
  return { ok: true }
}

/** Uniform 429 body: honest error + Retry-After header + JSON retryAfter. */
export function rateLimitResponse(bucket: RateBucket, retryAfter: number): NextResponse {
  return NextResponse.json(
    {
      error: `rate limit exceeded (${bucket}) — retry in ${retryAfter}s`,
      bucket,
      retryAfter,
    },
    {
      status: 429,
      headers: { 'Retry-After': String(retryAfter), 'Cache-Control': 'no-store' },
    }
  )
}
