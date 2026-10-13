// M.I.S.T. Arbiter · per-turn execution context (Phase 2-b wiring).
//
// The executeTool wrapper opens an "arbiter turn" around executeToolCore; the
// deep internals (tool exec → bridgeAction → bridgeExec) read it through
// AsyncLocalStorage to know (a) WHO originated the call (origin, turnId) and
// (b) that the Arbiter already ALLOWED this tool call — the only condition
// under which bridgeExec may mint a one-time actuator ticket for the exact
// action+args it is about to send. Losing the context (e.g. a module-registry
// split in dev) fails CLOSED: bridgeExec re-arbitrates the raw action, which
// asks — never auto-allows.
//
// This module also owns the CANONICAL SERIALIZATION for ticket argsHashes.
// The bridge daemon (db/bridge/mist-bridge.js) implements the IDENTICAL
// function in plain JS — the spec is frozen here, both sides carry the same
// comment, and the round-trip is pinned by tests/security/wiring.test.ts:
//
//   stableStringify(v):
//     undefined            → "null"            (JSON.stringify drops it in objects; arrays keep a null slot)
//     null / non-object    → JSON.stringify(v) (numbers/strings/bools)
//     Array                → "[" + items.map(stableStringify).join(",") + "]"
//     Object               → "{" + keys.sort() → JSON.stringify(key) + ":" + stableStringify(value),
//                            joined with "," — UNDEFINED-VALUED KEYS ARE SKIPPED
//                            (mirrors JSON.stringify, so the hash is over exactly
//                            the bytes the bridge receives after body serialization)

import { createHash } from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import type { Origin } from './arbiter'

export interface ArbiterTurn {
  /** who caused this tool call (owner_chat | owner_voice | …) */
  origin: Origin
  /** taint + audit join key (conversation turn, mission id, …) */
  turnId: string
  /** the wrapper's arbitrate() said allow for THIS tool call */
  arbiterAllowed: boolean
  /** tickets minted by bridgeExec inside this turn (audit-recorded) */
  mintedTickets: string[]
  /** Phase 3-a · R1: the owner's AbortSignal for this turn (unified's
   *  request signal). bridgeExec reads it through the context so the ~19
   *  tool exec fns never change signature — aborting it kills in-flight
   *  bridge fetches with honest exec/read semantics. */
  signal?: AbortSignal
}

const turnStore = new AsyncLocalStorage<ArbiterTurn>()

/** Run `fn` inside an arbiter turn — the wrapper's allow rides along every
 *  internal bridgeExec the tool makes. */
export function runWithArbiterTurn<T>(turn: ArbiterTurn, fn: () => Promise<T>): Promise<T> {
  return turnStore.run(turn, fn)
}

/** The active turn, or null outside a wrapper-allowed execution. */
export function currentArbiterTurn(): ArbiterTurn | null {
  return turnStore.getStore() ?? null
}

/** bridgeExec notes each ticket it mints so the wrapper's audit row can
 *  record the ticket that actually rode the bridge call. */
export function noteMintedTicket(ticket: string): void {
  const turn = turnStore.getStore()
  if (turn && turn.mintedTickets.length < 8) turn.mintedTickets.push(ticket)
}

// ---------- canonical serialization (frozen spec — see header) ----------

export function stableStringify(v: unknown): string {
  if (v === undefined) return 'null'
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null'
  if (Array.isArray(v)) return `[${v.map((item) => stableStringify(item)).join(',')}]`
  const obj = v as Record<string, unknown>
  const parts: string[] = []
  for (const key of Object.keys(obj).sort()) {
    if (obj[key] === undefined) continue // JSON.stringify parity
    parts.push(`${JSON.stringify(key)}:${stableStringify(obj[key])}`)
  }
  return `{${parts.join(',')}}`
}

/** sha256 hex of the canonical serialization — the ticket's argsHash. */
export function ticketArgsHash(args: Record<string, unknown> | undefined | null): string {
  return createHash('sha256').update(stableStringify(args ?? {})).digest('hex')
}
