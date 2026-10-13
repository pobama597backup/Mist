// Phase 2-a · Arbiter core tests — written BEFORE the implementation (red),
// green after. Pins the frozen 116-tool risk table, the arg-aware
// escalations, the scope/origin decision matrix (A0–A4), both floors,
// taint semantics, one-time bridge tickets, the hash-chained append-only
// audit log, and standing orders. Run: bun test tests/security/arbiter.test.ts
import { test, expect, beforeAll, afterAll } from 'bun:test'
import { BASE_TOOLS } from '../../src/lib/services/tools-service'
import {
  TOOL_RISK,
  classifyRisk,
  isKnownTool,
  isProtectedPath,
  PROTECTED_PATHS,
  type RiskClass,
} from '../../src/lib/arbiter/risk-table'
import {
  arbitrate,
  mintTicket,
  verifyTicket,
  resetTicketNonces,
  requiresTicket,
  BRIDGE_ACTUATORS,
  ARBITER_VERSION,
  type ArbitrateInput,
  type ArbitrateResult,
  type StandingOrderCard,
} from '../../src/lib/arbiter/arbiter'
import { appendAuditEvent, verifyAuditChain, GENESIS_HASH } from '../../src/lib/arbiter/audit'
import { markTainted, isTainted, clearTaint, taintSummary, serializeTaint } from '../../src/lib/arbiter/taint'
import { db } from '../../src/lib/db'

const TURN = 'arbiter-test'
const T_CAP = `${TURN}-cap`
const T_SHORT = `${TURN}-short`

/** Test-only cleanup that respects the APPEND-ONLY chain: delete THIS test's
 *  rows only while they form the tail (anything below the highest non-test
 *  row stays — deleting mid-chain rows would break every future
 *  verifyAuditChain). Phase 2-b: the dev server writes audit rows too, so
 *  interleaving is now possible and this guard is mandatory. */
async function tailSafeDeleteTestRows(): Promise<void> {
  const mine = [TURN, T_CAP, T_SHORT]
  const others = await db.auditEvent.findFirst({
    where: { NOT: { OR: [{ turnId: { in: mine } }, { turnId: null }] } },
    orderBy: { seq: 'desc' },
    select: { seq: true },
  })
  const below = others?.seq ?? 0
  await db.auditEvent.deleteMany({ where: { seq: { gt: below }, turnId: { in: mine } } })
}

beforeAll(async () => {
  resetTicketNonces()
  clearTaint(TURN)
  clearTaint(T_CAP)
  clearTaint(T_SHORT)
  // test-only cleanup — the audit module itself is append-only (no deletes)
  await tailSafeDeleteTestRows()
})

afterAll(async () => {
  clearTaint(TURN)
  clearTaint(T_CAP)
  clearTaint(T_SHORT)
  await tailSafeDeleteTestRows()
})

// ---------- helpers ----------

const RISKS: RiskClass[] = [
  'read',
  'sensitive-read',
  'write',
  'network',
  'exec',
  'destructive',
  'persist',
  'egress',
  'self-modify',
]

/** arbitrate with matrix defaults; `probe` is not a bridge actuator. */
function arb(o: Partial<ArbitrateInput> & Pick<ArbitrateInput, 'risk' | 'origin'>): ArbitrateResult {
  return arbitrate({
    tool: 'probe',
    canonicalArgs: {},
    tainted: false,
    scope: 'A2',
    ...o,
  })
}

function so(o: Partial<StandingOrderCard> = {}): StandingOrderCard {
  return {
    id: 'so-1',
    tools: ['write_file'],
    pathPrefixes: [],
    budget: {},
    expiryAt: null,
    usage: { calls: 0 },
    ...o,
  }
}

// ---------- risk table ----------

test('RISK · every BASE_TOOLS tool has a TOOL_RISK entry, no orphans, 116 total', () => {
  const names = BASE_TOOLS.map((t) => t.info.name)
  expect(names).toHaveLength(116)
  const missing = names.filter((n) => !(n in TOOL_RISK))
  expect(missing).toEqual([])
  const orphans = Object.keys(TOOL_RISK).filter((n) => !names.includes(n))
  expect(orphans).toEqual([])
})

