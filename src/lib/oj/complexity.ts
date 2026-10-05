// M.I.S.T. × OpenJarvis — per-query complexity router (port of
// openjarvis/learning/routing/complexity.py @ 5e5f5ef, oj-spine-1).
//
// OpenJarvis scores every query 0.0–1.0 from independent weighted signals
// (length .20, code/math domain .25, reasoning/multi-step .25, question +
// subtask count .15, creative .15), maps the score to a tier, and derives a
// token budget (1024 → 16384, ×2 for thinking models whose internal
// chain-of-thought consumes output tokens). The tier then drives
// smallest-vs-largest model selection (IPW: local models handle ~89% of
// single-turn queries — route cheap, escalate honestly).
//
// M.I.S.T. adaptation: no local runtimes exist in the sandbox — her 21-lane
// cascade IS the engine layer. Tiers therefore map to M.I.S.T. LANES:
//   instant  (< 0.25) — keyless/fast lanes, tiny budgets
//   standard (< 0.55) — the normal cascade order
//   deep     (< 0.80) — reasoning-capable lanes, generous budgets
//   research (≥ 0.80) — the full deep-research path, max budget
// The OpenJarvis tier vocabulary (trivial..very_complex) is aliased below for
// trace-store compatibility (prisma Trace.tier documents both).

import { bus } from './event-bus'

export type ComplexityTier = 'instant' | 'standard' | 'deep' | 'research'

/** OpenJarvis-native tier names, for display + any consumer that wants them. */
export type OjTierAlias = 'trivial' | 'simple' | 'moderate' | 'complex' | 'very_complex'

export interface ComplexityResult {
  /** 0.0 – 1.0 */
  score: number
  tier: ComplexityTier
  /** OpenJarvis's own 5-step tier name for the same score. */
  ojTier: OjTierAlias
  /** Tier-derived output token budget (before thinking-model multiplier). */
  suggestedMaxTokens: number
  signals: {
    length: number
    domain: number
    reasoning: number
    multiPart: number
    creative: number
    hasCode: boolean
    hasMath: boolean
    hasReasoning: boolean
    hasMultiStep: boolean
    hasCreative: boolean
    nQuestions: number
    nSubtasks: number
  }
}

// ---------- signal patterns (ported verbatim from complexity.py) ----------

