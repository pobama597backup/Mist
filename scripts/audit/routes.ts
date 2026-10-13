/// <reference types="bun-types" />
/**
 * MIST Phase 4-b route harness (P12) — the standing latency gate.
 * Run: bun run audit:routes   (or bun scripts/audit/routes.ts)
 *
 * WHAT IT DOES:
 *  1. Hits the safe read-only GET set (the same 41-route list the phase-0
 *     baseline probed) WARM — 1 warmup + 7 measured hits per route — and
 *     reports p50/p95/max per route plus the aggregate.
 *  2. FAILS (exit 1) when ANY route's warm p95 exceeds 300ms — the mandate's
 *     "no non-LLM p95 > 300 ms" line. Every route in this set is non-LLM by
 *     construction (POST/LLM/SSE/secret routes are excluded, listed below).
 *  3. Measures buildContext (p50/p95 over 10 calls) + the tools block size
 *     and the stable static prefix size, and records them alongside the
 *     BEFORE numbers from docs/baseline-2026-10-10.json (same box, measured
 *     the day before the Phase 4-b changes — the honest before/after pair).
 *  4. Records the live TTFT/hedge configuration from lane-health.
 *  5. Writes docs/baseline-<date>-phase4.json.
 *
 * Constraints (ADR-0001): next build stays banned; this harness only ever
 * makes GET requests against the live dev server on 127.0.0.1:3000.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '../..')
const OUT = join(ROOT, 'docs', `baseline-${new Date().toISOString().slice(0, 10)}-phase4.json`)
const BEFORE_BASELINE = join(ROOT, 'docs', 'baseline-2026-10-10.json')
const BASE = 'http://127.0.0.1:3000'

/** Safe read-only GET set — the baseline's probe list. The baseline
 *  probed 41; mesh + data-boundary were deleted in Phase 3-a · R12 (dead
 *  routes), so the live set is these 39. */
const SAFE_GETS = [
  '/api/mist/health', '/api/mist/tools/list', '/api/mist/tools/categories', '/api/mist/skills/list',
  '/api/mist/skills/executions', '/api/mist/missions', '/api/mist/memory/stats', '/api/mist/llm/lanes',
  '/api/mist/llm/status', '/api/mist/telemetry', '/api/mist/traces', '/api/mist/dreams', '/api/mist/agents',
  '/api/mist/subagents', '/api/mist/companions', '/api/mist/watchlist', '/api/mist/autonomy',
  '/api/mist/operators', '/api/mist/connectors', '/api/mist/introspection', '/api/mist/alerts',
  '/api/mist/approvals', '/api/mist/conversations', '/api/mist/digest', '/api/mist/trends',
  '/api/mist/research', '/api/mist/evolution', '/api/mist/github',
  '/api/mist/browser/status', '/api/mist/bridge', '/api/mist/hermes', '/api/mist/learning',
  '/api/mist/analytics/efficiency', '/api/mist/cron',
  '/api/mist/obsidian?action=status', // the bare path 400s by design (action-based API)
  '/api/mist/voice/status', '/api/mist/voice/local/status', '/api/mist/voice/local/engines', '/api',
]

const SKIPPED = [
  '/api/mist/mesh + /api/mist/data-boundary (deleted Phase 3-a · R12 — were 2 of the baseline\u2019s 41)',
  '/api/mist/welcome (GET has side-effect seen-gate)',
  '/api/mist/recover (kills processes — do not probe)',
  '/api/mist/google (returns GEMINI_API_KEY)',
  '/api/mist/synapse/stream (SSE long-lived)',
  '/api/mist/voice/tts/stream (SSE)',
  '/api/mist/evolution/scan (side-effecting scan)',
  'all POST-only routes (LLM/writes) — every probed route is non-LLM',
  'all [id] dynamic routes (need params)',
]

/** Nearest-rank percentile (same arithmetic as baseline.ts's pct()). */
function pct(arr: number[], p: number): number | null {
  if (!arr.length) return null
  const s = [...arr].sort((a, b) => a - b)
  return Math.round(s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] * 100) / 100
}