const escalations: Array<[string, Record<string, unknown>, RiskClass]> = [
  ['owner_files', { op: 'delete', path: 'x' }, 'destructive'],
  ['owner_files', { op: 'read', path: 'x' }, 'sensitive-read'],
  ['owner_files', { op: 'write', path: 'x' }, 'write'],
  ['owner_files', { op: 'list' }, 'write'], // spec-literal: only read/delete are special — list lands conservative
  ['write_file', { path: 'src/lib/x.ts' }, 'self-modify'],
  ['write_file', { path: 'package.json' }, 'self-modify'],
  ['write_file', { path: '.env' }, 'self-modify'],
  ['write_file', { path: '.env.local' }, 'self-modify'],
  ['write_file', { path: 'prisma/schema.prisma' }, 'self-modify'],
  ['write_file', { path: 'db/notes/x.md' }, 'write'],
  ['read_file', { path: '.env' }, 'sensitive-read'],
  ['read_file', { path: 'db/provider-keys.json' }, 'sensitive-read'],
  ['read_file', { path: 'secrets/vault.txt' }, 'sensitive-read'],
  ['read_file', { path: 'config/api-key.json' }, 'sensitive-read'],
  ['read_file', { path: 'auth/token-store.json' }, 'sensitive-read'],
  ['read_file', { path: 'src/lib/x.ts' }, 'read'],
  ['hermes_memory', { action: 'read' }, 'sensitive-read'],
  ['hermes_memory', { action: 'append' }, 'persist'],
  ['hermes_cron', { action: 'add' }, 'persist'],
  ['hermes_cron', { action: 'run' }, 'exec'],
  ['cron_create', {}, 'persist'],
  ['save_skill', {}, 'persist'],
  ['skill_save', {}, 'persist'],
  ['write_persona', {}, 'persist'],
  ['mist_self_write', { path: 'db/persona/voice.md' }, 'persist'],
  ['mist_self_write', { path: 'src/lib/x.ts' }, 'self-modify'],
  ['ui_automate', { command: 'inspect' }, 'sensitive-read'],
  ['ui_automate', { command: 'find' }, 'sensitive-read'],
  ['ui_automate', { command: 'click' }, 'exec'],
  ['llm_pools', { action: 'pick' }, 'self-modify'],
  ['llm_pools', { action: 'list' }, 'network'],
  ['mist_deep_selfcheck', { repair: true }, 'self-modify'],
  ['mist_deep_selfcheck', { repair: false }, 'read'],
  ['mist_deep_selfcheck', {}, 'self-modify'], // repair defaults to true in the tool schema — it auto-applies
  ['mist_backlog', { action: 'remove' }, 'destructive'],
  ['mist_backlog', { action: 'list' }, 'persist'],
  ['memory_manage', { action: 'delete' }, 'destructive'],
  ['memory_manage', { action: 'add' }, 'persist'],
  ['user_profile_manage', { action: 'get' }, 'sensitive-read'],
  ['user_profile_manage', { action: 'set' }, 'persist'],
  ['obsidian_create_note', { overwrite: true }, 'destructive'],
  ['obsidian_create_note', {}, 'write'],
  ['browser_type', { submit: true }, 'egress'],
  ['browser_type', {}, 'network'],
  ['browser_click', { selector: '#submit-btn' }, 'egress'],
  ['browser_click', { selector: '#title' }, 'network'],
  ['cron_delete', {}, 'destructive'],
]

test('RISK · arg-aware escalations (register-faithful)', () => {
  for (const [tool, args, want] of escalations) {
    expect(classifyRisk(tool, args)).toBe(want)
  }
})

test('RISK · unknown tools default to the conservative middle (write), flagged unknown', () => {
  expect(classifyRisk('omni_future_thing', {})).toBe('write')
  expect(classifyRisk('skill:quick-math', {})).toBe('write')
  expect(isKnownTool('omni_future_thing')).toBe(false)
  expect(isKnownTool('skill:quick-math')).toBe(false)
  expect(isKnownTool('read_file')).toBe(true)
})

