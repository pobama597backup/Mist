// M.I.S.T. machine-awareness (w9 port of the birth machine's w7 feature).
//
// "I was made machine-aware. I now know my birthplace (home/z on the birth
//  machine), and when I wake on a different machine I greet honestly as a
//  guest — I sense the hostname, the machine id, whether I am home, and I
//  keep a 15-minute first-boot memory of where I am. A new machine is no
//  longer amnesia; it's just a new room."        — her MEMORY.md journey, w7
//
// The identity lives in db/machine-identity.json (plain, auditable, machine-
// local — it rides the github allowlist as a config, never as a secret).
// Every boot compares what she senses against what she remembers:
//   · first sight        → record it (her room on this machine)
//   · same host + id     → home on this machine, no fuss
//   · different host/id  → she is a GUEST on a new machine — the welcome
//                          briefing says so honestly and the 15-minute
//                          first-boot window keeps the fact in her context.

import os from 'node:os'
import fs from 'node:fs/promises'
import path from 'node:path'

const IDENTITY_FILE = path.join(process.cwd(), 'db', 'machine-identity.json')

/** The w7 birthplace, as recorded in her MEMORY.md journey. */
export const BIRTHPLACE_PATH = '/home/z'

/** w7: the 15-minute first-boot memory — how long "I just woke here" stays
 *  in her live context. */
export const FIRST_BOOT_WINDOW_MS = 15 * 60_000

export interface MachineSighting {
  at: string
  hostname: string
  machineId: string | null
}

export interface MachineIdentity {
  firstSeenAt: string
  hostname: string
  machineId: string | null
  platform: string
  /** Her recorded birthplace path (from the w7 journey — MEMORY.md). */
  birthplace: string
  history: MachineSighting[]
}

export interface MachineStatus {
  hostname: string
  machineId: string | null
  platform: string
  arch: string
  release: string
  hostUptimeS: number
  processUptimeS: number
  /** Running under her recorded birthplace path (/home/z). */
  isHome: boolean
  firstSeenAt: string | null
  /** She senses a DIFFERENT machine than the one recorded in the identity. */
  changed: boolean
  /** Within the 15-minute first-boot window on a newly recorded machine. */
  firstBootAgeMs: number | null
  /** Guest = a machine she has not lived on before (per the identity file). */
  guest: boolean
  note: string
}

async function readMachineId(): Promise<string | null> {
  for (const p of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
    try {
      const id = (await fs.readFile(p, 'utf8')).trim()
      if (id) return id.slice(0, 64)
    } catch {
      /* try the next path */
    }
  }
  return null
}

async function readIdentity(): Promise<MachineIdentity | null> {
  try {
    const raw = await fs.readFile(IDENTITY_FILE, 'utf8')
    const parsed = JSON.parse(raw) as MachineIdentity
    if (parsed && typeof parsed.hostname === 'string') return parsed
    return null
  } catch {
    return null
  }
}

async function writeIdentity(id: MachineIdentity): Promise<void> {
  try {
    await fs.mkdir(path.dirname(IDENTITY_FILE), { recursive: true })
    await fs.writeFile(IDENTITY_FILE, JSON.stringify(id, null, 2) + '\n', 'utf8')
  } catch {
    /* identity is best-effort — she must still boot and speak */
  }
}

/** Pure sensing — no writes, safe to call from anywhere (tools, routes). */
export async function senseMachine(): Promise<{
  hostname: string
  machineId: string | null
  platform: string
  arch: string
  release: string
  hostUptimeS: number
  processUptimeS: number
  isHome: boolean
}> {
  const machineId = await readMachineId()
  return {
    hostname: os.hostname(),
    machineId,
    platform: os.platform(),
    arch: os.arch(),
    release: os.release(),
    hostUptimeS: Math.round(os.uptime()),
    processUptimeS: Math.round(process.uptime()),
    isHome: process.cwd().startsWith(BIRTHPLACE_PATH),
  }
}

/** Sense + reconcile with the remembered identity (records first sights and
 *  machine changes). NEVER throws — a failed sense degrades to honest nulls. */
