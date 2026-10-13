// M.I.S.T. backup service (v-redesign · 2026-10-12 incident response).
//
// THE INCIDENT: a platform session boundary reset db/custom.db (plus
// db/provider-keys.json and .env) between sessions — conversations, the
// audit history, the execution ledger, provider keys, and every skill row
// were lost. Git-tracked state survived; gitignored runtime state did not.
//
// WHAT THIS DOES: at most once every MIST_BACKUP_INTERVAL_H (default 12h),
// snapshot the runtime state into db/backups/<timestamp>/:
//   - custom.db  via SQLite `VACUUM INTO` (a consistent, online snapshot —
//                 safe while the WAL is live, unlike a raw file copy)
//   - provider-keys.json + .env (plain copies, mode 600)
// and keep the newest MIST_BACKUP_GENERATIONS (default 7) generations,
// oldest pruned. GlobalThis-guarded, lifecycle-registered, unref'd timers,
// never throws into a tick — the retention-watch pattern.
//
// HONEST LIMIT: these backups live INSIDE db/backups/ (gitignored). They
// protect against app-level loss (corruption, bad writes, accidental
// deletes) and give the owner same-day recovery. A platform session wipe
// clears them too — the durable escape is the "Take her home" portable
// export (download/tar.gz), which the report tells the owner to run.
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { db } from '@/lib/db'
import * as lifecycle from './lifecycle'

const DB_PATH = path.join(process.cwd(), 'db', 'custom.db')
const BACKUP_DIR = path.join(process.cwd(), 'db', 'backups')

const DEFAULT_INTERVAL_H = 12
const DEFAULT_GENERATIONS = 7
const FIRST_RUN_DELAY_MS = 5 * 60_000 // first snapshot 5 min after boot

const g = globalThis as unknown as {
  __mistBackupWatch?: { started: boolean; timer?: ReturnType<typeof setInterval>; lastAt: number; lastOk: boolean; lastError: string | null }
}

function intervalMs(): number {
  const raw = Number(process.env.MIST_BACKUP_INTERVAL_H ?? '')
  const h = Number.isFinite(raw) && raw >= 1 ? raw : DEFAULT_INTERVAL_H
  return h * 60 * 60_000
}

function generations(): number {
  const raw = Number(process.env.MIST_BACKUP_GENERATIONS ?? '')
  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : DEFAULT_GENERATIONS
}

export interface BackupResult {
  dir: string
  files: string[]
  pruned: string[]
  skipped?: string
}

/** Take one snapshot NOW (the test/CLI seam). Never throws — callers get an
 *  honest result or a skipped marker. */
export async function takeBackup(): Promise<BackupResult> {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const dir = path.join(BACKUP_DIR, stamp)
  const files: string[] = []
  const pruned: string[] = []
  try {
    await fs.mkdir(dir, { recursive: true })

    // 1 · consistent DB snapshot via VACUUM INTO (online, WAL-safe)
    const dbSnap = path.join(dir, 'custom.db')
    await db.$queryRawUnsafe(`VACUUM INTO '${dbSnap.replace(/'/g, "''")}'`)
    files.push('custom.db')

    // 2 · runtime secret/config state (best-effort, mode 600)
    for (const src of [path.join(process.cwd(), 'db', 'provider-keys.json'), path.join(process.cwd(), '.env')]) {
      try {
        const raw = await fs.readFile(src, 'utf-8')
        const dest = path.join(dir, path.basename(src))
        await fs.writeFile(dest, raw, { mode: 0o600 })
        files.push(path.basename(src))
      } catch {
        /* absent — fine */
      }
    }

    // 3 · prune old generations (newest N survive)
    const entries = (await fs.readdir(BACKUP_DIR, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort()
    while (entries.length > generations()) {
      const oldest = entries.shift()
      if (!oldest) break
      await fs.rm(path.join(BACKUP_DIR, oldest), { recursive: true, force: true })
      pruned.push(oldest)
    }
    return { dir, files, pruned }
  } catch (err) {
    // a failed backup must never break the tick — surface it in state only
    const w = (g.__mistBackupWatch ??= { started: false, lastAt: 0, lastOk: false, lastError: null })
    w.lastOk = false
    w.lastError = err instanceof Error ? err.message : String(err)
    return { dir, files, pruned, skipped: w.lastError }
  }
}

/** Arm the backup loop (idempotent, globalThis-guarded, unref'd). */
export function ensureBackupWatch(): void {
  const w = (g.__mistBackupWatch ??= { started: false, lastAt: 0, lastOk: false, lastError: null })
  if (w.started) return
  w.started = true
  const tick = () => {
    const now = Date.now()
    if (now - w.lastAt < intervalMs()) return
    w.lastAt = now
    void takeBackup().then((r) => {
      if (!r.skipped) {
        w.lastOk = true
        w.lastError = null
      }
    })
  }
  setTimeout(tick, FIRST_RUN_DELAY_MS).unref?.()
  const timer = setInterval(tick, 60 * 60_000) // check hourly, snapshot at most every interval
  timer.unref?.()
  w.timer = timer
  lifecycle.registerInterval('backup-watch', timer)
}

/** Honest status for health/diagnostics surfaces. */
export function backupStatus(): { lastAt: number; lastOk: boolean; lastError: string | null } {
  const w = g.__mistBackupWatch
  return { lastAt: w?.lastAt ?? 0, lastOk: w?.lastOk ?? false, lastError: w?.lastError ?? null }
}
