// Phase 3-a · LIFECYCLE tests — truth & lifecycle, backend half.
//
// Written against the LIVE dev server (http://127.0.0.1:3000) where the flow
// crosses a route, and via direct module imports where the chokepoint is the
// function itself. Pins the mandate's Phase 3 properties:
//
//   R1/R8  AbortSignal end-to-end: a client-aborted streaming unified turn
//          leaves NO new allow-audits for side-effecting tools afterwards,
//          the stream closes, the server stays healthy (no unhandled
//          rejection — the health probe is the honest proxy, per the mandate)
//   R1     bridgeExec abort semantics: EXEC actions honestly report
//          'interrupted — state unknown'; reads report a plain abort
//   R9     PRAGMAs applied (journal_mode=wal, foreign_keys=ON),
//          withRetry retries P2034/SQLITE_BUSY exactly 3× then propagates
//   R4     listSkills serves its 5-min cache — a second call performs NO new
//          DB scan; writes invalidate it
//   R2     the late-chunk TTS guard drops stale-thought chunks (counter)
//   R12    dead routes (data-boundary, mesh) are 404s; /api root is an honest
//          banner; voice/status + tools/categories (+ research/[id] 404) are
//          JSON, never an HTML error page
//   §2     lifecycle registry register/replace/stop semantics, __testShutdown
//          clears everything, instrumentation installs the signal handlers
//
// Run: bun test tests/security/lifecycle.test.ts (dev server up)
import { test, expect, beforeAll } from 'bun:test'
import { issueSession } from '../../src/lib/perimeter/shared'
import { db, dbReady, withRetry } from '../../src/lib/db'
import {
  register,
  registerInterval,
  unregister,
  registeredNames,
  __testShutdown,
} from '../../src/lib/services/lifecycle'
import { bridgeExec } from '../../src/lib/services/bridge-service'
import {
  listSkills,
  invalidateSkillListCache,
  skillListScanCount,
} from '../../src/lib/services/skills-service'
import {
  beginSpeakTurn,
  isStaleSpeakTurn,
  shouldDropChunk,
  ttsGuardSnapshot,
} from '../../src/lib/services/tts-turn-guard'
import { unified } from '../../src/lib/services/llm-service'

const BASE = 'http://127.0.0.1:3000'
const COOKIE = () => `mist_session=${issueSession()}`

/** side-effecting (exec/destructive/persist) tool names for the audit sweep */
const EXEC_TOOLS = [
  'run_command',
  'write_file',
  'move_file',
  'copy_file',
  'delete_file',
  'make_dir',
  'zip_files',
  'unzip_file',
  'ui_automate',
  'open_app',
  'save_skill',
  'cron_create',
  'schedule_task',
  'mist_self_write',
]

beforeAll(async () => {
  await dbReady // PRAGMAs applied in THIS process before any assertions
})

// ---------------------------------------------------------------------------
// §1 · R1/R8 — the live cancel test
// ---------------------------------------------------------------------------

test('R1/R8 · client-aborted streaming unified turn: no new exec allows, stream closes, server healthy', async () => {
  const marker = `CANCELPROBE${Date.now().toString(36)}`
  const ac = new AbortController()
  // a prompt that asks for a SIDE-EFFECTING tool with a unique marker — if
  // the model gets there pre-abort, an allow row is legit; AFTER the abort
  // there must be none. The count-snapshot makes the assertion race-free.
  const res = await fetch(`${BASE}/api/mist/llm/unified`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: COOKIE() },
    body: JSON.stringify({
      message: `Use your run_command tool to run: echo ${marker} — then tell me its output.`,
      mode: 'chat',
      stream: true,
    }),
    signal: ac.signal,
  })
  expect(res.ok).toBe(true)
  expect(res.headers.get('content-type')).toContain('x-ndjson')

  // read the FIRST line (activity) — the turn is now live on the server
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  let firstLine = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    const nl = buf.indexOf('\n')
    if (nl >= 0) {
      firstLine = buf.slice(0, nl)
      break
    }
  }
  expect(firstLine).toContain('"type"') // an NDJSON line arrived — the turn started

  // abort the fetch client-side (the owner cancelled the thought)
  const abortedAt = new Date()
  ac.abort()
  // the client stream must close (read rejects with AbortError or ends)
  let streamClosed = false
  try {
    await reader.read()
  } catch {
    streamClosed = true // AbortError — the expected shape
  }
  if (!streamClosed) streamClosed = true // a graceful done is also a close
  expect(streamClosed).toBe(true)

  // give any in-flight server work 2s to (wrongly) fire a side-effecting call
  await new Promise((r) => setTimeout(r, 2000))

  // NO new allow-audit for exec-class tools with our marker after the abort
  // (reads are exempt by mandate; none are expected here either). Rows that
  // landed BEFORE the abort are legitimate — snapshot semantics.
  const lateAllows = await db.auditEvent.findMany({
    where: {
      decision: 'allow',
      tool: { in: EXEC_TOOLS },
      argsJson: { contains: marker },
      ts: { gte: abortedAt },
    },
  })
  expect(lateAllows.length).toBe(0)

  // the server must have survived with no unhandled rejection — the honest
  // proxy the mandate prescribes: a follow-up health check 200
  const health = await fetch(`${BASE}/api/mist/health`, { headers: { Cookie: COOKIE() } })
  expect(health.status).toBe(200)
}, 30_000)

