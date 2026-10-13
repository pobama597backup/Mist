// M.I.S.T. Arbiter · the decision core (Phase 2-a, Sovereign Hardening).
//
// A PURE function: origins, scopes, floors, taint and standing orders in;
// one of allow | ask | deny | defer out. It never reads files, never touches
// the db, never holds the bridge token — the wiring (Phase 2-b) supplies
// everything and mints the ticket for allowed bridge actuators via the
// exported mintTicket/verifyTicket helpers (which take the key explicitly).
// result.ticket / result.auditId are wiring-fillable: the core returns
// decision + reason (+ orderRef when a standing order authorized the call).
//
// Decision order (pinned by tests/security/arbiter.test.ts):
//   FLOOR 1  protected path writes → deny (every origin, every scope,
//            even A4, even under a standing order)
//   FLOOR 2  untrusted origins (web/mcp read-only; tool_output/skill/memory
//            ask for anything beyond read)
//   TAINT    tainted content beyond read → ask — standing orders and
//            remembered consent are IGNORED entirely
//   SCOPES   A0/A1 observe → A2 ask matrix → A3 standing orders → A4
//            unleashed (chat/voice only, budget-guarded)

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { isProtectedPath, normalizeProjectPath, type RiskClass } from './risk-table'

export const ARBITER_VERSION = '2.0.0'

export type Origin =
  | 'owner_chat'
  | 'owner_voice'
  | 'owner_cron'
  | 'owner_heartbeat'
  | 'tool_output'
  | 'web'
  | 'skill'
  | 'memory'
  | 'mcp'

export type Decision = 'allow' | 'ask' | 'deny' | 'defer'

export type Scope = 'A0' | 'A1' | 'A2' | 'A3' | 'A4'

export interface StandingOrderCard {
  id: string
  tools: string[] // exact names, or ['*']
  pathPrefixes: string[] // when non-empty, the call's file path must fall under one
  budget: { maxCalls?: number; windowMs?: number; spendCapUsd?: number }
  expiryAt?: number | null // epoch ms; now >= expiryAt means expired
  usage?: { calls: number } // pre-loaded, already windowed by the wiring
}

export interface ArbitrateInput {
  tool: string
  canonicalArgs: Record<string, unknown>
  risk: RiskClass
  origin: Origin
  tainted: boolean
  scope: Scope
  /** informational label for the autonomy dial the wiring read (A4 hint) */
  dial?: string
  standingOrders?: StandingOrderCard[]
  budget?: { callsRemaining?: number } // A4 scope budget; exhausted → A2 fallback
  now?: number
  /** convenience: pre-extracted file-ish arg path for prefix matching */
  filePath?: string | null
  /** A4 may waive the voice-exec confirmation for chosen scopes */
  voiceWaived?: boolean
  /** Phase 2-b ONE-TIME OWNER APPROVAL: the fingerprint of an Approval row
   *  the owner just clicked approve on. Softens ONLY the ask-matrix asks
   *  (A2/A3 asks + the A4 voice-exec confirm) into allow 'owner-approved' —
   *  floors 1+2, taint, and the A0/A1 observe-only asks are NOT softened:
   *  a card approval cannot write a protected path, trust an untrusted
   *  origin, launder tainted content, or raise the autonomy scope. */
  ownerApprovalFingerprint?: string
}

export interface ArbitrateResult {
  decision: Decision
  reason: string
  ticket?: string
  auditId?: string
  orderRef?: string
  /** Phase 7 · the chain-max risk the matrix actually ran with for a
   *  `skill:<name>` call — present only when the resolver seam below
   *  resolved the skill's chain (absent = the caller's input risk stood,
   *  which for skill:* is classifyRisk's flat 'write' unknown default). */
  effectiveRisk?: RiskClass
}

/** The bridge actions that mutate the owner's machine — an ALLOWED call on
 *  one of these must carry a freshly minted one-time ticket (wiring mints). */
export const BRIDGE_ACTUATORS = new Set<string>([
  'run_command',
  'write_file',
  'move_file',
  'copy_file',
  'delete_file',
  'make_dir',
  'zip_files',
  'unzip_files',
  'ui_automate',
  'hermes_ask',
  'open_app',
  'owner_files',
])

const SIDE_EFFECT_RISKS: ReadonlySet<RiskClass> = new Set([
  'write',
  'exec',
  'destructive',
  'persist',
  'egress',
  'self-modify',
])