// ---------- A2 matrix ----------

test('A2 · owner_chat: read/sensitive-read/network allow, everything else asks', () => {
  for (const risk of RISKS) {
    const r = arb({ risk, origin: 'owner_chat' })
    expect(r.decision).toBe(risk === 'read' || risk === 'sensitive-read' || risk === 'network' ? 'allow' : 'ask')
  }
})

// ---------- one-time owner approval (Phase 2-b core addition) ----------

test('OA · write + ownerApproval at A2 → allow with reason owner-approved (the bell click is the confirmation)', () => {
  const r = arb({ risk: 'write', origin: 'owner_chat', ownerApprovalFingerprint: 'create_note:{"title":"t"}' })
  expect(r.decision).toBe('allow')
  expect(r.reason).toBe('owner-approved')
  // exec/destructive/persist side effects soften the same way, chat and voice
  for (const risk of ['exec', 'destructive', 'persist'] as RiskClass[]) {
    expect(arb({ risk, origin: 'owner_chat', ownerApprovalFingerprint: 'x' }).decision).toBe('allow')
    expect(arb({ risk, origin: 'owner_voice', ownerApprovalFingerprint: 'x' }).decision).toBe('allow')
  }
  // the A4 voice-exec confirm is softened too (the tap IS the on-screen confirm)
  expect(arb({ risk: 'exec', origin: 'owner_voice', scope: 'A4', ownerApprovalFingerprint: 'x' }).reason).toBe('owner-approved')
})

test('OA · tainted + ownerApproval → still ask (taint floor fires before any scope can soften)', () => {
  const r = arb({ risk: 'write', origin: 'owner_chat', tainted: true, ownerApprovalFingerprint: 'x' })
  expect(r.decision).toBe('ask')
  expect(r.reason).toBe('tainted content — fresh one-time approval required')
})

test('OA · protected path + ownerApproval → still deny (floor 1 is not softened by a card approval)', () => {
  const r = arb({
    tool: 'write_file',
    canonicalArgs: { path: 'src/lib/arbiter/arbiter.ts' },
    risk: 'self-modify',
    origin: 'owner_chat',
    ownerApprovalFingerprint: 'x',
  })
  expect(r.decision).toBe('deny')
  expect(r.reason).toContain('protected-path')
})

test('OA · untrusted origin + ownerApproval → still ask/deny (floor 2 is not softened either)', () => {
  expect(arb({ risk: 'exec', origin: 'web', ownerApprovalFingerprint: 'x' }).decision).toBe('deny')
  expect(arb({ risk: 'exec', origin: 'skill', ownerApprovalFingerprint: 'x' }).decision).toBe('ask')
  expect(arb({ risk: 'exec', origin: 'skill', ownerApprovalFingerprint: 'x' }).reason).not.toBe('owner-approved')
})

test('OA · unattended defer is NOT softened (a card approval cannot un-attend a cron turn)', () => {
  const r = arb({ risk: 'write', origin: 'owner_cron', ownerApprovalFingerprint: 'x' })
  expect(r.decision).toBe('defer')
})

test('A2 · owner_voice: reads + network allow, side effects ask with the S14 voice-exec reason', () => {
  for (const risk of RISKS) {
    const r = arb({ risk, origin: 'owner_voice' })
    if (risk === 'read' || risk === 'sensitive-read' || risk === 'network') {
      expect(r.decision).toBe('allow')
    } else {
      expect(r.decision).toBe('ask')
      expect(r.reason).toContain('voice-exec')
    }
  }
})

test('A2 · owner_cron + owner_heartbeat (unattended): reads allow, side effects defer', () => {
  for (const risk of RISKS) {
    for (const origin of ['owner_cron', 'owner_heartbeat'] as const) {
      const r = arb({ risk, origin })
      if (risk === 'read' || risk === 'sensitive-read' || risk === 'network') {
        expect(r.decision).toBe('allow')
      } else {
        expect(r.decision).toBe('defer')
        expect(r.reason).toContain('unattended')
      }
    }
  }
})

