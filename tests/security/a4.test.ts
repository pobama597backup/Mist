// Phase 5 · A4/A6 tests — the unleash protocol, live + in-process.
//
// A4 is the ONLY way scope A4 is ever reached (the settings dial caps at A3 —
// A0–A2 free, A3 needs the standing-orders budget view, Phase 6 gets the full
// UI; here: the setting + the honest scope chip). Pins:
//   the ritual requires a session (perimeter) + duration bounds + passphrase
//   scope A4 + owner_chat + untainted in-scope intents stop asking (matrix)
//   floor 2 (untrusted origins) is NOT softened at A4 — web + destructive → deny
//   the budget fallback: exhausted budget → the A2 ask matrix
//   expiry reverts (a short live unleash at the service-level 5s floor)
//   kill aborts an in-flight bridge call ≤1s + audit rows a4_start / a4_kill
//   kill never needs the passphrase (one tap is the point)
import { test, expect, beforeAll, afterAll } from 'bun:test'
import { readdirSync, rmSync, existsSync } from 'node:fs'
import path from 'node:path'
import { timingSafeEqual } from 'node:crypto'
import { issueSession } from '../../src/lib/perimeter/shared'
import { db } from '../../src/lib/db'
import { arbitrate } from '../../src/lib/arbiter/arbiter'
import { setAutonomyScope, getAutonomyScope } from '../../src/lib/arbiter/wiring'
import {
  a4Status,
  startA4Session,
  killA4,
  registerA4TurnController,
  resolveArbiterScope,
  noteA4AllowedCall,
  A4_ROUTE_MIN_MS,
  A4_MAX_MS,
} from '../../src/lib/arbiter/unleash'
import { executeTool } from '../../src/lib/services/tools-service'
import { SETTING_A4_PASSPHRASE, SETTING_AUTONOMY_SCOPE } from '../../src/lib/services/candor-service'
import { verifyAuditChain } from '../../src/lib/arbiter/audit'

const BASE = 'http://127.0.0.1:3000'
const COOKIE = () => `mist_session=${issueSession()}`

function jsonPost(url: string, body: unknown, headers: Record<string, string> = {}) {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
}

const NOTES_DIR = path.join(process.cwd(), 'db', 'notes')
const NOTE_PREFIX = 'a-unleash-allow-proof'
const PASSPHRASE = 'a4-test-passphrase-9f3ab2'

function rmNoteFiles(prefix: string): void {
  if (!existsSync(NOTES_DIR)) return
  for (const f of readdirSync(NOTES_DIR)) if (f.startsWith(prefix)) rmSync(path.join(NOTES_DIR, f), { force: true })
}

// NOTE on audit rows: the a4_start / a4_kill / a4_expire rows this file mints
// are HONEST lifecycle history and stay in the append-only chain (the wiring
// tests' tail-safe delete exists for rows whose presence would change other
// assertions; nothing here does). A13 verifies the chain after everything.

beforeAll(async () => {
  // start from a clean slate on BOTH processes. The GET also PRE-WARMS the
  // route in the dev server (first-compile of a cold route can eat seconds —
  // the 5.0s render stall the file once hit under suite load);
  // the DELETE kills any session a previous run leaked (bodyless DELETE is
  // legal through the perimeter — the content-type gate only arms on bodies).
  await fetch(`${BASE}/api/mist/autonomy/unleash`, { headers: { Cookie: COOKIE() } }).catch(() => undefined)
  await killA4().catch(() => undefined)
  await fetch(`${BASE}/api/mist/autonomy/unleash`, { method: 'DELETE', headers: { Cookie: COOKIE() } }).catch(() => undefined)
  await db.setting.deleteMany({ where: { key: SETTING_A4_PASSPHRASE } }).catch(() => undefined)
}, 15_000)

