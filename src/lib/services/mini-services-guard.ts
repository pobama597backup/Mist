// M.I.S.T. mini-services guard — keep neural/mesh/pilot alive (Phase 1 ops).
//
// WHY THIS EXISTS (same reason as mini-services/dev-guard): this sandbox
// reaps every process spawned inside an agent tool-command at the command
// boundary — a `setsid nohup bun run dev &` from a shell dies seconds later.
// Processes spawned by BOOT-SESSION descendants survive. The Next dev
// server is one (dev-guard child), and /api/mist/health is probed by
// dev-guard every 45s — so a guarded spawner called from the health route
// resurrects a dead mini-service within one probe interval, forever, from
// inside the surviving process tree.
//
// Contract: only spawns when a port is DOWN (never double-spawns a live
// service), throttled to one sweep per 30s, best-effort, never throws.
import { spawn } from 'node:child_process'
import net from 'node:net'
import path from 'node:path'

interface MiniServiceSpec {
  /** directory name under mini-services/ */
  name: string
  /** loopback port the service must be listening on */
  port: number
}

const SERVICES: MiniServiceSpec[] = [
  { name: 'neural-service', port: 3003 },
  { name: 'mesh-service', port: 3004 },
  { name: 'browser-pilot', port: 3030 },
]

const SWEEP_MS = 30_000

let lastSweep = 0
let sweeping = false

/** TCP-connect liveness probe on loopback (true = something is listening). */
function portAlive(port: number, timeoutMs = 1_500): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket()
    const done = (ok: boolean) => {
      socket.removeAllListeners()
      socket.destroy()
      resolve(ok)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
    socket.connect(port, '127.0.0.1')
  })
}

/** Spawn `bun run dev` for a service, detached — the parent is THIS Next
 * server process (a surviving boot-session descendant), so the child is not
 * reaped at tool-command boundaries. */
function spawnService(spec: MiniServiceSpec): void {
  const cwd = path.join(process.cwd(), 'mini-services', spec.name)
  try {
    const child = spawn('bun', ['run', 'dev'], {
      cwd,
      detached: true,
      stdio: 'ignore',
    })
    child.unref()
    console.log(`[mini-services-guard] ${spec.name} down on :${spec.port} — spawned bun run dev (pid ${child.pid})`)
  } catch (err) {
    console.log(
      `[mini-services-guard] ${spec.name} spawn failed: ${err instanceof Error ? err.message : String(err)}`
    )
  }
}

/** Called from /api/mist/health (probed every 45s by dev-guard). Idempotent,
 * throttled, never throws — a dead mini-service comes back within ~45s. */
export async function ensureMiniServices(): Promise<void> {
  if (sweeping || Date.now() - lastSweep < SWEEP_MS) return
  sweeping = true
  lastSweep = Date.now()
  try {
    for (const spec of SERVICES) {
      if (await portAlive(spec.port)) continue
      spawnService(spec)
    }
  } catch {
    /* never break the health probe */
  } finally {
    sweeping = false
  }
}