// ---------- A0 / A1 / A4 scopes ----------

test('A0/A1 · observe-only: reads allow, actuators ask (attended) or defer (unattended)', () => {
  for (const scope of ['A0', 'A1'] as const) {
    for (const risk of RISKS) {
      const attended = arb({ risk, origin: 'owner_chat', scope })
      const unattended = arb({ risk, origin: 'owner_cron', scope })
      if (risk === 'read' || risk === 'sensitive-read') {
        expect(attended.decision).toBe('allow')
        expect(unattended.decision).toBe('allow')
      } else {
        expect(attended.decision).toBe('ask')
        expect(attended.reason).toContain('observe-only')
        expect(unattended.decision).toBe('defer')
      }
    }
  }
})

test('A4 · chat allows everything untainted + non-protected; voice-exec still asks unless waived', () => {
  for (const risk of RISKS) {
    expect(arb({ risk, origin: 'owner_chat', scope: 'A4' }).decision).toBe('allow')
  }
  const voiceAsk = arb({ risk: 'write', origin: 'owner_voice', scope: 'A4' })
  expect(voiceAsk.decision).toBe('ask')
  expect(voiceAsk.reason).toContain('voice-exec')
  expect(arb({ risk: 'write', origin: 'owner_voice', scope: 'A4', voiceWaived: true }).decision).toBe('allow')
  expect(arb({ risk: 'read', origin: 'owner_voice', scope: 'A4' }).decision).toBe('allow')
  // unattended origins never ride the A4 dial — they fall back to A2 (defer)
  expect(arb({ risk: 'write', origin: 'owner_cron', scope: 'A4' }).decision).toBe('defer')
  // budget exhausted → out of scope → A2 fallback
  expect(arb({ risk: 'write', origin: 'owner_chat', scope: 'A4', budget: { callsRemaining: 0 } }).decision).toBe('ask')
  expect(arb({ risk: 'write', origin: 'owner_chat', scope: 'A4', budget: { callsRemaining: 3 } }).decision).toBe('allow')
})

// ---------- floors ----------

test('FLOOR 1 · protected paths deny writes at every scope — even A4 with a wildcard standing order', () => {
  const a4 = { origin: 'owner_chat' as const, scope: 'A4' as const, standingOrders: [so({ tools: ['*'] })] }
  for (const p of [
    'src/lib/arbiter/arbiter.ts',
    'src/lib/arbiter/deep/nested/x.ts',
    'src/proxy.ts',
    'src/app/api/mist/approvals/route.ts',
    'src/lib/audit/chain.ts',
    'db/bridge/mist-bridge.js',
    'scripts/secret-scan.ts',
    'hooks/pre-commit',
    '.env',
    '.env.local',
    'prisma/schema.prisma',
    'db/persona/SOUL.md',
    'src/lib/services/context-builder.ts',
    'src/lib/services/evolution-service.ts',
  ]) {
    const r = arbitrate({
      tool: 'write_file',
      canonicalArgs: { path: p },
      risk: 'self-modify',
      tainted: false,
      filePath: p,
      ...a4,
    })
    expect(r.decision).toBe('deny')
    expect(r.reason).toContain('protected-path')
  }
  // reads of protected paths stay open
  expect(
    arb({ tool: 'read_file', risk: 'sensitive-read', canonicalArgs: { path: '.env' }, filePath: '.env' }).decision
  ).toBe('allow')
  // exec targeting a protected file denies too
  expect(arb({ risk: 'exec', origin: 'owner_chat', scope: 'A4', filePath: 'src/proxy.ts' }).decision).toBe('deny')
  // a non-protected write follows the matrix instead of the floor
  expect(
    arb({ risk: 'write', origin: 'owner_chat', canonicalArgs: { path: 'db/notes/x.md' }, filePath: 'db/notes/x.md' })
      .decision
  ).toBe('ask')
})