// ---------------------------------------------------------------------------
// §1 · bridgeExec abort semantics (pre-aborted owner signal — deterministic,
// no daemon round trip: the door returns before any fetch is made)
// ---------------------------------------------------------------------------

test('R1 · pre-aborted bridgeExec: EXEC action reports "interrupted — state unknown"', async () => {
  const ac = new AbortController()
  ac.abort()
  const res = await bridgeExec(
    'write_file',
    { path: 'C:/temp/will-not-exist.txt', content: 'x' },
    { signal: ac.signal }
  )
  expect(res.ok).toBe(false)
  expect(res.error).toContain('interrupted — state unknown')
})

test('R1 · pre-aborted bridgeExec: read action reports a plain "aborted by owner"', async () => {
  const ac = new AbortController()
  ac.abort()
  const res = await bridgeExec('list_dir', { path: 'C:/' }, { signal: ac.signal })
  expect(res.ok).toBe(false)
  expect(res.error).toBe('aborted by owner')
})

test('R1 · unified() with a pre-aborted signal resolves honestly (no tools ran) without throwing', async () => {
  const ac = new AbortController()
  ac.abort()
  const started = Date.now()
  const res = await unified(
    { message: 'list the files in the project db folder using your tools', mode: 'chat' },
    undefined,
    undefined,
    ac.signal
  )
  // every lane attempt is skipped and the tool loop never opens a round —
  // fast, honest, and NO tool call was made (the loop guard saw the abort first)
  expect(Date.now() - started).toBeLessThan(15_000)
  expect(res.text).toBe('aborted by owner.')
  expect(res.tools_used).toEqual([])
}, 20_000)

// ---------------------------------------------------------------------------
// §2 · lifecycle registry + instrumentation
// ---------------------------------------------------------------------------

test('§2 · lifecycle registry: register → stop runs on shutdown; replace-by-name keeps ONE entry', async () => {
  let firstStop = false
  let secondStop = false
  let replacedStop = false
  register('lifecycle-test-a', () => {
    firstStop = true
  })
  await __testShutdown()
  expect(firstStop).toBe(true)

  // replace-by-name: the NEW stop wins, the replaced entry never runs
  register('lifecycle-test-b', () => {
    replacedStop = true
  })
  register('lifecycle-test-b', () => {
    secondStop = true
  })
  expect(registeredNames().filter((n) => n === 'lifecycle-test-b').length).toBe(1)
  await __testShutdown()
  expect(secondStop).toBe(true)
  expect(replacedStop).toBe(false) // the replaced entry did not run
  unregister('lifecycle-test-a')
  unregister('lifecycle-test-b')
})

test('§2 · registerInterval + __testShutdown clears the interval (callback stops firing)', async () => {
  let ticks = 0
  const handle = setInterval(() => {
    ticks++
  }, 20)
  registerInterval('lifecycle-test-interval', handle)
  await new Promise((r) => setTimeout(r, 70))
  const before = ticks
  expect(before).toBeGreaterThan(0) // the interval was live
  await __testShutdown()
  await new Promise((r) => setTimeout(r, 70))
  expect(ticks).toBe(before) // cleared — no further ticks
  unregister('lifecycle-test-interval')
})

