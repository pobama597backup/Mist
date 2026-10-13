// Phase 4-b · Speed (BACKEND half) — tool routing, parallel context blocks,
// lane health (EWMA/breaker/TTFT/hedge), the outbound opt-in, retention caps
// and lexical honesty.
//
// Structure (mirrors the mandate's Phase 4 bullets):
//   P2/P7   TOOLS block = stable core (≤15 one-liners, memoized) + top-k ≤12
//          full schemas; buildContext parallel blocks with per-block timeout
//   R10    pure lane-health logic: EWMA ordering, 3-fail breaker, half-open
//          recovery, TTFT deadlines, hedge pairing (never two keyless)
//   R5     outbound_watchers flag (default FALSE) — a watcher tick performs
//          ZERO outbound (fetch spy proves it); flag true restores
//   P5     retention caps: seed over-cap rows for two models → trim →
//          counts at cap, oldest gone, newest retained
//   P6     Intl.Segmenter tokenization + hash-dedupe; the "vector" surfaces
//          tell the lexical truth
//   S15    z-ai-web-dev-sdk loads dynamically (source-of-truth scan)
//
// Run: bun test tests/security/speed-backend.test.ts (dev server up for the
// three live-route checks; the rest are direct module seams).
import { test, expect, describe, beforeAll, afterAll } from 'bun:test'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { issueSession } from '../../src/lib/perimeter/shared'
import { db } from '../../src/lib/db'
import {
  buildContext,
  selectTopKTools,
  oneLineDescription,
  withBlockTimeout,
  ctxBlockTimeoutMs,
  invalidateToolBlockCache,
} from '../../src/lib/services/context-builder'
import { BASE_TOOLS } from '../../src/lib/services/tools-service'
import {
  noteLaneAttempt,
  circuitState,
  laneWarm,
  orderLanes,
  pickHedgeLane,
  isHedgeableLane,
  isLocalLane,
  ttftDeadlineMs,
  ttftCloudMs,
  ttftLocalColdMs,
  ttftLocalWarmMs,
  EWMA_ALPHA,
  laneHealthSnapshot,
  __resetLaneHealthForTests,
} from '../../src/lib/services/lane-health'
import { tokenize, dedupeTokens, tokenSet } from '../../src/lib/services/vector-service'
import { outboundWatchersEnabled, setOutboundWatchers, getSetting, setSetting } from '../../src/lib/services/settings-service'
import { egressFetch, EgressPausedError } from '../../src/lib/services/egress'
import { sweepWatchlist } from '../../src/lib/services/watchlist-service'
import { syncOpenClaw } from '../../src/lib/services/openclaw-service'
import { markLvSyncCheck } from '../../src/lib/oj/upstream-sync'
import { enforceRetentionCaps, retentionCaps, trimModelToCap } from '../../src/lib/services/retention-service'
import type { ToolInfo } from '../../src/lib/types'

const BASE = 'http://127.0.0.1:3000'
const COOKIE = () => `mist_session=${issueSession()}`

// ═══════════════════════════════════════════════════════════════════════
// P2/P7 — tool routing + parallel context blocks
// ═══════════════════════════════════════════════════════════════════════

