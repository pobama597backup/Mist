import { NextResponse } from 'next/server'
import { ensureHeartbeatWatch } from '@/lib/services/heartbeat-service'
import { ensureEvolutionWatch } from '@/lib/services/evolution-service'
import { ensureOpenClawWatch } from '@/lib/services/openclaw-service'
import { ensureSchedulerWatch } from '@/lib/services/scheduler-service'
import { ensureLearningWatch } from '@/lib/services/learning-service'
import { execSync } from 'child_process'
import os from 'os'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

function getPort3000Pid(): number | null {
  try {
    // Use lsof to find process on port 3000
    const output = execSync('lsof -ti:3000', { encoding: 'utf-8', timeout: 1000 }).trim()
    if (output) {
      const pids = output.split('\n').map(p => parseInt(p, 10)).filter(p => !isNaN(p))
      return pids[0] || null
    }
    return null
  } catch {
    return null
  }
}

function getEventLoopLag(): number {
  const start = process.hrtime.bigint()
  setImmediate(() => {})
  // Measure how long until the next tick
  const end = process.hrtime.bigint()
  return Number(end - start) / 1_000_000 // Convert to ms
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

  const ram_mb = getRamUsageMB()
  const event_loop_lag_ms = getEventLoopLag()
  const port_3000_pid = getPort3000Pid()

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
    node_version: process.version
  })
}
