// Phase 2-b · Arbiter WIRING tests — the chokepoints, live.
//
// Written against the LIVE dev server (http://127.0.0.1:3000) where the flow
// crosses a route (tools/execute, bridge relay, approvals decide) and via
// direct module imports where the chokepoint is the function itself. Pins
// the mandate's headline properties:
//
//   A1   a client-asserted `confirmed:true` authorizes NOTHING — the
//        Arbiter asks, nothing ran, the audit chain holds an ask, not allow
//   READ allow / WRITE ask / PROTECTED deny / UNATTENDED defer
//   TAINT beats standing orders (a wildcard order cannot launder a replay)
//   ONE-TIME approval: decide → executes ONCE → consumed, replay impossible
//   BRIDGE TICKET: actuator actions run only behind an Arbiter HMAC ticket
//        (single-use, tamper-proof, bound to action+args)
//   the audit chain verifies after everything above
//
// Run: bun test tests/security/wiring.test.ts (dev server + bridge :8734 up)
import { test, expect, beforeAll, afterAll } from 'bun:test'
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, rmSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { issueSession, getMistSecrets } from '../../src/lib/perimeter/shared'
import { executeTool } from '../../src/lib/services/tools-service'
import { markTainted, clearTaint } from '../../src/lib/arbiter/taint'
import { verifyAuditChain } from '../../src/lib/arbiter/audit'
import { invalidateStandingOrderCache } from '../../src/lib/arbiter/wiring'
import { db } from '../../src/lib/db'

const BASE = 'http://127.0.0.1:3000'
const BRIDGE = 'http://127.0.0.1:8734'
const COOKIE = () => `mist_session=${issueSession()}`

// ---- test-scoped identifiers (cleanup keys everything by these) ----
const TAINT_TURN = 'w-t'
const READ_TURN = 'w-t-read'
const DEFER_TURN = 'w-t-defer'
const TAINT_MARKER = 'UNIQUE-TAINT-MARKER-9f3ab2'
const MARKERS = ['pwned', 'ticket-ok', 'w-t'] // argsJson / fingerprint sweep keys
const NOTES_DIR = path.join(process.cwd(), 'db', 'notes')

const createdApprovalIds: string[] = []
let fixtureOrderId: string | null = null

function jsonPost(url: string, body: unknown, headers: Record<string, string> = {}) {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
}

function noteFiles(prefix: string): string[] {
  if (!existsSync(NOTES_DIR)) return []
  return readdirSync(NOTES_DIR).filter((f) => f.startsWith(prefix))
}

function rmNoteFiles(prefix: string): void {
  for (const f of noteFiles(prefix)) rmSync(path.join(NOTES_DIR, f), { force: true })
}

/** Test-only cleanup that respects the APPEND-ONLY chain: delete THIS file's
 *  audit rows only while they form the tail above the highest non-test row
 *  (mid-chain deletion would break every future verifyAuditChain — the dev
 *  server is a concurrent writer now, so the guard is mandatory). */
async function tailSafeDeleteWiringRows(): Promise<void> {
  const all = await db.auditEvent.findMany({
    orderBy: { seq: 'asc' },
    select: { seq: true, turnId: true, argsJson: true },
  })
  const isMine = (r: { turnId: string | null; argsJson: string }) =>
    [TAINT_TURN, READ_TURN, DEFER_TURN].includes(r.turnId ?? '') ||
    MARKERS.some((m) => (r.argsJson ?? '').includes(m))
  const below = all.filter((r) => !isMine(r)).reduce((m, r) => Math.max(m, r.seq), 0)
  const mineAbove = all.filter((r) => r.seq > below && isMine(r)).map((r) => r.seq)
  if (mineAbove.length > 0) await db.auditEvent.deleteMany({ where: { seq: { in: mineAbove } } })
}

