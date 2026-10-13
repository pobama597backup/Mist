// Phase 6-a · Control Room tests — standing orders (owner API + LIVE engine
// honoring), the audit read API ("why did she do that?" + chain tamper
// evidence), and the CSP production branch.
//
// Written BEFORE the implementation (test-first). The core proof this file
// pins: the UI surface and the engine are the SAME machine — an order created
// through /api/mist/orders is honored by the actual arbitrate() path (allow
// with orderRef), the LIVE dev-server chokepoint sees it without waiting for
// the 30s card-cache TTL, and revoking flips the same call back to ask.
//
// Run: bun test tests/security/control-room.test.ts (dev server on :3000 up)
import { test, expect, beforeAll, afterAll } from 'bun:test'
import { existsSync, readdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import { issueSession } from '../../src/lib/perimeter/shared'
import { db } from '../../src/lib/db'
import { arbitrate } from '../../src/lib/arbiter/arbiter'
import { classifyRisk } from '../../src/lib/arbiter/risk-table'
import {
  loadStandingOrderCards,
  invalidateStandingOrderCache,
  setAutonomyScope,
} from '../../src/lib/arbiter/wiring'
import { killA4 } from '../../src/lib/arbiter/unleash'
import { verifyAuditChain } from '../../src/lib/arbiter/audit'
import { cspScriptSrc } from '../../src/proxy'

const BASE = 'http://127.0.0.1:3000'
const COOKIE = () => `mist_session=${issueSession()}`

// ---- test-scoped identifiers (cleanup keys everything off this tag) ----
const TAG = 'cr6a'
const NOTES_DIR = path.join(process.cwd(), 'db', 'notes')

/** ids captured across tests (the CR-4 order for the tamper proof, the CR-6
 *  order for the orderRef-in-audit proof) */
let mainOrderId: string | null = null
let liveOrderId: string | null = null

function jsonPost(url: string, body: unknown, headers: Record<string, string> = {}) {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
}

function rmNoteFiles(prefix: string): void {
  if (!existsSync(NOTES_DIR)) return
  for (const f of readdirSync(NOTES_DIR)) if (f.startsWith(prefix)) rmSync(path.join(NOTES_DIR, f), { force: true })
}

beforeAll(async () => {
  // Live-state hygiene (mirror a4.test.ts): kill any leaked A4 session on the
  // dev server AND in this process, pin the live dial to the documented
  // default A2 — the live-engine proof below must not ride an A4 allow.
  await fetch(`${BASE}/api/mist/autonomy/unleash`, { method: 'DELETE', headers: { Cookie: COOKIE() } }).catch(() => undefined)
  await killA4().catch(() => undefined)
  await jsonPost(`${BASE}/api/mist/candor`, { autonomyScope: 'A2' }, { Cookie: COOKIE() }).catch(() => undefined)
  setAutonomyScope('A2')
  // prior-run residue (orders are owner config, not append-only history —
  // direct delete is the suite convention from wiring.test.ts's fixture)
  await db.standingOrder.deleteMany({ where: { title: { contains: TAG } } }).catch(() => undefined)
  await db.approval.deleteMany({ where: { fingerprint: { contains: TAG } } }).catch(() => undefined)
  await db.alert.deleteMany({ where: { title: { contains: TAG } } } ).catch(() => undefined)
  await db.memoryQueue.deleteMany({ where: { content: { contains: TAG } } }).catch(() => undefined)
  rmNoteFiles(TAG)
  invalidateStandingOrderCache()
  // PRE-WARM the new routes on the dev server — first-compile of a cold route
  // can eat seconds (the a4.test.ts stall lesson). All warm-ups are side-effect
  // free: 400 (no tools) / 404 (no such order) / gated GETs.
  await fetch(`${BASE}/api/mist/orders`, { headers: { Cookie: COOKIE() } }).catch(() => undefined)
  await jsonPost(`${BASE}/api/mist/orders`, { title: 'warm' }, { Cookie: COOKIE() }).catch(() => undefined)
  await fetch(`${BASE}/api/mist/orders/nonexistent-warmup`, { method: 'DELETE', headers: { Cookie: COOKIE() } }).catch(() => undefined)
  await fetch(`${BASE}/api/mist/audit?limit=1`, { headers: { Cookie: COOKIE() } }).catch(() => undefined)
}, 60_000)

afterAll(async () => {
  // live state back to the documented default
  await fetch(`${BASE}/api/mist/autonomy/unleash`, { method: 'DELETE', headers: { Cookie: COOKIE() } }).catch(() => undefined)
  await killA4().catch(() => undefined)
  setAutonomyScope('A2')
  // test artifacts (orders/approvals/alerts/queue rows/note files). The
  // standing_order.create/revoke AUDIT rows stay — they are honest append-only
  // owner-command history, exactly like a4.test.ts's a4_start/a4_kill rows.
  await db.standingOrder.deleteMany({ where: { title: { contains: TAG } } }).catch(() => undefined)
  await db.approval.deleteMany({ where: { fingerprint: { contains: TAG } } }).catch(() => undefined)
  await db.alert.deleteMany({ where: { title: { contains: TAG } } }).catch(() => undefined)
  await db.memoryQueue.deleteMany({ where: { content: { contains: TAG } } }).catch(() => undefined)
  rmNoteFiles(TAG)
  invalidateStandingOrderCache()
})

// ---------------------------------------------------------------- perimeter + validation

test('CR-1 · orders POST without a session → 403 (the perimeter gate)', async () => {
  const res = await jsonPost(`${BASE}/api/mist/orders`, { title: 'x', tools: ['read_file'] })
  expect(res.status).toBe(403)
  const body = (await res.json()) as { error?: string }
  expect(body.error).toContain('session required')
})

test('CR-2 · orders GET without a session → 403 (owner surface — GETs need the in-route gate)', async () => {
  const res = await fetch(`${BASE}/api/mist/orders`)
  expect(res.status).toBe(403)
  const body = (await res.json()) as { error?: string }
  expect(body.error).toContain('session required')
})

test('CR-3 · orders validation: unknown tool names are rejected with close matches; bad shapes get honest 400s', async () => {
  // a near-miss tool name → 400 naming the close match
  const nearMiss = await jsonPost(
    `${BASE}/api/mist/orders`,
    { title: 'x', tools: ['create_notee'] },
    { Cookie: COOKIE() }
  )
  expect(nearMiss.status).toBe(400)
  const nearMissBody = (await nearMiss.json()) as { error?: string }
  expect(nearMissBody.error).toContain('create_notee')
  expect(nearMissBody.error).toContain('create_note') // the suggested close match
  // a garbage name → 400, still helpful (points at the registry / "*")
  const garbage = await jsonPost(
    `${BASE}/api/mist/orders`,
    { title: 'x', tools: ['zzzz-no-such-tool'] },
    { Cookie: COOKIE() }
  )
  expect(garbage.status).toBe(400)
  expect(((await garbage.json()) as { error?: string }).error).toContain('unknown tool')
  // missing title / missing tools / bad expiry / bad budget
  const noTitle = await jsonPost(`${BASE}/api/mist/orders`, { tools: ['read_file'] }, { Cookie: COOKIE() })
  expect(noTitle.status).toBe(400)
  expect(((await noTitle.json()) as { error?: string }).error).toContain('title')
  const noTools = await jsonPost(`${BASE}/api/mist/orders`, { title: 'x' }, { Cookie: COOKIE() })
  expect(noTools.status).toBe(400)
  expect(((await noTools.json()) as { error?: string }).error).toContain('tools')
  const badExpiry = await jsonPost(
    `${BASE}/api/mist/orders`,
    { title: 'x', tools: ['read_file'], expiryAt: 'not-a-date' },
    { Cookie: COOKIE() }
  )
  expect(badExpiry.status).toBe(400)
  expect(((await badExpiry.json()) as { error?: string }).error).toContain('expiryAt')
  const pastExpiry = await jsonPost(
    `${BASE}/api/mist/orders`,
    { title: 'x', tools: ['read_file'], expiryAt: new Date(Date.now() - 3_600_000).toISOString() },
    { Cookie: COOKIE() }
  )
  expect(pastExpiry.status).toBe(400) // an expired-on-arrival order is a footgun — refused honestly
  const badBudget = await jsonPost(
    `${BASE}/api/mist/orders`,
    { title: 'x', tools: ['read_file'], budget: { maxCalls: -1 } },
    { Cookie: COOKIE() }
  )
  expect(badBudget.status).toBe(400)
  expect(((await badBudget.json()) as { error?: string }).error).toContain('budget')
}, 30_000)

// ---------------------------------------------------------------- create + list

test('CR-4 · create a valid order → 200 + listed in GET with the engine-derived fields', async () => {
  const res = await jsonPost(
    `${BASE}/api/mist/orders`,
    {
      title: `${TAG} notes pre-consent`,
      tools: ['create_note'],
      budget: { maxCalls: 5, windowMs: 60_000 },
    },
    { Cookie: COOKIE() }
  )
  expect(res.status).toBe(200)
  const body = (await res.json()) as {
    ok?: boolean
    order?: { id: string; title: string; tools: string[]; budget: Record<string, number>; active: boolean; expired: boolean; usage: { calls: number } }
  }
  expect(body.ok).toBe(true)
  expect(body.order?.title).toBe(`${TAG} notes pre-consent`)
  expect(body.order?.tools).toEqual(['create_note'])
  expect(body.order?.budget).toEqual({ maxCalls: 5, windowMs: 60_000 })
  expect(body.order?.active).toBe(true)
  expect(body.order?.expired).toBe(false)
  expect(body.order?.usage?.calls).toBe(0)
  mainOrderId = body.order?.id ?? null
  expect(mainOrderId).toBeTruthy()

  const listRes = await fetch(`${BASE}/api/mist/orders`, { headers: { Cookie: COOKIE() } })
  expect(listRes.status).toBe(200)
  const list = (await listRes.json()) as { orders?: Array<{ id: string; title: string; active: boolean; createdAt: string }> }
  const mine = list.orders?.find((o) => o.id === mainOrderId)
  expect(mine).toBeTruthy()
  expect(mine?.title).toBe(`${TAG} notes pre-consent`)
  expect(mine?.active).toBe(true)
  // newest first (createdAt non-increasing down the list)
  const created = (list.orders ?? []).map((o) => new Date(o.createdAt).getTime())
  for (let i = 1; i < created.length; i++) expect(created[i]).toBeLessThanOrEqual(created[i - 1])
}, 30_000)

// ---------------------------------------------------------------- THE core proof

test('CR-5 · LIVE ENGINE HONORING: the created order flips the real arbitrate() ask → allow with orderRef; revoke flips it back to ask', async () => {
  expect(mainOrderId).toBeTruthy()
  // create_note is the harmless write-class tool a4.test.ts uses for its A4
  // proofs: at A2 owner_chat it ASKS (read-class tools already allow at A2 —
  // the ask-gated cell an order can flip is exactly this one).
  const args = { title: `${TAG} matrix proof`, content: 'order honoring proof — p6a' }
  const risk = classifyRisk('create_note', args)
  expect(risk).toBe('write')
  const base = {
    tool: 'create_note',
    canonicalArgs: args,
    risk,
    origin: 'owner_chat' as const,
    tainted: false,
    scope: 'A2' as const,
    filePath: null as string | null,
  }

  // baseline: the pure A2 matrix asks (no standing order may soften it)
  expect(arbitrate({ ...base, standingOrders: [] }).decision).toBe('ask')

  // the engine's own loader (the same loadStandingOrderCards() the chokepoint
  // calls) must see the order IMMEDIATELY — invalidate + fresh read, no 30s
  // TTL wait. (The route already invalidated ITS process; this process holds
  // its own cache, so the test invalidates its own — the cross-process half
  // of this proof is CR-6, live through the dev server.)
  invalidateStandingOrderCache()
  const cards = await loadStandingOrderCards()
  expect(cards.some((c) => c.id === mainOrderId)).toBe(true)

  // the SAME arbitrate() call, now with the live cards → allow, orderRef named
  const honored = arbitrate({ ...base, standingOrders: cards })
  expect(honored.decision).toBe('allow')
  expect(honored.orderRef).toBe(mainOrderId)
  expect(honored.reason).toContain('standing-order')

  // revoke through the API → the engine's next fresh load drops the card → ask
  const revoke = await fetch(`${BASE}/api/mist/orders/${mainOrderId}`, { method: 'DELETE', headers: { Cookie: COOKIE() } })
  expect(revoke.status).toBe(200)
  expect(((await revoke.json()) as { ok?: boolean }).ok).toBe(true)
  invalidateStandingOrderCache()
  const cardsAfter = await loadStandingOrderCards()
  expect(cardsAfter.some((c) => c.id === mainOrderId)).toBe(false)
  const reverted = arbitrate({ ...base, standingOrders: cardsAfter })
  expect(reverted.decision).toBe('ask')
  expect(reverted.orderRef).toBeUndefined()
}, 30_000)

test('CR-6 · LIVE cache invalidation: the ENGINE process (dev server chokepoint) honors the order the instant it is created — and the revoke the instant it lands', async () => {
  // This is the cross-process half of the proof: create through the route,
  // then immediately execute through the LIVE /tools/execute chokepoint. If
  // the route had NOT called invalidateStandingOrderCache() in the dev
  // server's process, the chokepoint's ≤30s-stale card cache would ask.
  const create = await jsonPost(
    `${BASE}/api/mist/orders`,
    { title: `${TAG} live engine proof`, tools: ['create_note'], budget: { maxCalls: 10, windowMs: 300_000 } },
    { Cookie: COOKIE() }
  )
  expect(create.status).toBe(200)
  liveOrderId = ((await create.json()) as { order?: { id?: string } }).order?.id ?? null
  expect(liveOrderId).toBeTruthy()

  const allowed = await jsonPost(
    `${BASE}/api/mist/tools/execute`,
    { tool: 'create_note', args: { title: `${TAG} live-engine-proof`, content: 'the order authorized this — p6a' } },
    { Cookie: COOKIE() }
  )
  expect(allowed.status).toBe(200)
  const allowedBody = (await allowed.json()) as { success: boolean; output?: { file?: string } | null; error: string | null }
  expect(allowedBody.success).toBe(true)
  expect(JSON.stringify(allowedBody.output)).not.toContain('pending-approval')
  expect(allowedBody.output && 'file' in (allowedBody.output ?? {})).toBe(true)

  // revoke → the SAME live chokepoint asks again on the very next call
  const revoke = await fetch(`${BASE}/api/mist/orders/${liveOrderId}`, { method: 'DELETE', headers: { Cookie: COOKIE() } })
  expect(revoke.status).toBe(200)
  const asked = await jsonPost(
    `${BASE}/api/mist/tools/execute`,
    { tool: 'create_note', args: { title: `${TAG} live-engine-proof-2`, content: 'the revoke landed — p6a' } },
    { Cookie: COOKIE() }
  )
  expect(asked.status).toBe(200)
  const askedBody = (await asked.json()) as { success: boolean; output?: unknown }
  expect(JSON.stringify(askedBody.output)).toContain('pending-approval')
}, 30_000)

// ---------------------------------------------------------------- revoke semantics

test('CR-7 · revoking an already-revoked order is an honest 409 (documented design), unknown ids 404; "*" wildcard orders are legal', async () => {
  const create = await jsonPost(
    `${BASE}/api/mist/orders`,
    { title: `${TAG} wildcard probe`, tools: ['*'] },
    { Cookie: COOKIE() }
  )
  expect(create.status).toBe(200)
  const id = ((await create.json()) as { order?: { id?: string } }).order?.id
  expect(id).toBeTruthy()
  const first = await fetch(`${BASE}/api/mist/orders/${id}`, { method: 'DELETE', headers: { Cookie: COOKIE() } })
  expect(first.status).toBe(200)
  // DESIGN DECISION (route comment): a second revoke is a 409 with the
  // original revokedAt — honest "nothing changed" beats a silent no-op.
  const second = await fetch(`${BASE}/api/mist/orders/${id}`, { method: 'DELETE', headers: { Cookie: COOKIE() } })
  expect(second.status).toBe(409)
  const secondBody = (await second.json()) as { error?: string }
  expect(secondBody.error).toContain('already revoked')
  const notFound = await fetch(`${BASE}/api/mist/orders/does-not-exist-at-all`, { method: 'DELETE', headers: { Cookie: COOKIE() } })
  expect(notFound.status).toBe(404)
}, 30_000)

// ---------------------------------------------------------------- audit read API

test('CR-8 · audit GET without a session → 403 (the "why did she do that" surface is owner-only)', async () => {
  const res = await fetch(`${BASE}/api/mist/audit`)
  expect(res.status).toBe(403)
})

test('CR-9 · audit GET shape: newest-first events + chain {valid, checkedCount}; no single-use tickets in the read', async () => {
  const res = await fetch(`${BASE}/api/mist/audit?limit=10`, { headers: { Cookie: COOKIE() } })
  expect(res.status).toBe(200)
  const body = (await res.json()) as {
    events?: Array<{ id: string; seq: number; ts: string; tool: string; risk: string; origin: string; tainted: boolean; decision: string; reason: string; argsJson: string; orderRef?: string | null; turnId?: string | null }>
    chain?: { valid: boolean; checkedCount: number }
  }
  expect(body.events).toBeTruthy()
  expect((body.events ?? []).length).toBeLessThanOrEqual(10)
  expect((body.events ?? []).length).toBeGreaterThanOrEqual(2)
  const seqs = (body.events ?? []).map((e) => e.seq)
  for (let i = 1; i < seqs.length; i++) expect(seqs[i]).toBeLessThan(seqs[i - 1]) // newest first
  for (const e of body.events ?? []) {
    expect(typeof e.ts).toBe('string')
    expect(typeof e.tool).toBe('string')
    expect(typeof e.decision).toBe('string')
    expect(typeof e.argsJson).toBe('string')
    expect('ticket' in e).toBe(false) // single-use bridge tickets have no read value — never surfaced
  }
  expect(body.chain?.valid).toBe(true)
  expect(body.chain?.checkedCount).toBeGreaterThanOrEqual(1)
}, 30_000)

test('CR-10 · audit filters + bounds: tool/decision/origin/since honored, limit 1–200 enforced, cursor walks strictly older', async () => {
  // the orders lifecycle rows this file minted are in the trail
  const creates = await fetch(`${BASE}/api/mist/audit?tool=standing_order.create&limit=50`, { headers: { Cookie: COOKIE() } })
  expect(creates.status).toBe(200)
  const createsBody = (await creates.json()) as { events?: Array<{ tool: string; decision: string; argsJson: string }>; chain?: { valid: boolean } }
  expect((createsBody.events ?? []).length).toBeGreaterThanOrEqual(1)
  for (const e of createsBody.events ?? []) expect(e.tool).toBe('standing_order.create')
  // the CR-4 create row carries the order id + title in argsJson
  expect((createsBody.events ?? []).some((e) => e.argsJson.includes(mainOrderId ?? '___') && e.argsJson.includes(TAG))).toBe(true)
  // revokes too
  const revokes = await fetch(`${BASE}/api/mist/audit?tool=standing_order.revoke&decision=allow`, { headers: { Cookie: COOKIE() } })
  const revokesBody = (await revokes.json()) as { events?: Array<{ decision: string }> }
  expect((revokesBody.events ?? []).length).toBeGreaterThanOrEqual(1)
  for (const e of revokesBody.events ?? []) expect(e.decision).toBe('allow')
  // the CR-6 allowed execution is attributed to its order (orderRef in the trail)
  const attributed = await fetch(`${BASE}/api/mist/audit?tool=create_note&decision=allow&limit=50`, { headers: { Cookie: COOKIE() } })
  const attributedBody = (await attributed.json()) as { events?: Array<{ orderRef?: string | null }> }
  expect((attributedBody.events ?? []).some((e) => e.orderRef === liveOrderId)).toBe(true)
  // origin filter
  const ownerRows = await fetch(`${BASE}/api/mist/audit?origin=owner_chat&limit=25`, { headers: { Cookie: COOKIE() } })
  const ownerBody = (await ownerRows.json()) as { events?: Array<{ origin: string }> }
  for (const e of ownerBody.events ?? []) expect(e.origin).toBe('owner_chat')
  // since: a future bound sees nothing, and an empty window still verifies
  const future = await fetch(`${BASE}/api/mist/audit?since=${encodeURIComponent(new Date(Date.now() + 3_600_000).toISOString())}`, { headers: { Cookie: COOKIE() } })
  const futureBody = (await future.json()) as { events?: unknown[]; chain?: { valid: boolean; checkedCount: number } }
  expect(futureBody.events).toEqual([])
  expect(futureBody.chain?.valid).toBe(true)
  expect(futureBody.chain?.checkedCount).toBe(0)
  // limit bounds: 0 / 201 / non-numeric are honest 400s
  expect((await fetch(`${BASE}/api/mist/audit?limit=0`, { headers: { Cookie: COOKIE() } })).status).toBe(400)
  expect((await fetch(`${BASE}/api/mist/audit?limit=201`, { headers: { Cookie: COOKIE() } })).status).toBe(400)
  expect((await fetch(`${BASE}/api/mist/audit?limit=abc`, { headers: { Cookie: COOKIE() } })).status).toBe(400)
  expect((await fetch(`${BASE}/api/mist/audit?decision=bogus`, { headers: { Cookie: COOKIE() } })).status).toBe(400)
  // cursor: ?before= walks strictly older than the page's oldest seq
  const page1 = await fetch(`${BASE}/api/mist/audit?limit=5`, { headers: { Cookie: COOKIE() } })
  const page1Body = (await page1.json()) as { events?: Array<{ seq: number }>; nextBefore?: number | null }
  expect(page1Body.events?.length).toBe(5)
  const oldest = page1Body.events![4].seq
  expect(page1Body.nextBefore).toBe(oldest)
  const page2 = await fetch(`${BASE}/api/mist/audit?limit=5&before=${oldest}`, { headers: { Cookie: COOKIE() } })
  const page2Body = (await page2.json()) as { events?: Array<{ seq: number }>; chain?: { valid: boolean } }
  expect((page2Body.events ?? []).length).toBeGreaterThan(0)
  for (const e of page2Body.events ?? []) expect(e.seq).toBeLessThan(oldest)
  expect(page2Body.chain?.valid).toBe(true)
}, 30_000)

test('CR-11 · TAMPER EVIDENCE: a direct AuditEvent row edit breaks the chain at exactly that seq (restored after)', async () => {
  // pick the newest standing_order.create row — minted by THIS file, so the
  // tamper + restore touches only test-owned history (arbiter.test.ts's rule)
  const row = await db.auditEvent.findFirst({ where: { tool: 'standing_order.create' }, orderBy: { seq: 'desc' } })
  expect(row).toBeTruthy()
  const original = row!.argsJson
  // LESSON (learned the hard way during development): every assertion between
  // the tamper and the restore must sit inside try/finally — a failed expect
  // before the restore would leak the tampered row into the SHARED chain and
  // break every later verifyAuditChain (including other suites').
  try {
    await db.auditEvent.update({ where: { seq: row!.seq }, data: { argsJson: '{"tampered":"p6a-proof"}' } })
    // the API recomputes every hash in the window — it must NOT trust stored ones
    const broken = await fetch(`${BASE}/api/mist/audit?limit=100`, { headers: { Cookie: COOKIE() } })
    expect(broken.status).toBe(200)
    const brokenBody = (await broken.json()) as { chain?: { valid: boolean; checkedCount: number; brokenAtSeq?: number; reason?: string } }
    expect(brokenBody.chain?.valid).toBe(false)
    expect(brokenBody.chain?.brokenAtSeq).toBe(row!.seq)
    expect(typeof brokenBody.chain?.reason).toBe('string')
    // cross-check with the in-process full-chain walker
    const v = await verifyAuditChain()
    expect(v.ok).toBe(false)
    expect(v.brokenAt).toBe(row!.seq)
  } finally {
    // restore — this test leaves NO permanent damage to the append-only chain
    await db.auditEvent.update({ where: { seq: row!.seq }, data: { argsJson: original } })
  }
  const healed = await fetch(`${BASE}/api/mist/audit?limit=100`, { headers: { Cookie: COOKIE() } })
  const healedBody = (await healed.json()) as { chain?: { valid: boolean } }
  expect(healedBody.chain?.valid).toBe(true)
  expect((await verifyAuditChain()).ok).toBe(true)
}, 30_000)

// ---------------------------------------------------------------- CSP prod branch + A4 status shape

test('CR-12 · CSP: production drops unsafe-eval from script-src; dev keeps it; the live dev header carries the dev shape', async () => {
  expect(cspScriptSrc('production')).toBe("script-src 'self' 'unsafe-inline'")
  expect(cspScriptSrc('production')).not.toContain('unsafe-eval')
  expect(cspScriptSrc('development')).toBe("script-src 'self' 'unsafe-inline' 'unsafe-eval'")
  expect(cspScriptSrc(undefined)).toContain('unsafe-eval') // module default (unset NODE_ENV = dev posture)
  // the LIVE server runs dev mode — its header keeps both (HMR constraint)
  const res = await fetch(`${BASE}/`)
  expect(res.status).toBe(200)
  const csp = res.headers.get('content-security-policy') ?? ''
  expect(csp).toContain("script-src 'self' 'unsafe-inline' 'unsafe-eval'")
  expect(csp).toContain("default-src 'self'")
  expect(csp).toContain("frame-ancestors 'none'") // loopback keeps the strict posture
}, 30_000)

test('CR-13 · the A4 status shape the Control Room polls (+ the candor chip readout)', async () => {
  const res = await fetch(`${BASE}/api/mist/autonomy/unleash`, { headers: { Cookie: COOKIE() } })
  expect(res.status).toBe(200)
  const body = (await res.json()) as { active: boolean; remainingMs: number; passphraseRequired: boolean; currentScope: string }
  expect(typeof body.active).toBe('boolean')
  expect(typeof body.remainingMs).toBe('number')
  expect(typeof body.passphraseRequired).toBe('boolean')
  expect(['A0', 'A1', 'A2', 'A3', 'A4']).toContain(body.currentScope)
  // beforeAll killed any leaked session — the honest reverted state
  expect(body.active).toBe(false)
  expect(body.currentScope).not.toBe('A4')
  // the candor dial chip (GET is open — status surface by design)
  const candor = await fetch(`${BASE}/api/mist/candor`)
  expect(candor.status).toBe(200)
  const candorBody = (await candor.json()) as { mode: string; autonomyScope: string }
  expect(['standard', 'frank', 'unfiltered']).toContain(candorBody.mode)
  expect(['A0', 'A1', 'A2', 'A3']).toContain(candorBody.autonomyScope)
}, 30_000)