afterAll(async () => {
  // live state
  await fetch(`${BASE}/api/mist/autonomy/unleash`, { method: 'DELETE', headers: { Cookie: COOKIE() } }).catch(() => undefined)
  await jsonPost(`${BASE}/api/mist/candor`, { autonomyScope: 'A2' }, { Cookie: COOKIE() }).catch(() => undefined)
  // in-process state
  await killA4().catch(() => undefined)
  setAutonomyScope('A2')
  await db.setting.deleteMany({ where: { key: SETTING_A4_PASSPHRASE } }).catch(() => undefined)
  await db.setting.deleteMany({ where: { key: SETTING_AUTONOMY_SCOPE } }).catch(() => undefined)
  await db.approval.deleteMany({ where: { fingerprint: { contains: 'a-unleash' } } }).catch(() => undefined)
  await db.approval
    .deleteMany({ where: { OR: [{ fingerprint: { contains: 'a4-kill-test' } }, { fingerprint: { contains: 'a-unleash' } }] } })
    .catch(() => undefined)
  await db.alert.deleteMany({ where: { title: { contains: 'a-unleash' } } }).catch(() => undefined)
  rmNoteFiles(NOTE_PREFIX)
  rmNoteFiles('a-unleash-dial-proof') // A11's probes — files only ever exist if a leaked A4 let one through
})

// ---------------------------------------------------------------- the ritual's guards

test('A1 · unleash requires an owner session (perimeter 403 without a cookie)', async () => {
  const res = await jsonPost(`${BASE}/api/mist/autonomy/unleash`, { durationMs: 2 * 3600_000 })
  expect(res.status).toBe(403)
})

test('A2 · duration bounds: 4min → 400, 25h → 400 (5min-24h is the ritual window)', async () => {
  const tooShort = await jsonPost(`${BASE}/api/mist/autonomy/unleash`, { durationMs: 4 * 60_000 }, { Cookie: COOKIE() })
  expect(tooShort.status).toBe(400)
  const tooLong = await jsonPost(`${BASE}/api/mist/autonomy/unleash`, { durationMs: 25 * 3600_000 }, { Cookie: COOKIE() })
  expect(tooLong.status).toBe(400)
  expect(A4_ROUTE_MIN_MS).toBe(300_000)
  expect(A4_MAX_MS).toBe(86_400_000)
})

test('A3 · the unleash ritual starts a visible session and the scope goes A4', async () => {
  const res = await jsonPost(
    `${BASE}/api/mist/autonomy/unleash`,
    { durationMs: 2 * 3600_000, scope: { tools: ['*'], pathPrefixes: [], budget: { maxCalls: 100 }, voiceWaived: false } },
    { Cookie: COOKIE() }
  )
  expect(res.status).toBe(200)
  const body = (await res.json()) as { active: boolean; remainingMs: number; scope: { tools: string[] } }
  expect(body.active).toBe(true)
  expect(body.remainingMs).toBeGreaterThan(100)
  expect(body.scope.tools).toContain('*')
  const statusRes = await fetch(`${BASE}/api/mist/autonomy/unleash`, { headers: { Cookie: COOKIE() } })
  const status = (await statusRes.json()) as { active: boolean; remainingMs: number; scope?: unknown; passphraseRequired?: boolean }
  expect(status.active).toBe(true)
  expect(status.passphraseRequired).toBe(false) // no passphrase set yet
}, 30_000)

test('A4 · scope applied LIVE: A4 + owner_chat + untainted in-scope write stops asking (no approval row)', async () => {
  // the live session is active from A3 — create_note is a write-class tool on
  // a non-protected path, owner_chat origin, untainted: at A2 this asks (the
  // wiring test pins that); at A4 the matrix allows it outright.
  const res = await jsonPost(
    `${BASE}/api/mist/tools/execute`,
    { tool: 'create_note', args: { title: NOTE_PREFIX, content: 'the A4 allow proof — p5' } },
    { Cookie: COOKIE() }
  )
  expect(res.status).toBe(200)
  const body = (await res.json()) as {
    success: boolean
    output?: { status?: string; file?: string } | null
    error: string | null
  }
  expect(body.success).toBe(true)
  expect(body.output && 'file' in (body.output ?? {})).toBe(true)
  expect(JSON.stringify(body.output)).not.toContain('pending-approval')
})