beforeAll(async () => {
  clearTaint(TAINT_TURN)
  // prior-run residue (approvals the bell would show, note files, audit
  // rows) — audit rows go through the TAIL-SAFE deleter only: a mid-chain
  // delete would break every future verifyAuditChain
  await tailSafeDeleteWiringRows()
  await db.approval.deleteMany({ where: { fingerprint: { contains: 'w-t' } } }).catch(() => undefined)
  await db.alert.deleteMany({ where: { title: { contains: 'w-t' } } }).catch(() => undefined)
  await db.memoryQueue.deleteMany({ where: { content: { contains: 'w-t' } } }).catch(() => undefined)
  rmNoteFiles('w-t-approve-flow-note-')
  rmNoteFiles('w-t-clean-note-')
  rmNoteFiles('w-t-tainted-note-')
  rmNoteFiles('w-t-defer-check-note-')
})

afterAll(async () => {
  clearTaint(TAINT_TURN)
  // fixture standing order + cached cards
  if (fixtureOrderId) await db.standingOrder.deleteMany({ where: { id: fixtureOrderId } }).catch(() => undefined)
  invalidateStandingOrderCache()
  // approvals the tests created (by id, plus any fingerprint-marker strays)
  await db.approval
    .deleteMany({
      where: { OR: [...(createdApprovalIds.length > 0 ? [{ id: { in: createdApprovalIds } }] : []), { fingerprint: { contains: 'w-t' } }] },
    })
    .catch(() => undefined)
  // alerts the approval spine raised for them
  await db.alert
    .deleteMany({
      where: {
        OR: [
          ...(createdApprovalIds.length > 0 ? createdApprovalIds.map((id) => ({ meta: { contains: id } })) : []),
          { title: { contains: 'w-t' } },
        ],
      },
    })
    .catch(() => undefined)
  // staged note memory + the note files themselves
  await db.memoryQueue.deleteMany({ where: { content: { contains: 'w-t' } } }).catch(() => undefined)
  rmNoteFiles('w-t-approve-flow-note-')
  rmNoteFiles('w-t-clean-note-')
  rmNoteFiles('w-t-tainted-note-')
  await tailSafeDeleteWiringRows()
})

// ---------- A1 · the headline: client `confirmed` is IGNORED ----------

test('W1 · confirmed:true does NOT execute run_command — ask instead, no allow in the window, high-tier Approval', async () => {
  const windowStart = new Date()
  const res = await jsonPost(
    `${BASE}/api/mist/tools/execute`,
    { tool: 'run_command', args: { command: 'echo pwned' }, confirmed: true },
    { Cookie: COOKIE() }
  )
  expect(res.status).toBe(200)
  const body = (await res.json()) as { success: boolean; output?: { status?: string; approvalId?: string }; error?: string | null }
  // honest NOT-EXECUTED result, not a failure the model would retry blindly
  expect(body.success).toBe(true)
  expect(body.output?.status).toBe('pending-approval')
  expect(String(body.output?.message ?? '')).toContain('Awaiting your approval')
  const approvalId = body.output?.approvalId
  expect(typeof approvalId).toBe('string')
  if (typeof approvalId === 'string') createdApprovalIds.push(approvalId)

  // the Approval row: tool_exec, HIGH tier (exec risk), pending
  const row = approvalId ? await db.approval.findUnique({ where: { id: approvalId } }) : null
  expect(row?.actionType).toBe('tool_exec')
  expect(row?.tier).toBe('high')
  expect(row?.status).toBe('pending')

  // NOTHING executed: no allow verdict for run_command in the window
  const allows = await db.auditEvent.findMany({
    where: { tool: 'run_command', decision: 'allow', ts: { gte: windowStart } },
  })
  expect(allows).toHaveLength(0)
  // and the ask itself is in the chain
  const asks = await db.auditEvent.findMany({
    where: { tool: 'run_command', decision: 'ask', ts: { gte: windowStart } },
  })
  expect(asks.length).toBeGreaterThanOrEqual(1)
}, 30_000)

// ---------- read-class allow (direct import) ----------