const CODE_PATTERNS =
  /```|`[^`]+`|\bdef\s|\bclass\s|\bimport\s|\bfunction\s|\bconst\s|\bvar\s|\blet\s|\bif\s*\(|->|=>|\{\s*\}|\bfor\s+\w+\s+in\s|#include|System\.out/i
const MATH_PATTERNS =
  /\bsolve\b|\bintegral\b|\bequation\b|\bproof\b|\bderivative\b|\bmatrix\b|\btheorem\b|\bcalculate\b|\bcompute\b|\bsigma\b|\bsum\b|\blimit\b|\bprobability\b/i
const REASONING_PATTERNS =
  /\bexplain\b|\banalyze\b|\bcompare\b|\bwhy\b|\bstep[- ]by[- ]step\b|\breason\b|\bthink\b|\bpros\s+and\s+cons\b|\btrade-?\s*offs?\b|\bevaluate\b/i
const MULTI_STEP_PATTERNS =
  /\bthen\b[\s\S]*\bthen\b|\bfirst\b[\s\S]*\bnext\b|\bstep\s*\d|\b(?:and\s+also|additionally|furthermore)\b|\b\d+\.\s/i
const CREATIVE_PATTERNS =
  /\bwrite\b[\s\S]*\b(?:essay|story|article|report|poem)\b|\bgenerate\b[\s\S]*\b(?:code|script|program)\b|\bcreate\b|\bdesign\b|\bdraft\b|\bcompose\b/i

/** Models known to burn output tokens on internal chain-of-thought. */
const THINKING_MODEL_PATTERNS = /qwen3\.5|qwq|deepseek-r1|o1-|o3-|o4-|nemotron-3|reasoning/i

/** Token budgets per tier (port of _TOKEN_TIERS, mapped to M.I.S.T. lanes). */
const TOKEN_TIERS: Record<ComplexityTier, number> = {
  instant: 1024, // greetings, yes/no, factoid lookups
  standard: 4096, // explanations, summaries
  deep: 8192, // analysis, code generation, multi-step
  research: 16384, // long-form, multi-part reasoning
}

const TIER_THRESHOLDS: Array<{ max: number; tier: ComplexityTier; oj: OjTierAlias }> = [
  { max: 0.25, tier: 'instant', oj: 'trivial' },
  { max: 0.55, tier: 'standard', oj: 'moderate' },
  { max: 0.8, tier: 'deep', oj: 'complex' },
  { max: Infinity, tier: 'research', oj: 'very_complex' },
]

/** Thinking models need extra headroom for internal chain-of-thought. */
export const THINKING_TOKEN_MULTIPLIER = 2

export function isThinkingModel(modelName: string | null | undefined): boolean {
  if (!modelName) return false
  return THINKING_MODEL_PATTERNS.test(modelName)
}

export function adjustTokensForModel(suggested: number, modelName?: string | null): number {
  return isThinkingModel(modelName) ? suggested * THINKING_TOKEN_MULTIPLIER : suggested
}

function countSubTasks(query: string): number {
  const numbered = (query.match(/^\s*\d+[.)]\s/gm) ?? []).length
  const bulleted = (query.match(/^\s*[-*]\s/gm) ?? []).length
  return numbered + bulleted
}

/**
 * Score a query's complexity from 0.0 (instant) to 1.0 (research).
 * Pure function — no I/O, no side effects, safe to call anywhere.
 */
export function scoreComplexity(query: string): ComplexityResult {
  const q = typeof query === 'string' ? query : String(query ?? '')
  let score = 0

  // --- length (0–0.20) ---
  const length = q.length
  const lengthScore = length < 20 ? 0 : length < 100 ? 0.3 : length < 300 ? 0.6 : length < 800 ? 0.8 : 1
  score += 0.2 * lengthScore

  // --- domain: code / math (0–0.25) ---
  const hasCode = CODE_PATTERNS.test(q)
  const hasMath = MATH_PATTERNS.test(q)
  let domainScore = 0
  if (hasCode) domainScore = Math.max(domainScore, 0.7)
  if (hasMath) domainScore = Math.max(domainScore, 0.8)
  if (hasCode && hasMath) domainScore = 1
  score += 0.25 * domainScore

  // --- reasoning / multi-step phrasing (0–0.25) ---
  const hasReasoning = REASONING_PATTERNS.test(q)
  const hasMultiStep = MULTI_STEP_PATTERNS.test(q)
  let reasoningScore = 0
  if (hasReasoning) reasoningScore = 0.6
  if (hasMultiStep) reasoningScore = Math.max(reasoningScore, 0.8)
  if (hasReasoning && hasMultiStep) reasoningScore = 1
  score += 0.25 * reasoningScore

  // --- question + sub-task count (0–0.15) ---
  const nQuestions = (q.match(/\?/g) ?? []).length
  const nSubtasks = countSubTasks(q)
  const multiPart = nQuestions + nSubtasks
  const multiScore = multiPart <= 1 ? 0 : multiPart <= 3 ? 0.5 : 1
  score += 0.15 * multiScore

  // --- creative / generative (0–0.15) ---
  const hasCreative = CREATIVE_PATTERNS.test(q)
  score += 0.15 * (hasCreative ? 0.7 : 0)

  score = Math.max(0, Math.min(1, score))

  const bucket = TIER_THRESHOLDS.find((t) => score < t.max) ?? TIER_THRESHOLDS[TIER_THRESHOLDS.length - 1]

  return {
    score: Math.round(score * 1000) / 1000,
    tier: bucket.tier,
    ojTier: bucket.oj,
    suggestedMaxTokens: TOKEN_TIERS[bucket.tier],
    signals: {
      length: lengthScore,
      domain: domainScore,
      reasoning: reasoningScore,
      multiPart: multiScore,
      creative: hasCreative ? 0.7 : 0,
      hasCode,
      hasMath,
      hasReasoning,
      hasMultiStep,
      hasCreative,
      nQuestions,
      nSubtasks,
    },
  }
}

/** Cascade lane recommendation per tier (M.I.S.T.'s honest escalation policy). */
export function laneForTier(tier: ComplexityTier): string {
  switch (tier) {
    case 'instant':
      return 'cascade:keyless-first — trivial queries ride the free fast lanes (kilo/llm7/pollinations) before costing a keyed lane'
    case 'standard':
      return 'cascade:normal — default provider order, no escalation needed'
    case 'deep':
      return 'cascade:reasoning — prefer reasoning-capable lanes (550B nemotron, openrouter) with generous budgets'
    case 'research':
      return 'cascade:research — full deep-research path / mission loop with max budget'
  }
}

/**
 * Score + route in one call — emits a `complexity_routed` bus event so the
 * spine (traces, UI pulse) can observe every routing decision.
 */
export function routeQuery(
  query: string,
  opts?: { model?: string | null; emitEvent?: boolean }
): ComplexityResult & { lane: string; tokenBudget: number } {
  const result = scoreComplexity(query)
  const tokenBudget = adjustTokensForModel(result.suggestedMaxTokens, opts?.model)
  const lane = laneForTier(result.tier)
  if (opts?.emitEvent !== false) {
    try {
      bus.emit('complexity_routed', {
        query: query.slice(0, 300),
        score: result.score,
        tier: result.tier,
        tokenBudget,
        lane,
        signals: result.signals as unknown as Record<string, unknown>,
      })
    } catch {
      // telemetry must never break routing
    }
  }
  return { ...result, lane, tokenBudget }
}

/**
 * Human-facing policy note — explains WHY a query routed to its tier, in one
 * line, so the UI (XRay footer, traces tab) can show routing decisions
 * honestly instead of a bare number.
 */
export function complexityPolicyNote(result: ComplexityResult): string {
  const why: string[] = []
  const s = result.signals
  if (s.length > 0) why.push('long query')
  if (s.hasCode) why.push('code')
  if (s.hasMath) why.push('math')
  if (s.hasReasoning) why.push('reasoning cues')
  if (s.hasMultiStep) why.push('multi-step phrasing')
  if (s.nQuestions + s.nSubtasks > 1) why.push(`${s.nQuestions + s.nSubtasks} parts`)
  if (s.hasCreative) why.push('generative task')
  const reason = why.length > 0 ? why.join(' + ') : 'simple phrasing'
  const budgetNote =
    result.suggestedMaxTokens >= 8192 ? ' — escalated budget, reasoning lane preferred' : ''
  return `score ${result.score.toFixed(2)} from ${reason} → ${result.tier} lane, ≤${result.suggestedMaxTokens} output tokens${budgetNote}`
}