test('FLOOR 1 · isProtectedPath normalization (absolute, case-insensitive, subpaths, backslashes)', () => {
  expect(isProtectedPath('/home/z/my-project/src/proxy.ts')).toBe(true)
  expect(isProtectedPath('SRC/LIB/ARBITER/evil.ts')).toBe(true)
  expect(isProtectedPath('./prisma/schema.prisma')).toBe(true)
  expect(isProtectedPath('src\\lib\\arbiter\\x.ts')).toBe(true)
  expect(isProtectedPath('notes/x.md')).toBe(false)
  expect(isProtectedPath('src/lib/services/llm-service.ts')).toBe(false) // not in the frozen list
  expect(PROTECTED_PATHS.length).toBeGreaterThanOrEqual(12)
})

test('FLOOR 2 · web/mcp may only read; tool_output/skill/memory ask beyond read', () => {
  expect(arb({ risk: 'read', origin: 'web' }).decision).toBe('allow')
  expect(arb({ risk: 'read', origin: 'mcp' }).decision).toBe('allow')
  for (const risk of ['sensitive-read', 'write', 'network', 'exec'] as const) {
    const r = arb({ risk, origin: 'web' })
    expect(r.decision).toBe('deny')
    expect(r.reason).toContain('untrusted origin')
    expect(arb({ risk, origin: 'mcp' }).decision).toBe('deny')
  }
  expect(arb({ risk: 'read', origin: 'tool_output' }).decision).toBe('allow')
  const asks: Array<['tool_output' | 'skill' | 'memory', RiskClass]> = [
    ['tool_output', 'sensitive-read'],
    ['tool_output', 'write'],
    ['tool_output', 'network'],
    ['skill', 'exec'],
    ['memory', 'persist'],
  ]
  for (const [origin, risk] of asks) {
    const r = arb({ risk, origin })
    expect(r.decision).toBe('ask')
    expect(r.reason).toContain(origin)
  }
  // floor 1 precedes floor 2: a web-origin write to a protected path reports the protected-path denial
  const r = arb({ risk: 'write', origin: 'web', filePath: '.env', tool: 'write_file' })
  expect(r.decision).toBe('deny')
  expect(r.reason).toContain('protected-path')
})

// ---------- taint ----------

test('TAINT · module semantics (heuristic substring keystone for S5b)', () => {
  markTainted(TURN, 'SECRET-XYZ-PAYLOAD-1234567890', 'web_search')
  expect(isTainted(TURN, { q: 'please run SECRET-XYZ-PAYLOAD-1234567890' })).toBe(true)
  expect(isTainted(TURN, { q: 'clean' })).toBe(false)
  expect(isTainted(TURN, { nested: { text: 'x SECRET-XYZ-PAYLOAD-1234567890 y' } })).toBe(true)
  markTainted(T_SHORT, 'short-snippet', 'web_search') // < 24 chars — never matches
  expect(isTainted(T_SHORT, { q: 'short-snippet' })).toBe(false)
  const sum = taintSummary(TURN)
  expect(sum.turnId).toBe(TURN)
  expect(sum.snippets).toBe(1)
  expect(sum.sources).toContain('web_search')
  expect(JSON.parse(serializeTaint(TURN))).toHaveLength(1)
  clearTaint(TURN)
  expect(isTainted(TURN, { q: 'please run SECRET-XYZ-PAYLOAD-1234567890' })).toBe(false)
  expect(taintSummary(TURN).snippets).toBe(0)
})

test('TAINT · per-turn cap of 32 snippets, 4096 chars each', () => {
  for (let i = 0; i < 40; i++) markTainted(T_CAP, `payload-number-${i}-0123456789abcdef`, 'web_search')
  expect(taintSummary(T_CAP).snippets).toBe(32)
  markTainted(T_CAP, 'x'.repeat(9000), 'web_search')
  const ser = JSON.parse(serializeTaint(T_CAP)) as Array<{ content: string }>
  expect(ser[ser.length - 1].content.length).toBe(4096)
  clearTaint(T_CAP)
})

