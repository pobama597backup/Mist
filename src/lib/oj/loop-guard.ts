// M.I.S.T. × OpenJarvis — agent loop guards (port of
// openjarvis/agents/loop_guard.py @ 5e5f5ef, oj-spine-1).
//
// OpenJarvis's LoopGuard detects and prevents degenerate tool-calling loops
// before they burn a whole budget:
//   1. identical-call tracking — SHA-256 of (tool, args) blocked after N
//      repeats (default 3)
//   2. ping-pong detection — sliding window catches A-B-A-B / A-B-C-A-B-C
//      tool sequences
//   3. per-tool poll budget — the same tool more than N times is polling
//   4. warn-before-block — the first cycle warns (teaches), the second blocks
//
// M.I.S.T. adaptation (createLoopGuard): guards are TIER-AWARE — the
// complexity router (complexity.ts) sizes the turn/token/wall-clock budgets
// per query tier, so a research mission gets room to work while an instant
// query is cut off fast. Token budgets and wall-clock caps complete the
// OpenJarvis executor rail (its AgentExecutor enforces the same axes).
// Mission integration overrides maxTurns with the mission's own step budget
// so the guard never pre-empts an explicit creator-set budget.

import { createHash } from 'node:crypto'
import type { ComplexityTier } from './complexity'
import { bus } from './event-bus'

export interface LoopGuardTuning {
  /** Hard cap on loop steps (turns). Derived from tier when omitted. */
  maxTurns?: number
  /** Identical tool+args repeats allowed before tripping. Default 3. */
  maxIdenticalCalls?: number
  /** Same-tool call ceiling (poll budget). Default 5. */
  maxPerTool?: number
  /** Wall-clock cap in ms. Derived from tier when omitted. */
  wallClockMs?: number
  /** Token budget (estimated in+out). Derived from tier when omitted. */
  tokenBudget?: number
  /** Warn on first detection, block on the second. Default true. */
  warnBeforeBlock?: boolean
}

export type LoopGuardReasonType =
  | 'identical_call'
  | 'ping_pong'
  | 'poll_budget'
  | 'max_turns'
  | 'token_budget'
  | 'wall_clock'

export interface LoopGuardVerdict {
  ok: boolean
  /** true when this is the warn-before-block pass (ok, but change course). */
  warned: boolean
  reasonType?: LoopGuardReasonType
  reason: string
}

export interface LoopGuardStep {
  tool: string
  args?: Record<string, unknown>
  /** Estimated tokens consumed by this step (0 when unknown). */
  tokens?: number
}

export interface LoopGuardState {
  turns: number
  tokensUsed: number
  elapsedMs: number
  uniqueCalls: number
  /** tool → count */
  perTool: Record<string, number>
  warnings: number
}

/** Tier-derived defaults (research gets room; instant gets cut fast). */
const TIER_DEFAULTS: Record<ComplexityTier, Required<Pick<LoopGuardTuning, 'maxTurns' | 'wallClockMs' | 'tokenBudget'>>> = {
  instant: { maxTurns: 6, wallClockMs: 60_000, tokenBudget: 4_096 },
  standard: { maxTurns: 12, wallClockMs: 5 * 60_000, tokenBudget: 32_768 },
  deep: { maxTurns: 24, wallClockMs: 12 * 60_000, tokenBudget: 131_072 },
  research: { maxTurns: 40, wallClockMs: 30 * 60_000, tokenBudget: 524_288 },
}

export interface LoopGuard {
  check(step: LoopGuardStep): LoopGuardVerdict
  state: LoopGuardState
  reset(): void
}

function hashCall(tool: string, args: Record<string, unknown> | undefined): string {
  const canonical = (() => {
    try {
      const keys = Object.keys(args ?? {}).sort()
      const obj: Record<string, unknown> = {}
      for (const k of keys) obj[k] = args?.[k]
      return JSON.stringify(obj)
    } catch {
      return String(tool)
    }
  })()
  return createHash('sha256').update(`${tool}:${canonical}`).digest('hex').slice(0, 16)
}

/** Stable, arg-order-insensitive similarity: Jaccard over serialized args. */
function similarArgs(
  a: Record<string, unknown> | undefined,
  b: Record<string, unknown> | undefined
): boolean {
  const sa = JSON.stringify(a ?? {})
  const sb = JSON.stringify(b ?? {})
  if (sa === sb) return true
  try {
    const objA = a ?? {}
    const objB = b ?? {}
    const keys = new Set([...Object.keys(objA), ...Object.keys(objB)])
    let same = 0
    for (const k of keys) {
      if (JSON.stringify(objA[k]) === JSON.stringify(objB[k])) same++
    }
    return keys.size > 0 && same / keys.size >= 0.8
  } catch {
    return false
  }
}

/**
 * Create a tier-aware loop guard. `check()` BEFORE executing each step; a
 * verdict with ok:false means do not execute (the reason is a teaching
 * message, safe to feed back to the actor). A warned verdict means the step
 * proceeds but the caller should surface the warning.
 */