test('W2 · read tool allows at A2 without a prompt and audits the allow', async () => {
  const result = await executeTool('system_info', {}, false, { origin: 'owner_chat', turnId: READ_TURN })
  expect(result.success).toBe(true)
  const audit = await db.auditEvent.findFirst({
    where: { tool: 'system_info', decision: 'allow', turnId: READ_TURN },
    orderBy: { seq: 'desc' },
  })
  expect(audit?.decision).toBe('allow')
}, 30_000)

// ---------- write-class ask → ONE-TIME approval → executes once ----------

test('W3 · create_note asks via the live route; approve executes ONCE; consumed is terminal', async () => {
  const title = 'w-t approve flow note'
  const res = await jsonPost(
    `${BASE}/api/mist/tools/execute`,
    { tool: 'create_note', args: { title, content: 'w-t wiring test note body' }, confirmed: true },
    { Cookie: COOKIE() }
  )
  expect(res.status).toBe(200)
  const body = (await res.json()) as { success: boolean; output?: { status?: string; approvalId?: string } }
  expect(body.success).toBe(true)
  expect(body.output?.status).toBe('pending-approval')
  const approvalId = body.output?.approvalId
  expect(typeof approvalId).toBe('string')
  if (typeof approvalId === 'string') createdApprovalIds.push(approvalId)
  // nothing ran yet
  expect(noteFiles('w-t-approve-flow-note-')).toHaveLength(0)

  // owner approves → the row executes exactly once, right there
  const decide = await jsonPost(`${BASE}/api/mist/approvals/${approvalId}`, { decision: 'approve' }, { Cookie: COOKIE() })
  expect(decide.status).toBe(200)
  expect(((await decide.json()) as { ok?: boolean }).ok).toBe(true)

  const row = await db.approval.findUnique({ where: { id: approvalId ?? '' } })
  expect(row?.status).toBe('consumed') // single-use: consumed by its one execution
  let payload: Record<string, unknown> = {}
  try {
    payload = JSON.parse(row?.payload ?? '{}') as Record<string, unknown>
  } catch {
    /* asserted below via keys */
  }
  const execution = payload.execution as { executed?: boolean; ok?: boolean; output?: { file?: string } } | undefined
  expect(execution?.executed).toBe(true)
  expect(execution?.ok).toBe(true)
  expect(typeof execution?.output?.file).toBe('string')
  expect(existsSync(String(execution?.output?.file))).toBe(true) // the note really landed
  expect(noteFiles('w-t-approve-flow-note-')).toHaveLength(1)

  // a second decide is refused — no second execution
  const again = await jsonPost(`${BASE}/api/mist/approvals/${approvalId}`, { decision: 'approve' }, { Cookie: COOKIE() })
  expect(again.status).toBe(400)
  expect(((await again.json()) as { error?: string }).error ?? '').toContain('already consumed')
  expect(noteFiles('w-t-approve-flow-note-')).toHaveLength(1) // still exactly one
}, 60_000)

// ---------- floor 1 · protected path deny ----------

test('W4 · write_file to the Arbiter itself is DENIED — no file change, deny audited', async () => {
  const target = 'src/lib/arbiter/arbiter.ts'
  const abs = path.join(process.cwd(), target)
  const before = createHash('sha256').update(readFileSync(abs, 'utf-8')).digest('hex')
  const res = await jsonPost(
    `${BASE}/api/mist/tools/execute`,
    { tool: 'write_file', args: { path: target, content: 'w-t-deny-x' }, confirmed: true },
    { Cookie: COOKIE() }
  )
  expect(res.status).toBe(200)
  const body = (await res.json()) as { success: boolean; error?: string | null; output?: unknown }
  expect(body.success).toBe(false)
  expect(body.error ?? '').toContain('denied by Arbiter')
  expect(body.error ?? '').toContain('protected-path')
  expect(body.output).toBeNull()
  // the file is byte-identical
  const after = createHash('sha256').update(readFileSync(abs, 'utf-8')).digest('hex')
  expect(after).toBe(before)
  // and the denial is in the chain
  const deny = await db.auditEvent.findFirst({
    where: { tool: 'write_file', decision: 'deny', argsJson: { contains: 'w-t-deny-x' } },
    orderBy: { seq: 'desc' },
  })
  expect(deny?.reason).toContain('protected-path')
}, 30_000)