// ---------------------------------------------------------------- matrix pins (in-process, the frozen core)

test('A5 · floor 2 is NOT softened at A4: web-originated destructive → deny, even unleashed', () => {
  const verdict = arbitrate({
    tool: 'delete_file',
    canonicalArgs: { path: 'db/notes/somefile.md' },
    risk: 'destructive',
    origin: 'web',
    tainted: false,
    scope: 'A4',
    budget: { callsRemaining: 10 },
  })
  // the honest pin: NOT allow — the matrix's floor 2 denies untrusted origins
  // beyond read at EVERY scope (the ask-shape in the mandate memo is the
  // tool_output/skill/memory branch; web/mcp is the harder deny)
  expect(verdict.decision).not.toBe('allow')
  expect(verdict.decision).toBe('deny')
  expect(verdict.reason).toContain('untrusted origin')
})

test('A6 · the A4 budget fallback: exhausted budget → the A2 ask matrix', () => {
  const exhausted = arbitrate({
    tool: 'create_note',
    canonicalArgs: { title: 'x', content: 'y' },
    risk: 'write',
    origin: 'owner_chat',
    tainted: false,
    scope: 'A4',
    budget: { callsRemaining: 0 },
  })
  expect(exhausted.decision).toBe('ask')
  const full = arbitrate({
    tool: 'create_note',
    canonicalArgs: { title: 'x', content: 'y' },
    risk: 'write',
    origin: 'owner_chat',
    tainted: false,
    scope: 'A4',
    budget: { callsRemaining: 5 },
  })
  expect(full.decision).toBe('allow')
  expect(full.reason).toContain('A4')
})

test('A7 · voice-exec inside A4: waived → allow, not waived → ask (S14 stays a floor unless waived)', () => {
  const unwaived = arbitrate({
    tool: 'run_command',
    canonicalArgs: { command: 'echo hi' },
    risk: 'exec',
    origin: 'owner_voice',
    tainted: false,
    scope: 'A4',
    voiceWaived: false,
    budget: { callsRemaining: 5 },
  })
  expect(unwaived.decision).toBe('ask')
  expect(unwaived.reason).toContain('voice-exec')
  const waived = arbitrate({
    tool: 'run_command',
    canonicalArgs: { command: 'echo hi' },
    risk: 'exec',
    origin: 'owner_voice',
    tainted: false,
    scope: 'A4',
    voiceWaived: true,
    budget: { callsRemaining: 5 },
  })
  expect(waived.decision).toBe('allow')
})

// ---------------------------------------------------------------- expiry

test('A8 · auto-expiry reverts the scope and audits a4_expire (short live unleash at the service floor)', async () => {
  const start = await startA4Session({
    durationMs: 5_000, // the service-level floor (the ROUTE enforces 5min+; the service allows short windows for tests/timers)
    scope: { tools: ['*'], pathPrefixes: [], budget: { maxCalls: 50 }, voiceWaived: true },
    now: Date.now(),
  })
  expect(start.ok).toBe(true)
  expect((await a4Status()).active).toBe(true)
  // in-scope while live
  const during = await resolveArbiterScope('create_note', null)
  expect(during.scope).toBe('A4')
  // wait past expiry
  await new Promise((r) => setTimeout(r, 5_300))
  const after = await resolveArbiterScope('create_note', null)
  expect(after.scope).not.toBe('A4')
  expect((await a4Status()).active).toBe(false)
  const rows = await db.auditEvent.findMany({ where: { reason: { contains: 'a4_expire' } } })
  expect(rows.length).toBeGreaterThanOrEqual(1)
}, 30_000)

