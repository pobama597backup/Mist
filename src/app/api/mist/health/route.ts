import { NextResponse } from 'next/server'
import { ensureHeartbeatWatch } from '@/lib/services/heartbeat-service'
import { ensureEvolutionWatch } from '@/lib/services/evolution-service'
import { ensureOpenClawWatch } from '@/lib/services/openclaw-service'
import { ensureSchedulerWatch } from '@/lib/services/scheduler-service'
import { ensureLearningWatch } from '@/lib/services/learning-service'
import { ensureOjSyncWatch, ensureMarkLvSyncWatch } from '@/lib/oj/upstream-sync'
import { ensureProviderKeysRestored } from '@/lib/services/config-service'
import { ensureMiniServices } from '@/lib/services/mini-services-guard'
import { ensureRetentionWatch } from '@/lib/services/retention-service'
import { ensureBackupWatch } from '@/lib/services/backup-service'
import { outboundWatchersEnabled } from '@/lib/services/settings-service'
import { getGlobalCandorMode } from '@/lib/services/candor-service'
import { a4Status } from '@/lib/arbiter/unleash'
import { ensureEgressFlushWatch } from '@/lib/services/egress'
import { exec } from 'child_process'
import { promisify } from 'util'
import os from 'os'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const execAsync = promisify(exec)

async function getPort3000Pid(): Promise<number | null> {
  try {
    // Use lsof to find process on port 3000
    const { stdout } = await execAsync('lsof -ti:3000', { encoding: 'utf-8', timeout: 1000 })
    const output = stdout.trim()
    if (output) {
      const pids = output.split('\n').map(p => parseInt(p, 10)).filter(p => !isNaN(p))
      return pids[0] || null
    }
    return null
  } catch {
    return null
  }
}

function getEventLoopLag(): Promise<number> {
  return new Promise((resolve) => {
    const start = process.hrtime.bigint()
    setImmediate(() => {
      const end = process.hrtime.bigint()
      resolve(Number(end - start) / 1_000_000) // Convert to ms
    })
  })
}

function getRamUsageMB(): number {
  const used = process.memoryUsage().heapUsed
  return Math.round(used / 1024 / 1024)
}

export async function GET() {
  // Bootstrap background loops
  ensureHeartbeatWatch()
  ensureEvolutionWatch()
  ensureOpenClawWatch()
  ensureSchedulerWatch()
  ensureLearningWatch()
  ensureOjSyncWatch()
  ensureMarkLvSyncWatch() // mlv-rust-3: the Mark-LV (teacher's assistant) anti-rust watch
  void ensureProviderKeysRestored() // fire-and-forget: heal provider keys from db backup if the snapshot stubbed .env
  void ensureMiniServices() // fire-and-forget (Phase 1 ops): resurrect neural/mesh/pilot if a reaper cycle killed them
  void ensureRetentionWatch() // Phase 4-b · P5: retention caps on a slow loop
  ensureBackupWatch() // v-redesign incident response: runtime-state snapshots (custom.db + keys) into db/backups/
  ensureEgressFlushWatch() // Phase 5 · C6: the egress ledger's hourly snapshot timer

  const ram_mb = getRamUsageMB()
  const event_loop_lag_ms = await getEventLoopLag()
  const port_3000_pid = await getPort3000Pid()
  const [watchers, candorMode, a4] = await Promise.all([outboundWatchersEnabled(), getGlobalCandorMode(), a4Status()])

  return NextResponse.json({
    status: 'ok',
    service: 'mist-unified',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
    ram_mb,
    event_loop_lag_ms,
    port_3000_pid,
    uptime_seconds: process.uptime(),
    platform: os.platform(),
    node_version: process.version,
    // Phase 4-b · R5: the outbound-watchers opt-in, surfaced here so every
    // boot/status check answers "is this machine talking to the world right
    // now?" honestly (dormant default = zero outbound).
    watchers: {
      enabled: watchers,
      note: 'watchlist (npmjs/github 6h), oj-sync + mark-lv git watchers, openclaw digest, evolution auto-suggest — all idle while false',
    },
    // Phase 5 · C2/A6 — the dial + the unleash badge on every boot/status check
    candor: { mode: candorMode },
    a4: {
      active: a4.active,
      remainingMs: a4.active ? a4.remainingMs : 0,
      ...(a4.active && a4.scope ? { scope: a4.scope } : {}),
      passphraseRequired: a4.passphraseRequired,
    },
  })
}
