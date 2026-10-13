// M.I.S.T. retention service (Phase 4-b · P5) — caps on the unbounded tables.
//
// THE PROBLEM: FastReply, SpokenCache, Trace (+TraceStep), AutonomyEvent,
// KnowledgeChunk and Alert only ever GROW. A long-lived deployment slowly
// bloats the SQLite file and every uncapped scan (vectorSearch caps at 500
// rows by luck of ORDER BY, but count/list surfaces and the file itself do
// not). This service trims each table to an env-tunable cap on a slow loop
// (10 minutes, registered with the 3-a lifecycle registry, globalThis-guarded,
// unref'd — the heartbeat bootstrap pattern).
//
// TRIM POLICY (honest, per table):
//   FastReply      ≤ 500  LRU by updatedAt (Prisma bumps @updatedAt on every
//                         hit-increment, so recently-replayed rows survive)
//   SpokenCache    ≤ 400  oldest-first by createdAt (aligns the w3 in-line
//                         trim in voice-service to the same cap source)
//   Trace          ≤ 5000 oldest-first by createdAt; TraceStep follows via
//                  the schema's onDelete: Cascade (foreign_keys=ON since 3-a)
//   AutonomyEvent  ≤ 2000 oldest-first by createdAt
//   KnowledgeChunk ≤ 5000 oldest-first by createdAt
//   Alert          ≤ 400  oldest-first by createdAt (pending alerts deliver in
//                  minutes; an alert older than 400 newer ones is stale)
//
// VACUUM DISCIPLINE: after a pass that deleted > MIST_RETENTION_VACUUM_AFTER
// (default 1000) rows, PRAGMA wal_checkpoint(TRUNCATE) runs ONCE — not every
// tick. Checkpointing is opportunistic; a busy database simply skips it.
import { db } from '@/lib/db'
import { recordActivity } from './activity-service'
import * as lifecycle from './lifecycle'

function capFromEnv(name: string, fallback: number): number {
  const raw = Number(process.env[name] ?? '')
  return Number.isFinite(raw) && raw >= 10 ? Math.floor(raw) : fallback
}

export function retentionCaps(): Record<string, number> {
  return {
    fastReply: capFromEnv('MIST_RETENTION_FASTREPLY', 500),
    spokenCache: capFromEnv('MIST_RETENTION_SPOKENCACHE', 400),
    trace: capFromEnv('MIST_RETENTION_TRACE', 5000),
    autonomyEvent: capFromEnv('MIST_RETENTION_AUTONOMY', 2000),
    knowledgeChunk: capFromEnv('MIST_RETENTION_KNOWLEDGE', 5000),
    alert: capFromEnv('MIST_RETENTION_ALERT', 400),
  }
}

export interface RetentionTrimResult {
  model: string
  cap: number
  before: number
  after: number
  deleted: number
}

/** Trim ONE table to its cap, oldest-first. Exported as the test seam
 *  (seed → trim → assert) — production callers go through
 *  enforceRetentionCaps(). Returns the honest result (or a zero-delete
 *  result on error — retention must never break a tick). */
export async function trimModelToCap(
  model: 'fastReply' | 'spokenCache' | 'trace' | 'autonomyEvent' | 'knowledgeChunk' | 'alert',
  cap: number
): Promise<RetentionTrimResult> {
  const delegate = db[model] as {
    count(args?: unknown): Promise<number>
    findMany(args: unknown): Promise<Array<{ id: string }>>
    deleteMany(args: unknown): Promise<{ count: number }>
  }
  const before = await delegate.count({})
  if (before <= cap) return { model, cap, before, after: before, deleted: 0 }
  const overflow = before - cap
  const oldest = await delegate.findMany({
    orderBy: { createdAt: 'asc' },
    take: overflow,
    select: { id: true },
  })
  if (oldest.length === 0) return { model, cap, before, after: before, deleted: 0 }
  const res = await delegate.deleteMany({ where: { id: { in: oldest.map((o) => o.id) } } })
  const after = await delegate.count({})
  return { model, cap, before, after, deleted: res.count }
}

/** One retention pass over every capped table. NEVER throws. */
export async function enforceRetentionCaps(): Promise<RetentionTrimResult[]> {
  const caps = retentionCaps()
  const out: RetentionTrimResult[] = []
  let totalDeleted = 0
  for (const [model, cap] of Object.entries(caps) as Array<[keyof ReturnType<typeof retentionCaps>, number]>) {
    try {
      const r = await trimModelToCap(model as Parameters<typeof trimModelToCap>[0], cap)
      out.push(r)
      totalDeleted += r.deleted
    } catch {
      // one bad table must never block the others; the next tick retries
    }
  }
  // opportunistic WAL truncate after a BIG trim — keeps the -wal file from
  // outgrowing the db after long-running over-cap states. Not every tick.
  const vacuumAfter = capFromEnv('MIST_RETENTION_VACUUM_AFTER', 1000)
  if (totalDeleted > vacuumAfter) {
    try {
      await db.$queryRaw`PRAGMA wal_checkpoint(TRUNCATE)`
    } catch {
      /* a busy db refuses the checkpoint — fine, it is opportunistic */
    }
  }
  if (totalDeleted > 0) {
    recordActivity(
      'retention',
      `caps enforced: ${out.filter((r) => r.deleted > 0).map((r) => `${r.model} ${r.before}→${r.after}`).join(', ')}`
    )
  }
  return out
}

// ---------- the slow loop (10 min, lifecycle-registered) ----------

const RETENTION_INTERVAL_MS = 10 * 60_000
const FIRST_RUN_DELAY_MS = 2 * 60_000

const g = globalThis as unknown as {
  __mistRetentionWatch?: { started: boolean; timer?: ReturnType<typeof setInterval>; runs: number }
}

/** Arm the retention loop (idempotent, globalThis-guarded, unref'd). */
export function ensureRetentionWatch(): void {
  const w = (g.__mistRetentionWatch ??= { started: false, runs: 0 })
  if (w.started) return
  w.started = true
  const tick = () => {
    w.runs++
    void enforceRetentionCaps().catch(() => undefined)
  }
  setTimeout(tick, FIRST_RUN_DELAY_MS).unref?.()
  w.timer = setInterval(tick, RETENTION_INTERVAL_MS)
  w.timer.unref?.()
  lifecycle.registerInterval('retention-watch', w.timer)
}
