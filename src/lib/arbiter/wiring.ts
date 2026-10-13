// M.I.S.T. Arbiter · wiring layer (Phase 2-b).
//
// Everything the CHOKEPOINTS (tools-service executeTool, bridge-service
// bridgeExec) need around the pure core: the autonomy scope source, standing
// orders + windowed usage (30s cache), the approval fingerprint, risk→tier
// mapping for Approval rows, the raw-bridge-action risk classes, and the
// shared ask/defer flow (Approval row + audit event + the honest message the
// caller returns). The core (arbiter.ts) stays pure — this module owns all
// db/secret-adjacent plumbing so the two chokepoints share ONE policy path.
//
// Standing-order usage is counted from the hash-chained AuditEvent stream
// itself (orderRef = order id, decision 'allow', ts inside the order's
// windowMs) — the audit log is the source of truth for what was spent.

import { db } from '@/lib/db'
import { createApproval, type ApprovalOrigin, type ApprovalTier } from '@/lib/oj/approval-service'
import { appendAuditEvent } from './audit'
import { arbitrate, registerSkillRiskResolver, type Origin, type Scope, type StandingOrderCard } from './arbiter'
import { classifyRisk, type RiskClass } from './risk-table'
import { skillChainRisk } from './chain-risk'

// ---------- autonomy scope ----------

/**
 * The owner's autonomy scope for Arbiter decisions. Module default 'A2'
 * (ask-by-default) until the Phase 5 autonomy dial stores a real setting —
 * pluggable by design: setAutonomyScope() is the seam the dial will write.
 */
let autonomyScope: Scope = 'A2'

export function getAutonomyScope(): Scope {
  return autonomyScope
}

export function setAutonomyScope(scope: Scope): void {
  autonomyScope = scope
}

/** Phase 2-c: numeric rank for scope comparisons (A0=0 … A4=4) — the
 *  evolution auto-apply floor is scopeRank(scope) >= 3 (A3+). */
export function scopeRank(scope: Scope): number {
  return ({ A0: 0, A1: 1, A2: 2, A3: 3, A4: 4 } as const)[scope]
}

// ---------- canonical args / fingerprint ----------

/** The same canonicalization executeTool always applied: object → itself,
 *  everything else → {}. classifyRisk / fingerprints / taint all see THIS. */
export function canonicalizeArgs(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {}
}

/** Best-effort file-ish arg extraction for path-prefix checks (nullable). */
export function extractFilePath(args: Record<string, unknown>): string | null {
  for (const key of ['path', 'file', 'target']) {
    const v = args[key]
    if (typeof v === 'string' && v.length > 0) return v
  }
  return null
}

/**
 * Stable fingerprint binding ONE approval to ONE tool call shape: tool name +
 * shallow sorted-keys JSON of the canonical args, capped at 200 chars. The
 * re-execution (approval-service decide) recomputes this from the stored
 * payload — a mismatched args object must NOT ride a stale approval.
 */
export function approvalFingerprint(tool: string, canonicalArgs: Record<string, unknown>): string {
  const keys = Object.keys(canonicalArgs).sort()
  const shallow = `{${keys.map((k) => `${JSON.stringify(k)}:${JSON.stringify(canonicalArgs[k])}`).join(',')}}`
  return `${tool}:${shallow}`.slice(0, 200)
}

// ---------- risk → approval tier / origin mapping ----------

/** Approval.tier for an Arbiter ask (the column's own vocabulary: low|medium|high). */
export function riskTier(risk: RiskClass): ApprovalTier {
  if (risk === 'read' || risk === 'sensitive-read' || risk === 'network') return 'low'
  if (risk === 'write' || risk === 'persist') return 'medium'
  return 'high' // exec | egress | destructive | self-modify
}

/** Approval.origin from an Arbiter origin (column is a free string; the
 *  unattended deferrals arrive through the Arbiter itself). */