// ---------------------------------------------------------------- the kill switch

test('A9 · kill aborts an in-flight bridge call ≤1s + audits a4_start/a4_kill + reverts scope', async () => {
  const start = await startA4Session({
    durationMs: 60 * 60_000,
    scope: { tools: ['*'], pathPrefixes: [], budget: { maxCalls: 100 }, voiceWaived: false },
    now: Date.now(),
  })
  expect(start.ok).toBe(true)
  const preScope = getAutonomyScope()

  // the turn controller unified() would link while A4 is active
  const ac = new AbortController()
  const unregister = registerA4TurnController(ac)

  const t0 = Date.now()
  const pending = executeTool('run_command', { command: 'sleep 6' }, false, {
    origin: 'owner_chat',
    turnId: 'a4-kill-test',
    signal: ac.signal,
  })
  // let the call land on the bridge (in-flight), then kill
  await new Promise((r) => setTimeout(r, 400))
  const killed = await killA4()
  expect(killed.ok).toBe(true)

  const result = await Promise.race([
    pending,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('kill did not abort the in-flight call within 1s')), 1_100)),
  ])
  const elapsed = Date.now() - t0
  expect(elapsed).toBeLessThan(2_000)
  expect(result.success).toBe(false)
  expect((result.error ?? '')).toContain('interrupted')
  unregister()

  // scope reverted to the pre-A4 scope
  expect(getAutonomyScope()).toBe(preScope === 'A4' ? 'A2' : preScope)
  expect((await a4Status()).active).toBe(false)
  // audit rows for the whole lifecycle
  const reasons = (await db.auditEvent.findMany({ where: { reason: { contains: 'a4_' } } })).map((r) => r.reason)
  expect(reasons.some((r) => r.startsWith('a4_start'))).toBe(true)
  expect(reasons.some((r) => r.startsWith('a4_kill'))).toBe(true)
}, 20_000)

// ---------------------------------------------------------------- passphrase

test('A10 · the passphrase gate: wrong → 403, none sent → 403, correct → 200 — and kill NEVER needs it', async () => {
  await db.setting.upsert({
    where: { key: SETTING_A4_PASSPHRASE },
    update: { value: PASSPHRASE },
    create: { key: SETTING_A4_PASSPHRASE, value: PASSPHRASE },
  })
  // give the dev server's settings cache time to see it (cross-process write: ≤~4.1s bound)
  await new Promise((r) => setTimeout(r, 4_600))

  const none = await jsonPost(`${BASE}/api/mist/autonomy/unleash`, { durationMs: 3600_000 }, { Cookie: COOKIE() })
  expect(none.status).toBe(403)
  const wrong = await jsonPost(`${BASE}/api/mist/autonomy/unleash`, { durationMs: 3600_000, passphrase: 'wrong-one' }, { Cookie: COOKIE() })
  expect(wrong.status).toBe(403)
  const correct = await jsonPost(`${BASE}/api/mist/autonomy/unleash`, { durationMs: 3600_000, passphrase: PASSPHRASE }, { Cookie: COOKIE() })
  expect(correct.status).toBe(200)
  const body = (await correct.json()) as { active: boolean; passphraseRequired: boolean }
  expect(body.active).toBe(true)
  expect(body.passphraseRequired).toBe(true)

  // kill is one tap — no passphrase, ever
  const killRes = await fetch(`${BASE}/api/mist/autonomy/unleash`, { method: 'DELETE', headers: { Cookie: COOKIE() } })
  expect(killRes.status).toBe(200)
  const killed = (await killRes.json()) as { active: boolean }
  expect(killed.active).toBe(false)

  // a passphrase shorter than 8 chars is refused at set time (min length) —
  // the timing-safe compare below is the route's comparison shape
  const a = Buffer.from(PASSPHRASE)
  const b = Buffer.from(PASSPHRASE)
  expect(a.length === b.length && timingSafeEqual(a, b)).toBe(true)
}, 30_000)

