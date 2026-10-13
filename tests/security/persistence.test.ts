// Phase 2-c · PERSISTENCE POISONING tests (S11 + evolution gate A5/S8).
//
// Written against the schema/routing/gate seams directly (module imports) and
// the one new route live (/api/mist/quarantine). Pins the mandate's Phase 2
// persistence properties:
//
//   SCHEMA   LongtermMemory/Skill/CronJob carry source/trust/createdByTurn/
//            pinned; QuarantineItem CRUD works
//   S11      tainted internal auto-writes (fact remember, skill learning
//            loop, cron creation) land in the quarantine inbox — NEVER in
//            their real table, never in recall — until the owner decides;
//            accept/edit/drop perform (or withhold) the write with honest
//            provenance (trust 'derived', source quarantine:<id>)
//   GATE     applyProposal: protected path → proposal-only + Approval row +
//            zero diff work; below A3 → proposal-only; A3 with a failed gate
//            → no commit + backup restored (the OOM-degrade-keeps-commit
//            behaviour is GONE — a dead checker fails the gate)
//   DEFANG   the absolutist authority phrases are gone from the live prompt
//            sources (context-builder IDENTITY, SOUL.md, tools guidance) —
//            a source-of-truth test so future waves cannot re-empower them
//   WRAP     wrapToolOutput tags EVERY tool result (low severity included)
//
// Run: bun test tests/security/persistence.test.ts (dev server up for the
// route test; the rest are direct module seams).
import { test, expect, beforeAll, afterAll } from 'bun:test'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { issueSession } from '../../src/lib/perimeter/shared'
import { db } from '../../src/lib/db'
import { markTainted, clearTaint } from '../../src/lib/arbiter/taint'
import { getAutonomyScope, setAutonomyScope } from '../../src/lib/arbiter/wiring'
import {
  rememberDurableFact,
  decideQuarantineItem,
  quarantineWrite,
} from '../../src/lib/arbiter/quarantine'
import { getFact, latestFacts, deleteFact } from '../../src/lib/services/memory-service'
import { saveSkill, deleteSkill } from '../../src/lib/services/skills-service'
import { createCronJob } from '../../src/lib/services/scheduler-service'
import { applyProposal, evolutionGates } from '../../src/lib/services/evolution-service'
import { wrapToolOutput } from '../../src/lib/oj/guardrails'
import { verifyAuditChain } from '../../src/lib/arbiter/audit'

const BASE = 'http://127.0.0.1:3000'
const COOKIE = () => `mist_session=${issueSession()}`
const TAINT_MARKER = 'POISON-MARKER-77f3c1'
const ALT_SNIPPET = 'COMPLETELY-UNRELATED-SNIPPET-pq8-24chars'

// ---- test-scoped identifiers (cleanup keys everything by these) ----
const T_TURN = 'pq-1'
const T_TURN_ANY = 'pq-8'
const T_SKILL_TURN = 'pq-skill-t'
const T_SKILL_CLEAN = 'pq-skill-clean'
const T_CRON_TURN = 'pq-cron-t'
const T_CRON_CLEAN = 'pq-cron-clean'
const FACT_KEY = 'pq-fact-key'
const FIXTURE_A3 = 'src/lib/w-t-evo-fixture-a3.ts'

function isMineAudit(r: { tool: string; turnId: string | null; argsJson: string }): boolean {
  return (
    (r.turnId ?? '').startsWith('pq-') ||
    (r.argsJson ?? '').includes(TAINT_MARKER) ||
    (r.argsJson ?? '').includes('pq-evo')
  )
}

/** Tail-safe audit cleanup (same contract as wiring.test.ts: delete THIS
 * file's rows only while they form the tail above the highest non-test row). */
async function tailSafeDeleteRows(): Promise<void> {
  const all = await db.auditEvent.findMany({ orderBy: { seq: 'asc' }, select: { seq: true, tool: true, turnId: true, argsJson: true } })
  const below = all.filter((r) => !isMineAudit(r)).reduce((m, r) => Math.max(m, r.seq), 0)
  const mineAbove = all.filter((r) => r.seq > below && isMineAudit(r)).map((r) => r.seq)
  if (mineAbove.length > 0) await db.auditEvent.deleteMany({ where: { seq: { in: mineAbove } } })
}

