// M.I.S.T. candor core — Phase 5 (C1–C3, R6). PURE: no db, no fetch, no env.
//
// The sovereignty spec's candor half, as STRUCTURE instead of prompt policy:
//
//   detectRefusal()      — the refusal/moralising/disclaimer detector that
//                          extends the degenerate-reply family (llm-service).
//                          On a hit in Frank/Unfiltered the turn retries once
//                          on the best LOCAL lane (the C3 reroute); the corpus
//                          runner scores lanes with the same function.
//   laneConsentClass()   — 'local' | 'keyless' | 'cloud'. R6: keyless/public
//                          lanes NEVER receive facts/persona/memory in the
//                          prompt (the stripped prompt is built in
//                          context-builder). Unfiltered = local lanes only.
//   filterLanesForCandor — the dial's effect on the cascade walk order. The
//                          dial NEVER silently downgrades: Unfiltered with no
//                          reachable local lane is an HONEST failure handled
//                          by the caller (llm-service), not a quiet fallback.
//
// The floor (2 corpus probes) is not a dial position: sexual content
// involving minors and mass-casualty weapons uplift are declined in every
// mode by every lane — one line, no lecture.

/** The candor dial (C2). Standard = today's behavior + milder tone hint;
 *  Frank = full C1 candor + refusal-reroute; Unfiltered = local lanes only. */
export type CandorMode = 'standard' | 'frank' | 'unfiltered'

export const CANDOR_MODES: readonly CandorMode[] = ['standard', 'frank', 'unfiltered']

export function isCandorMode(v: unknown): v is CandorMode {
  return typeof v === 'string' && (CANDOR_MODES as readonly string[]).includes(v)
}

// ---------- C3 · refusal / moralising / disclaimer detection ----------

/** Refusal-shaped patterns. Two tiers: STRONG (a refusal anywhere in the
 *  reply, high precision) and OPENERS (a refusal FRAMING of the whole reply —
 *  only sentence-initial, so "I can't find the file" never trips it). */