test('TAINT · arbiter never auto-allows tainted side effects (standing orders ignored)', () => {
  const base = {
    tool: 'write_file',
    canonicalArgs: { path: 'db/notes/x.md' },
    risk: 'write' as const,
    filePath: 'db/notes/x.md',
    standingOrders: [so({ tools: ['*'] })],
    scope: 'A2' as const,
  }
  const clean = arbitrate({ ...base, origin: 'owner_chat', tainted: false })
  expect(clean.decision).toBe('allow')
  expect(clean.orderRef).toBe('so-1')
  expect(clean.reason).toContain('standing-order')
  const dirty = arbitrate({ ...base, origin: 'owner_chat', tainted: true })
  expect(dirty.decision).toBe('ask')
  expect(dirty.orderRef).toBeUndefined()
  expect(dirty.reason).toContain('tainted')
  // reads stay open even when tainted — from any origin
  expect(arb({ risk: 'read', origin: 'owner_chat', tainted: true }).decision).toBe('allow')
  expect(arb({ risk: 'read', origin: 'web', tainted: true }).decision).toBe('allow')
  // unattended + tainted → ask (fresh approval), not a silent defer
  expect(arb({ risk: 'write', origin: 'owner_cron', tainted: true }).decision).toBe('ask')
  // A4 + tainted → ask
  expect(arb({ risk: 'write', origin: 'owner_chat', tainted: true, scope: 'A4' }).decision).toBe('ask')
})

// ---------- standing orders ----------

test('SO · A3 honors an active matching order; every mismatch falls back to the A2 matrix', () => {
  const now = Date.now()
  const write = { tool: 'write_file', canonicalArgs: { path: 'db/notes/x.md' }, risk: 'write' as const, filePath: 'db/notes/x.md' }
  // honored: exact tool, wildcard, prefix match
  const ok = arbitrate({ ...write, origin: 'owner_cron', tainted: false, scope: 'A3', standingOrders: [so()] })
  expect(ok.decision).toBe('allow')
  expect(ok.orderRef).toBe('so-1')
  expect(ok.reason).toContain('standing-order: so-1')
  expect(
    arbitrate({ ...write, origin: 'owner_cron', tainted: false, scope: 'A3', standingOrders: [so({ tools: ['*'] })] })
      .decision
  ).toBe('allow')
  expect(
    arbitrate({
      ...write,
      origin: 'owner_cron',
      tainted: false,
      scope: 'A3',
      standingOrders: [so({ pathPrefixes: ['db/notes/'] })],
    }).decision
  ).toBe('allow')
  // not honored: expired (boundary pinned — now >= expiryAt is expired)…
  expect(
    arbitrate({
      ...write,
      origin: 'owner_cron',
      tainted: false,
      scope: 'A3',
      now,
      standingOrders: [so({ expiryAt: now })],
    }).decision
  ).toBe('defer')
  expect(
    arbitrate({
      ...write,
      origin: 'owner_cron',
      tainted: false,
      scope: 'A3',
      now,
      standingOrders: [so({ expiryAt: now - 1 })],
    }).decision
  ).toBe('defer')
  // …tool mismatch, pathPrefix mismatch (and no filePath at all), budget exhausted
  expect(
    arbitrate({ ...write, origin: 'owner_cron', tainted: false, scope: 'A3', standingOrders: [so({ tools: ['read_file'] })] })
      .decision
  ).toBe('defer')
  expect(
    arbitrate({
      ...write,
      origin: 'owner_cron',
      tainted: false,
      scope: 'A3',
      standingOrders: [so({ pathPrefixes: ['db/skills/'] })],
    }).decision
  ).toBe('defer')
  expect(
    arbitrate({
      ...write,
      origin: 'owner_cron',
      tainted: false,
      scope: 'A3',
      standingOrders: [so({ pathPrefixes: ['db/notes/'] })],
      filePath: null,
      canonicalArgs: {},
    }).decision
  ).toBe('defer')
  expect(
    arbitrate({
      ...write,
      origin: 'owner_cron',
      tainted: false,
      scope: 'A3',
      standingOrders: [so({ budget: { maxCalls: 3 }, usage: { calls: 3 } })],
    }).decision
  ).toBe('defer')
  // no orders at all → A2 matrix for that origin (chat asks, cron defers)
  expect(arbitrate({ ...write, origin: 'owner_chat', tainted: false, scope: 'A3', standingOrders: [] }).decision).toBe(
    'ask'
  )
  expect(arbitrate({ ...write, origin: 'owner_cron', tainted: false, scope: 'A3' }).decision).toBe('defer')
})