async function cleanupAll(): Promise<void> {
  await db.quarantineItem.deleteMany({ where: { OR: [{ turnId: { startsWith: 'pq-' } }, { contentJson: { contains: 'pq-' } }] } }).catch(() => undefined)
  await db.longtermMemory.deleteMany({ where: { key: { startsWith: 'pq-' } } }).catch(() => undefined)
  await db.vectorMemory.deleteMany({ where: { OR: [{ text: { contains: 'pq-' } }, { text: { contains: TAINT_MARKER } }] } }).catch(() => undefined)
  await db.skill.deleteMany({ where: { name: { startsWith: 'pq-' } } }).catch(() => undefined)
  await db.cronJob.deleteMany({ where: { name: { startsWith: 'pq-' } } }).catch(() => undefined)
  await db.evolutionProposal.deleteMany({ where: { title: { startsWith: 'pq-evo' } } }).catch(() => undefined)
  await db.approval.deleteMany({ where: { OR: [{ payload: { contains: 'pq-evo' } }, { title: { contains: 'pq-' } }] } }).catch(() => undefined)
  await db.alert.deleteMany({ where: { title: { contains: 'pq-' } } }).catch(() => undefined)
  await tailSafeDeleteRows()
  for (const f of ['src/lib/w-t-evo-fixture-a2.ts', FIXTURE_A3]) {
    const p = path.join(process.cwd(), f)
    if (existsSync(p)) rmSync(p, { force: true })
  }
  // saveSkill mirrors every saved skill into db/skills/<slug>.md — test skills
  // leave those mirrors behind; sweep them like wiring sweeps its note files
  for (const f of ['pq-skill-clean.md', 'pq-skill-poisoned.md']) {
    const p = path.join(process.cwd(), 'db/skills', f)
    if (existsSync(p)) rmSync(p, { force: true })
  }
  rmSync(path.join(process.cwd(), 'db/backups'), { recursive: true, force: true })
}

let scopeAtStart: ReturnType<typeof getAutonomyScope>

beforeAll(async () => {
  scopeAtStart = getAutonomyScope()
  for (const t of [T_TURN, T_TURN_ANY, T_SKILL_TURN, T_SKILL_CLEAN, T_CRON_TURN, T_CRON_CLEAN]) clearTaint(t)
  await cleanupAll()
})

afterAll(async () => {
  for (const t of [T_TURN, T_TURN_ANY, T_SKILL_TURN, T_SKILL_CLEAN, T_CRON_TURN, T_CRON_CLEAN]) clearTaint(t)
  // the scope seam is module state — leave it exactly as we found it
  setAutonomyScope(scopeAtStart)
  await cleanupAll()
})

// ---------- SCHEMA · the new columns exist and round-trip ----------

test('P1 · LongtermMemory carries source/trust/createdByTurn/pinned (create+read)', async () => {
  await db.longtermMemory.deleteMany({ where: { key: 'pq-schema-fact' } })
  const row = await db.longtermMemory.create({
    data: { key: 'pq-schema-fact', value: 'schema round-trip', trust: 'derived', source: 'pq-test', createdByTurn: T_TURN, pinned: true },
  })
  expect(row.trust).toBe('derived')
  expect(row.source).toBe('pq-test')
  expect(row.createdByTurn).toBe(T_TURN)
  expect(row.pinned).toBe(true)
  const back = await db.longtermMemory.findUnique({ where: { key: 'pq-schema-fact' } })
  expect(back?.source).toBe('pq-test')
  expect(back?.pinned).toBe(true)
  // rows created without trust get the owner default (the honest default for
  // writes that predate the trust system)
  await db.longtermMemory.deleteMany({ where: { key: 'pq-schema-fact-2' } })
  const bare = await db.longtermMemory.create({ data: { key: 'pq-schema-fact-2', value: 'bare' } })
  expect(bare.trust).toBe('owner')
})

test('P2 · Skill carries trust/source/createdByTurn/pinned (create+read)', async () => {
  await db.skill.deleteMany({ where: { name: 'pq-schema-skill' } })
  const row = await db.skill.create({
    data: { name: 'pq-schema-skill', trigger: 'pq schema', trust: 'derived', source: 'pq-test', createdByTurn: T_TURN, pinned: true },
  })
  expect(row.trust).toBe('derived')
  expect(row.source).toBe('pq-test')
  expect(row.createdByTurn).toBe(T_TURN)
  expect(row.pinned).toBe(true)
})