export function originToApprovalOrigin(origin: Origin): ApprovalOrigin {
  switch (origin) {
    case 'owner_chat':
    case 'owner_voice':
      return 'mist'
    case 'owner_cron':
      return 'mission'
    case 'owner_heartbeat':
      return 'operator'
    case 'tool_output':
      return 'subagent'
    default:
      return 'arbiter' // web | mcp | skill | memory — never decision-makers, only askers
  }
}

// ---------- standing orders (30s cache + windowed usage) ----------

const STANDING_ORDER_CACHE_MS = 30_000
let orderCache: { at: number; cards: StandingOrderCard[] } | null = null

/** Active standing orders as arbiter cards, with windowed usage counted from
 *  AuditEvents (orderRef = order id, decision 'allow'). Cached 30s in-module. */
export async function loadStandingOrderCards(): Promise<StandingOrderCard[]> {
  // Phase 7: the chokepoint awaits THIS on every call, right before
  // arbitrate() — pre-warming the skill-chain cache here means arbitrate()'s
  // sync seam always sees warm data from call #1 (the alternative — a cold
  // first call at the flat unknown default — is conservative but stale).
  // TTL-guarded internally: warm calls cost one Date.now() comparison.
  await ensureSkillChainCache()
  if (orderCache && Date.now() - orderCache.at < STANDING_ORDER_CACHE_MS) return orderCache.cards
  const rows = await db.standingOrder
    .findMany({ where: { active: true } })
    .catch(() => [] as Awaited<ReturnType<typeof db.standingOrder.findMany>>)
  const now = Date.now()
  const cards: StandingOrderCard[] = []
  for (const row of rows) {
    if (row.expiryAt && now >= row.expiryAt.getTime()) continue // expired when now >= expiryAt (pinned by core tests)
    let tools: string[] = []
    let budget: { maxCalls?: number; windowMs?: number; spendCapUsd?: number } = {}
    try {
      tools = JSON.parse(row.tools) as string[]
      budget = JSON.parse(row.budget) as typeof budget
    } catch {
      continue // a corrupt card is not an authorization
    }
    let calls = 0
    if (typeof budget.maxCalls === 'number') {
      const windowMs = typeof budget.windowMs === 'number' && budget.windowMs > 0 ? budget.windowMs : Infinity
      const since = windowMs === Infinity ? undefined : new Date(now - windowMs)
      try {
        calls = await db.auditEvent.count({
          where: { orderRef: row.id, decision: 'allow', ...(since ? { ts: { gt: since } } : {}) },
        })
      } catch {
        calls = 0
      }
    }
    cards.push({
      id: row.id,
      tools,
      pathPrefixes: safeStringArray(row.pathPrefixes),
      budget,
      expiryAt: row.expiryAt ? row.expiryAt.getTime() : null,
      usage: { calls },
    })
  }
  orderCache = { at: now, cards }
  return cards
}

function safeStringArray(json: string): string[] {
  try {
    const parsed = JSON.parse(json) as unknown
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : []
  } catch {
    return []
  }
}

/** Drop the 30s cache — called when an order is created/revoked so the next
 *  decision sees fresh cards (and by tests seeding fixtures directly). */
export function invalidateStandingOrderCache(): void {
  orderCache = null
}

// ---------- Phase 7 · skill chain-max effective risk (skills deep audit) ----------
//
// Mandate Phase 7 (docs/phase-0/tool-risk-table.md): "19x `skill:<name>` |
// chain-max | chain | effective risk = max of chained tools". Every saved
// skill is exposed to the LLM as a callable tool `skill:<name>`; until Phase 7
// the Arbiter treated those names as flat 'write' (classifyRisk's unknown
// default). THIS module owns the DB-touching half: the name->toolChain cache
// (same TTL pattern as the standing-order cache — 30s, event-invalidated),
// the sync resolver installed into arbitrate()'s Phase 7 seam, and the
// pre-warm hook so the seam always sees warm data (arbitrateToolCall awaits
// loadStandingOrderCards() on EVERY call, before arbitrate() — the skill-chain
// cache refreshes there). Invalidation hooks the same points as the skills
// list cache: skills-service invalidateSkillListCache() (fired on every save /
// quarantine-accept / delete) drops this cache too.