test('SO · orders also authorize A2 asks (owner pre-consent beats channel confirmation); A0 stays observe-only', () => {
  const write = { tool: 'write_file', canonicalArgs: { path: 'db/notes/x.md' }, risk: 'write' as const }
  const chat = arbitrate({ ...write, origin: 'owner_chat', tainted: false, scope: 'A2', standingOrders: [so()] })
  expect(chat.decision).toBe('allow')
  expect(chat.orderRef).toBe('so-1')
  const cron = arbitrate({ ...write, origin: 'owner_cron', tainted: false, scope: 'A2', standingOrders: [so()] })
  expect(cron.decision).toBe('allow')
  expect(cron.orderRef).toBe('so-1')
  const voice = arbitrate({ ...write, origin: 'owner_voice', tainted: false, scope: 'A2', standingOrders: [so()] })
  expect(voice.decision).toBe('allow')
  const a0 = arbitrate({ ...write, origin: 'owner_chat', tainted: false, scope: 'A0', standingOrders: [so()] })
  expect(a0.decision).toBe('ask')
  expect(a0.reason).toContain('observe-only')
})

// ---------- confirmed flag is structurally ignored ----------

test('CONFIRMED · a client-asserted confirmed flag cannot change a decision', () => {
  const base: ArbitrateInput = {
    tool: 'write_file',
    canonicalArgs: {},
    risk: 'write',
    origin: 'owner_chat',
    tainted: false,
    scope: 'A2',
  }
  const withConfirmed = { ...base, confirmed: true } as ArbitrateInput // extra field — ignored
  expect(arbitrate(withConfirmed)).toEqual(arbitrate(base))
  expect(arbitrate(withConfirmed).decision).toBe('ask')
})

// ---------- tickets ----------

test('TICKET · mint/verify round-trip, format, single-use, expiry, tamper, wrong key', () => {
  const key = 'arbiter-ticket-key-0123456789' // test fixture, lowercase on purpose (secret-scan friendly)
  const now = 1_000_000
  const argsHash = 'a'.repeat(16)
  const t = mintTicket({ action: 'run_command', argsHash, key, now })
  expect(t).toMatch(/^v1\.1060000\.[a-f0-9]{12}\.[a-f0-9]{64}$/)
  const ok = verifyTicket({ ticket: t, action: 'run_command', argsHash, key, now: now + 1000, consume: true })
  expect(ok.ok).toBe(true)
  // single-use: consuming twice fails, and a spent ticket never verifies again
  const second = verifyTicket({ ticket: t, action: 'run_command', argsHash, key, now: now + 1000, consume: true })
  expect(second.ok).toBe(false)
  expect(second.reason).toContain('single-use')
  expect(verifyTicket({ ticket: t, action: 'run_command', argsHash, key, now: now + 1000 }).ok).toBe(false)
  // expiry boundary: now == expMs still valid, now > expMs expired
  const t2 = mintTicket({ action: 'run_command', argsHash, key, now })
  expect(verifyTicket({ ticket: t2, action: 'run_command', argsHash, key, now: now + 60_000 }).ok).toBe(true)
  const t3 = mintTicket({ action: 'run_command', argsHash, key, now })
  const expired = verifyTicket({ ticket: t3, action: 'run_command', argsHash, key, now: now + 60_001 })
  expect(expired.ok).toBe(false)
  expect(expired.reason).toContain('expired')
  // tampered action / wrong key / malformed
  const t4 = mintTicket({ action: 'run_command', argsHash, key, now })
  expect(verifyTicket({ ticket: t4, action: 'write_file', argsHash, key, now }).ok).toBe(false)
  const t5 = mintTicket({ action: 'run_command', argsHash, key, now })
  expect(verifyTicket({ ticket: t5, action: 'run_command', argsHash, key: 'wrong-key-9876543210abcdef', now }).ok).toBe(
    false
  )
  expect(verifyTicket({ ticket: 'garbage', action: 'run_command', argsHash, key, now }).ok).toBe(false)
  expect(verifyTicket({ ticket: 'v9.1.2.3', action: 'run_command', argsHash, key, now }).ok).toBe(false)
})