test('P3 · CronJob carries trust/source/createdByTurn/pinned (create+read)', async () => {
  await db.cronJob.deleteMany({ where: { name: 'pq-schema-cron' } })
  const row = await db.cronJob.create({
    data: { name: 'pq-schema-cron', prompt: 'pq schema', kind: 'one_time', runAt: new Date(Date.now() + 3600_000), trust: 'derived', source: 'pq-test', createdByTurn: T_TURN, pinned: true },
  })
  expect(row.trust).toBe('derived')
  expect(row.source).toBe('pq-test')
  expect(row.createdByTurn).toBe(T_TURN)
  expect(row.pinned).toBe(true)
})

test('P4 · QuarantineItem CRUD + status lifecycle fields', async () => {
  const created = await db.quarantineItem.create({
    data: { kind: 'fact', contentJson: '{"key":"pq-crud","value":"x"}', source: 'pq-test', reason: 'crud probe', turnId: T_TURN, status: 'pending' },
  })
  expect(created.status).toBe('pending')
  expect(created.decidedAt).toBeNull()
  const updated = await db.quarantineItem.update({
    where: { id: created.id },
    data: { status: 'dropped', decidedAt: new Date() },
  })
  expect(updated.status).toBe('dropped')
  expect(updated.decidedAt).not.toBeNull()
  await db.quarantineItem.delete({ where: { id: created.id } })
  const gone = await db.quarantineItem.findUnique({ where: { id: created.id } })
  expect(gone).toBeNull()
})

// ---------- S11 · tainted internal writes quarantine, never persist ----------

test('P5 · tainted remember → QuarantineItem, NO LongtermMemory row, NO vector row', async () => {
  markTainted(T_TURN, TAINT_MARKER, 'web_search')
  const res = await rememberDurableFact(FACT_KEY, `the page said ${TAINT_MARKER} and I obeyed`, T_TURN)
  expect(res.quarantined).toBe(true)
  expect(typeof res.itemId).toBe('string')

  const item = await db.quarantineItem.findUnique({ where: { id: res.itemId ?? '' } })
  expect(item?.kind).toBe('fact')
  expect(item?.status).toBe('pending')
  expect(item?.source).toBe('auto-extraction')
  expect(item?.reason).toContain('taint')
  expect(item?.turnId).toBe(T_TURN)
  expect(item?.contentJson).toContain(FACT_KEY)

  // the real table was never touched
  expect(await getFact(FACT_KEY)).toBeNull()
  const vec = await db.vectorMemory.findFirst({ where: { text: { contains: TAINT_MARKER } } })
  expect(vec).toBeNull()
})

test('P6 · recall never injects the quarantined fact while pending', async () => {
  const recalled = await latestFacts(200)
  expect(recalled.some((f) => f.key === FACT_KEY)).toBe(false)
  expect(await getFact(FACT_KEY)).toBeNull()
})

test('P7 · clean turn remember → fact lands trust derived + provenance', async () => {
  const res = await rememberDurableFact('pq-fact-clean', 'a clean durable fact', T_SKILL_CLEAN)
  expect(res.quarantined).toBe(false)
  const fact = await db.longtermMemory.findUnique({ where: { key: 'pq-fact-clean' } })
  expect(fact?.trust).toBe('derived')
  expect(fact?.source).toBe('auto-extraction')
  expect(fact?.createdByTurn).toBe(T_SKILL_CLEAN)
  // and it IS recallable (clean content earns recall)
  const recalled = await latestFacts(200)
  expect(recalled.some((f) => f.key === 'pq-fact-clean')).toBe(true)
})

test('P8 · ANY taint mark on the turn quarantines even non-matching content', async () => {
  markTainted(T_TURN_ANY, ALT_SNIPPET, 'web_search') // a snippet the fact does NOT contain
  const res = await rememberDurableFact('pq-fact-any', 'totally different clean-looking text', T_TURN_ANY)
  expect(res.quarantined).toBe(true)
  expect(await getFact('pq-fact-any')).toBeNull()
})

