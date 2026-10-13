// Phase 7 · skills deep audit + chain-max risk — tests.
//
// Pins the mandate's Phase 7 row (docs/phase-0/tool-risk-table.md):
//     "19x `skill:<name>` | chain-max | chain | effective risk = max of
//      chained tools"
// and the executed Phase 0 triage (docs/phase-0/prisma-and-skills.md §D7).
//
// Three sections, in run order:
//
//   §T POST-TRIAGE INVARIANTS (first — they describe the live state the
//      triage script left: exactly 12 skills, zero omni_* chains, 7 archive
//      files, the merged model-selector, no resurrection mirrors)
//   §P PURE chain-risk units (no DB — chain-risk.ts + the derived ladder)
//   §L LIVE skill-risk (DB-seeded s7-* skills + the real wiring seam +
//      the executeTool chokepoint, direct-import style per wiring.test.ts)
//
// The live tests create their skills via prisma directly (the task allows
// prisma OR the session-gated save route) and drive the CHOKEPOINT through
// direct module imports — the wiring.test.ts W2/W5/W6 pattern. A route-level
// variant would race the dev server's OWN 30s chain cache (a separate
// process that prisma-direct seeding cannot invalidate), so it is
// deliberately not used for freshly-seeded fixtures.
//
// Run: bun test tests/security/skills7.test.ts (live DB + dev server up)
import { test, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { existsSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { db } from '../../src/lib/db'
import { executeTool } from '../../src/lib/services/tools-service'
import { arbitrate, type ArbitrateInput } from '../../src/lib/arbiter/arbiter'
import {
  skillChainRisk,
  RISK_SEVERITY,
  maxRisk,
  EMPTY_CHAIN_RISK,
  MAX_NESTED_DEPTH,
} from '../../src/lib/arbiter/chain-risk'
import {
  ensureSkillChainCache,
  effectiveSkillRisk,
  invalidateSkillChainCache,
  invalidateStandingOrderCache,
  riskTier,
} from '../../src/lib/arbiter/wiring'
import { RISK_CLASSES, classifyRisk, isKnownTool, type RiskClass } from '../../src/lib/arbiter/risk-table'

const TURN = 's7-t'
const MARKER = 's7-'
const ARCHIVE_DIR = path.join(process.cwd(), 'db', 'skills-archive')
const SKILLS_MIRROR_DIR = path.join(process.cwd(), 'db', 'skills')

const KEEP_NAMES = [
  'hermes-operator', 'research-first', 'quick-math', 'pdf-extract', 'get-latest-version',
  'read-package-version', 'count-images-downloads', 'research-ai-agents', 'self-review-report',
  'system-health-check', 'system-status-with-weather',
]
const ARCHIVED_NAMES = [
  'adaptive-model-selector', 'agent-skills-integration', 'exec-proof', 'generate-self-review-report',
  'gpt6-luna-evaluator', 'optimal-model-selector', 'security-threat-monitor',
]

// ---------- cleanup helpers (suite conventions) ----------

/** Tail-safe audit-row cleanup: delete THIS file's rows only while they form
 *  the tail above the highest non-test row (the dev server is a concurrent
 *  writer; mid-chain deletion would break every future verifyAuditChain). */
async function tailSafeDeleteS7Rows(): Promise<void> {
  const all = await db.auditEvent.findMany({
    orderBy: { seq: 'asc' },
    select: { seq: true, turnId: true, tool: true },
  })
  const isMine = (r: { turnId: string | null; tool: string }) =>
    r.turnId === TURN || r.tool.startsWith('skill:s7-')
  const below = all.filter((r) => !isMine(r)).reduce((m, r) => Math.max(m, r.seq), 0)
  const mineAbove = all.filter((r) => r.seq > below && isMine(r)).map((r) => r.seq)
  if (mineAbove.length > 0) await db.auditEvent.deleteMany({ where: { seq: { in: mineAbove } } })
}

/** Delete every s7-* fixture (skills, executions, approvals, alerts) and drop
 *  the caches so no later test sees them. */
async function cleanupS7Fixtures(): Promise<void> {
  await db.skill.deleteMany({ where: { name: { startsWith: 's7-' } } }).catch(() => undefined)
  await db.skillExecution.deleteMany({ where: { skill_name: { startsWith: 's7-' } } }).catch(() => undefined)
  await db.approval.deleteMany({ where: { fingerprint: { contains: MARKER } } }).catch(() => undefined)
  await db.alert.deleteMany({ where: { title: { contains: MARKER } } }).catch(() => undefined)
  await tailSafeDeleteS7Rows()
  invalidateSkillChainCache()
  invalidateStandingOrderCache()
}

/** Seed an s7-* skill directly via prisma and refresh the wiring's chain
 *  cache — the honest equivalent of the owner's save route for fixtures. */
async function seedSkill(name: string, chain: string[]): Promise<void> {
  await db.skill.create({
    data: {
      name,
      trigger: `s7 fixture ${name}`,
      steps: `s7 fixture steps for ${name}`,
      toolChain: JSON.stringify(chain),
      notes: 's7 test fixture',
      source: 's7-test',
      trust: 'owner',
    },
  })
  invalidateSkillChainCache()
  await ensureSkillChainCache()
}

beforeAll(async () => {
  await cleanupS7Fixtures()
})

afterEach(async () => {
  // every live test removes its own fixtures so the post-triage live count
  // stays exactly 12 for any later reader of this suite
  await cleanupS7Fixtures()
})

afterAll(async () => {
  await cleanupS7Fixtures()
})

// ===========================================================================
// §T · POST-TRIAGE INVARIANTS — the live state scripts/skills-audit-7.ts left
// (run FIRST: before any fixture this file creates; the invariants describe
// the triage output, not the test process)
// ===========================================================================

test('T1 · post-triage live table: exactly 12 skills — the 11 KEEP + model-selector', async () => {
  const rows = await db.skill.findMany({ select: { name: true } })
  const names = rows.map((r) => r.name).sort()
  expect(names).toHaveLength(12)
  expect(names).toEqual([...KEEP_NAMES, 'model-selector'].sort())
})

test('T2 · post-triage: ZERO live skills chain dead omni_* tools (or any name unknown to TOOL_RISK)', async () => {
  const rows = await db.skill.findMany({ select: { name: true, toolChain: true } })
  expect(rows.length).toBeGreaterThan(0)
  const offenders: string[] = []
  for (const row of rows) {
    const chain = JSON.parse(row.toolChain) as unknown
    if (!Array.isArray(chain)) continue
    for (const entry of chain) {
      if (typeof entry === 'string' && !isKnownTool(entry)) offenders.push(`${row.name}→${entry}`)
    }
  }
  expect(offenders).toEqual([])
})

test('T3 · post-triage: model-selector = the merged skill (live chain subset, phase7 provenance)', async () => {
  const row = await db.skill.findUnique({ where: { name: 'model-selector' } })
  expect(row).not.toBeNull()
  const chain = JSON.parse(row?.toolChain ?? '[]') as string[]
  // the phase-0 triage's LIVE subset — every entry verified against TOOL_RISK
  expect(chain).toEqual(['memory_get', 'memory_set', 'capability_check'])
  for (const entry of chain) expect(isKnownTool(entry)).toBe(true)
  expect(chain.some((c) => c.startsWith('omni_'))).toBe(false)
  // provenance set honestly by the audit script
  expect(row?.source).toBe('phase7-audit')
  expect(row?.trust).toBe('owner')
})

test('T4 · post-triage: 7 archive exports on disk; originals gone; no resurrection mirrors; the KEEP duplicate survives', async () => {
  // the 7 exports (exec-proof's copy explicitly KEPT per the phase-0 note)
  const files = readdirSync(ARCHIVE_DIR).filter((f) => f.endsWith('.md')).sort()
  expect(files).toEqual(ARCHIVED_NAMES.map((n) => `${n}.md`).sort())
  // each export is a real full record (spot-check the two decision classes)
  const execProof = await Bun.file(path.join(ARCHIVE_DIR, 'exec-proof.md')).text()
  expect(execProof).toContain('name: exec-proof')
  expect(execProof).toContain('phase7-audit ARCHIVE')
  expect(execProof).toContain('ledger proven')
  const merged = await Bun.file(path.join(ARCHIVE_DIR, 'adaptive-model-selector.md')).text()
  expect(merged).toContain('phase7-audit MERGE')
  expect(merged).toContain('omni_list_models') // the dead chain is recorded honestly
  // the originals are gone from the live table
  for (const name of ARCHIVED_NAMES) {
    const row = await db.skill.findUnique({ where: { name } })
    expect(row).toBeNull()
  }
  // their db/skills mirrors are gone too — importEcosystemSkills must not
  // resurrect a dead skill from a stale mirror
  for (const name of ARCHIVED_NAMES) {
    expect(existsSync(path.join(SKILLS_MIRROR_DIR, `${name}.md`))).toBe(false)
  }
  // the duplicate-of decision: generate-self-review-report archived, the
  // original self-review-report skill still live with its own chain
  const kept = await db.skill.findUnique({ where: { name: 'self-review-report' } })
  expect(kept).not.toBeNull()
  expect((JSON.parse(kept?.toolChain ?? '[]') as string[]).includes('skill:self-review-report')).toBe(false)
})

// ===========================================================================
// §P · PURE chain-risk units (no DB)
// ===========================================================================

const never: (name: string) => string[] | null = () => null

test('P1 · empty chain → read (the documented prompt-expansion decision)', () => {
  const r = skillChainRisk([], never)
  expect(r.risk).toBe('read')
  expect(r.dead).toEqual([])
  expect(r.nested).toEqual([])
  expect(EMPTY_CHAIN_RISK).toBe('read')
  // the honest counter-consideration is documented in chain-risk.ts:
  // executeSkillTool's uses-bump + ledger row are call-bookkeeping, the same
  // class of write the audit append performs for EVERY verdict (reads
  // included) — not counted in the risk class by engine convention.
})

test('P2 · single read tool → read', () => {
  expect(skillChainRisk(['memory_get'], never).risk).toBe('read')
  expect(skillChainRisk(['calculate'], never).risk).toBe('read')
})

test('P3 · max-of-many: read + exec → exec (the MAX operator, not the first, not the average)', () => {
  expect(skillChainRisk(['read_file', 'run_command'], never).risk).toBe('exec')
  expect(skillChainRisk(['run_command', 'read_file'], never).risk).toBe('exec') // order-independent
  expect(maxRisk('read', 'exec')).toBe('exec')
  expect(maxRisk('exec', 'read')).toBe('exec')
})

test('P4 · dead omni_* counts as the conservative unknown default AND is reported in dead', () => {
  const r = skillChainRisk(['omni_list_models', 'memory_get'], never)
  expect(r.risk).toBe('write') // max(unknown-default 'write', read)
  expect(r.dead).toEqual(['omni_list_models'])
  expect(r.nested).toEqual([])
  // dead does not CAP the max — the max operator stays honest when a live
  // tool outranks the dead default
  const r2 = skillChainRisk(['omni_list_models', 'run_command'], never)
  expect(r2.risk).toBe('exec')
  expect(r2.dead).toEqual(['omni_list_models'])
})

test('P5 · nested skill resolution (one level): the inner chain max rides up', () => {
  const resolver = (name: string): string[] | null =>
    name === 's7-inner' ? ['run_command'] : null
  const r = skillChainRisk(['memory_get', 'skill:s7-inner'], resolver)
  expect(r.risk).toBe('exec') // the nested run_command dominates
  expect(r.dead).toEqual([])
  expect(r.nested).toEqual([]) // successful descents are not stops
  // a nested skill unknown to the resolver stops as unknown + is recorded
  const r2 = skillChainRisk(['skill:s7-missing'], resolver)
  expect(r2.risk).toBe('write')
  expect(r2.nested).toEqual(['skill:s7-missing'])
})

test('P6 · nested cycle a→b→a TERMINATES at the depth cap with the unknown default', () => {
  const chains: Record<string, string[]> = {
    's7-a': ['skill:s7-b', 'calculate'],
    's7-b': ['skill:s7-a'],
  }
  const resolver = (name: string): string[] | null => chains[name] ?? null
  // if the recursion did not terminate this test would hang — the depth cap
  // (MAX_NESTED_DEPTH = 3) is the cycle safety
  const r = skillChainRisk(chains['s7-a'], resolver)
  expect(MAX_NESTED_DEPTH).toBe(3)
  expect(r.risk).toBe('write') // the cycle stop counts as the unknown default; calculate is read
  expect(r.nested.length).toBeGreaterThan(0) // the stop is on the record
  expect(r.nested.every((n) => n.startsWith('skill:'))).toBe(true)
})

test('P7 · ladder sanity: strictly increasing across all 9 classes, engine-grounded', () => {
  // the derived ladder (chain-risk.ts) — the suggested ordering VERIFIED
  // against the engine's actual gating
  const ladder: RiskClass[] = [
    'read', 'sensitive-read', 'network', 'write', 'persist', 'exec', 'egress', 'destructive', 'self-modify',
  ]
  // covers every RiskClass exactly once
  expect([...ladder].sort()).toEqual([...RISK_CLASSES].sort())
  // strictly increasing severity
  for (let i = 1; i < ladder.length; i++) {
    expect(RISK_SEVERITY[ladder[i - 1]]).toBeLessThan(RISK_SEVERITY[ladder[i]])
  }
  // ENGINE GROUNDING — the hard boundaries are the arbiter's own gates:
  const probe = (o: Partial<ArbitrateInput> & Pick<ArbitrateInput, 'risk' | 'origin'>): ReturnType<typeof arbitrate> =>
    arbitrate({ tool: 'probe', canonicalArgs: {}, tainted: false, scope: 'A2', ...o })
  // (1) read < sensitive-read — floor 2: web/mcp allows ONLY read (arbiter.ts:193-194)
  expect(probe({ risk: 'read', origin: 'web' }).decision).toBe('allow')
  expect(probe({ risk: 'sensitive-read', origin: 'web' }).decision).toBe('deny')
  // (2) sensitive-read < network — observe scopes pass sensitive-read but ASK network (arbiter.ts:210-214)
  expect(probe({ risk: 'sensitive-read', origin: 'owner_chat', scope: 'A0' }).decision).toBe('allow')
  expect(probe({ risk: 'network', origin: 'owner_chat', scope: 'A0' }).decision).toBe('ask')
  // (3) network < write — the A2 allow-set vs the ask matrix (arbiter.ts:165-168)
  expect(probe({ risk: 'network', origin: 'owner_chat' }).decision).toBe('allow')
  expect(probe({ risk: 'write', origin: 'owner_chat' }).decision).toBe('ask')
  // (4) {write,persist} < {exec,egress,destructive,self-modify} — the wiring's
  // own severity intuition, riskTier (wiring.ts): medium vs high
  expect(riskTier('write')).toBe('medium')
  expect(riskTier('persist')).toBe('medium')
  for (const high of ['exec', 'egress', 'destructive', 'self-modify'] as RiskClass[]) {
    expect(riskTier(high)).toBe('high')
  }
})

// ===========================================================================
// §L · LIVE skill-risk (DB-seeded s7-* skills, the real wiring seam, the
// executeTool chokepoint)
// ===========================================================================

test('L1 · skill chaining run_command → chain-max exec, NOT flat write (the mandated case)', async () => {
  await seedSkill('s7-exec-chain', ['run_command'])

  // the pure layer is unchanged: classifyRisk still answers the conservative
  // unknown default for skill:* names — chain-max is the WIRING's override
  expect(classifyRisk('skill:s7-exec-chain', {})).toBe('write')

  // direct arbitrate at A2 owner_chat untainted → ASK with the chain-max risk
  const verdict = arbitrate({
    tool: 'skill:s7-exec-chain',
    canonicalArgs: {},
    risk: classifyRisk('skill:s7-exec-chain', {}), // what the chokepoint would pass
    origin: 'owner_chat',
    tainted: false,
    scope: 'A2',
  })
  expect(verdict.decision).toBe('ask')
  expect(verdict.effectiveRisk).toBe('exec') // chain-max, NOT the flat 'write' input
  expect(verdict.reason).toContain('A2 ask-by-default')
  expect(verdict.reason).not.toContain('dead tools') // the chain is clean — no dishonest note

  // end-to-end through the CHOKEPOINT: the ask's Approval row + audit row
  // carry the effective class ('exec' / high tier), not flat 'write' / medium
  const result = await executeTool('skill:s7-exec-chain', {}, false, {
    origin: 'owner_chat',
    turnId: TURN,
  })
  expect(result.success).toBe(true)
  expect((result.output as { status?: string }).status).toBe('pending-approval')

  const audit = await db.auditEvent.findFirst({
    where: { tool: 'skill:s7-exec-chain', turnId: TURN },
    orderBy: { seq: 'desc' },
  })
  expect(audit?.decision).toBe('ask')
  expect(audit?.risk).toBe('exec') // Phase 7: the audit row carries chain-max
  expect(audit?.reason).toContain('A2 ask-by-default')

  const approval = await db.approval.findFirst({
    where: { fingerprint: { contains: 's7-exec-chain' } },
    orderBy: { createdAt: 'desc' },
  })
  expect(approval).not.toBeNull()
  expect(approval?.tier).toBe('high') // exec tier — a flat 'write' would have been 'medium'
  const payload = JSON.parse(approval?.payload ?? '{}') as { risk?: string }
  expect(payload.risk).toBe('exec')
}, 30_000)

test('L1b · nested live skills resolve through the real cache (one level)', async () => {
  await seedSkill('s7-inner', ['run_command'])
  await seedSkill('s7-outer', ['memory_get', 'skill:s7-inner'])
  const resolved = effectiveSkillRisk('s7-outer')
  expect(resolved).not.toBeNull()
  expect(resolved?.risk).toBe('exec') // the nested run_command rides up
  expect(resolved?.dead).toEqual([])
  expect(resolved?.nested).toEqual([])
})

test('L2 · skill chaining only web_search → chain-max network → the matrix ALLOWS at A2 (flat write would have ASKED)', async () => {
  await seedSkill('s7-net-chain', ['web_search'])

  const verdict = arbitrate({
    tool: 'skill:s7-net-chain',
    canonicalArgs: {},
    risk: 'write', // the flat unknown default
    origin: 'owner_chat',
    tainted: false,
    scope: 'A2',
  })
  // honest per the engine's own matrix: network is in the A2 allow-set
  // (arbiter.ts:165) — this ALLOW is the discriminating proof that the risk
  // INPUT was chain-max: the same call at flat 'write' would ask
  expect(verdict.decision).toBe('allow')
  expect(verdict.effectiveRisk).toBe('network')
  expect(verdict.reason).toBe('matrix allow (read-class/network)')

  // and the chokepoint really allows + executes it (prompt expansion)
  const result = await executeTool('skill:s7-net-chain', {}, false, {
    origin: 'owner_chat',
    turnId: TURN,
  })
  expect(result.success).toBe(true)
  expect(result.output).not.toBeNull()
  const allow = await db.auditEvent.findFirst({
    where: { tool: 'skill:s7-net-chain', decision: 'allow', turnId: TURN },
    orderBy: { seq: 'desc' },
  })
  // NOTE (honest limit): the allow-path audit row is appended by
  // arbitrateToolCall (tools-service) with the pure-table risk — outside the
  // Phase 7 editable file set — so its risk column still reads the flat
  // 'write' there. The DECISION ran on chain-max (the reason below proves
  // it); the ask/defer rows carry the effective class via askFlow.
  expect(allow?.decision).toBe('allow')
  expect(allow?.reason).toBe('matrix allow (read-class/network)')
}, 30_000)

test('L3 · empty-chain skill → read (prompt expansion): allows at A2 AND at A0 observe AND for web origins', async () => {
  await seedSkill('s7-prompt-skill', [])

  const resolved = effectiveSkillRisk('s7-prompt-skill')
  expect(resolved?.risk).toBe('read')

  const atA2 = arbitrate({
    tool: 'skill:s7-prompt-skill', canonicalArgs: {}, risk: 'write',
    origin: 'owner_chat', tainted: false, scope: 'A2',
  })
  expect(atA2.decision).toBe('allow')
  expect(atA2.effectiveRisk).toBe('read')

  const atA0 = arbitrate({
    tool: 'skill:s7-prompt-skill', canonicalArgs: {}, risk: 'write',
    origin: 'owner_chat', tainted: false, scope: 'A0',
  })
  expect(atA0.decision).toBe('allow') // observe allow (read-class)
  expect(atA0.reason).toContain('observe allow')

  const web = arbitrate({
    tool: 'skill:s7-prompt-skill', canonicalArgs: {}, risk: 'write',
    origin: 'web', tainted: false, scope: 'A2',
  })
  expect(web.decision).toBe('allow') // floor 2: untrusted origins may read
}, 30_000)

test('L4 · dead-chain honesty: the reason names the dead tools verbatim', async () => {
  await seedSkill('s7-dead-chain', ['omni_list_models', 'memory_get'])

  const resolved = effectiveSkillRisk('s7-dead-chain')
  expect(resolved?.risk).toBe('write') // the dead default outranks the read entry
  expect(resolved?.dead).toEqual(['omni_list_models'])

  const verdict = arbitrate({
    tool: 'skill:s7-dead-chain', canonicalArgs: {}, risk: 'write',
    origin: 'owner_chat', tainted: false, scope: 'A2',
  })
  expect(verdict.decision).toBe('ask')
  expect(verdict.effectiveRisk).toBe('write')
  expect(verdict.reason).toContain('chain contains dead tools: omni_list_models')

  // and the honest note reaches the audit row through the ask flow
  await executeTool('skill:s7-dead-chain', {}, false, { origin: 'owner_chat', turnId: TURN })
  const audit = await db.auditEvent.findFirst({
    where: { tool: 'skill:s7-dead-chain', turnId: TURN },
    orderBy: { seq: 'desc' },
  })
  expect(audit?.reason).toContain('chain contains dead tools: omni_list_models')
}, 30_000)

test('L5 · unresolved skill (cold cache / unknown name) keeps the flat risk — honest fallback, no effectiveRisk', async () => {
  invalidateSkillChainCache()
  expect(effectiveSkillRisk('s7-never-created')).toBeNull()
  const verdict = arbitrate({
    tool: 'skill:s7-never-created', canonicalArgs: {}, risk: 'write',
    origin: 'owner_chat', tainted: false, scope: 'A2',
  })
  expect(verdict.decision).toBe('ask') // the flat write input stood
  expect(verdict.effectiveRisk).toBeUndefined()
  // restore a warm cache for any later reader
  await ensureSkillChainCache()
})

test('L6 · the live merged model-selector resolves through the seam: chain-max persist, asks at A2', async () => {
  invalidateSkillChainCache()
  await ensureSkillChainCache()
  const resolved = effectiveSkillRisk('model-selector')
  // chain [memory_get(read), memory_set(persist), capability_check(read)] —
  // the memory_set persist dominates: the honest price of the merged chain
  expect(resolved?.risk).toBe('persist')
  expect(resolved?.dead).toEqual([]) // the omni_* entries are gone (T3)
  const verdict = arbitrate({
    tool: 'skill:model-selector', canonicalArgs: {}, risk: 'write',
    origin: 'owner_chat', tainted: false, scope: 'A2',
  })
  expect(verdict.decision).toBe('ask') // persist asks at A2 — the matrix decides, chain-max only feeds it
  expect(verdict.effectiveRisk).toBe('persist')
})
