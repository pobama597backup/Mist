// M.I.S.T. Arbiter · hash-chained, append-only audit log (Phase 2-a).
//
// Every arbitrate() verdict lands here as one row: seq (1, 2, 3…), the
// previous row's hash, and hash = sha256(prevHash|seq|ts|tool|risk|origin|
// tainted|decision|reason|argsJson). Tampering with any row breaks the chain
// and verifyAuditChain() names the exact seq. Appends are serialized through
// an in-process promise queue because Prisma's autoincrement() only works on
// Int @id in SQLite — seq = MAX(seq)+1 inside the serialized section. The
// @unique on seq makes a cross-process race fail loudly, never silently.
//
// DELIBERATELY APPEND-ONLY: this module exports no delete and no update.
// Rewriting decision history (retention, erasure) is an owner decision, not
// an agent capability. pruneNothing() exists to make that policy greppable.

import { createHash } from 'node:crypto'
import type { AuditEvent } from '@prisma/client'
import { db, withRetry } from '@/lib/db'
import type { RiskClass } from './risk-table'
import type { Decision, Origin } from './arbiter'

export const GENESIS_HASH = '0'.repeat(64)

export interface AuditEventInput {
  tool: string
  argsJson?: string
  risk: RiskClass
  origin: Origin
  tainted?: boolean
  decision: Decision
  reason?: string
  ticket?: string | null
  turnId?: string | null
  orderRef?: string | null
  ts?: Date
}

export interface ChainCheck {
  ok: boolean
  brokenAt?: number
  reason?: string
}

interface ChainFields {
  prevHash: string
  seq: number
  ts: string
  tool: string
  risk: string
  origin: string
  tainted: boolean
  decision: string
  reason: string
  argsJson: string
}

/** THE chain hash — sha256(prevHash|seq|ts|tool|risk|origin|tainted|decision|
 * reason|argsJson). Phase 6-a: exported so the audit READ route recomputes
 * row hashes with the exact append-time function — the tamper-evidence
 * surface must never trust stored hashes, so it must never duplicate the
 * recipe either (a drifted copy would verify nothing). */
export function chainHash(f: ChainFields): string {
  return createHash('sha256')
    .update(
      `${f.prevHash}|${f.seq}|${f.ts}|${f.tool}|${f.risk}|${f.origin}|${f.tainted}|${f.decision}|${f.reason}|${f.argsJson}`
    )
    .digest('hex')
}

let appendQueue: Promise<unknown> = Promise.resolve()

export function appendAuditEvent(evt: AuditEventInput): Promise<AuditEvent> {
  const run = appendQueue.then(() => appendNow(evt))
  // the queue must never poison: a failed append is retried by the caller,
  // the next append still gets a clean shot at MAX(seq)
  appendQueue = run.then(
    () => undefined,
    () => undefined
  )
  return run
}

async function appendNow(evt: AuditEventInput): Promise<AuditEvent> {
  const ts = evt.ts ?? new Date()
  const argsJson = evt.argsJson ?? '{}'
  const reason = evt.reason ?? ''
  const tainted = evt.tainted ?? false
  // Phase 3-a · R9: the seq read + row insert are ONE transaction (the
  // read-modify-write was the last place two appends could interleave and
  // burn a seq), and the whole append rides withRetry for SQLITE_BUSY/P2034
  // — the one write path that serializes under load.
  // Phase 5 fix: EXPLICIT transaction options. The DEFAULT 5s interactive-tx
  // timeout expired under suite load (dev-server compile + parallel writers
  // stalled the findFirst >5s → "Transaction already closed" → the audit row
  // silently lost + the caller's route stalled 5s). 15s timeout / 5s
  // queue-wait rides out real stalls while staying bounded; the append itself
  // is two fast statements, so the honest-path cost is unchanged.
  return withRetry(() =>
    db.$transaction(
      async (tx) => {
        const head = await tx.auditEvent.findFirst({ orderBy: { seq: 'desc' }, select: { seq: true, hash: true } })
        const seq = (head?.seq ?? 0) + 1
        const prevHash = head?.hash ?? GENESIS_HASH
        const hash = chainHash({
          prevHash,
          seq,
          ts: ts.toISOString(),
          tool: evt.tool,
          risk: evt.risk,
          origin: evt.origin,
          tainted,
          decision: evt.decision,
          reason,
          argsJson,
        })
        return tx.auditEvent.create({
          data: {
            seq,
            ts,
            tool: evt.tool,
            argsJson,
            risk: evt.risk,
            origin: evt.origin,
            tainted,
            decision: evt.decision,
            reason,
            ticket: evt.ticket ?? null,
            turnId: evt.turnId ?? null,
            orderRef: evt.orderRef ?? null,
            prevHash,
            hash,
          },
        })
      },
      { timeout: 15_000, maxWait: 5_000 }
    )
  )
}

/** Rehash walk over the chain (most recent `limit` rows when given). */
export async function verifyAuditChain(limit?: number): Promise<ChainCheck> {
  let rows = await db.auditEvent.findMany({ orderBy: { seq: 'asc' } })
  if (typeof limit === 'number' && limit > 0) rows = rows.slice(-limit)
  let prevHash = GENESIS_HASH
  let prevSeq = 0
  for (const row of rows) {
    if (row.seq !== prevSeq + 1) {
      return { ok: false, brokenAt: row.seq, reason: `seq gap before ${row.seq} — rows were removed` }
    }
    if (row.prevHash !== prevHash) {
      return { ok: false, brokenAt: row.seq, reason: `prev-hash mismatch at seq ${row.seq}` }
    }
    const expect = chainHash({
      prevHash: row.prevHash,
      seq: row.seq,
      ts: row.ts.toISOString(),
      tool: row.tool,
      risk: row.risk,
      origin: row.origin,
      tainted: row.tainted,
      decision: row.decision,
      reason: row.reason,
      argsJson: row.argsJson,
    })
    if (expect !== row.hash) {
      return { ok: false, brokenAt: row.seq, reason: `hash mismatch at seq ${row.seq} — row modified after append` }
    }
    prevHash = row.hash
    prevSeq = row.seq
  }
  return { ok: true }
}

/** Append-only policy marker — does nothing, deletes nothing, by design. */
export function pruneNothing(): void {
  /* intentionally empty */
}