describe('tool routing (P2: core + top-k ≤12 + find_tool)', () => {
  const PROBE = 'hey, what can you actually do around here?'

  function coreSection(prompt: string): string {
    const m = prompt.match(/TOOLS AVAILABLE \(core[\s\S]*?(?=\n\nTOOLS RELEVANT)/)
    expect(m).not.toBeNull()
    return m![0]
  }

  function topKSection(prompt: string): string {
    const m = prompt.match(/TOOLS RELEVANT TO THIS MESSAGE[\s\S]*?(?=\n\n|$)/)
    expect(m).not.toBeNull()
    return m![0]
  }

  test('the CORE block serializes IDENTICALLY every turn (stable prefix, hash equal)', async () => {
    invalidateToolBlockCache()
    const a = await buildContext(PROBE, 'chat')
    const b = await buildContext(PROBE, 'chat')
    expect(coreSection(a.prompt)).toBe(coreSection(b.prompt))
  })

  test('core block: ≤15 one-line entries, no argument schemas, sorted', async () => {
    const ctx = await buildContext(PROBE, 'chat')
    const core = coreSection(ctx.prompt)
    const lines = core.match(/^- [a-z0-9_]+ — .+$/gm) ?? []
    expect(lines.length).toBeGreaterThan(0)
    expect(lines.length).toBeLessThanOrEqual(15)
    for (const line of lines) {
      // one-liner: first sentence capped ~80 chars — the whole line stays short
      expect(line.length).toBeLessThanOrEqual(120)
      // NO param schemas in the core list (the top-k block is the only place)
      expect(line).not.toMatch(/\(\w+: \w+ \((required|default)/)
    }
    const names = lines.map((l) => l.slice(2, l.indexOf(' — ')))
    expect([...names].sort()).toEqual(names) // sorted → stable serialization
  })

  test('capability_check (the find-tool) is in core and tells her how to request more', async () => {
    const ctx = await buildContext(PROBE, 'chat')
    const core = coreSection(ctx.prompt)
    expect(core).toContain('- capability_check — ')
    expect(core).toContain('NEED MORE TOOLS? capability_check(intent)')
  })

  test('every frozen core name exists in the live registry and is implemented', () => {
    const implemented = new Set(BASE_TOOLS.filter((t) => t.info.implemented).map((t) => t.info.name))
    const src = readFileSync(path.join(process.cwd(), 'src/lib/services/context-builder.ts'), 'utf8')
    const m = src.match(/const CORE_TOOL_NAMES = \[([\s\S]*?)\] as const/)
    expect(m).not.toBeNull()
    const names = [...m![1].matchAll(/'([a-z0-9_]+)'/g)].map((x) => x[1])
    expect(names.length).toBeGreaterThan(0)
    expect(names.length).toBeLessThanOrEqual(15)
    for (const n of names) expect(implemented.has(n)).toBe(true)
  })

  test('top-k block ships ≤12 FULL schemas (tool-heavy message)', async () => {
    const ctx = await buildContext(
      'search the web and read a page about the weather in Lagos, then take a screenshot and run a background task',
      'chat'
    )
    const top = topKSection(ctx.prompt)
    const schemas = top.match(/^- [a-z0-9_:]+ — .+\(.+\)$/gm) ?? []
    expect(schemas.length).toBeGreaterThan(0)
    expect(schemas.length).toBeLessThanOrEqual(12)
  })

  test('an irrelevant message ships ZERO schemas (the core + find-tool carry it)', async () => {
    const ctx = await buildContext('hello there', 'chat')
    const top = topKSection(ctx.prompt)
    expect(top).toContain('none scored relevant')
    expect((top.match(/^- /gm) ?? []).length).toBe(0)
  })

  test('static prefix ≤ 2.5k tokens and prompt tokens dropped ≥30% vs the 2026-10-10 baseline', async () => {
    const ctx = await buildContext(PROBE, 'chat')
    const staticPrefix = coreSection(ctx.prompt) // core + discovery + tool-use rule
    expect(Math.round(staticPrefix.length / 4)).toBeLessThanOrEqual(2500)
    // baseline: promptChars 62506 ≈ 15627 tokens for the same probe message
    const afterTokens = Math.round(ctx.prompt.length / 4)
    expect(afterTokens).toBeLessThanOrEqual(Math.round(15627 * 0.7))
  })

  test('selectTopKTools is deterministic and relevance-ordered', () => {
    const tools: ToolInfo[] = [
      { name: 'web_search', description: 'Search the live web for information.', category: 'web', implemented: true, parameters: [] },
      { name: 'calculate', description: 'Safely evaluate a math expression.', category: 'utility', implemented: true, parameters: [] },
      { name: 'dream_recall', description: 'Recall dreams from the journal.', category: 'memory', implemented: true, parameters: [] },
    ]
    const a = selectTopKTools(tools, 'search the web for the weather')
    const b = selectTopKTools(tools, 'search the web for the weather')
    expect(a.map((t) => t.name)).toEqual(['web_search'])
    expect(a).toEqual(b)
    expect(selectTopKTools(tools, '')).toEqual([]) // nothing to score against
  })

  test('oneLineDescription: first sentence, capped ~80 chars', () => {
    expect(oneLineDescription('First sentence here. Second sentence.')).toBe('First sentence here')
    const long = 'A'.repeat(120)
    expect(oneLineDescription(long)).toHaveLength(80)
    expect(oneLineDescription(long).endsWith('…')).toBe(true)
  })
})

describe('parallel context blocks (P7: Promise.all + per-block timeout)', () => {
  test('a slow block times out honestly (marker, not a hang)', async () => {
    const slow = new Promise<string>((r) => setTimeout(() => r('late'), 200))
    const out = await withBlockTimeout('test-slow', slow, 20)
    expect(out.ok).toBe(false)
    if (out.ok === false) expect(out.reason).toBe('timeout')
  })

  test('a fast block resolves; a rejecting block errors (never throws)', async () => {
    const fast = await withBlockTimeout('test-fast', Promise.resolve('value'), 500)
    expect(fast.ok).toBe(true)
    const boom = await withBlockTimeout('test-boom', Promise.reject(new Error('x')), 500)
    expect(boom.ok).toBe(false)
    if (boom.ok === false) expect(boom.reason).toBe('error')
  })

  test('a late rejection after a timeout win never surfaces unhandled', async () => {
    let rejected = false
    const p = new Promise<never>((_, rej) => setTimeout(() => { rejected = true; rej(new Error('late')) }, 30))
    const out = await withBlockTimeout('test-late-reject', p, 5)
    expect(out.ok).toBe(false)
    await new Promise((r) => setTimeout(r, 60))
    expect(rejected).toBe(true) // it DID reject — and nothing crashed
  })

  test('the per-block timeout is env-tunable with a sane default', () => {
    expect(ctxBlockTimeoutMs()).toBe(800)
    process.env.MIST_CTX_BLOCK_TIMEOUT_MS = '250'
    try {
      expect(ctxBlockTimeoutMs()).toBe(250)
    } finally {
      delete process.env.MIST_CTX_BLOCK_TIMEOUT_MS
    }
  })

  test('buildContext returns metadata (not prompt content) for timeouts', async () => {
    const ctx = await buildContext('hello there', 'chat')
    expect(ctx.prompt).toBeDefined()
    expect(ctx.tools_available).toBeGreaterThan(0)
    // block_timeouts is metadata-only: when present it lists names, never leaks into the prompt
    for (const name of ctx.block_timeouts ?? []) {
      expect(ctx.prompt).not.toContain(`timed out after`)
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════
// R10 — lane health: EWMA ordering, breaker, TTFT, hedge pairing
// ═══════════════════════════════════════════════════════════════════════

describe('lane health (R10)', () => {
  beforeAll(() => __resetLaneHealthForTests())
  afterAll(() => __resetLaneHealthForTests())

  test('EWMA math: alpha 0.3 mixes samples as 0.7·prev + 0.3·new', () => {
    __resetLaneHealthForTests()
    noteLaneAttempt('t-ewma', { ok: true, durationMs: 1000 })
    noteLaneAttempt('t-ewma', { ok: true, durationMs: 2000 })
    const st = laneHealthSnapshot().find((s) => s.lane === 't-ewma')
    expect(st?.ewmaMs).toBeCloseTo((1 - EWMA_ALPHA) * 1000 + EWMA_ALPHA * 2000, 5)
  })

  test('EWMA reorders the cascade: the measured-fast lane floats to the front', () => {
    __resetLaneHealthForTests()
    noteLaneAttempt('t-slow', { ok: true, durationMs: 9000 })
    noteLaneAttempt('t-fast', { ok: true, durationMs: 400 })
    // static order would be [t-slow, t-fast, t-unmeasured]
    expect(orderLanes(['t-slow', 't-fast', 't-unmeasured'])).toEqual([
      't-fast',
      't-slow',
      't-unmeasured', // never-attempted keeps static order BEHIND measured lanes
    ])
  })

  test('3 consecutive failures open the circuit; the lane defers to a last-resort rung', () => {
    __resetLaneHealthForTests()
    noteLaneAttempt('t-breaker', { ok: true, durationMs: 500 })
    noteLaneAttempt('t-breaker', { ok: false, durationMs: 100 })
    expect(circuitState('t-breaker')).toBe('closed')
    noteLaneAttempt('t-breaker', { ok: false, durationMs: 100 })
    expect(circuitState('t-breaker')).toBe('closed') // 2 fails is not yet 3
    noteLaneAttempt('t-breaker', { ok: false, durationMs: 100 })
    expect(circuitState('t-breaker')).toBe('open')
    expect(orderLanes(['t-fresh', 't-breaker'])).toEqual(['t-fresh', 't-breaker'])
  })

  test('half-open: the window elapses, a probe succeeds, the circuit closes', () => {
    __resetLaneHealthForTests()
    for (let i = 0; i < 3; i++) noteLaneAttempt('t-half', { ok: false, durationMs: 50 })
    expect(circuitState('t-half')).toBe('open')
    // time-travel past the 5-minute open window (circuitState accepts now)
    const future = Date.now() + 6 * 60_000
    expect(circuitState('t-half', future)).toBe('half-open')
    // the probe succeeds → closed
    noteLaneAttempt('t-half', { ok: true, durationMs: 300 })
    expect(circuitState('t-half')).toBe('closed')
    expect(orderLanes(['t-half', 't-other'])).toEqual(['t-half', 't-other'])
  })

  test('half-open: a failed probe re-opens the circuit', () => {
    __resetLaneHealthForTests()
    for (let i = 0; i < 3; i++) noteLaneAttempt('t-reopen', { ok: false, durationMs: 50 })
    const future = Date.now() + 6 * 60_000
    expect(circuitState('t-reopen', future)).toBe('half-open')
    noteLaneAttempt('t-reopen', { ok: false, durationMs: 50 }) // the probe fails
    expect(circuitState('t-reopen')).toBe('open')
  })

  test('when EVERY lane is open, the original order stands (never refuse to connect)', () => {
    __resetLaneHealthForTests()
    for (let i = 0; i < 3; i++) noteLaneAttempt('t-a', { ok: false, durationMs: 50 })
    for (let i = 0; i < 3; i++) noteLaneAttempt('t-b', { ok: false, durationMs: 50 })
    expect(orderLanes(['t-a', 't-b'])).toEqual(['t-a', 't-b'])
  })

  test('TTFT deadlines: cloud 8s · local 20s cold / 5s warm (warmth = success <60s)', () => {
    __resetLaneHealthForTests()
    expect(ttftCloudMs()).toBe(8000)
    expect(ttftLocalColdMs()).toBe(20000)
    expect(ttftLocalWarmMs()).toBe(5000)
    expect(ttftDeadlineMs('t-cloud', false)).toBe(8000)
    expect(ttftDeadlineMs('core', true)).toBe(20000) // local, cold (never used)
    expect(isLocalLane('core', null)).toBe(true)
    expect(isLocalLane('kilo', 'https://api.kilo.com/v1')).toBe(false)
    noteLaneAttempt('core', { ok: true, durationMs: 800 })
    expect(laneWarm('core')).toBe(true)
    expect(ttftDeadlineMs('core', true)).toBe(5000) // warm now
  })

  test('a TTFT breach counts toward the breaker (a lane consistently too slow IS failing)', () => {
    __resetLaneHealthForTests()
    for (let i = 0; i < 3; i++) noteLaneAttempt('t-ttft', { ok: false, durationMs: 8000, ttftBreach: true })
    expect(circuitState('t-ttft')).toBe('open')
    const st = laneHealthSnapshot().find((s) => s.lane === 't-ttft')
    expect(st?.ttftBreaches).toBe(3)
  })

  test('hedge pairing: never two keyless lanes — the hedge is owner-keyed or local ONLY', () => {
    expect(isHedgeableLane('kilo', {})).toBe(false) // public keyless, no key
    expect(isHedgeableLane('pollinations', {})).toBe(false)
    expect(isHedgeableLane('kilo', { apiKey: 'byok' })).toBe(true) // owner-keyed via BYOK
    expect(isHedgeableLane('openrouter', { apiKey: 'sk-x' })).toBe(true)
    expect(isHedgeableLane('core', {})).toBe(true) // local
    // the pick walks candidates but ONLY returns hedgeable ones
    const pick = pickHedgeLane('kilo', [
      { lane: 'pollinations', hedgeable: false },
      { lane: 'llm7', hedgeable: false },
      { lane: 'openrouter', hedgeable: true },
    ])
    expect(pick).toBe('openrouter')
    // with only keyless candidates there is NO hedge (sequential fall-through)
    expect(
      pickHedgeLane('kilo', [
        { lane: 'pollinations', hedgeable: false },
        { lane: 'llm7', hedgeable: false },
      ])
    ).toBeNull()
    // a keyed primary may hedge to a local lane; the primary itself is never its own hedge
    expect(pickHedgeLane('openrouter', [{ lane: 'openrouter', hedgeable: true }, { lane: 'core', hedgeable: true }])).toBe('core')
  })

  test('llm-service wires the measured ladder (source-of-truth scan)', () => {
    const src = readFileSync(path.join(process.cwd(), 'src/lib/services/llm-service.ts'), 'utf8')
    expect(src).toContain('order = orderLanes(order)')
    expect(src).toContain('ttft-deadline')
    expect(src).toContain('pickHedgeLane')
    expect(src).toContain('hedge-race-lost') // the loser is aborted silently
    expect(src).not.toContain('stickyLaneOrder') // the single-pin ordering is superseded
    expect(src).not.toContain('noteStickySuccess')
  })
})

// ═══════════════════════════════════════════════════════════════════════
// R5 — dormant = 0 outbound unless opted in (visible indicator)
// ═══════════════════════════════════════════════════════════════════════

describe('outbound watchers opt-in (R5)', () => {
  // spy seam: swap globalThis.fetch, count calls, restore in afterAll
  let fetchCalls = 0
  const realFetch = globalThis.fetch

  beforeAll(async () => {
    await setOutboundWatchers(false) // the dormant default, explicit
  })

  afterAll(async () => {
    globalThis.fetch = realFetch
    await setOutboundWatchers(false) // leave the machine dormant
    await db.setting.deleteMany({ where: { key: { in: ['test:setting:1'] } } }).catch(() => {})
  })

  test('the flag defaults to FALSE (dormant = 0 outbound)', async () => {
    await db.setting.deleteMany({ where: { key: 'outbound_watchers' } }).catch(() => {})
    // clear the ~2s read cache by writing through the service (same process)
    expect(await outboundWatchersEnabled()).toBe(false)
  })

  test('with the flag FALSE, egressFetch throws BEFORE any socket opens (fetch spy: zero calls)', async () => {
    fetchCalls = 0
    globalThis.fetch = (async () => {
      fetchCalls++
      return new Response('{}')
    }) as typeof fetch
    try {
      await expect(egressFetch('https://registry.npmjs.org/openclaw/latest')).rejects.toBeInstanceOf(EgressPausedError)
      expect(fetchCalls).toBe(0) // provably zero outbound
    } finally {
      globalThis.fetch = realFetch
    }
  })

  test('with the flag TRUE, egressFetch passes through to fetch (spy sees the call)', async () => {
    await setOutboundWatchers(true)
    fetchCalls = 0
    globalThis.fetch = (async () => {
      fetchCalls++
      return new Response('{"version":"ok"}')
    }) as typeof fetch
    try {
      const res = await egressFetch('https://registry.npmjs.org/openclaw/latest')
      expect(res.ok).toBe(true)
      expect(fetchCalls).toBe(1) // the flag restored the outbound path
    } finally {
      globalThis.fetch = realFetch
      await setOutboundWatchers(false)
    }
  })

  test('a watchlist sweep with the flag false performs ZERO outbound and answers honestly paused', async () => {
    fetchCalls = 0
    globalThis.fetch = (async () => {
      fetchCalls++
      return new Response('{}')
    }) as typeof fetch
    try {
      const res = await sweepWatchlist(true)
      expect(res.paused).toBe(true)
      expect(res.ok).toBe(false)
      expect(res.message).toContain('watchers paused')
      expect(fetchCalls).toBe(0)
    } finally {
      globalThis.fetch = realFetch
    }
  })

  test('the oj-sync and mark-lv sweeps and the openclaw digest idle honestly (paused, no egress)', async () => {
    const oj = await (await import('../../src/lib/oj/upstream-sync')).sweepOjSync(true)
    expect(oj.paused).toBe(true)
    expect(oj.message).toContain('watchers paused')
    const mlv = await markLvSyncCheck(true)
    expect(mlv.paused).toBe(true)
    const oc = await syncOpenClaw(true)
    expect(oc.paused).toBe(true)
  })

  test('settings rows round-trip (the Setting store)', async () => {
    expect((await setSetting('test:setting:1', 'hello')).ok).toBe(true)
    expect(await getSetting('test:setting:1')).toBe('hello')
  })

  test('LIVE /api/mist/health surfaces watchers:{enabled} (visible indicator)', async () => {
    const res = await fetch(`${BASE}/api/mist/health`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { watchers?: { enabled?: boolean } }
    expect(typeof body.watchers?.enabled).toBe('boolean')
  })

  test('LIVE /api/mist/oj/sync carries the watchers state + the toggle answers through the perimeter', async () => {
    const get = await fetch(`${BASE}/api/mist/oj/sync`)
    expect(get.status).toBe(200)
    const body = (await get.json()) as { watchers?: { enabled?: boolean; note?: string } }
    expect(typeof body.watchers?.enabled).toBe('boolean')
    expect(body.watchers?.note).toBeTruthy()
    // the toggle is a POST — perimeter-sessioned like every write
    const post = await fetch(`${BASE}/api/mist/oj/sync`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: COOKIE() },
      body: JSON.stringify({ action: 'watchers_set', enabled: true }),
    })
    expect(post.status).toBe(200)
    const set = (await post.json()) as { ok: boolean; enabled: boolean }
    expect(set.ok).toBe(true)
    expect(set.enabled).toBe(true)
    // …and back to dormant
    await setOutboundWatchers(false)
    expect(await outboundWatchersEnabled()).toBe(false)
  })

  test('LIVE /api/mist/events carries the flag on the health topic', async () => {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), 5000)
    const res = await fetch(`${BASE}/api/mist/events?panels=chat`, {
      signal: ctrl.signal,
      headers: { accept: 'text/event-stream' },
    }).catch(() => null)
    expect(res?.status).toBe(200)
    const reader = res!.body?.getReader()
    const first = await reader!.read()
    clearTimeout(t)
    const text = new TextDecoder().decode(first.value ?? new Uint8Array())
    ctrl.abort()
    try {
      await reader!.cancel()
    } catch {
      /* abort race is fine */
    }
    const ev = JSON.parse(text.replace(/^data: /, '').trim()) as {
      topics?: { health?: { watchers?: { enabled?: boolean } } }
    }
    expect(typeof ev.topics?.health?.watchers?.enabled).toBe('boolean')
  })
})

// ═══════════════════════════════════════════════════════════════════════
// P5 — retention caps
// ═══════════════════════════════════════════════════════════════════════

describe('retention caps (P5)', () => {
  const ANCIENT = new Date('2020-01-01T00:00:00Z')
  const FUTURE = new Date(Date.now() + 3600_000)
  const mine: { alert: string[]; autonomy: string[]; trace: string[] } = { alert: [], autonomy: [], trace: [] }

  afterAll(async () => {
    // leave nothing behind: my surviving rows are removed explicitly
    if (mine.alert.length) await db.alert.deleteMany({ where: { id: { in: mine.alert } } }).catch(() => {})
    if (mine.autonomy.length) await db.autonomyEvent.deleteMany({ where: { id: { in: mine.autonomy } } }).catch(() => {})
    if (mine.trace.length) await db.trace.deleteMany({ where: { id: { in: mine.trace } } }).catch(() => {})
  })

  test('caps are env-tunable with the mandate defaults', () => {
    const caps = retentionCaps()
    expect(caps.fastReply).toBe(500)
    expect(caps.spokenCache).toBe(400)
    expect(caps.trace).toBe(5000)
    expect(caps.autonomyEvent).toBe(2000)
    expect(caps.knowledgeChunk).toBe(5000)
    expect(caps.alert).toBe(400)
    process.env.MIST_RETENTION_ALERT = '25'
    try {
      expect(retentionCaps().alert).toBe(25)
    } finally {
      delete process.env.MIST_RETENTION_ALERT
    }
  })

  test('seed over-cap rows for TWO models → trim → fixture verdicts hold (marker-anchored, race-free)', async () => {
    // DETERMINISM (5-fix): exact global-cap arithmetic (`deleted === 6`) raced
    // the LIVE dev server — a heartbeat/dev-guard alert landing between seed
    // and trim shifts `deleted` by one and breaks the run (proven in the
    // OOM-heal suite run). The FIXTURE MARKER is the honest anchor instead:
    // ANCIENT rows are always the oldest rows in the table and FUTURE rows
    // always the newest (no live row carries a future createdAt), so the
    // trim's verdict ON THEM is deterministic no matter what the live server
    // does during the window. `after <= cap` is the invariant that matters;
    // exact `deleted` counts are observational, not contractual.
    //
    // ALERT: 6 ancient seeds + 2 future seeds. cap = everyone-else + 2 → the
    // ancient six are the overflow, the future two survive.
    const othersAlert = await db.alert.count({ where: { title: { not: { contains: 'pq4b-' } } } })
    for (let i = 0; i < 6; i++) {
      const row = await db.alert.create({
        data: {
          kind: 'system',
          title: `pq4b-ancient-alert-${i}`,
          body: 'retention test fixture (ancient)',
          createdAt: new Date(ANCIENT.getTime() + i * 1000),
        },
      })
      mine.alert.push(row.id)
    }
    for (let i = 0; i < 2; i++) {
      const row = await db.alert.create({
        data: {
          kind: 'system',
          title: `pq4b-newest-alert-${i}`,
          body: 'retention test fixture (newest)',
          createdAt: new Date(FUTURE.getTime() + i * 1000),
        },
      })
      mine.alert.push(row.id)
    }
    const cap = othersAlert + 2 // my future seeds + everyone else survive
    const res = await trimModelToCap('alert', cap)
    // fixture verdicts: every ancient row is gone, every future row survives
    expect(await db.alert.count({ where: { title: { contains: 'pq4b-ancient' } } })).toBe(0)
    const remaining = await db.alert.findMany({ where: { title: { contains: 'pq4b-' } } })
    expect(remaining.map((r) => r.title).sort()).toEqual(['pq4b-newest-alert-0', 'pq4b-newest-alert-1'])
    // the cap invariant (a concurrent live row can only LOWER `after`)
    expect(res.after).toBeLessThanOrEqual(cap)
    expect(res.after).toBeGreaterThanOrEqual(2) // my survivors are in there
    expect(res.deleted).toBeGreaterThan(0) // the trim did trim

    // AUTONOMY EVENT: same marker-anchored shape, second model
    const othersAutonomy = await db.autonomyEvent.count({ where: { summary: { not: { contains: 'pq4b-' } } } })
    for (let i = 0; i < 5; i++) {
      const row = await db.autonomyEvent.create({
        data: {
          type: 'retention_test',
          summary: `pq4b-ancient-autonomy-${i}`,
          createdAt: new Date(ANCIENT.getTime() + i * 1000),
        },
      })
      mine.autonomy.push(row.id)
    }
    const row = await db.autonomyEvent.create({
      data: { type: 'retention_test', summary: 'pq4b-newest-autonomy', createdAt: FUTURE },
    })
    mine.autonomy.push(row.id)
    const res2 = await trimModelToCap('autonomyEvent', othersAutonomy + 1)
    expect(await db.autonomyEvent.count({ where: { summary: { contains: 'pq4b-ancient' } } })).toBe(0)
    const remaining2 = await db.autonomyEvent.findMany({ where: { summary: { contains: 'pq4b-' } } })
    expect(remaining2.map((r) => r.summary)).toEqual(['pq4b-newest-autonomy'])
    expect(res2.after).toBeLessThanOrEqual(othersAutonomy + 1)
    expect(res2.after).toBeGreaterThanOrEqual(1)
    expect(res2.deleted).toBeGreaterThan(0)
  })

  test('Trace trim cascades TraceStep (no orphans)', async () => {
    // seed 2 ancient traces, each with a step; trim with cap 0 for these ids
    // via count-based cap: cap = real count → my ancient rows overflow
    const realTraces = await db.trace.count()
    for (let i = 0; i < 2; i++) {
      const t = await db.trace.create({
        data: {
          query: `pq4b-ancient-trace-${i}`,
          createdAt: new Date(ANCIENT.getTime() + i * 1000),
        },
      })
      mine.trace.push(t.id)
      await db.traceStep.create({
        data: { traceId: t.id, idx: 0, type: 'route', createdAt: ANCIENT },
      })
    }
    const res = await trimModelToCap('trace', realTraces)
    // marker-anchored (same race-free shape as the TWO-models test above —
    // exact `deleted` races concurrent live traces): my ancient pair is gone
    expect(res.deleted).toBeGreaterThanOrEqual(2)
    expect(await db.trace.count({ where: { query: { contains: 'pq4b-ancient-trace' } } })).toBe(0)
    // the steps went WITH their traces (engine-level onDelete: Cascade)
    const orphanSteps = await db.traceStep.count({ where: { traceId: { in: mine.trace } } })
    expect(orphanSteps).toBe(0)
  })

  test('enforceRetentionCaps runs every table without throwing and returns honest results', async () => {
    const results = await enforceRetentionCaps()
    expect(results.length).toBe(6)
    for (const r of results) {
      expect(r.after).toBeLessThanOrEqual(r.cap)
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════
// P6 — lexical honesty (Intl.Segmenter + hash dedupe + honest labels)
// ═══════════════════════════════════════════════════════════════════════

describe('lexical honesty (P6)', () => {
  test('tokenize: word segmentation, stopwords dropped, DUPLICATES kept (TF needs counts)', () => {
    const toks = tokenize('the cat sat on the mat, cat!')
    expect(toks).toEqual(['cat', 'sat', 'mat', 'cat']) // the/on are stopwords
  })

  test('dedupeTokens / tokenSet: hash-dedupe, first-seen order', () => {
    expect(dedupeTokens(['cat', 'sat', 'cat', 'mat', 'sat'])).toEqual(['cat', 'sat', 'mat'])
    expect(tokenSet('cat cat sat mat sat mat')).toEqual(['cat', 'sat', 'mat'])
  })

  test('the vector-service header tells the truth: no embeddings, lexical engine', () => {
    const src = readFileSync(path.join(process.cwd(), 'src/lib/services/vector-service.ts'), 'utf8')
    expect(src).toContain('purely LEXICAL')
    expect(src).toContain('NO\n// embeddings here')
  })

  test('the memory-tab surfaces say "lexical" (embeddings not installed), not "vector memory"', () => {
    const src = readFileSync(path.join(process.cwd(), 'src/components/mist/diagnostics/memory-tab.tsx'), 'utf8')
    expect(src).toContain('lexical recall (embeddings not installed)')
    expect(src).not.toContain('aria-label="Vector memory search"')
    expect(src).not.toContain('semantic recall')
  })
})

// ═══════════════════════════════════════════════════════════════════════
// S15 — z-ai-web-dev-sdk is DYNAMIC (never loads at boot)
// ═══════════════════════════════════════════════════════════════════════

describe('z-ai dynamic import (S15)', () => {
  test('zai.ts imports the SDK dynamically only (source-of-truth scan)', () => {
    const src = readFileSync(path.join(process.cwd(), 'src/lib/services/zai.ts'), 'utf8')
    expect(src).toContain("import('z-ai-web-dev-sdk')")
    expect(src).not.toMatch(/^import ZAI from 'z-ai-web-dev-sdk'/m) // the static boot-time import is gone
  })

  test('no client-side module imports the SDK (backend-only contract)', () => {
    // real scan: walk the CLIENT surfaces (components + hooks) and assert
    // nothing there imports the SDK. llm-service's `import type` is erased at
    // compile time and never loads anything — backend services may keep it.
    const scan = (dir: string): string[] => {
      const found: string[] = []
      let entries: Array<{ name: string; isDirectory(): boolean }>
      try {
        entries = readdirSync(dir, { withFileTypes: true })
      } catch {
        return found
      }
      for (const e of entries) {
        const p = `${dir}/${e.name}`
        if (e.isDirectory()) found.push(...scan(p))
        else if (e.name.endsWith('.tsx') || e.name.endsWith('.ts')) {
          const src = readFileSync(p, 'utf8')
          if (/from ['"]z-ai-web-dev-sdk['"]/.test(src) && !/^import type /m.test(src)) found.push(p)
        }
      }
      return found
    }
    expect(scan(path.join(process.cwd(), 'src/components'))).toEqual([])
    expect(scan(path.join(process.cwd(), 'src/hooks'))).toEqual([])
  })
})