const SKILL_CHAIN_CACHE_MS = 30_000
let chainCache: { at: number; chains: Map<string, string[]> } | null = null

/** Drop the skill-chain cache — fired by skills-service's
 *  invalidateSkillListCache() (every skill mutation) and by tests. */
export function invalidateSkillChainCache(): void {
  chainCache = null
}

/** Refresh the name->toolChain cache (TTL-guarded; never throws — a store
 *  hiccup keeps the previous snapshot). Exported for tests + the pre-warm. */
export async function ensureSkillChainCache(): Promise<void> {
  if (chainCache && Date.now() - chainCache.at < SKILL_CHAIN_CACHE_MS) return
  try {
    const rows = await db.skill.findMany({ select: { name: true, toolChain: true } })
    const chains = new Map<string, string[]>()
    for (const row of rows) {
      try {
        const parsed = JSON.parse(row.toolChain) as unknown
        chains.set(row.name, Array.isArray(parsed) ? parsed.filter((t): t is string => typeof t === 'string') : [])
      } catch {
        chains.set(row.name, []) // a corrupt chain column reads as empty (prompt-expansion class)
      }
    }
    chainCache = { at: Date.now(), chains }
  } catch {
    // keep the previous snapshot; the resolver's null fallback (flat risk)
    // is the honest conservative path while the store is unreachable
  }
}

export interface SkillChainResolution {
  risk: RiskClass
  dead: string[]
  nested: string[]
}

/** The Phase 7 resolver installed into arbitrate()'s seam: sync (the cache is
 *  pre-warmed), null when the skill is unknown or the cache is cold — the
 *  caller then keeps classifyRisk's flat unknown default for skill:* ('write').
 *  Nested `skill:<name>` entries resolve through the same snapshot
 *  (depth-capped, cycle-safe — chain-risk.ts). */
export function effectiveSkillRisk(skillName: string): SkillChainResolution | null {
  const snapshot = chainCache
  if (!snapshot) return null
  const chain = snapshot.chains.get(skillName)
  if (!chain) return null
  return skillChainRisk(chain, (nested) => snapshot.chains.get(nested) ?? null)
}

// Module-load registration: the moment any chokepoint imports this module
// (tools-service imports it for canonicalizeArgs/askFlow/loadStandingOrderCards),
// arbitrate()'s seam goes live. No import cycle: arbiter.ts imports nothing here.
registerSkillRiskResolver(effectiveSkillRisk)

// ---------- raw bridge-action risk (the relay / hermes / bg-task path) ----------

/** The bridge daemon's GATED_ACTIONS, mirrored app-side: exactly the actions
 *  that may ONLY run with a freshly minted Arbiter ticket. */
export const TICKETED_BRIDGE_ACTIONS = new Set<string>([
  'run_command',
  'write_file',
  'move_file',
  'copy_file',
  'delete_file',
  'make_dir',
  'zip_files',
  'unzip_file',
  'ui_automate',
  'hermes_ask',
  'open_app',
])

/** Risk class for a RAW bridge action (the /exec relay path): the mandate's
 *  per-action map, with write_file/ui_automate reusing the arg-aware tool
 *  classifiers (src/ writes escalate to self-modify, inspect stays a read). */
export function classifyBridgeActionRisk(action: string, args: Record<string, unknown>): RiskClass {
  switch (action) {
    case 'run_command':
    case 'open_app':
    case 'hermes_ask':
      return 'exec'
    case 'delete_file':
      return 'destructive'
    case 'write_file':
      return classifyRisk('write_file', args)
    case 'ui_automate':
      return classifyRisk('ui_automate', args)
    case 'move_file':
    case 'copy_file':
    case 'make_dir':
    case 'zip_files':
    case 'unzip_file':
      return 'write'
    default:
      return 'read'
  }
}

// ---------- the shared ask / defer flow ----------

