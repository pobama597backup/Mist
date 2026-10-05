// M.I.S.T. telemetry — CPU / RAM / disk / process sampling
// CPU is sampled twice 120ms apart; module-level cache of 1s avoids per-request cost.
import os from 'node:os'
import fs from 'node:fs/promises'
import type { TelemetryResponse } from '@/lib/types'

const PROJECT_ROOT = process.cwd()

let cache: { at: number; data: TelemetryResponse } | null = null

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n))
}

function round(n: number, digits = 1): number {
  const f = 10 ** digits
  return Math.round(n * f) / f
}

export async function getTelemetry(): Promise<TelemetryResponse> {
  if (cache && Date.now() - cache.at < 1000) return cache.data

  // --- CPU: two samples of per-core times, 120ms apart ---
  const first = os.cpus()
  await new Promise((resolve) => setTimeout(resolve, 120))
  const second = os.cpus()
  let totalDiff = 0
  let idleDiff = 0
  for (let i = 0; i < Math.min(first.length, second.length); i++) {
    const a = first[i]?.times
    const b = second[i]?.times
    if (!a || !b) continue
    const td =
      b.user - a.user + (b.nice - a.nice) + (b.sys - a.sys) + (b.idle - a.idle) + (b.irq - a.irq)
    totalDiff += td
    idleDiff += b.idle - a.idle
  }
  const cpuPercent = totalDiff > 0 ? clamp((1 - idleDiff / totalDiff) * 100, 0, 100) : 0

  // --- RAM ---
  const totalMem = os.totalmem()
  const freeMem = os.freemem()
  const ramUsedMb = (totalMem - freeMem) / 1024 / 1024
  const ramPercent = totalMem > 0 ? ((totalMem - freeMem) / totalMem) * 100 : 0

  // --- Disk (statfs on project root) ---
  let diskPercent = 0
  let diskUsedGb = 0
  let diskTotalGb = 0
  try {
    const stat = await fs.statfs(PROJECT_ROOT)
    diskTotalGb = (Number(stat.blocks) * Number(stat.bsize)) / 1024 ** 3
    diskUsedGb = ((Number(stat.blocks) - Number(stat.bfree)) * Number(stat.bsize)) / 1024 ** 3
    diskPercent = diskTotalGb > 0 ? (diskUsedGb / diskTotalGb) * 100 : 0
  } catch {
    // statfs unavailable — leave zeros
  }

  // --- Process ---
  const rssMb = process.memoryUsage().rss / 1024 / 1024

  const data: TelemetryResponse = {
    cpu_percent: round(cpuPercent),
    ram_percent: round(ramPercent),
    ram_used_mb: round(ramUsedMb),
    ram_total_mb: round(totalMem / 1024 / 1024),
    disk_percent: round(diskPercent),
    disk_used_gb: round(diskUsedGb, 2),
    disk_total_gb: round(diskTotalGb, 2),
    rss_mb: round(rssMb),
    uptime_s: round(process.uptime(), 1),
    platform: os.platform(),
    node_version: process.version,
    hostname: os.hostname(),
  }

  cache = { at: Date.now(), data }
  return data
}

/** Project root used for disk sampling (also used by file tools as an allowed root). */
export function projectRoot(): string {
  return PROJECT_ROOT
}