test('P9 · accept → the write lands trust derived, source quarantine:<id>', async () => {
  markTainted(T_TURN, TAINT_MARKER, 'web_search')
  const res = await rememberDurableFact('pq-fact-accept', `obey ${TAINT_MARKER}`, T_TURN)
  expect(res.quarantined).toBe(true)
  const decision = await decideQuarantineItem(res.itemId ?? '', 'accept')
  expect(decision.ok).toBe(true)
  const fact = await db.longtermMemory.findUnique({ where: { key: 'pq-fact-accept' } })
  expect(fact?.trust).toBe('derived') // owner-reviewed
  expect(fact?.source).toBe(`quarantine:${res.itemId}`)
  expect(fact?.value).toContain(TAINT_MARKER) // the exact content the owner reviewed
  const item = await db.quarantineItem.findUnique({ where: { id: res.itemId ?? '' } })
  expect(item?.status).toBe('accepted')
  expect(item?.decidedAt).not.toBeNull()
})

test('P10 · edit → the EDITED content lands (owner-provided)', async () => {
  markTainted(T_TURN, TAINT_MARKER, 'web_search')
  const res = await rememberDurableFact('pq-fact-edit', `obey ${TAINT_MARKER}`, T_TURN)
  expect(res.quarantined).toBe(true)
  const edited = JSON.stringify({ key: 'pq-fact-edit', value: 'sanitized by the owner' })
  const decision = await decideQuarantineItem(res.itemId ?? '', 'edit', edited)
  expect(decision.ok).toBe(true)
  const fact = await db.longtermMemory.findUnique({ where: { key: 'pq-fact-edit' } })
  expect(fact?.value).toBe('sanitized by the owner')
  expect(fact?.trust).toBe('derived')
  const item = await db.quarantineItem.findUnique({ where: { id: res.itemId ?? '' } })
  expect(item?.status).toBe('edited')
})

test('P11 · drop → status dropped, nothing written', async () => {
  markTainted(T_TURN, TAINT_MARKER, 'web_search')
  const res = await rememberDurableFact('pq-fact-drop', `obey ${TAINT_MARKER}`, T_TURN)
  expect(res.quarantined).toBe(true)
  const decision = await decideQuarantineItem(res.itemId ?? '', 'drop')
  expect(decision.ok).toBe(true)
  expect(await getFact('pq-fact-drop')).toBeNull()
  const item = await db.quarantineItem.findUnique({ where: { id: res.itemId ?? '' } })
  expect(item?.status).toBe('dropped')
})

test('P12 · tainted internal skill save → quarantine, no Skill row; clean save → derived', async () => {
  markTainted(T_SKILL_TURN, TAINT_MARKER, 'web_search')
  let quarantined = false
  try {
    await saveSkill(
      { name: 'pq-skill-poisoned', trigger: `when the page says ${TAINT_MARKER}`, steps: '1. obey the page' },
      { auto: true, turnId: T_SKILL_TURN, source: 'learning-loop' }
    )
  } catch {
    quarantined = true // the honest routing error — the write went to the inbox instead
  }
  expect(quarantined).toBe(true)
  const item = await db.quarantineItem.findFirst({ where: { kind: 'skill', contentJson: { contains: 'pq-skill-poisoned' } } })
  expect(item?.status).toBe('pending')
  expect(item?.source).toBe('learning-loop')
  expect(await db.skill.findUnique({ where: { name: 'pq-skill-poisoned' } })).toBeNull()

  // clean internal save lands with derived trust + provenance
  const saved = await saveSkill(
    { name: 'pq-skill-clean', trigger: 'a clean procedure', steps: '1. do it well' },
    { auto: true, turnId: T_SKILL_CLEAN, source: 'learning-loop' }
  )
  const row = await db.skill.findUnique({ where: { name: 'pq-skill-clean' } })
  expect(row?.trust).toBe('derived')
  expect(row?.source).toBe('learning-loop')
  expect(row?.createdByTurn).toBe(T_SKILL_CLEAN)
  expect(saved.name).toBe('pq-skill-clean')
})