/** True when an ALLOWED decision on this tool/risk must be ticketed before it
 *  reaches the bridge (mirrors the bridge's own gated-action set). */
export function requiresTicket(tool: string, risk: RiskClass): boolean {
  return BRIDGE_ACTUATORS.has(tool) && SIDE_EFFECT_RISKS.has(risk)
}

const PATH_ARG_KEYS = ['path', 'file', 'filepath', 'to', 'dest', 'target', 'note_path', 'notePath', 'from'] as const

function targetPaths(input: ArbitrateInput): string[] {
  const out: string[] = []
  if (typeof input.filePath === 'string' && input.filePath.length > 0) out.push(input.filePath)
  const args = input.canonicalArgs ?? {}
  for (const key of PATH_ARG_KEYS) {
    const v = args[key]
    if (typeof v === 'string' && v.length > 0) out.push(v)
  }
  return out
}

function isUnattended(origin: Origin): boolean {
  return origin === 'owner_cron' || origin === 'owner_heartbeat'
}

function orderMatches(order: StandingOrderCard, input: ArbitrateInput, now: number): boolean {
  if (typeof order.expiryAt === 'number' && now >= order.expiryAt) return false
  const tools = order.tools ?? []
  if (!tools.includes(input.tool) && !tools.includes('*')) return false
  const prefixes = order.pathPrefixes ?? []
  if (prefixes.length > 0) {
    const fp = typeof input.filePath === 'string' && input.filePath.length > 0 ? input.filePath : null
    if (!fp) return false
    const rel = normalizeProjectPath(fp)
    if (!prefixes.some((p) => rel.startsWith(normalizeProjectPath(p)))) return false
  }
  // windowMs/spendCapUsd are enforced by the wiring when it loads usage
  // (usage.calls arrives pre-windowed); the arbiter checks the call cap only.
  const maxCalls = order.budget?.maxCalls
  if (typeof maxCalls === 'number' && (order.usage?.calls ?? 0) >= maxCalls) return false
  return true
}

const VOICE_EXEC_REASON = 'voice-exec — confirm on screen (tap) or spoken confirm phrase'
const UNATTENDED_REASON = 'unattended — queued for owner approval'

/** A one-time owner approval (an Approval row the owner just decided) turns
 *  an ask into an allow. Everything else — deny, defer, allow — passes through
 *  untouched: deferrals stay queued (unattended origins re-ask through their
 *  own channel) and denials stay denials. */
function softenAskWithOwnerApproval(r: ArbitrateResult, fingerprint: string | undefined): ArbitrateResult {
  if (fingerprint && r.decision === 'ask') return { decision: 'allow', reason: 'owner-approved' }
  return r
}

/** The A2 ask-matrix — also the fallback for A3 (no matching order) and A4
 *  (out of scope). Voice gets the S14 confirm path; unattended origins defer. */
function a2Decision(risk: RiskClass, origin: Origin): ArbitrateResult {
  if (risk === 'read' || risk === 'sensitive-read' || risk === 'network') {
    return { decision: 'allow', reason: 'matrix allow (read-class/network)' }
  }
  if (origin === 'owner_chat') return { decision: 'ask', reason: 'A2 ask-by-default — owner confirmation required' }
  if (origin === 'owner_voice') return { decision: 'ask', reason: VOICE_EXEC_REASON }
  return { decision: 'defer', reason: UNATTENDED_REASON }
}

// ---------- Phase 7 · skill chain-max seam (skills deep audit) ----------
//
// The mandate's Phase 7 row (docs/phase-0/tool-risk-table.md):
//     "19x `skill:<name>` | chain-max | chain | effective risk = max of
//      chained tools"
// A `skill:<name>` call is a CHAIN; its effective risk is the MAX over the
// chained tools (chain-risk.ts — nested skill: entries resolve recursively,
// depth-capped, cycle-safe; dead/unknown names count as the register's own
// conservative unknown default 'write'). The DB-backed resolver lives in the
// WIRING (wiring.ts effectiveSkillRisk — 30s cache, pre-warmed on the
// chokepoint's standing-order load); this core stays file/db-free and merely
// consults the installed seam. When the seam cannot resolve (unknown skill,
// cold cache) the caller's risk stands. chain-max changes the RISK INPUT
// only — the verdict still flows through the normal origin-risk-taint-scope
// matrix below, unchanged.

