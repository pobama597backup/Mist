// M.I.S.T. Arbiter · skill CHAIN-MAX effective risk (Phase 7, Sovereign
// Hardening — skills deep audit + chain-max risk).
//
// The mandate's Phase 7 row (docs/phase-0/tool-risk-table.md):
//     "19× `skill:<name>` | chain-max | chain | effective risk = max of
//      chained tools"
// A saved skill is exposed to the LLM as a callable tool `skill:<name>`
// (skills-service skillTools) and its `toolChain` column DECLARES the tools
// the skill's steps exercise. executeSkillTool itself only serves the skill
// content (prompt expansion) — the LLM then calls the chained tools as
// ordinary tool calls, each arbitrated on its own — so chain-max is honest
// LABELING of the skill's declarative footprint (defense in depth: the
// `skill:<name>` call is gated by what following it would DO).
//
// This module is PURE: no db, no files. The wiring (wiring.ts
// effectiveSkillRisk) supplies the DB-backed chain lookup + cache; the tests
// exercise skillChainRisk with literal chains.
//
// Phase 0 triage executed alongside this module: docs/phase-0/prisma-and-
// skills.md §D7 (MERGE 3→1 model-selector, ARCHIVE 4 dead/duplicate skills,
// KEEP 11) — scripts/skills-audit-7.ts.

import { TOOL_RISK, isKnownTool, type RiskClass } from './risk-table'

// ---------- the severity ladder ----------
//
// DERIVED FROM THE ARBITER ITSELF, not invented. The engine's own gating
// (src/lib/arbiter/arbiter.ts) partitions the classes; the boundaries below
// are exactly the boundaries at which the matrix first asks/denies a class:
//
//   read            arbiter.ts:193 the ONLY class allowed for untrusted
//                   web/mcp origins; :204 the only class that passes under
//                   taint; :210 allowed at A0/A1 observe. It NEVER asks at
//                   any scope/origin → strictly lowest.
//   sensitive-read  :210-211 still allowed at A0/A1 observe AND :165 in the
//                   A2 allow-set, but :194 DENIED for web/mcp (only 'read'
//                   passes floor 2) and :205 asked under taint → above read.
//   network         :165 in the A2 allow-set, but NOT in the A0/A1 observe
//                   allow-list :210 → ASKS at observe scopes (:214) while
//                   sensitive-read passes → sensitive-read < network.
//   write, persist  beyond the A2 allow-set → ask at A2 (:168-170). The
//                   matrix treats them identically; the ENGINE's severity
//                   intuition for them lives in the wiring's own approval
//                   tier map (wiring.ts:79-81 riskTier): both 'medium'.
//   exec, egress,
//   destructive,
//   self-modify     same A2 ask (:168); wiring.ts:81 riskTier 'high' — the
//                   engine's own line that separates them from write/persist.
//
// Boundaries {read | sensitive-read | network | write+persist | exec-class}
// are engine-hard (matrix floors + the tier map). WITHIN {write, persist} and
// within the high tier the engine is indifferent — any consistent total
// order is compatible with it; the tiebreaks below are documented:
//   write < persist        persist writes DURABLE state that outlives the
//                          call (memory_set, cron_create, set_reminder)
//                          vs write's in-flight content writes.
//   exec < egress          exec runs code contained to the machine; egress
//                          sends data OUT irreversibly (the C6 egress ledger
//                          exists precisely because leaving the machine is a
//                          distinct, unrecoverable step).
//   egress < destructive   egress leaks, destructive destroys locally — the
//                          floor-1 list (arbiter.ts:181-186) treats
//                          destructive as unconditionally floored.
//   destructive <
//   self-modify            the class the whole protected-path floor + the
//                          evolution gate exist to contain (mist_self_write,
//                          oj_sync_apply) — the most sovereign action class.
export const RISK_SEVERITY: Record<RiskClass, number> = {
  read: 0,
  'sensitive-read': 1,
  network: 2,
  write: 3,
  persist: 4,
  exec: 5,
  egress: 6,
  destructive: 7,
  'self-modify': 8,
}

/** The MAX operator over the derived ladder — the severer of two classes. */
export function maxRisk(a: RiskClass, b: RiskClass): RiskClass {
  return RISK_SEVERITY[a] >= RISK_SEVERITY[b] ? a : b
}

