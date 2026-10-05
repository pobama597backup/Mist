// M.I.S.T. rate limiter — honest port of OpenJarvis's security rate limiting
// (src/openjarvis/security/rate_limiter.py: token bucket with per-key buckets)
// plus a sliding-window-log algorithm for precise remaining/retryAfter answers.
//
// In-memory only, globalThis-guarded so Next.js dev hot reloads share ONE
// limiter per process (mirrors the service-singleton patterns across M.I.S.T.).
// No loops, no timers — stale state is swept lazily on access.
//
// Surfaces (presets, per the integration plan):
//   chat     20 requests / minute
//   tools    60 requests / minute
//   research  5 requests / 10 minutes
//   mcp      30 requests / minute

export interface RateLimitOptions {
  /** Max requests allowed inside the window. */
  limit: number
  /** Window length in milliseconds. */
  windowMs: number
}

export interface RateLimitResult {
  allowed: boolean
  /** Requests still available inside the current window (0 when denied). */
  remaining: number
  /** Milliseconds until the next request would be allowed (0 when allowed). */
  retryAfterMs: number
  limit: number
  windowMs: number
  algorithm: 'sliding-window' | 'token-bucket'
}

export type RateSurface = 'chat' | 'tools' | 'research' | 'mcp'

export const RATE_SURFACE_PRESETS: Record<RateSurface, RateLimitOptions> = {
  chat: { limit: 20, windowMs: 60_000 },
  tools: { limit: 60, windowMs: 60_000 },
  research: { limit: 5, windowMs: 600_000 },
  mcp: { limit: 30, windowMs: 60_000 },
}

interface TokenBucketState {
  tokens: number
  lastRefill: number
}

interface LimiterState {
  /** Sliding-window log: key → request timestamps inside the window. */
  windows: Map<string, number[]>
  /** Token buckets (OpenJarvis port): key → { tokens, lastRefill }. */
  buckets: Map<string, TokenBucketState>
  lastSweep: number
}

// globalThis guard — one limiter per process, survives hot reloads.
const g = globalThis as unknown as { __mistOjRateLimiter?: LimiterState }
const state: LimiterState = (g.__mistOjRateLimiter ??= {
  windows: new Map(),
  buckets: new Map(),
  lastSweep: Date.now(),
})

const SWEEP_INTERVAL_MS = 60_000
const MAX_TRACKED_KEYS = 10_000

/** Lazily drop stale windows/buckets so long-lived processes never grow unbounded. */
function sweep(now: number): void {
  if (now - state.lastSweep < SWEEP_INTERVAL_MS && state.windows.size < MAX_TRACKED_KEYS) return
  const deadWindows: string[] = []
  for (const [key, stamps] of state.windows) {
    // A window is dead when its newest timestamp is older than the longest
    // supported window (10 min research preset, with headroom).
    if (stamps.length === 0 || now - stamps[stamps.length - 1] > 660_000) deadWindows.push(key)
  }
  for (const key of deadWindows) state.windows.delete(key)
  // Buckets refill continuously; one that has sat idle for 11+ minutes is
  // indistinguishable from a fresh bucket, so drop it.
  const deadBuckets: string[] = []
  for (const [key, bucket] of state.buckets) {
    if (now - bucket.lastRefill > 660_000) deadBuckets.push(key)
  }
  for (const key of deadBuckets) state.buckets.delete(key)
  state.lastSweep = now
}

/**
 * Sliding-window-log acquire. Precise: `remaining` and `retryAfterMs` are
 * exact for the window log, which is what callers want to surface as
 * `Retry-After` style hints.
 */
export function acquire(key: string, opts: RateLimitOptions): RateLimitResult {
  if (!Number.isFinite(opts.limit) || opts.limit < 1 || !Number.isFinite(opts.windowMs) || opts.windowMs <= 0) {
    throw new Error('rate limit options must include limit >= 1 and windowMs > 0')
  }
  const now = Date.now()
  sweep(now)
  const limit = Math.floor(opts.limit)
  const windowMs = opts.windowMs

  const stamps = (state.windows.get(key) ?? []).filter((t) => now - t < windowMs)
  if (stamps.length >= limit) {
    const retryAfterMs = Math.max(1, windowMs - (now - stamps[0]) + 1)
    state.windows.set(key, stamps)
    return { allowed: false, remaining: 0, retryAfterMs, limit, windowMs, algorithm: 'sliding-window' }
  }
  stamps.push(now)
  state.windows.set(key, stamps)
  return {
    allowed: true,
    remaining: limit - stamps.length,
    retryAfterMs: 0,
    limit,
    windowMs,
    algorithm: 'sliding-window',
  }
}

/**
 * Token-bucket acquire — the faithful port of OpenJarvis's TokenBucket
 * (rate = limit/windowMs tokens per ms, capacity = limit, continuous refill).
 * Bursts up to `limit` are allowed instantly, then the refill rate governs.
 */
export function acquireTokenBucket(key: string, opts: RateLimitOptions): RateLimitResult {
  const now = Date.now()
  sweep(now)
  const limit = Math.floor(opts.limit)
  const windowMs = opts.windowMs
  const ratePerMs = limit / windowMs

  let bucket = state.buckets.get(key)
  if (!bucket) {
    bucket = { tokens: limit, lastRefill: now }
    state.buckets.set(key, bucket)
  }
  const elapsed = now - bucket.lastRefill
  bucket.tokens = Math.min(limit, bucket.tokens + elapsed * ratePerMs)
  bucket.lastRefill = now

  if (bucket.tokens >= 1) {
    bucket.tokens -= 1
    return {
      allowed: true,
      remaining: Math.floor(bucket.tokens),
      retryAfterMs: 0,
      limit,
      windowMs,
      algorithm: 'token-bucket',
    }
  }
  const waitMs = Math.ceil((1 - bucket.tokens) / ratePerMs)
  return { allowed: false, remaining: 0, retryAfterMs: waitMs, limit, windowMs, algorithm: 'token-bucket' }
}

/**
 * Surface-preset check: `checkRateLimit('chat', ipOrSessionKey)` applies the
 * frozen per-surface preset (chat 20/min, tools 60/min, research 5/10min,
 * mcp 30/min) under a `surface:key` namespace.
 */
export function checkRateLimit(surface: RateSurface, key: string): RateLimitResult {
  const preset = RATE_SURFACE_PRESETS[surface]
  return acquire(`surface:${surface}:${key}`, preset)
}

/** Inspect a key's current sliding-window usage without consuming a slot. */
export function peek(key: string, opts: RateLimitOptions): { used: number; remaining: number } {
  const now = Date.now()
  const stamps = (state.windows.get(key) ?? []).filter((t) => now - t < opts.windowMs)
  return { used: stamps.length, remaining: Math.max(0, Math.floor(opts.limit) - stamps.length) }
}

/** Reset rate-limit state for one key (or everything when key is omitted). */
export function resetRateLimit(key?: string): void {
  if (key === undefined) {
    state.windows.clear()
    state.buckets.clear()
  } else {
    state.windows.delete(key)
    state.buckets.delete(key)
  }
}