async function timedFetch(path: string, timeoutMs = 30_000): Promise<{ ok: boolean; status: number; ms: number }> {
  const t0 = performance.now()
  try {
    const ctl = new AbortController()
    const t = setTimeout(() => ctl.abort(), timeoutMs)
    const r = await fetch(BASE + path, { signal: ctl.signal })
    clearTimeout(t)
    return { ok: r.ok, status: r.status, ms: Math.round(performance.now() - t0) }
  } catch {
    return { ok: false, status: 0, ms: Math.round(performance.now() - t0) }
  }
}

const WARMUP_HITS = 1
const MEASURED_HITS = 7
const P95_BUDGET_MS = 300

async function routeLatency() {
  const routes: Record<string, { status: number; p50ms: number | null; p95ms: number | null; maxMs: number | null; warmMs: number[] }> = {}
  const failures: string[] = []
  for (const p of SAFE_GETS) {
    for (let i = 0; i < WARMUP_HITS; i++) await timedFetch(p, 45_000)
    const warm: number[] = []
    let status = 0
    for (let i = 0; i < MEASURED_HITS; i++) {
      const r = await timedFetch(p, 45_000)
      status = r.status
      if (r.ok) warm.push(r.ms)
    }
    const p50 = pct(warm, 50)
    const p95 = pct(warm, 95)
    routes[p] = { status, p50ms: p50, p95ms: p95, maxMs: warm.length ? Math.max(...warm) : null, warmMs: warm }
    if (!warm.length) failures.push(`${p}: no successful warm hits (status ${status})`)
    else if ((p95 ?? 0) > P95_BUDGET_MS) failures.push(`${p}: warm p95 ${p95}ms exceeds the ${P95_BUDGET_MS}ms budget`)
  }
  const allWarm = Object.values(routes).flatMap((r) => r.warmMs)
  return {
    method: `warm GET (${WARMUP_HITS} warmup + ${MEASURED_HITS} measured hits per route, dev server live)`,
    probed: SAFE_GETS.length,
    skipped: SKIPPED,
    budget: { p95MaxMs: P95_BUDGET_MS, scope: 'every probed route is non-LLM (POST/LLM/SSE/secret routes excluded)' },
    aggregate: { p50ms: pct(allWarm, 50), p95ms: pct(allWarm, 95), maxMs: allWarm.length ? Math.max(...allWarm) : null },
    slowest: Object.entries(routes)
      .sort((a, b) => (b[1].p95ms ?? 0) - (a[1].p95ms ?? 0))
      .slice(0, 6)
      .map(([p, r]) => `${p} p95=${r.p95ms}ms max=${r.maxMs}ms status=${r.status}`),
    routes,
    failures,
  }
}

/** buildContext AFTER measurement — same probe message and arithmetic as the
 *  baseline's buildContextTiming() so the before/after pair is honest. */