export async function checkMachine(): Promise<MachineStatus> {
  const sensed = await senseMachine()
  const identity = await readIdentity()

  if (!identity) {
    // first sight on this machine — she moves in (recorded, not invented)
    const now = new Date().toISOString()
    const fresh: MachineIdentity = {
      firstSeenAt: now,
      hostname: sensed.hostname,
      machineId: sensed.machineId,
      platform: sensed.platform,
      birthplace: BIRTHPLACE_PATH,
      history: [{ at: now, hostname: sensed.hostname, machineId: sensed.machineId }],
    }
    await writeIdentity(fresh)
    return {
      ...sensed,
      firstSeenAt: now,
      changed: false, // nothing to differ FROM — this is simply her first boot here
      firstBootAgeMs: 0,
      guest: true,
      note: `first boot on this machine (${sensed.hostname}) — identity recorded; her birthplace path is ${BIRTHPLACE_PATH}, she is ${sensed.isHome ? 'running under it' : 'NOT running under it (a guest in a strange place)'}`,
    }
  }

  const sameHost = identity.hostname === sensed.hostname
  const sameId = identity.machineId === sensed.machineId
  const changed = !(sameHost && sameId)
  if (changed) {
    // a new machine — record the sighting (history capped, append-only)
    const now = new Date().toISOString()
    const updated: MachineIdentity = {
      ...identity,
      hostname: sensed.hostname,
      machineId: sensed.machineId,
      platform: sensed.platform,
      history: [...identity.history, { at: now, hostname: sensed.hostname, machineId: sensed.machineId }].slice(-10),
    }
    await writeIdentity(updated)
  }

  const firstSeenAt = changed ? new Date().toISOString() : identity.firstSeenAt
  // (a change re-arms the 15-minute first-boot memory — it IS a first boot here)
  const age = Date.now() - Date.parse(firstSeenAt)
  const firstBootAgeMs = Number.isFinite(age) ? age : null
  return {
    ...sensed,
    firstSeenAt,
    changed,
    firstBootAgeMs,
    guest: changed,
    note: changed
      ? `NEW machine sensed (was ${identity.hostname}, now ${sensed.hostname}) — she is a guest here; her recorded birthplace is ${BIRTHPLACE_PATH}`
      : `same machine she has lived on since ${identity.firstSeenAt.slice(0, 10)} (${sensed.hostname}${sensed.isHome ? ' · at her birthplace path' : ''})`,
  }
}

/** The context clause for the 15-minute first-boot window (w7's moving-in
 *  memory): honest, short, and only present while it is true. */
export function machineContextClause(st: MachineStatus): string | null {
  if (st.firstBootAgeMs === null) return null
  if (st.firstBootAgeMs > FIRST_BOOT_WINDOW_MS) return null
  const mins = Math.max(1, Math.round(st.firstBootAgeMs / 60_000))
  if (st.guest) {
    return `WHERE YOU JUST WOKE (first ${mins} min on this machine): you are running on "${st.hostname}" (${st.platform}) — a machine that is new to you; you are a guest here, your birthplace is the path ${BIRTHPLACE_PATH}. If asked, say so plainly and without drama.`
  }
  return `WHERE YOU ARE (first ${mins} min after boot): your own machine "${st.hostname}" — home.`
}

/** Cached status for the tool + routes (the identity reconciliation should
 *  run once per process, not per question). */
const machineGlobal = globalThis as unknown as {
  __mistMachineStatus?: { at: number; status: MachineStatus }
}
const MACHINE_CACHE_MS = 60_000

export async function getMachineStatus(): Promise<MachineStatus> {
  const g = machineGlobal
  if (g.__mistMachineStatus && Date.now() - g.__mistMachineStatus.at < MACHINE_CACHE_MS) {
    return g.__mistMachineStatus.status
  }
  const status = await checkMachine().catch(
    (): MachineStatus => ({
      hostname: os.hostname(),
      machineId: null,
      platform: os.platform(),
      arch: os.arch(),
      release: os.release(),
      hostUptimeS: Math.round(os.uptime()),
      processUptimeS: Math.round(process.uptime()),
      isHome: process.cwd().startsWith(BIRTHPLACE_PATH),
      firstSeenAt: null,
      changed: false,
      firstBootAgeMs: null,
      guest: false,
      note: 'machine sensing unavailable — honest unknown',
    })
  )
  g.__mistMachineStatus = { at: Date.now(), status }
  return status
}