export interface AskFlowInput {
  tool: string
  canonicalArgs: Record<string, unknown>
  risk: RiskClass
  origin: Origin
  turnId?: string
  tainted?: boolean
  /** false (or an unattended origin) → the row is filed via the Arbiter and
   *  the honest message says QUEUED, not awaiting. */
  interactive: boolean
  /** arbitrate()'s reason for the ask/defer — audit-recorded verbatim. */
  verdictReason: string
}

export interface AskFlowResult {
  approvalId: string | null
  title: string
  message: string
}

/** One ask (or defer): Approval row (the bell renders it) + audit event + the
 *  honest message the caller returns INSTEAD of executing. Never throws —
 *  an approval-store hiccup degrades to an honest not-executed result. */
export async function askFlow(input: AskFlowInput): Promise<AskFlowResult> {
  const deferred = input.interactive === false
  const title = askTitle(input.tool, input.canonicalArgs)
  // PHASE 7 (skills deep audit): an ask for a `skill:<name>` call must RECORD
  // the chain-max effective risk the verdict used. The chokepoint passes the
  // flat table risk here (classifyRisk's conservative unknown default 'write'
  // for skill:*); re-resolve through the same seam + cache arbitrate()
  // decided with, so the Approval row, its tier, and the audit row all carry
  // the honest effective class (e.g. 'exec' + high tier for a run_command
  // chain — NOT flat 'write' + medium).
  let risk = input.risk
  if (input.tool.startsWith('skill:')) {
    const resolved = effectiveSkillRisk(input.tool.slice('skill:'.length))
    if (resolved) risk = resolved.risk
  }
  const fingerprint = approvalFingerprint(input.tool, input.canonicalArgs)
  let approvalId: string | null = null
  try {
    const res = await createApproval({
      actionType: 'tool_exec',
      title,
      payload: {
        tool: input.tool,
        args: input.canonicalArgs,
        origin: input.origin,
        turnId: input.turnId ?? null,
        tainted: input.tainted === true,
        risk, // Phase 7: the chain-max effective risk for skill:* asks
      },
      tier: riskTier(risk),
      origin: deferred ? 'arbiter' : originToApprovalOrigin(input.origin),
      fingerprint,
    })
    approvalId = res.approvalId ?? null
  } catch {
    approvalId = null // the row is the UX, not the gate — the NOT-EXECUTED result below is the gate
  }
  await appendAuditEvent({
    tool: input.tool,
    argsJson: safeArgsJson(input.canonicalArgs),
    risk, // Phase 7: chain-max effective risk for skill:* asks (matches the verdict)
    origin: input.origin,
    tainted: input.tainted === true,
    decision: deferred ? 'defer' : 'ask',
    reason: input.verdictReason,
    turnId: input.turnId ?? null,
  }).catch(() => undefined)
  // Phase 5 fix: the interactive ask carries the VERDICT REASON — the owner
  // deserves the WHY (A1 observe-only says "raise the autonomy scope to act",
  // A2 says "ask-by-default", voice says the confirm phrase, taint says fresh
  // approval) in the same breath as the request, not only in the audit row.
  const message = deferred
    ? `queued for owner review — not executed (${title}); I will run it the moment the owner approves it in the approval bell`
    : `⏸ Awaiting your approval — I have asked the owner to confirm: ${title}. Tell them what you are about to do and wait for the go. (${input.verdictReason})`
  return { approvalId, title, message }
}

/** `${tool} — ${one-line arg summary}` — first string-ish arg, capped. */
function askTitle(tool: string, canonicalArgs: Record<string, unknown>): string {
  const keys = Object.keys(canonicalArgs).sort()
  for (const key of keys) {
    const v = canonicalArgs[key]
    if (typeof v === 'string' && v.trim().length > 0) {
      return `${tool} — ${v.trim().slice(0, 80)}`.slice(0, 160)
    }
  }
  return tool
}

function safeArgsJson(canonicalArgs: Record<string, unknown>): string {
  try {
    return JSON.stringify(canonicalArgs).slice(0, 2000)
  } catch {
    return '{}'
  }
}

// re-exported for the chokepoints' convenience (single import surface)
export { arbitrate }
export type { Origin, Scope }
