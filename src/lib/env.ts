// Machine awareness — she knows where she is.
//
// She was born in the build sandbox at /home/z/my-project. Cloned anywhere
// else (a PC, another box), she detects it on boot, remembers every machine
// she has ever woken up on (db/environment.json — machine-local state, never
// committed), and any surface that cares (status-bar chip, welcome briefing,
// /api/mist/environment) can ask.
//
// Deliberately PURE node (os + fs only — no DB, no services) so any route or
// service can call it without dependency weight. Every value is computed
// from the LIVE machine — nothing is cached from a past boot.

import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

/** Where she was born and raised (the build sandbox). */
export const BIRTHPLACE = '/home/z/my-project'
/** Where she is running right now (resolved, never hardcoded). */
export const ROOT = process.cwd()
/** Hostname of the machine she is on. */
export const HOSTNAME = os.hostname()
/** Human platform label, e.g. "Linux 6.1 · x64" / "Windows_NT 10.0 · x64". */
export const PLATFORM = `${os.type()} ${os.release()} · ${os.arch()}`
/** True when she is still on her birth machine. */
export const IS_HOME = ROOT === BIRTHPLACE

const STATE_FILE = path.join(ROOT, 'db', 'environment.json')

export interface MachineRecord {
  id: string
  hostname: string
  platform: string
  root: string
  firstBootAt: string
  lastBootAt: string
  boots: number
}

export interface EnvironmentInfo {
  isHome: boolean
  hostname: string
  platform: string
  root: string
  birthplace: string
  machineId: string
  /** machines she has ever woken on (that this install knows about) */
  machines: number
  /** first boot on THIS machine within the boot window — the "I'm not home" moment */
  firstBoot: boolean
  /** boot count on this machine */
  boots: number
  cpus: number
  memoryMB: number
  uptimeSec: number
}

/** Stable per-machine fingerprint (hostname + platform + cpu + ram, FNV-1a). */
export function machineId(): string {
  const cpu = os.cpus()[0]?.model ?? 'unknown-cpu'
  const raw = `${HOSTNAME}|${os.type()}|${os.arch()}|${cpu}|${os.totalmem()}`
  let h = 0x811c9dc5
  for (let i = 0; i < raw.length; i++) {
    h ^= raw.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}

interface EnvState {
  machines: MachineRecord[]
}

function readState(): EnvState {
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8')) as EnvState
    return Array.isArray(raw.machines) ? raw : { machines: [] }
  } catch {
    return { machines: [] }
  }
}

// write throttle — the state file is touched at most every 6h (plus once per
// new machine), so polling this function is effectively free.
let lastWriteAt = 0

/**
 * Detect + record the machine she just woke up on. One tiny JSON read per
 * call; `firstBoot` stays true for the whole boot window (15 min) so every
 * caller in one boot (status bar, welcome, API) sees the same answer.
 */
export function getEnvironment(): EnvironmentInfo {
  const id = machineId()
  const state = readState()
  const nowIso = new Date().toISOString()
  const now = Date.now()

  let rec = state.machines.find((m) => m.id === id)
  if (!rec) {
    rec = { id, hostname: HOSTNAME, platform: PLATFORM, root: ROOT, firstBootAt: nowIso, lastBootAt: nowIso, boots: 0 }
    state.machines.push(rec)
  }
  rec.boots += 1
  rec.lastBootAt = nowIso

  const firstBoot = rec.boots === 1 && now - Date.parse(rec.firstBootAt) < 15 * 60_000

  // write when a machine is brand new, or on the 6h heartbeat
  if (rec.boots === 1 || lastWriteAt === 0 || now - lastWriteAt > 6 * 3600_000) {
    lastWriteAt = now
    try {
      fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true })
      fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2))
    } catch {
      /* read-only fs — awareness still works, just not persisted */
    }
  }

  return {
    isHome: IS_HOME,
    hostname: HOSTNAME,
    platform: PLATFORM,
    root: ROOT,
    birthplace: BIRTHPLACE,
    machineId: id,
    machines: state.machines.length,
    firstBoot,
    boots: rec.boots,
    cpus: os.cpus().length,
    memoryMB: Math.round(os.totalmem() / 1024 / 1024),
    uptimeSec: Math.round(process.uptime()),
  }
}
