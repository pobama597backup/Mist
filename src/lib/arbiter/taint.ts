// M.I.S.T. Arbiter · taint tracking (Phase 2-a · S5b keystone).
//
// Per-turn registry of untrusted content snippets. The wiring marks a turn
// tainted when a network-risk tool ran or when output arrived from
// web/browser/mcp sources; from then on, arbitrate() never auto-allows a
// side effect for that turn (fresh one-time approval only — see arbiter.ts).
//
// HONEST LIMITS: matching is plain substring over JSON.stringify(args).
// That catches literal exfiltration/injection replay (the payload riding
// into a tool argument verbatim) and misses paraphrases. It is a keystone,
// not a panacea — the injection scanner (wrapUntrusted) and the trust tiers
// remain the other layers.

export interface TaintEntry {
  content: string
  source: string
  at: number
}

export interface TaintSummary {
  turnId: string
  snippets: number
  sources: string[]
  firstAt: number | null
  lastAt: number | null
}

const MAX_SNIPPETS_PER_TURN = 32
const MAX_SNIPPET_CHARS = 4096
const MIN_MATCHING_SNIPPET = 24 // shorter snippets would match everything

const registry = new Map<string, TaintEntry[]>()

/** Record untrusted content for a turn (capped: 32/turn, 4096 chars each —
 *  when the cap is hit the oldest snippet drops, keeping freshest evidence). */
export function markTainted(turnId: string, content: string, source: string): void {
  const list = registry.get(turnId) ?? []
  const snippet = content.length > MAX_SNIPPET_CHARS ? content.slice(0, MAX_SNIPPET_CHARS) : content
  if (list.length >= MAX_SNIPPETS_PER_TURN) list.shift()
  list.push({ content: snippet, source, at: Date.now() })
  registry.set(turnId, list)
}

/** JSON array of the turn's entries — for the wiring to persist a turn's
 *  taint across process restarts if it chooses to. */
export function serializeTaint(turnId: string): string {
  return JSON.stringify(registry.get(turnId) ?? [])
}

/** True when any stored snippet (≥ 24 chars) appears inside the serialized
 *  args — i.e. the untrusted payload is being replayed into a tool call. */
export function isTainted(turnId: string, args: Record<string, unknown>): boolean {
  const list = registry.get(turnId)
  if (!list || list.length === 0) return false
  const hay = JSON.stringify(args ?? {})
  return list.some((e) => e.content.length >= MIN_MATCHING_SNIPPET && hay.includes(e.content))
}

/** True when the turn carries ANY taint marks at all (Phase 2-c): internal
 *  auto-writes (fact remember, skill learning, cron creation) quarantine on
 *  this — untrusted content touched the turn, so everything the turn produced
 *  waits for the owner, not just verbatim replays. */
export function turnHasTaintMarks(turnId: string | null | undefined): boolean {
  if (!turnId) return false
  return (registry.get(turnId)?.length ?? 0) > 0
}

export function clearTaint(turnId: string): void {
  registry.delete(turnId)
}

export function taintSummary(turnId: string): TaintSummary {
  const list = registry.get(turnId) ?? []
  return {
    turnId,
    snippets: list.length,
    sources: [...new Set(list.map((e) => e.source))],
    firstAt: list.length > 0 ? list[0].at : null,
    lastAt: list.length > 0 ? list[list.length - 1].at : null,
  }
}