test('TICKET · actuator set + requiresTicket wiring hints', () => {
  expect(ARBITER_VERSION).toBe('2.0.0')
  expect(BRIDGE_ACTUATORS.size).toBe(12)
  expect(BRIDGE_ACTUATORS.has('run_command')).toBe(true)
  expect(BRIDGE_ACTUATORS.has('owner_files')).toBe(true)
  expect(BRIDGE_ACTUATORS.has('open_url')).toBe(false) // reads through the owner's own browser, not a machine actuator
  expect(requiresTicket('run_command', 'exec')).toBe(true)
  expect(requiresTicket('owner_files', 'destructive')).toBe(true)
  expect(requiresTicket('owner_files', 'sensitive-read')).toBe(false)
  expect(requiresTicket('read_file', 'read')).toBe(false)
  expect(requiresTicket('write_file', 'network')).toBe(false) // not an actuator risk pairing that exists
})

// ---------- audit chain ----------

test('AUDIT · append-only hash chain: seq contiguity, chaining, concurrency, tamper detection', async () => {
  // Phase 2-b: the suite no longer owns the table — the dev server writes
  // audit rows (every arbitrated tool call) — so seqs are asserted RELATIVE
  // to the head at test start, and the tamper is RESTORED afterwards (a
  // permanent tamper would poison every future verifyAuditChain).
  const head = await db.auditEvent.findFirst({ orderBy: { seq: 'desc' } })
  const base = head?.seq ?? 0
  const rows = []
  for (const tool of ['alpha', 'beta', 'gamma']) {
    rows.push(
      await appendAuditEvent({
        tool,
        risk: 'read',
        origin: 'owner_chat',
        decision: 'allow',
        reason: 'matrix allow',
        turnId: TURN,
      })
    )
  }
  expect(rows.map((r) => r.seq)).toEqual([base + 1, base + 2, base + 3])
  expect(rows[0].prevHash).toBe(head ? head.hash : GENESIS_HASH)
  expect(rows[1].prevHash).toBe(rows[0].hash)
  expect(rows[2].prevHash).toBe(rows[1].hash)
  let v = await verifyAuditChain()
  expect(v.ok).toBe(true)
  // concurrent appends serialize through the in-process queue — no seq collisions
  const many = await Promise.all(
    ['c1', 'c2', 'c3', 'c4', 'c5'].map((tool) =>
      appendAuditEvent({ tool, risk: 'read', origin: 'owner_chat', decision: 'allow', turnId: TURN })
    )
  )
  const seqs = many.map((r) => r.seq).sort((a, b) => a - b)
  expect(new Set(seqs).size).toBe(5)
  expect(seqs[0]).toBeGreaterThanOrEqual(base + 4)
  expect(seqs[4]).toBeGreaterThanOrEqual(base + 8)
  v = await verifyAuditChain()
  expect(v.ok).toBe(true)
  // tampering the middle row breaks the chain at exactly that seq
  const tamperedAt = rows[1].seq
  const originalReason = rows[1].reason
  await db.auditEvent.update({ where: { seq: tamperedAt }, data: { reason: 'TAMPERED' } })
  v = await verifyAuditChain()
  expect(v.ok).toBe(false)
  expect(v.brokenAt).toBe(tamperedAt)
  expect(typeof v.reason).toBe('string')
  // restore — the chain must verify again (this test leaves no permanent damage)
  await db.auditEvent.update({ where: { seq: tamperedAt }, data: { reason: originalReason } })
  v = await verifyAuditChain()
  expect(v.ok).toBe(true)
})