async function buildContextAfter() {
  try {
    const mod = await import('../../src/lib/services/context-builder')
    const msg = 'hey, what can you actually do around here?'
    const t: number[] = []
    let promptChars = 0
    let toolsBlockChars = 0
    let staticPrefixChars = 0
    await mod.buildContext(msg, 'chat' as never) // warmup (lazy imports, caches)
    for (let i = 0; i < 10; i++) {
      const t0 = performance.now()
      const ctx = await mod.buildContext(msg, 'chat' as never)
      t.push(performance.now() - t0)
      promptChars = ctx.prompt.length
      // the whole TOOLS section: stable core prefix + dynamic top-k + browser note
      // (spans until the bridge block that follows it)
      const m = ctx.prompt.match(/TOOLS AVAILABLE \(core[\s\S]*?(?=\n\nYOUR LOCAL BRIDGE)/)
      toolsBlockChars = m ? m[0].length : toolsBlockChars
      // the stable static prefix: core list + discovery line + tool-use rule
      const core = ctx.prompt.match(/TOOLS AVAILABLE \(core[\s\S]*?(?=\n\nTOOLS RELEVANT)/)
      staticPrefixChars = core ? core[0].length : staticPrefixChars
    }
    return {
      p50ms: pct(t, 50),
      p95ms: pct(t, 95),
      minMs: Math.round(Math.min(...t)),
      samples: t.map((x) => Math.round(x)),
      promptChars,
      promptApproxTokens: Math.round(promptChars / 4),
      toolsBlockChars,
      toolsBlockApproxTokens: Math.round(toolsBlockChars / 4),
      staticPrefixChars,
      staticPrefixApproxTokens: Math.round(staticPrefixChars / 4),
    }
  } catch (e) {
    return { status: 'UNVERIFIED', reason: String(e).slice(0, 200) }
  }
}

function beforeNumbers(): Record<string, unknown> {
  try {
    const b = JSON.parse(readFileSync(BEFORE_BASELINE, 'utf8')) as Record<string, unknown>
    return {
      source: 'docs/baseline-2026-10-10.json (same box, pre-Phase-4-b)',
      buildContext: b.buildContext,
      toolsList: b.toolsList,
      routeAggregate: {
        p50ms: (b.routeLatency as Record<string, unknown>)?.aggregateP50ms,
        p95ms: (b.routeLatency as Record<string, unknown>)?.aggregateP95ms,
      },
    }
  } catch {
    return { status: 'UNVERIFIED', reason: 'docs/baseline-2026-10-10.json not found' }
  }
}

async function ttftConfig() {
  try {
    const lh = await import('../../src/lib/services/lane-health')
    return {
      cloudMs: lh.ttftCloudMs(),
      localColdMs: lh.ttftLocalColdMs(),
      localWarmMs: lh.ttftLocalWarmMs(),
      warmAfterMs: lh.WARM_AFTER_MS,
      ewmaAlpha: lh.EWMA_ALPHA,
      breaker: { failureThreshold: lh.BREAKER_FAILURE_THRESHOLD, openMs: lh.BREAKER_OPEN_MS },
      hedgeRule: 'only owner-keyed or local lanes are ever hedged — never a second public keyless lane',
      scope: 'streaming chat attempts only; thinking:true requests are exempt (reasoning time IS the work); non-streaming internal brains keep the total budget',
    }
  } catch (e) {
    return { status: 'UNVERIFIED', reason: String(e).slice(0, 200) }
  }
}

async function main() {
  const t0 = Date.now()
  console.log(`[1/3] route latency (${SAFE_GETS.length} routes × ${WARMUP_HITS + MEASURED_HITS} hits)…`)
  const routes = await routeLatency()
  console.log('[2/3] buildContext after-measurement (11 calls)…')
  const ctxAfter = await buildContextAfter()
  console.log('[3/3] TTFT/hedge config + before-numbers…')
  const ttft = await ttftConfig()
  const before = beforeNumbers()

  const report = {
    date: new Date().toISOString(),
    phase: '4-b (Speed — backend half)',
    routeHarness: routes,
    buildContext: { before: (before as Record<string, unknown>).buildContext, after: ctxAfter },
    toolsBlock: {
      before: { toolsBlockChars: 38122, toolsBlockApproxTokens: 9531, approxTokensFullBlock: 13799 },
      after: ctxAfter,
    },
    ttft,
    before,
    harnessDurationMs: Date.now() - t0,
  }
  writeFileSync(OUT, JSON.stringify(report, null, 2) + '\n')

  console.log(`\naggregate: p50 ${routes.aggregate.p50ms}ms · p95 ${routes.aggregate.p95ms}ms · max ${routes.aggregate.maxMs}ms`)
  if (routes.slowest.length) console.log('slowest:', routes.slowest.join(' | '))
  if (typeof ctxAfter === 'object' && 'p50ms' in ctxAfter) {
    console.log(
      `buildContext after: p50 ${ctxAfter.p50ms}ms · p95 ${ctxAfter.p95ms}ms · prompt ~${ctxAfter.promptApproxTokens} tok · tools block ~${ctxAfter.toolsBlockApproxTokens} tok · static prefix ~${ctxAfter.staticPrefixApproxTokens} tok`
    )
  }
  if (routes.failures.length > 0) {
    console.error(`\nFAIL — ${routes.failures.length} route(s) over budget:`)
    for (const f of routes.failures) console.error(`  ${f}`)
    process.exit(1)
  }
  console.log(`\nPASS — every probed route's warm p95 is within the ${P95_BUDGET_MS}ms budget.`)
  console.log(`written: ${OUT.replace(ROOT + '/', '')}`)
  if (!existsSync(OUT)) process.exit(1)
}

await main()