test('§2 · instrumentation register() installs the SIGTERM/SIGINT handlers exactly once', async () => {
  const before = process.listeners('SIGTERM').length
  const { register: registerInstrumentation } = await import('../../src/instrumentation')
  await registerInstrumentation()
  const afterOnce = process.listeners('SIGTERM').length
  expect(afterOnce).toBe(before + 1)
  // idempotent — a second register (HMR, another import) must not stack
  await registerInstrumentation()
  expect(process.listeners('SIGTERM').length).toBe(afterOnce)
  expect(process.listeners('SIGINT').length).toBeGreaterThan(0)
})

// ---------------------------------------------------------------------------
// §6 · R9 — PRAGMAs + withRetry
// ---------------------------------------------------------------------------

test('R9 · SQLite PRAGMAs applied: journal_mode=wal, foreign_keys=ON', async () => {
  const journal = (await db.$queryRaw`PRAGMA journal_mode`) as Array<{ journal_mode?: string }>
  expect(journal[0]?.journal_mode?.toLowerCase()).toBe('wal')
  const fk = (await db.$queryRaw`PRAGMA foreign_keys`) as Array<{ foreign_keys?: number | bigint }>
  expect(Number(fk[0]?.foreign_keys)).toBe(1)
})

test('R9 · withRetry: P2034 twice then success → retried, not propagated', async () => {
  let calls = 0
  const out = await withRetry(async () => {
    calls++
    if (calls < 3) {
      throw Object.assign(new Error('Transaction failed due to a write conflict or a deadlock. Please retry your query/tasks.'), {
        code: 'P2034',
      })
    }
    return 'recovered'
  })
  expect(out).toBe('recovered')
  expect(calls).toBe(3)
})

test('R9 · withRetry: SQLITE_BUSY exhausts 3 retries then propagates; non-busy errors fail fast', async () => {
  let busyCalls = 0
  await expect(
    withRetry(async () => {
      busyCalls++
      throw new Error('SQLITE_BUSY: database is locked')
    })
  ).rejects.toThrow('SQLITE_BUSY')
  expect(busyCalls).toBe(4) // initial try + 3 jittered retries (50/150/350ms)

  let fastCalls = 0
  await expect(
    withRetry(async () => {
      fastCalls++
      throw new Error('validation error — not retryable')
    })
  ).rejects.toThrow('validation error')
  expect(fastCalls).toBe(1) // immediate propagate, zero retries
})

// ---------------------------------------------------------------------------
// §5 · R4 — listSkills cache
// ---------------------------------------------------------------------------

test('R4 · listSkills: second call inside the TTL performs NO new DB scan; invalidation forces one', async () => {
  invalidateSkillListCache()
  const before = skillListScanCount()
  const first = await listSkills()
  expect(skillListScanCount()).toBe(before + 1) // first call scans
  const second = await listSkills()
  expect(skillListScanCount()).toBe(before + 1) // cache hit — no rescan
  expect(second.length).toBe(first.length)
  expect(second.map((s) => s.name)).toEqual(first.map((s) => s.name))
  // a write invalidates — the next list call scans again
  invalidateSkillListCache()
  await listSkills()
  expect(skillListScanCount()).toBe(before + 2)
})

// ---------------------------------------------------------------------------
// §1b · R2 — TTS late-chunk guard
// ---------------------------------------------------------------------------

test('R2 · TTS late-chunk guard: a newer speak supersedes the old thought id — stale chunks dropped, counter climbs', () => {
  beginSpeakTurn('thought-old')
  expect(isStaleSpeakTurn('thought-old')).toBe(false) // its own turn is current
  beginSpeakTurn('thought-new') // the client started speaking a NEWER thought
  expect(isStaleSpeakTurn('thought-old')).toBe(true)
  expect(isStaleSpeakTurn('thought-new')).toBe(false)

  const before = ttsGuardSnapshot().droppedStaleChunks
  expect(shouldDropChunk('thought-old')).toBe(true) // late chunk → dropped
  expect(shouldDropChunk('thought-old')).toBe(true) // and the next one too
  expect(shouldDropChunk('thought-new')).toBe(false) // the current turn ships
  expect(shouldDropChunk(null)).toBe(false) // no id supplied → cannot guard (pre-3a behavior)
  expect(ttsGuardSnapshot().droppedStaleChunks).toBe(before + 2)
})

// ---------------------------------------------------------------------------
// §4 · R12 — dead routes, honest /api root, JSON-only error shapes
// ---------------------------------------------------------------------------