export interface SkillRiskResolution {
  risk: RiskClass
  dead: string[]
  nested: string[]
}

export type SkillRiskResolver = (skillName: string) => SkillRiskResolution | null

let skillRiskResolver: SkillRiskResolver | null = null

/** Install (or clear, with null) the Phase 7 skill chain resolver. The
 *  wiring registers effectiveSkillRisk at module load; tests may swap it. */
export function registerSkillRiskResolver(fn: SkillRiskResolver | null): void {
  skillRiskResolver = fn
}

/** THE decision core — the pre-Phase-7 arbitrate() body, verbatim (floors,
 *  taint, scopes, standing orders). Private; arbitrate() below wraps it with
 *  the Phase 7 chain-max risk resolution for `skill:` tools. */
function arbitrateCore(input: ArbitrateInput): ArbitrateResult {
  const now = input.now ?? Date.now()
  const risk = input.risk
  const origin = input.origin

  // FLOOR 1 — protected paths deny writes at every scope, before anything
  // else can soften them. Reads of protected paths stay open.
  const paths = targetPaths(input)
  const floorApplies =
    risk === 'write' ||
    risk === 'self-modify' ||
    risk === 'persist' ||
    risk === 'destructive' ||
    (risk === 'exec' && paths.length > 0)
  if (floorApplies && paths.some((p) => isProtectedPath(p))) {
    return { decision: 'deny', reason: 'protected-path — propose via evolution; only the owner UI applies' }
  }

  // FLOOR 2 — untrusted origins.
  if (origin === 'web' || origin === 'mcp') {
    if (risk === 'read') return { decision: 'allow', reason: 'untrusted origin: read only' }
    return { decision: 'deny', reason: 'untrusted origin (web/mcp) may only read' }
  }
  if (origin === 'tool_output' || origin === 'skill' || origin === 'memory') {
    if (risk === 'read') return { decision: 'allow', reason: 'untrusted origin: read only' }
    // wiring converts ask → defer when unattended; the ask itself stays honest
    return { decision: 'ask', reason: `untrusted origin (${origin}) — owner approval required` }
  }

  // TAINT — never auto-allow anything beyond read while tainted; standing
  // orders and permission memory are deliberately unreachable here.
  if (input.tainted && risk !== 'read') {
    return { decision: 'ask', reason: 'tainted content — fresh one-time approval required' }
  }

  // SCOPES (owner origins only beyond this point)
  if (input.scope === 'A0' || input.scope === 'A1') {
    if (risk === 'read' || risk === 'sensitive-read') {
      return { decision: 'allow', reason: 'observe allow (read-class)' }
    }
    if (isUnattended(origin)) return { decision: 'defer', reason: UNATTENDED_REASON }
    return { decision: 'ask', reason: `${input.scope} observe-only — raise the autonomy scope to act` }
  }

  if (input.scope === 'A2' || input.scope === 'A3') {
    // An active standing order is the owner's explicit pre-consent — it
    // beats channel confirmation (voice) and unattended deferral alike.
    const order = (input.standingOrders ?? []).find((o) => orderMatches(o, input, now))
    if (order) return { decision: 'allow', reason: `standing-order: ${order.id}`, orderRef: order.id }
    return softenAskWithOwnerApproval(a2Decision(risk, origin), input.ownerApprovalFingerprint)
  }

  // A4 — unleashed: chat/voice only, inside the dial's budget. Unattended
  // origins and exhausted budgets fall back to A2. The dial's own expiry is
  // enforced by the wiring (it stops passing scope A4 when the dial ends).
  const inA4Scope =
    (origin === 'owner_chat' || origin === 'owner_voice') &&
    !(typeof input.budget?.callsRemaining === 'number' && input.budget.callsRemaining <= 0)
  if (!inA4Scope) return softenAskWithOwnerApproval(a2Decision(risk, origin), input.ownerApprovalFingerprint)
  if (
    origin === 'owner_voice' &&
    !input.voiceWaived &&
    (risk === 'write' || risk === 'exec' || risk === 'destructive' || risk === 'persist' || risk === 'egress')
  ) {
    // the bell/tap approval IS an on-screen confirmation — soften this one
    // too, or a voice-side ask would ping-pong approvals forever
    return softenAskWithOwnerApproval({ decision: 'ask', reason: VOICE_EXEC_REASON }, input.ownerApprovalFingerprint)
  }
  return { decision: 'allow', reason: 'A4 unleashed — inside the owner-granted scope' }
}

