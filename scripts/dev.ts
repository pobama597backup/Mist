// M.I.S.T. dev supervisor (Phase 3-a · mandate: "scripts/dev.ts supervisor").
//
// A THIN, DOCUMENTED wrapper — the real supervisor already exists:
// mini-services/dev-guard (spawned detached by the boot-session
// neural-service, so it survives this sandbox's tool-command reaper). It
// probes /api/mist/health every 45s and respawns `bun run dev` when down,
// with its own single-instance pidfile + /proc cmdline-ownership protocol.
// This script therefore does NOT double-spawn anything: `start` only ensures
// the GUARD is alive (the guard owns the dev server); it never spawns
// `next dev` directly.
//
// Usage:
//   bun run dev:supervised        (or: bun scripts/dev.ts start)
//   bun scripts/dev.ts status     — who is up: dev server, guard, bridge, mini-services
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import net from 'node:net'

const PROJECT = '/home/z/my-project'
const GUARD_PID_FILE = `${PROJECT}/mini-services/dev-guard/dev-guard.pid`
const HEALTH = 'http://127.0.0.1:3000/api/mist/health'
const BRIDGE_HEALTH = 'http://127.0.0.1:8734/health'

/** Same ownership test as the guard itself (pidfile + /proc cmdline must say
 *  dev-guard) — a bare kill(pid,0) false-positives on recycled tids here. */
function guardAlive(): { alive: boolean; pid: number | null } {
  try {
    const pid = Number.parseInt(readFileSync(GUARD_PID_FILE, 'utf-8').trim(), 10)
    if (!Number.isFinite(pid) || pid <= 0) return { alive: false, pid: null }
    const cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf-8')
    if (!cmdline.includes('dev-guard')) return { alive: false, pid: null }
    process.kill(pid, 0)
    return { alive: true, pid }
  } catch {
    return { alive: false, pid: null }
  }
}

function portAlive(port: number, timeoutMs = 1500): Promise<boolean> {
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

async function httpUp(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(3000) })
    return res.ok
  } catch {
    return false
  }
}

function spawnGuard(): void {
  // The guard exits instantly if its pidfile points at a live dev-guard
  // (its own takeover protocol) — spawning here can never double-spawn.
  const child = spawn('bun', ['run', 'dev', '-b', 'mini-services/dev-guard/index.ts'], {
    cwd: PROJECT,
    detached: true,
    stdio: 'ignore',
  })
  child.unref()
  console.log(`[dev.ts] dev-guard spawned (pid ${child.pid}) — it owns the dev server from here`)
}

async function start(): Promise<void> {
  const guard = guardAlive()
  if (guard.alive) {
    console.log(`[dev.ts] dev-guard already running (pid ${guard.pid}) — not double-spawning`)
  } else {
    if (existsSync(`${PROJECT}/.zscripts/dev-guard-disabled`)) {
      console.log('[dev.ts] NOTE: .zscripts/dev-guard-disabled exists — the guard will not act until it is removed')
    }
    spawnGuard()
  }
  const dev = await httpUp(HEALTH)
  console.log(`[dev.ts] dev server :3000 — ${dev ? 'UP (health 200)' : 'down (the guard respawns it within ~45s; grace 90s after a spawn)'}`)
}

async function status(): Promise<void> {
  const guard = guardAlive()
  const [dev, bridge, neural, mesh, pilot] = await Promise.all([
    httpUp(HEALTH),
    httpUp(BRIDGE_HEALTH),
    portAlive(3003),
    portAlive(3004),
    portAlive(3030),
  ])
  console.log('── M.I.S.T. dev status ──────────────────────')
  console.log(`dev server  :3000        ${dev ? 'UP' : 'DOWN'}`)
  console.log(`dev-guard   ${guard.alive ? `pid ${guard.pid}` : 'NOT RUNNING'}${guard.alive ? '' : ' (bun run dev:supervised to start)'}`)
  console.log(`bridge      :8734        ${bridge ? 'UP' : 'DOWN'}`)
  console.log(`neural      :3003        ${neural ? 'UP' : 'DOWN'}`)
  console.log(`mesh        :3004        ${mesh ? 'UP' : 'DOWN'}`)
  console.log(`browser-pilot :3030      ${pilot ? 'UP' : 'DOWN'}`)
  console.log(`guard disabled-flag     ${existsSync(`${PROJECT}/.zscripts/dev-guard-disabled`) ? 'SET (guard inert)' : 'clear'}`)
  console.log('─────────────────────────────────────────────')
}

const cmd = process.argv[2] ?? 'status'
if (cmd === 'start') {
  void start()
} else if (cmd === 'status') {
  void status()
} else {
  console.error('usage: bun scripts/dev.ts [start|status]   (start = ensure the guard; the guard owns the dev server)')
  process.exit(2)
}