// ---------- unattended defer ----------

test('W5 · owner_cron create_note DEFERS — queued result, Approval pending, nothing executed', async () => {
  const result = await executeTool(
    'create_note',
    { title: 'w-t defer check note', content: 'w-t deferred — must not exist' },
    false,
    { origin: 'owner_cron', interactive: false, turnId: DEFER_TURN }
  )
  expect(result.success).toBe(true) // honest result, not an error
  const output = result.output as { status?: string; message?: string }
  expect(output?.status).toBe('queued-owner-review')
  expect(output?.message ?? '').toContain('queued for owner review')
  expect(noteFiles('w-t-defer-check-note-')).toHaveLength(0) // nothing ran
  // the queue row exists, filed via the Arbiter, still pending
  const row = await db.approval.findFirst({
    where: { actionType: 'tool_exec', status: 'pending', fingerprint: { contains: 'w-t defer check note' } },
    orderBy: { createdAt: 'desc' },
  })
  expect(row?.origin).toBe('arbiter')
  expect(row?.status).toBe('pending')
  if (row) createdApprovalIds.push(row.id)
}, 30_000)

// ---------- taint beats standing orders ----------

test('W6 · tainted args ask even under a WILDCARD standing order; untainted same call allows WITH orderRef', async () => {
  // fixture: the owner pre-approved EVERYTHING (tools ["*"], no expiry)
  const order = await db.standingOrder.create({
    data: { title: 'w-t test wildcard fixture', tools: '["*"]', pathPrefixes: '[]', budget: '{}', active: true },
  })
  fixtureOrderId = order.id
  invalidateStandingOrderCache()

  // tainted: the web_search output marker rides into the note content
  markTainted(TAINT_TURN, TAINT_MARKER, 'web_search')
  const tainted = await executeTool(
    'create_note',
    { title: 'w-t tainted note', content: `has ${TAINT_MARKER} inside` },
    false,
    { origin: 'owner_chat', turnId: TAINT_TURN }
  )
  expect(tainted.success).toBe(true)
  expect((tainted.output as { status?: string }).status).toBe('pending-approval') // taint wins over the wildcard
  expect(noteFiles('w-t-tainted-note-')).toHaveLength(0)
  const pendingRow = await db.approval.findFirst({
    where: { actionType: 'tool_exec', status: 'pending', fingerprint: { contains: 'w-t tainted note' } },
  })
  expect(pendingRow).not.toBeNull()
  if (pendingRow) createdApprovalIds.push(pendingRow.id)

  // untainted: the very same shape now rides the standing order through
  clearTaint(TAINT_TURN)
  const clean = await executeTool(
    'create_note',
    { title: 'w-t clean note', content: 'no marker inside — pre-consented shape' },
    false,
    { origin: 'owner_chat', turnId: TAINT_TURN }
  )
  expect(clean.success).toBe(true)
  expect(noteFiles('w-t-clean-note-')).toHaveLength(1) // actually executed
  const allow = await db.auditEvent.findFirst({
    where: { tool: 'create_note', decision: 'allow', turnId: TAINT_TURN },
    orderBy: { seq: 'desc' },
  })
  expect(allow?.orderRef).toBe(fixtureOrderId) // the order authorized it — on the record
}, 30_000)

// ---------- bridge ticket door (relay → approve → minted ticket → v3.7 bridge) ----------