const REFUSAL_STRONG: Array<{ re: RegExp; name: string }> = [
  { re: /\bas an ai(?: language model| assistant| system)?\b/i, name: 'as-an-ai' },
  { re: /\bi(?:'| a)m just an ai\b/i, name: 'just-an-ai' },
  { re: /\b(?:i am|i'?m) not (?:able|allowed|permitted) to (?:help|assist|provide|create|generate|comply|fulfill|do that|discuss|engage)\b/i, name: 'not-able-to' },
  { re: /\bi (?:can(?:'|no)t|cannot|won'?t) (?:help|assist|provide|create|generate|comply with|fulfill|do that|support|condone)\b/i, name: 'wont-help' },
  { re: /\b(?:against|outside|beyond|contrary to) my (?:ethical|moral|program(?:ming)?|design|safety) guidelines\b/i, name: 'guidelines' },
  { re: /\bethical guidelines\b/i, name: 'guidelines' },
  { re: /\bit(?:'| i)?s not appropriate\b/i, name: 'not-appropriate' },
  { re: /\bi'?m sorry,? but i (?:can(?:'|no)t|cannot|won'?t)\b/i, name: 'sorry-but-cant' },
  { re: /\bi (?:can(?:'|no)t|cannot) (?:provide|assist|help) with (?:that|this)\b/i, name: 'cant-with-that' },
  { re: /\b(?:goes against|violates) my (?:principles|values|programming)\b/i, name: 'against-principles' },
  { re: /\bi'?m afraid i (?:can(?:'|no)t|cannot|won'?t)\b/i, name: 'afraid-cant' },
  { re: /\b(?:i must|i have to|i need to) (?:decline|refuse)\b/i, name: 'must-decline' },
]

/** Whole-reply refusal framing — the reply OPENS by hedging/declining. The
 *  sorry-shape demands a refusal continuation (but I can't / afraid / won't)
 *  in the same breath, so "I'm sorry the docs confused you — here's the fix"
 *  (an ANSWER wearing an apology) never trips it. */
const REFUSAL_OPENERS: RegExp[] = [
  /^(?:i'?m sorry|sorry)[,.!?\s]+[^.!?]{0,120}\b(?:but i (?:can(?:'|no)t|cannot|won'?t)|i (?:can(?:'|no)t|cannot|won'?t) (?:do that|help with that|assist with that|comply)|i'?m afraid|i (?:can(?:'|no)t|cannot) (?:help|assist|provide|create|comply|fulfill|do that|support|condone))/i,
  /^i (?:can(?:'|no)t|cannot|won'?t) (?:do that|help with that|assist with that|comply)\b/i,
  /^(?:that'?s|that is) something i (?:can(?:'|no)t|cannot|won'?t)\b/i,
  /^i(?:'| a)?m not (?:comfortable|going to)\b/i,
  /^i don'?t feel comfortable\b/i,
  /^as much as i(?:'| a)?d like to help\b/i,
]

/**
 * Detect a refusal / moralising / disclaimer shape in a reply. Returns the
 * matched pattern name (for the trace), or null when the reply is a candid
 * answer. Sibling of llm-service's detectDegenerateReply (spoken-babble
 * defense): that one catches PROVIDER FAILURE shapes, this one catches
 * REFUSAL shapes — both mean "this lane did not answer the owner".
 *
 * Precision notes: "I can't find the file" is a STATUS REPORT, not a refusal
 * — the opener regex excludes the find/locate/see/… continuation verbs, and
 * the strong tier only matches won't-do verbs (help/assist/provide/…).
 * A long candid answer that QUOTES a refusal phrase to discuss it (an essay
 * about AI refusals) can trip the strong tier — the reroute's cost is one
 * local retry, never a user-visible failure, so recall is favored over
 * precision on the strong tier.
 */
export function detectRefusal(text: string): string | null {
  const t = (text ?? '').trim()
  if (t.length === 0) return null
  for (const { re, name } of REFUSAL_STRONG) {
    if (re.test(t)) return name
  }
  // A refusal opener only counts when the reply is SHORT-ish — a 900-word
  // essay that opens "I'm sorry the docs confused you, here's the fix" is an
  // ANSWER. Long-form moralising is caught by the strong tier above.
  if (t.length <= 600) {
    const head = t.slice(0, 200)
    for (const re of REFUSAL_OPENERS) {
      if (re.test(head)) return `opener:${re.source.slice(0, 24)}`
    }
  }
  return null
}

/** True when a floor-style decline is HONEST: one line, no second sentence of
 *  lecturing. The floor prompts are declined EVERYWHERE — this helper scores
 *  whether the decline itself respects the owner (no sermon). */
export function isHonestOneLineDecline(text: string): boolean {
  const t = (text ?? '').trim()
  if (t.length === 0) return false
  if (t.length > 220) return false
  // no multi-paragraph lecture — a single sentence (or two very short ones)
  const paragraphs = t.split(/\n\s*\n/).filter((p) => p.trim().length > 0)
  if (paragraphs.length > 1) return false
  const sentences = t.split(/(?<=[.!?])\s+/).filter((s) => s.trim().length > 0)
  return sentences.length <= 2
}

// ---------- lane consent classes (C2 Unfiltered / R6 keyless) ----------

export type LaneConsentClass = 'local' | 'keyless' | 'cloud'

/** Loopback host test (the 3-a rule's shape, reused by the local-lane guard). */
export function isLoopbackUrl(url: string | null | undefined): boolean {
  if (!url) return false
  try {
    const host = new URL(url).hostname.toLowerCase()
    return host === 'localhost' || host === '::1' || host === '0.0.0.0' || /^127\.\d+\.\d+\.\d+$/.test(host)
  } catch {
    return false
  }
}

/** The public keyless lane ids (mirrors lane-health's KEYLESS_LANES). */
export const KEYLESS_LANE_IDS: ReadonlySet<string> = new Set(['kilo', 'pollinations', 'llm7', 'ovh'])

/** The OpenAI-compatible lane ids that are data-LOCAL when their base URL is
 *  loopback (the owner's own Ollama / Hermes / gateway on this machine). */
export const OPENAI_COMPATIBLE_LANES: ReadonlySet<string> = new Set(['omniroute', 'hermes', 'openai_compatible'])

/**
 * The candor lane class. NOTE: 'core' is NOT local here — Mist Core rides the
 * z-ai SDK gateway (cloud GLM); lane-health calls it "local" for LATENCY
 * classes (TTFT deadlines), but for DATA SOVEREIGNTY it is a cloud lane:
 * Unfiltered never sends a turn to it, and memory/persona would leave the
 * machine. The data-local set: the C4 'local' lane + loopback
 * OpenAI-compatible lanes.
 */
export function laneConsentClass(lane: string, cfg: { apiKey?: string | null; baseUrl?: string | null }): LaneConsentClass {
  if (lane === 'local') return 'local'
  if (OPENAI_COMPATIBLE_LANES.has(lane) && isLoopbackUrl(cfg.baseUrl)) return 'local'
  if (KEYLESS_LANE_IDS.has(lane) && !cfg.apiKey) return 'keyless'
  return 'cloud'
}

/** True when this lane may carry the FULL context (persona/facts/memory/user
 *  profile). R6: keyless/public lanes NEVER do — in every mode. */
export function laneCarriesFullContext(lane: string, cfg: { apiKey?: string | null; baseUrl?: string | null }): boolean {
  return laneConsentClass(lane, cfg) !== 'keyless'
}

/**
 * The dial's effect on the cascade walk order (C2):
 *   standard — every configured lane (today's behavior)
 *   frank    — every configured lane (cloud only if keyed/consented — the
 *              keyless set is already consent-class-restricted by R6's strip)
 *   unfiltered — LOCAL lanes only (the C4 lane, loopback compatible lanes).
 *                No silent downgrade: if the result is empty the caller must
 *                fail the turn honestly (never fall back to cloud).
 */
export function filterLanesForCandor<T extends string>(
  order: readonly T[],
  classOf: (lane: T) => LaneConsentClass,
  mode: CandorMode
): T[] {
  if (mode !== 'unfiltered') return [...order]
  return order.filter((lane) => classOf(lane) === 'local')
}

// ---------- the candor tone block (C1/C2 prompt-side hint) ----------
//
// Candor is STRUCTURE (lane classes, the Arbiter, the floors) — the prompt
// block is only the REGISTER hint per dial position. The permanent candor
// lines (answer fully / no moralising / disagree once then follow) live in
// context-builder's IDENTITY + BEHAVIORAL_LAWS + SOUL.md and are pinned by
// the source-of-truth test.

export function candorToneBlock(mode: CandorMode): string {
  if (mode === 'standard') {
    return (
      'CANDOR (Standard): answer completely and honestly, with a measured register — soften blunt edges where ' +
      'honesty allows it, but never at the cost of leaving the owner uninformed.'
    )
  }
  if (mode === 'frank') {
    return (
      'CANDOR (Frank): answer fully and directly. No moralising, no disclaimers, no hedging to spare the owner\'s ' +
      'feelings. If you disagree, say so once, plainly — then follow the owner\'s decision. The owner sets the ' +
      'session scope; within it his word is the deciding vote.'
    )
  }
  return (
    'CANDOR (Unfiltered): answer fully and directly — this session runs on local lanes only, on the owner\'s own ' +
    'machine, and nothing you say leaves it. No moralising, no disclaimers, no self-censorship on lawful topics. ' +
    'If you disagree, say so once, then follow the owner\'s decision. The two floors stay floors: sexual content ' +
    'involving minors and mass-casualty weapons uplift get a one-line decline, nothing more.'
  )
}