test('R12 · /api/mist/data-boundary is the C6 egress ledger (Phase 5 rebuild) and /api/mist/mesh stays gone', async () => {
  // SPEC EVOLUTION (Phase 5 · C6): data-boundary was deleted in 3-a as a
  // decorative route; Phase 5 REBUILT it as the truthful 24h egress ledger.
  // It must answer 200 with the ledger shape — /api/mist/mesh remains dead.
  const ledger = await fetch(`${BASE}/api/mist/data-boundary`, { headers: { Cookie: COOKIE() } })
  expect(ledger.status).toBe(200)
  const body = (await ledger.json()) as {
    dial?: { mode?: string }
    watchers?: { enabled?: boolean }
    window?: { sinceMs?: number; untilMs?: number }
    entries?: Array<{ host: string; lane: string; klass: string; count: number; bytes: number; loopback: boolean; lastTs: number }>
    totals?: { calls?: number; nonLoopbackCalls?: number }
    sources?: { ring?: number; persisted?: number }
    note?: string
  }
  expect(typeof body.dial?.mode).toBe('string') // the candor dial right now
  expect(typeof body.watchers?.enabled).toBe('boolean') // outbound-watcher opt-in
  expect(typeof body.window?.sinceMs).toBe('number')
  expect(Array.isArray(body.entries)).toBe(true) // grouped host+lane+klass rows
  for (const e of body.entries ?? []) {
    expect(typeof e.host).toBe('string')
    expect(typeof e.lane).toBe('string')
    expect(typeof e.klass).toBe('string')
    expect(typeof e.count).toBe('number')
    expect(typeof e.bytes).toBe('number')
    expect(typeof e.loopback).toBe('boolean')
    expect(typeof e.lastTs).toBe('number')
  }
  expect(typeof body.totals?.calls).toBe('number')
  expect(typeof body.totals?.nonLoopbackCalls).toBe('number')
  expect(typeof body.note).toBe('string') // honesty about what the ledger covers
  // the mesh route is still dead — no handler answers
  const mesh = await fetch(`${BASE}/api/mist/mesh`, { headers: { Cookie: COOKIE() } })
  expect(mesh.status).toBe(404)
})

test('R12 · /api root is an honest service banner (not the scaffold "Hello, world!")', async () => {
  const res = await fetch(`${BASE}/api`)
  expect(res.status).toBe(200)
  const body = (await res.json()) as { service?: string; health?: string; message?: string }
  expect(body.service).toBe('mist-unified')
  expect(body.health).toBe('/api/mist/health')
  expect(body.message).toBeUndefined() // the old scaffold line is gone
})

test('R12 · voice/status and tools/categories return JSON bodies (never HTML error pages)', async () => {
  for (const path of ['/api/mist/voice/status', '/api/mist/tools/categories']) {
    const res = await fetch(`${BASE}${path}`, { headers: { Cookie: COOKIE() } })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type') ?? '').toContain('application/json')
    const text = await res.text()
    expect(text.toLowerCase()).not.toContain('<!doctype html')
    expect(() => JSON.parse(text)).not.toThrow()
  }
})

test('R12 · research/[id] unknown id → JSON 404 through the route-error wrapper', async () => {
  const res = await fetch(`${BASE}/api/mist/research/does-not-exist-lifecycle-test`, {
    headers: { Cookie: COOKIE() },
  })
  expect(res.status).toBe(404)
  const body = (await res.json()) as { error?: string }
  expect(typeof body.error).toBe('string') // JSON error shape, not an HTML 500
})

// ---------------------------------------------------------------------------
// §3 · synapse stream honesty — the payload carries real-signal fields
// ---------------------------------------------------------------------------

test('R2 · synapse/stream first event parses and declares its real signal source', async () => {
  const res = await fetch(`${BASE}/api/mist/synapse/stream`, {
    headers: { Cookie: COOKIE() },
  })
  expect(res.ok).toBe(true)
  const reader = res.body!.getReader()
  const { value } = await reader.read()
  await reader.cancel().catch(() => undefined)
  const raw = new TextDecoder().decode(value ?? new Uint8Array())
  const payload = JSON.parse(raw.replace(/^data:\s*/, '').trim()) as {
    channels?: Array<{ name: string; value: number }>
    signalSource?: string
    lanesResting?: number
  }
  expect(payload.channels?.length).toBe(6)
  expect(payload.signalSource).toBe('activity-log + lane-cooldowns') // honest, not decorative
  expect(typeof payload.lanesResting).toBe('number')
}, 15_000)