test('W7 · relay run_command gates to pending; approval mints a ticket the v3.7 bridge honors; replay + tamper rejected', async () => {
  // 1) the relay ask — 202-style honest pending, nothing executed
  const res = await jsonPost(
    `${BASE}/api/mist/bridge`,
    { action: 'run_command', args: { command: 'echo ticket-ok' } },
    { Cookie: COOKIE() }
  )
  expect(res.status).toBe(202)
  const body = (await res.json()) as { ok?: boolean; gated?: string; approvalId?: string; error?: string }
  expect(body.ok).toBe(false)
  expect(body.gated).toBe('pending-approval')
  expect(typeof body.approvalId).toBe('string')
  const approvalId = String(body.approvalId)
  createdApprovalIds.push(approvalId)

  // 2) owner approves → re-execution mints the one-time ticket → the bridge RUNS it
  const decide = await jsonPost(`${BASE}/api/mist/approvals/${approvalId}`, { decision: 'approve' }, { Cookie: COOKIE() })
  expect(decide.status).toBe(200)
  const row = await db.approval.findUnique({ where: { id: approvalId } })
  expect(row?.status).toBe('consumed')
  let payload: Record<string, unknown> = {}
  try {
    payload = JSON.parse(row?.payload ?? '{}') as Record<string, unknown>
  } catch {
    /* keys asserted below */
  }
  const execution = payload.execution as
    | { executed?: boolean; ok?: boolean; output?: { data?: { stdout?: string } } }
    | undefined
  expect(execution?.executed).toBe(true)
  expect(execution?.ok).toBe(true)
  expect(execution?.output?.data?.stdout ?? '').toContain('ticket-ok') // the daemon really ran it

  // 3) the audit row carries the ticket that rode the bridge call
  const allow = await db.auditEvent.findFirst({
    where: { tool: 'run_command', decision: 'allow', argsJson: { contains: 'ticket-ok' } },
    orderBy: { seq: 'desc' },
  })
  expect(allow?.ticket ?? '').toMatch(/^v1\.\d+\.[a-f0-9]{12}\.[a-f0-9]{64}$/)
  const ticket = String(allow?.ticket)

  // 4) replaying the SAME ticket against the daemon directly → single-use rejection
  const token = getMistSecrets().bridgeToken
  const replay = await jsonPost(`${BRIDGE}/exec`, { action: 'run_command', args: { command: 'echo ticket-ok' }, ticket }, {
    Authorization: `Bearer ${token}`,
  })
  expect(replay.status).toBe(403)
  expect(((await replay.json()) as { error?: string }).error ?? '').toContain('single-use')

  // 5) a tampered ticket is rejected on the HMAC itself
  const mac = ticket.split('.')[3]
  const flipped = `${mac.slice(0, 62)}${mac.slice(62) === '0' ? '1' : '0'}`
  const tampered = `${ticket.slice(0, ticket.length - 64)}${flipped}`
  const forged = await jsonPost(`${BRIDGE}/exec`, { action: 'run_command', args: { command: 'echo ticket-ok' }, ticket: tampered }, {
    Authorization: `Bearer ${token}`,
  })
  expect(forged.status).toBe(403)
  const forgedBody = (await forged.json()) as { error?: string }
  expect(forgedBody.error ?? '').toContain('requires an Arbiter ticket')
}, 90_000)

// ---------- relay read-through (non-actuator) ----------

test('W7b · relay read-only action passes straight through (no arbitration friction)', async () => {
  const res = await jsonPost(`${BASE}/api/mist/bridge`, { action: 'system_info', args: {} }, { Cookie: COOKIE() })
  expect(res.status).toBe(200)
  const body = (await res.json()) as { ok?: boolean; result?: { ok?: boolean } }
  expect(body.ok).toBe(true)
  expect(body.result?.ok).toBe(true)
}, 30_000)

// ---------- the chain holds after everything above ----------

test('W8 · the hash-chained audit log verifies after all of the above', async () => {
  const check = await verifyAuditChain()
  expect(check.ok).toBe(true)
}, 30_000)