export function arbitrate(input: ArbitrateInput): ArbitrateResult {
  // PHASE 7 · chain-max effective risk for `skill:<name>` calls. The seam is
  // sync (the wiring pre-warms its DB cache before the chokepoint calls
  // here); an unresolved skill keeps the caller's risk — for skill:* names
  // that is classifyRisk's flat 'write' unknown default (risk-table header:
  // the conservative middle). The matrix below then runs UNCHANGED on the
  // effective risk — chain-max is the risk INPUT, never a matrix bypass.
  let chainNote = ''
  let effectiveRisk: RiskClass | undefined
  if (skillRiskResolver !== null && input.tool.startsWith('skill:')) {
    const resolved = skillRiskResolver(input.tool.slice('skill:'.length))
    if (resolved) {
      effectiveRisk = resolved.risk
      if (resolved.dead.length > 0) {
        // honest audit trail: the chain names tools that no longer exist
        chainNote = `; chain contains dead tools: ${resolved.dead.join(', ')}`
      }
    }
  }
  const core = arbitrateCore(effectiveRisk === undefined ? input : { ...input, risk: effectiveRisk })
  const withNote = chainNote ? { ...core, reason: `${core.reason}${chainNote}` } : core
  return effectiveRisk === undefined ? withNote : { ...withNote, effectiveRisk }
}

// ---------- one-time bridge tickets ----------
//
// `v1.<expMs>.<nonce>.<hmac>` — hmac = HMAC-SHA256(key, action|argsHash|
// nonce|expMs). Single-use via a consumed-nonce registry (pruned as expired
// entries accumulate). Pure helpers: the key is always passed in — the
// arbiter core never reads it from disk itself.

const TICKET_TTL_MS = 60_000
const NONCE_PRUNE_AT = 512
const consumedNonces = new Map<string, number>() // nonce → expMs

function ticketHmac(action: string, argsHash: string, nonce: string, expMs: number, key: string): string {
  return createHmac('sha256', key).update(`${action}|${argsHash}|${nonce}|${expMs}`).digest('hex')
}

export function mintTicket(o: { action: string; argsHash: string; key: string; now?: number }): string {
  const now = o.now ?? Date.now()
  const expMs = now + TICKET_TTL_MS
  const nonce = randomBytes(6).toString('hex') // 12 hex chars
  return `v1.${expMs}.${nonce}.${ticketHmac(o.action, o.argsHash, nonce, expMs, o.key)}`
}

export interface TicketCheck {
  ok: boolean
  reason?: string
}

export function verifyTicket(o: {
  ticket: string
  action: string
  argsHash: string
  key: string
  now?: number
  consume?: boolean
}): TicketCheck {
  const now = o.now ?? Date.now()
  const parts = o.ticket.split('.')
  if (parts.length !== 4) return { ok: false, reason: 'malformed ticket' }
  const [version, expRaw, nonce, mac] = parts
  if (version !== 'v1') return { ok: false, reason: `unsupported ticket version: ${version}` }
  if (!/^\d{1,15}$/.test(expRaw) || !/^[a-f0-9]{12}$/.test(nonce) || !/^[a-f0-9]{64}$/.test(mac)) {
    return { ok: false, reason: 'malformed ticket' }
  }
  const expMs = Number(expRaw)
  const expected = ticketHmac(o.action, o.argsHash, nonce, expMs, o.key)
  const a = Buffer.from(mac, 'hex')
  const b = Buffer.from(expected, 'hex')
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, reason: 'hmac mismatch — forged ticket, or bound to another action/args' }
  }
  if (now > expMs) return { ok: false, reason: 'expired ticket' }
  if (consumedNonces.has(nonce)) return { ok: false, reason: 'single-use — ticket already consumed' }
  if (o.consume) {
    consumedNonces.set(nonce, expMs)
    if (consumedNonces.size > NONCE_PRUNE_AT) {
      for (const [n, exp] of consumedNonces) if (exp < now) consumedNonces.delete(n)
    }
  }
  return { ok: true }
}

/** Test hook — clears the consumed-nonce registry. */
export function resetTicketNonces(): void {
  consumedNonces.clear()
}