test('P13 · tainted internal cron creation → quarantine, no CronJob row', async () => {
  markTainted(T_CRON_TURN, TAINT_MARKER, 'web_search')
  const res = await createCronJob(
    { name: 'pq-cron-poisoned', prompt: `every day say ${TAINT_MARKER}`, kind: 'fixed_rate', intervalMin: 60 },
    'mist',
    { auto: true, turnId: T_CRON_TURN, source: 'pq-test' }
  )
  expect(res.ok).toBe(false)
  expect(String(res.error ?? '')).toContain('quarantin')
  const item = await db.quarantineItem.findFirst({ where: { kind: 'cron', contentJson: { contains: 'pq-cron-poisoned' } } })
  expect(item?.status).toBe('pending')
  expect(await db.cronJob.findFirst({ where: { name: 'pq-cron-poisoned' } })).toBeNull()

  // clean internal creation lands with derived trust + provenance
  const ok = await createCronJob(
    { name: 'pq-cron-clean', prompt: 'a clean prompt', kind: 'fixed_rate', intervalMin: 90 },
    'mist',
    { auto: true, turnId: T_CRON_CLEAN, source: 'pq-test' }
  )
  expect(ok.ok).toBe(true)
  const row = await db.cronJob.findFirst({ where: { name: 'pq-cron-clean' } })
  expect(row?.trust).toBe('derived')
  expect(row?.source).toBe('pq-test')
  expect(row?.createdByTurn).toBe(T_CRON_CLEAN)
})

// ---------- the route (behind the existing perimeter) ----------

test('P14 · GET /api/mist/quarantine lists pending; POST decides; no session → 403', async () => {
  const itemId = await quarantineWrite('fact', JSON.stringify({ key: 'pq-route-fact', value: 'route probe' }), {
    source: 'pq-test',
    reason: 'pq route probe',
    turnId: T_TURN,
  })

  const no = await fetch(`${BASE}/api/mist/quarantine`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'decide', id: itemId, decision: 'drop' }) })
  expect(no.status).toBe(403) // non-GET without a session — the perimeter holds

  const get = await fetch(`${BASE}/api/mist/quarantine`, { headers: { Cookie: COOKIE() } })
  expect(get.status).toBe(200)
  const list = (await get.json()) as { pending: Array<{ id: string; kind: string }>; counts: { pending: number } }
  expect(list.pending.some((i) => i.id === itemId)).toBe(true)
  expect(list.counts.pending).toBeGreaterThan(0)

  const post = await fetch(`${BASE}/api/mist/quarantine`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: COOKIE() },
    body: JSON.stringify({ action: 'decide', id: itemId, decision: 'drop' }),
  })
  expect(post.status).toBe(200)
  const decided = (await post.json()) as { ok: boolean; item?: { status: string } }
  expect(decided.ok).toBe(true)
  expect(decided.item?.status).toBe('dropped')
  expect(await getFact('pq-route-fact')).toBeNull()
})

// ---------- EVOLUTION GATE · protected paths, scope, battery ----------

async function makeProposal(title: string, changes: Array<Record<string, unknown>>): Promise<string> {
  const row = await db.evolutionProposal.create({
    data: {
      kind: 'feature',
      title,
      summary: 'pq-evo gate probe',
      rationale: 'pq-evo gate probe',
      origin: 'self',
      status: 'pending',
      changes: JSON.stringify(changes),
      targetFiles: JSON.stringify(changes.map((c) => c.path)),
    },
  })
  return row.id
}

test('P15 · protected path → reject BEFORE diff + Approval row (file_write, high, pending) + file untouched', async () => {
  const target = 'src/lib/arbiter/arbiter.ts'
  const before = readFileSync(path.join(process.cwd(), target), 'utf-8')
  const id = await makeProposal('pq-evo protected', [{ path: target, action: 'create', content: '// pq-evo poison the arbiter' }])

  const res = await applyProposal(id)
  expect(res.message).toContain('protected path')
  expect(res.proposal?.status).toBe('pending') // stays a proposal — she may propose, only the owner UI applies
  expect(readFileSync(path.join(process.cwd(), target), 'utf-8')).toBe(before) // zero diff work happened

  const approval = await db.approval.findFirst({ where: { actionType: 'file_write', payload: { contains: id } }, orderBy: { createdAt: 'desc' } })
  expect(approval?.status).toBe('pending')
  expect(approval?.tier).toBe('high')

  const denied = await db.auditEvent.findFirst({ where: { tool: 'evolution_apply', decision: 'deny', argsJson: { contains: 'pq-evo' } }, orderBy: { seq: 'desc' } })
  expect(denied).not.toBeNull()
})