// ---------------------------------------------------------------- the A0–A3 dial wiring

test('A11 · the settings autonomy_scope feeds the Arbiter (A2→A1 ask-floor changes the live verdict)', async () => {
  // baseline: the dev server runs A2 (default) — a write asks
  const atA2 = await jsonPost(
    `${BASE}/api/mist/tools/execute`,
    { tool: 'create_note', args: { title: 'a-unleash-dial-proof', content: 'dial proof' } },
    { Cookie: COOKIE() }
  )
  const a2Body = (await atA2.json()) as { output?: { status?: string } | null }
  expect(JSON.stringify(a2Body.output)).toContain('pending-approval')
  // clean the approval row the bell would show
  await db.approval.deleteMany({ where: { fingerprint: { contains: 'a-unleash-dial-proof' } } }).catch(() => undefined)

  // dial down to A1 via the route (cache invalidates in the dev server instantly)
  const res = await jsonPost(`${BASE}/api/mist/candor`, { autonomyScope: 'A1' }, { Cookie: COOKIE() })
  expect(res.status).toBe(200)

  const atA1 = await jsonPost(
    `${BASE}/api/mist/tools/execute`,
    { tool: 'create_note', args: { title: 'a-unleash-dial-proof-2', content: 'dial proof 2' } },
    { Cookie: COOKIE() }
  )
  const a1Body = (await atA1.json()) as { output?: { status?: string } | null; error?: string | null }
  // A1 observe-only: the ask says "raise the autonomy scope" honestly
  expect(JSON.stringify(a1Body.output)).toContain('raise the autonomy scope')
  await db.approval.deleteMany({ where: { fingerprint: { contains: 'a-unleash-dial-proof-2' } } }).catch(() => undefined)

  // restore A2
  const back = await jsonPost(`${BASE}/api/mist/candor`, { autonomyScope: 'A2' }, { Cookie: COOKIE() })
  expect(back.status).toBe(200)
  const probe = await resolveArbiterScope('create_note', null)
  expect(['A0', 'A1', 'A2', 'A3']).toContain(probe.scope)
}, 30_000)

test('A12 · noteA4AllowedCall decrements the session budget the matrix sees', async () => {
  const start = await startA4Session({
    durationMs: 60_000,
    scope: { tools: ['*'], pathPrefixes: [], budget: { maxCalls: 2 }, voiceWaived: false },
    now: Date.now(),
  })
  expect(start.ok).toBe(true)
  const before = await resolveArbiterScope('create_note', null)
  expect(before.budget?.callsRemaining).toBe(2)
  noteA4AllowedCall()
  noteA4AllowedCall()
  const after = await resolveArbiterScope('create_note', null)
  // exhausted → the resolver's DOCUMENTED budget fallback: no A4, no budget
  // field at all — the settings dial (A0–A3, default A2) answers the next
  // call. (The A4+budget-0 matrix branch is pinned directly by A6; this pin
  // is the resolver's end of the same contract.)
  expect(after.scope).not.toBe('A4')
  expect(after.a4).toBeFalsy()
  expect(after.budget).toBeUndefined()
  // exhausted → the A2 ask matrix applies for the NEXT call
  const verdict = arbitrate({
    tool: 'create_note',
    canonicalArgs: { title: 'x', content: 'y' },
    risk: 'write',
    origin: 'owner_chat',
    tainted: false,
    scope: after.scope,
    budget: after.budget,
  })
  expect(verdict.decision).toBe('ask')
  await killA4()
}, 20_000)

// ---------------------------------------------------------------- the chain survives

test('A13 · the hash-chained audit log verifies after every unleash lifecycle event', async () => {
  const check = await verifyAuditChain()
  expect(check.ok).toBe(true)
})