// ---------- empty chains ----------
//
// An EMPTY toolChain is a pure prompt-expansion skill (hermes-operator,
// research-first, …): no chained actuators, the call only serves guidance
// text. DECISION: 'read' — the ladder's lowest class. The honest
// counter-consideration: executeSkillTool bumps a uses counter and appends
// an execution-ledger row (DB writes on every call). The engine's own
// convention excludes exactly that kind of bookkeeping from the risk class:
// EVERY arbitrated call appends an audit row (appendAuditEvent on every
// verdict — reads included) and that write is never counted as side effect.
// The uses-bump + execution row are bookkeeping-around-the-call in the same
// class. If the owner later disagrees, flipping EMPTY_CHAIN_RISK to 'write'
// is the one-line change — both are defensible; 'read' is the honest pick.
export const EMPTY_CHAIN_RISK: RiskClass = 'read'

// ---------- nested chains ----------
//
// Depth cap: a nested `skill:<name>` entry resolves through the callback at
// most 3 levels below the top-level chain (depth 0 = the skill being
// arbitrated; nested chains resolve at depths 1, 2, 3; an entry encountered
// at depth >= 3 is NOT descended). This makes the recursion CYCLE-SAFE by
// construction: a→b→a→b… terminates at the cap with the unknown default.
export const MAX_NESTED_DEPTH = 3

/** The unknown/dead default — classifyRisk's own conservative unknown class
 *  (risk-table.ts: 'not so trusting that a novel side effect rides through'). */
const UNKNOWN_DEFAULT: RiskClass = 'write'

export interface SkillChainRiskResult {
  /** the chain-max effective risk class */
  risk: RiskClass
  /** chained tool names that are NOT in the frozen TOOL_RISK register
   *  (dead omni_* names and any other unknown) — each counted at the
   *  conservative unknown default */
  dead: string[]
  /** nested `skill:<name>` entries that did NOT resolve (depth-cap cut —
   *  the cycle-safe stop — or the callback returned null for an unknown
   *  skill). Successful descents contribute transitively and are not listed. */
  nested: string[]
}

/**
 * The Phase 7 chain-max: effective risk = MAX over the chained tools.
 *
 * - plain entries resolve against the frozen TOOL_RISK register (base class;
 *   arg-aware escalation cannot apply — chains carry names, not args)
 * - unknown/dead names (omni_*) count as the table's own conservative
 *   unknown default ('write') AND are reported in `dead`
 * - `skill:<name>` entries resolve via `resolveSkillChain` recursively
 *   (depth-capped at MAX_NESTED_DEPTH, cycle-safe; stops are recorded in
 *   `nested` and count as the unknown default)
 * - an EMPTY chain is a pure prompt-expansion skill → EMPTY_CHAIN_RISK
 *   ('read' — see the decision note above)
 *
 * `dead` and `nested` are deduped, first-seen order.
 */
export function skillChainRisk(
  chain: string[],
  resolveSkillChain: (name: string) => string[] | null,
  depth = 0
): SkillChainRiskResult {
  const dead = new Set<string>()
  const nested = new Set<string>()
  if (!Array.isArray(chain) || chain.length === 0) {
    return { risk: EMPTY_CHAIN_RISK, dead: [], nested: [] }
  }
  let risk: RiskClass = EMPTY_CHAIN_RISK // a pure-read chain must stay read
  for (const raw of chain) {
    if (typeof raw !== 'string') continue
    const entry = raw.trim()
    if (entry.length === 0) continue

    if (entry.startsWith('skill:')) {
      const nestedName = entry.slice('skill:'.length).trim()
      if (depth >= MAX_NESTED_DEPTH || nestedName.length === 0) {
        // depth-cap stop (cycle-safe) — the recursive hit is treated as the
        // unknown default and we do NOT descend
        nested.add(entry)
        risk = maxRisk(risk, UNKNOWN_DEFAULT)
        continue
      }
      const nestedChain = resolveSkillChain(nestedName)
      if (nestedChain === null) {
        // the nested skill is unknown (deleted / never existed) — same
        // conservative treatment as an unknown plain tool
        nested.add(entry)
        risk = maxRisk(risk, UNKNOWN_DEFAULT)
        continue
      }
      const sub = skillChainRisk(nestedChain, resolveSkillChain, depth + 1)
      risk = maxRisk(risk, sub.risk)
      for (const d of sub.dead) dead.add(d)
      for (const n of sub.nested) nested.add(n)
      continue
    }

    if (isKnownTool(entry)) {
      risk = maxRisk(risk, TOOL_RISK[entry])
    } else {
      // dead tool (omni_* / retired name) — the register's own unknown default
      dead.add(entry)
      risk = maxRisk(risk, UNKNOWN_DEFAULT)
    }
  }
  return { risk, dead: [...dead], nested: [...nested] }
}