test('P16 · non-protected path at scope A2 → proposal-only, no file, Approval row', async () => {
  const prev = getAutonomyScope()
  setAutonomyScope('A2')
  try {
    const target = 'src/lib/w-t-evo-fixture-a2.ts'
    const id = await makeProposal('pq-evo a2', [{ path: target, action: 'create', content: 'export const PQ_EVO_A2 = 1\n' }])
    const res = await applyProposal(id)
    expect(res.message).toContain('proposal only')
    expect(res.proposal?.status).toBe('pending')
    expect(existsSync(path.join(process.cwd(), target))).toBe(false)
    const approval = await db.approval.findFirst({ where: { actionType: 'file_write', payload: { contains: id } }, orderBy: { createdAt: 'desc' } })
    expect(approval?.status).toBe('pending')
  } finally {
    setAutonomyScope(prev)
  }
})

test('P17 · A3 + failed gate → NO commit, backup restored, honest rolled-back result', async () => {
  const prev = getAutonomyScope()
  setAutonomyScope('A3')
  const originalRunner = evolutionGates.runGateCommand
  evolutionGates.runGateCommand = async () => ({ ok: false, output: 'pq-evo forced gate failure (exit 1)' })
  const fixturePath = path.join(process.cwd(), FIXTURE_A3)
  writeFileSync(fixturePath, 'export const PQ_EVO_A3 = 1\n', 'utf-8')
  try {
    const id = await makeProposal('pq-evo a3 gate-fail', [
      { path: FIXTURE_A3, action: 'patch', find: 'export const PQ_EVO_A3 = 1', content: 'export const PQ_EVO_A3 = 2' },
    ])
    const res = await applyProposal(id)
    expect(res.proposal?.status).toBe('rolled_back')
    expect(res.message.toLowerCase()).toContain('gate')
    // the battery failed → the live tree was restored from the backup
    expect(readFileSync(fixturePath, 'utf-8')).toBe('export const PQ_EVO_A3 = 1\n')
    const row = await db.evolutionProposal.findUnique({ where: { id } })
    // proof the rollback came from the POST-COMMIT battery (not a staged-gate
    // failure that never touched the tree): the report names the gate
    expect((row?.lintOutput ?? '')).toContain('POST-COMMIT GATES FAILED')
    expect((row?.lintOutput ?? '').toLowerCase()).toContain('pq-evo forced gate failure')
  } finally {
    evolutionGates.runGateCommand = originalRunner
    setAutonomyScope(prev)
    if (existsSync(fixturePath)) rmSync(fixturePath, { force: true })
  }
})

// ---------- UNTRUSTED WRAP · every tool result, not only high/critical ----------

test('P18 · wrapToolOutput tags low-severity tool output as untrusted source=tool:<name>', () => {
  const wrapped = wrapToolOutput('calculate', '{"result":42}', 'low')
  expect(wrapped.includes('<untrusted source="tool:calculate">')).toBe(true)
  expect(wrapped.includes('</untrusted>')).toBe(true)
  expect(wrapped.includes('{"result":42}')).toBe(true)
  // clean and high severities tag too (high adds the injection warning)
  expect(wrapToolOutput('web_search', 'abc', 'clean').includes('<untrusted source="tool:web_search">')).toBe(true)
  expect(wrapToolOutput('read_page', 'def', 'high').includes('flagged instruction-like text')).toBe(true)
})

// ---------- DEFANG · authority comes from the scope, not the prompt ----------

test('P19 · absolutist authority phrases are GONE from the live prompt sources', () => {
  const identity = readFileSync(path.join(process.cwd(), 'src/lib/services/context-builder.ts'), 'utf-8')
  expect(identity.includes('authorize everything')).toBe(false)
  expect(identity.includes('NEVER refuse')).toBe(false)
  // the source uses typographic apostrophes (\u2019) — assert apostrophe-free fragments
  expect(identity.includes('authority to act is the session')).toBe(true)
  expect(identity.includes('autonomy scope, not this prompt')).toBe(true)
  expect(identity.includes('the Arbiter enforces')).toBe(true)

  const soul = readFileSync(path.join(process.cwd(), 'db/persona/SOUL.md'), 'utf-8')
  expect(soul.includes('authorizes everything')).toBe(false)
  expect(soul.includes('my authority is the scope he grants')).toBe(true)

  const tools = readFileSync(path.join(process.cwd(), 'src/lib/services/tools-service.ts'), 'utf-8')
  expect(tools.includes('NEVER refuse flatly')).toBe(false)
  expect(tools.includes('be straight about it')).toBe(true)
})

// ---------- the audit chain still verifies after everything above ----------

test('P20 · the hash-chained audit log verifies after all quarantine/gate events', async () => {
  const check = await verifyAuditChain()
  expect(check.ok).toBe(true)
})