export function createLoopGuard(tier: ComplexityTier | 'unrated' = 'standard', tuning: LoopGuardTuning = {}): LoopGuard {
  const base = TIER_DEFAULTS[tier === 'unrated' ? 'standard' : tier]
  const maxTurns = tuning.maxTurns ?? base.maxTurns
  const maxIdenticalCalls = tuning.maxIdenticalCalls ?? 3
  const maxPerTool = tuning.maxPerTool ?? 5
  const wallClockMs = tuning.wallClockMs ?? base.wallClockMs
  const tokenBudget = tuning.tokenBudget ?? base.tokenBudget
  const warnBeforeBlock = tuning.warnBeforeBlock ?? true

  const startedAt = Date.now()
  const callCounts = new Map<string, number>() // exact-hash → count
  const similarHistory: Array<{ tool: string; args: Record<string, unknown> | undefined; hash: string }> = []
  const toolSequence: string[] = []
  const perTool: Record<string, number> = {}
  const warned = new Set<string>()

  const state: LoopGuardState = {
    turns: 0,
    tokensUsed: 0,
    elapsedMs: 0,
    uniqueCalls: 0,
    perTool,
    warnings: 0,
  }

  function trip(
    reasonType: LoopGuardReasonType,
    detail: string,
    tool?: string,
    forceBlock = false
  ): LoopGuardVerdict {
    bus.emit('loop_guard_trip', {
      reasonType,
      tool,
      detail: detail.slice(0, 240),
    })
    if (warnBeforeBlock && !forceBlock && !warned.has(reasonType)) {
      warned.add(reasonType)
      state.warnings++
      return { ok: true, warned: true, reasonType, reason: detail }
    }
    return { ok: false, warned: false, reasonType, reason: detail }
  }

  return {
    state,
    check(step: LoopGuardStep): LoopGuardVerdict {
      state.turns++
      state.elapsedMs = Date.now() - startedAt
      const tokens = Math.max(0, Math.round(Number(step.tokens ?? 0)))
      state.tokensUsed += tokens

      // 0. hard rails — turns / wall clock / token budget always BLOCK
      if (state.turns > maxTurns) {
        return trip(
          'max_turns',
          `LOOP BUDGET SPENT: ${state.turns - 1} steps executed (cap ${maxTurns}). Stop calling tools and deliver your final answer from what you have.`,
          step.tool,
          true
        )
      }
      if (state.elapsedMs > wallClockMs) {
        return trip(
          'wall_clock',
          `TIME CAP REACHED: ${Math.round(state.elapsedMs / 1000)}s elapsed (cap ${Math.round(wallClockMs / 1000)}s). Finish now with what you have.`,
          step.tool,
          true
        )
      }
      if (state.tokensUsed > tokenBudget) {
        return trip(
          'token_budget',
          `TOKEN BUDGET EXCEEDED: ~${state.tokensUsed} tokens used (cap ${tokenBudget}). Compose your final answer now — no more tool calls.`,
          step.tool,
          true
        )
      }

      const hash = hashCall(step.tool, step.args)
      const prev = callCounts.get(hash) ?? 0
      callCounts.set(hash, prev + 1)
      if (prev + 1 === 1) state.uniqueCalls++

      // 1. identical-call tracking (sha of tool+args)
      if (callCounts.get(hash)! > maxIdenticalCalls) {
        return trip(
          'identical_call',
          `REPEATED IDENTICAL CALL: '${step.tool}' with the same arguments ${callCounts.get(hash)} times (max ${maxIdenticalCalls}). Deterministic tools return the same bytes — change the arguments or move on to producing results.`,
          step.tool
        )
      }

      // 1b. similar-args repeat: same tool + ~same args 3x (not byte-identical)
      const similars = similarHistory.filter(
        (h) => h.tool === step.tool && h.hash !== hash && similarArgs(h.args, step.args)
      ).length
      similarHistory.push({ tool: step.tool, args: step.args, hash })
      if (similars + (callCounts.get(hash) ?? 0) >= maxIdenticalCalls) {
        return trip(
          'identical_call',
          `LOOPING ON '${step.tool}': ${similars + 1} calls with near-identical arguments. You are re-asking the same thing — vary the approach substantially or deliver your result.`,
          step.tool
        )
      }

      // 2. per-tool poll budget
      perTool[step.tool] = (perTool[step.tool] ?? 0) + 1
      if (perTool[step.tool]! > maxPerTool) {
        return trip(
          'poll_budget',
          `POLL BUDGET EXCEEDED: '${step.tool}' called ${perTool[step.tool]} times (max ${maxPerTool}). Stop polling it — work with the data you already have.`,
          step.tool
        )
      }

      // 3. ping-pong detection (period-2 and period-3 patterns)
      toolSequence.push(step.tool)
      if (toolSequence.length > 12) toolSequence.shift()
      for (const period of [2, 3]) {
        if (toolSequence.length >= period * 2) {
          const tail = toolSequence.slice(-period * 2)
          const pattern = tail.slice(0, period)
          const repeats = pattern.length > 0 && tail.every((t, i) => t === pattern[i % period])
          if (repeats) {
            return trip(
              'ping_pong',
              `PING-PONG LOOP DETECTED: ${pattern.join(' → ')} repeating. Break the cycle — pick a different tool or produce your final answer.`,
              step.tool
            )
          }
        }
      }

      return { ok: true, warned: false, reason: '' }
    },
    reset() {
      callCounts.clear()
      similarHistory.length = 0
      toolSequence.length = 0
      for (const k of Object.keys(perTool)) delete perTool[k]
      warned.clear()
      state.turns = 0
      state.tokensUsed = 0
      state.elapsedMs = 0
      state.uniqueCalls = 0
      state.warnings = 0
    },
  }
}
