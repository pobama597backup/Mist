import { PrismaClient } from '@prisma/client'

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
  /** Phase 3-a · R9 guard: PRAGMAs must run exactly once per PROCESS, not per
   *  module compile (dev hot-reload re-evaluates this file — the flag on
   *  globalThis survives and the second run is a no-op). */
  __mistDbPragmas?: boolean
}

export const db =
  globalForPrisma.prisma ??
  new PrismaClient({
    // Phase 1 · S9: 'query' logging flooded dev.log with every row (and
    // row CONTENT) — warnings and errors only.
    log: ['warn', 'error'],
  })

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = db

// ---------- Phase 3-a · R9: SQLite durability/concurrency PRAGMAs ----------
//
// The phase-0 audit found ZERO PRAGMAs on the connection: default journal
// mode (rollback journal, writer blocks readers), no busy_timeout (any lock
// contention surfaces as SQLITE_BUSY immediately), synchronous=FULL (every
// commit fsyncs), and foreign_keys OFF (SQLite default — the schema's
// onDelete: Cascade relations were never actually enforced by the engine).
//
//   journal_mode=WAL      → readers never block the writer (chat turns read
//                           while the audit chain appends)
//   busy_timeout=5000     → lock contention waits up to 5s before SQLITE_BUSY
//   synchronous=NORMAL    → the recommended WAL companion (durable across
//                           app crashes; only a power loss can lose the last
//                           checkpoint — the honest trade for this store)
//   foreign_keys=ON       → engine-level enforcement of the schema relations
//
// Applied once per process, right after client creation; a failure is logged
// (never thrown — the app still works with engine defaults, degraded).
// `dbReady` resolves when the PRAGMAs have been applied (tests await it
// before asserting journal_mode/foreign_keys).
async function applyPragmas(): Promise<void> {
  if (globalForPrisma.__mistDbPragmas) return
  globalForPrisma.__mistDbPragmas = true
  try {
    await db.$queryRaw`PRAGMA journal_mode=WAL`
    await db.$queryRaw`PRAGMA busy_timeout=5000`
    await db.$queryRaw`PRAGMA synchronous=NORMAL`
    await db.$queryRaw`PRAGMA foreign_keys=ON`
    console.log('[db] PRAGMAs applied: journal_mode=WAL, busy_timeout=5000, synchronous=NORMAL, foreign_keys=ON')
  } catch (err) {
    globalForPrisma.__mistDbPragmas = false // allow a later import to retry
    console.warn(
      `[db] PRAGMA application failed (engine defaults in effect): ${err instanceof Error ? err.message : String(err)}`
    )
  }
}

/** Resolves when the PRAGMAs have been applied (or honestly failed+logged). */
export const dbReady: Promise<void> = applyPragmas()

// ---------- Phase 3-a · R9: SQLITE_BUSY retry ----------
//
// WAL + busy_timeout removes almost all SQLITE_BUSY, but two writers in ONE
// process (the serialized audit append racing a message persist) can still
// surface Prisma P2034 ("Transaction failed due to a write conflict or a
// deadlock") / raw SQLITE_BUSY. withRetry retries ONLY that error class —
// 3 retries, 50/150/350ms ±20% jitter so concurrent retries don't march in
// lockstep. Adopted at the audit append (the one place writes serialize
// under load); other call sites adopt it incrementally — wrapping every
// query now would hide latency bugs the honest way surfaces them.
const RETRY_DELAYS_MS = [50, 150, 350]

function isBusyError(err: unknown): boolean {
  if (err && typeof err === 'object') {
    const e = err as { code?: unknown; message?: unknown }
    if (e.code === 'P2034') return true
    if (typeof e.message === 'string' && /SQLITE_BUSY|database is locked/i.test(e.message)) return true
  }
  return false
}

/** Run a Prisma operation, retrying SQLITE_BUSY/P2034 up to 3× with jittered
 *  backoff (initial try + 3 retries). Everything else propagates immediately
 *  — retrying a validation error would only burn the caller's time. */
export async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn()
    } catch (err) {
      if (!isBusyError(err) || attempt >= RETRY_DELAYS_MS.length) throw err
      const base = RETRY_DELAYS_MS[attempt]
      const jitter = base * (0.8 + Math.random() * 0.4) // ±20%
      await new Promise((r) => setTimeout(r, jitter))
    }
  }
}

// Extend Prisma Client with SkillExecution model
export type { SkillExecution } from '@prisma/client'
