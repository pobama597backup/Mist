// M.I.S.T. dev-guard — emergency dev-server watchdog (added by task 12-a).
//
// WHY THIS EXISTS: on 2026-09-24 ~20:58 the sandbox OOM-killer terminated the
// Next dev server (:3000), and this environment reaps every process spawned
// from agent tool shells a few seconds after each call ends — so a normal
// restart would not survive. This guard is spawned (detached) by the
// boot-session neural-service, so IT and ITS CHILDREN survive the reaper
// (same pattern as the browser-pilot's playwright chromium).
//
// WHAT IT DOES (v3): every 12s it probes http://127.0.0.1:3000/api/mist/health.
// When down (and not in a spawn grace period, and no disable flag file), it
// respawns `bun run dev` in /home/z/my-project (the package.json dev script
// already pipes output to dev.log via tee, and caps the V8 heap at 1536MB so
// the kernel OOM-killer is a last resort instead of the routine).
//
// BRIDGE SUPERVISION (v2): when the marker file .zscripts/bridge-autostart
// exists (sandbox-only — NEVER created on a user PC), the guard also keeps
// the LOCAL sandbox bridge (node db/bridge/mist-bridge.js, :8734) alive, so
// her owner_files / ui_automate / system_watch tools have a body in the
// sandbox across reaper cycles. On a user's PC the bridge is started by
// run.bat / PC-SETUP and must NOT be spawned here (port collision).
//
// MINI-SERVICE SUPERVISION (v3, 2026-10-12): the sandbox boot chain sometimes
// spawns the neural/mesh/pilot services TWICE (double boot cycle). The second
// `bun --hot index.ts` fails to bind its port but never exits — each zombie
// burns 45-100MB on a 3.9GB no-swap box, which is exactly the memory pressure
// that OOM-kills the dev server and makes her "not open in the preview".
// Every tick the guard now sweeps each service dir: when the port is UP and
// more than one live worker exists, the OLDEST worker (the port binder in
// every real sequence) survives and the rest are SIGTERMed; when the port is
// DOWN, any surviving workers are non-listening zombies — killed — and ONE
// fresh worker is spawned (detached, logged to .zscripts/mini-service-*.log).
// Wrong kills self-correct on the next tick via the port check.
//
// HOW TO DISABLE: create the file /home/z/my-project/.zscripts/dev-guard-disabled
// (then kill this process). It never touches anything else.
import { spawn } from 'node:child_process'
import { existsSync, appendFileSync, writeFileSync, readFileSync, openSync, readdirSync, readlinkSync } from 'node:fs'
import net from 'node:net'

const PROJECT = '/home/z/my-project'
const HEALTH = 'http://127.0.0.1:3000/api/mist/health'
const DISABLE_FLAG = `${PROJECT}/.zscripts/dev-guard-disabled`
const PID_FILE = `${PROJECT}/mini-services/dev-guard/dev-guard.pid`
const CHECK_INTERVAL_MS = 12_000
const SPAWN_GRACE_MS = 45_000 // dev server compile time before re-checking
const BRIDGE_AUTOSTART_FLAG = `${PROJECT}/.zscripts/bridge-autostart`
const BRIDGE_HEALTH = 'http://127.0.0.1:8734/health'
const BRIDGE_LOG = `${PROJECT}/mini-services/dev-guard/bridge.log`

// ---- mini-service registry (supervised services only; lib/ has no server) ----
const SERVICES = [
  { name: 'neural-service', dir: `${PROJECT}/mini-services/neural-service`, port: 3003 },
  { name: 'mesh-service', dir: `${PROJECT}/mini-services/mesh-service`, port: 3004 },
  { name: 'browser-pilot', dir: `${PROJECT}/mini-services/browser-pilot`, port: 3030 },
] as const
const SERVICE_GRACE_MS = 45_000

// ---- single-instance guard (pidfile) ----
function alreadyRunning(): boolean {
  try {
    const pid = Number.parseInt(readFileSync(PID_FILE, 'utf-8').trim(), 10)
    if (Number.isFinite(pid) && pid > 0) {
      // HARDENED 2026-10-10: the old check (bare `process.kill(pid, 0)`) is
      // false-positive-prone in this sandbox — the original guard died, its
      // pid got confused with a recycled tid (bun "Watcher" threads keep
      // /proc/<pid> alive), and every re-bootstrap guard (2548/2549/3463)
      // surrendered to the stale pidfile and exited without logging. A guard
      // only yields to a pid that is a LIVE PROCESS WHOSE CMDLINE IS A
      // DEV-GUARD; threads/zombies/dead pidfiles lose ownership.
      const cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf-8')
      if (cmdline.includes('dev-guard')) {
        process.kill(pid, 0) // throws if truly gone despite /proc presence
        return true
      }
    }
  } catch {
    /* no pidfile, unreadable /proc entry, or dead pid — take over */
  }
  return false
}
if (alreadyRunning()) {
  process.exit(0)
}
try {
  writeFileSync(PID_FILE, `${process.pid}\n`)
} catch {
  /* best effort */
}

const g = globalThis as unknown as { __mistDevGuard?: boolean }
if (g.__mistDevGuard) {
  // hot-reload of this file must not stack a second interval loop
  process.exit(0)
}
g.__mistDevGuard = true

function log(line: string): void {
  try {
    appendFileSync(`${PROJECT}/mini-services/dev-guard/dev-guard.log`, `${new Date().toISOString()} ${line}\n`)
  } catch {
    /* best effort */
  }
}

async function devServerUp(): Promise<boolean> {
  try {
    const res = await fetch(HEALTH, { signal: AbortSignal.timeout(3000) })
    return res.ok
  } catch {
    return false
  }
}

// ---- /proc helpers ----
interface ProcInfo {
  pid: number
  cwd: string
  cmd: string
  startedAt: number // btime-relative jiffies (monotonic ordering key)
}

function listProcs(): ProcInfo[] {
  const out: ProcInfo[] = []
  let entries: string[] = []
  try {
    entries = readdirSync('/proc')
  } catch {
    return out
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue
    const pid = Number(entry)
    try {
      const cwd = readlinkSync(`/proc/${pid}/cwd`) // /proc magic symlink — readlink, not readFile
      const cmd = readFileSync(`/proc/${pid}/cmdline`, 'utf-8').replace(/\0/g, ' ').trim()
      if (!cmd) continue
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf-8')
      // field 22 (starttime) — after the comm "(...)" which may contain spaces
      const afterComm = stat.split(') ')[1] ?? ''
      const startedAt = Number(afterComm.split(' ')[19]) // 0-indexed: state=0 ... starttime=19
      out.push({ pid, cwd, cmd, startedAt: Number.isFinite(startedAt) ? startedAt : 0 })
    } catch {
      /* process gone or not ours — skip */
    }
  }
  return out
}

function serviceWorkers(procs: ProcInfo[], dir: string): ProcInfo[] {
  // a worker is a bun process (hot or run-dev) whose cwd is the service dir
  return procs.filter(
    (p) => p.cwd === dir && p.cmd.includes('bun') && (p.cmd.includes('--hot') || p.cmd.includes('index.ts')),
  )
}

function portUp(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.createConnection({ host: '127.0.0.1', port, timeout: 1500 })
    sock.once('connect', () => {
      sock.destroy()
      resolve(true)
    })
    sock.once('error', () => resolve(false))
    sock.once('timeout', () => {
      sock.destroy()
      resolve(false)
    })
  })
}

function killPid(pid: number, why: string): void {
  try {
    process.kill(pid, 'SIGTERM')
    log(`${why} (pid ${pid})`)
  } catch {
    /* already gone */
  }
}

function spawnService(name: string, dir: string): void {
  try {
    const out = openSync(`${PROJECT}/.zscripts/mini-service-${name}.log`, 'a')
    const child = spawn('bun', ['run', 'dev'], {
      cwd: dir,
      detached: true,
      stdio: ['ignore', out, out],
    })
    child.unref()
    log(`service ${name} down — spawned (pid ${child.pid})`)
  } catch (err) {
    log(`service ${name} spawn failed: ${err instanceof Error ? err.message : String(err)}`)
  }
}

const serviceLastSpawn = new Map<string, number>()

async function serviceTick(name: string, dir: string, port: number): Promise<void> {
  const last = serviceLastSpawn.get(name) ?? 0
  if (Date.now() - last < SERVICE_GRACE_MS) return
  const procs = listProcs()
  const workers = serviceWorkers(procs, dir).sort((a, b) => a.startedAt - b.startedAt)
  const up = await portUp(port)
  if (up) {
    if (workers.length > 1) {
      // the oldest worker bound the port in every real sequence; the rest are
      // duplicate-spawn zombies that failed EADDRINUSE and never exited
      for (const w of workers.slice(1)) killPid(w.pid, `service ${name}: swept duplicate worker`)
    }
    return
  }
  // port down: any live worker is a non-listening zombie — clear it, respawn one
  for (const w of workers) killPid(w.pid, `service ${name}: cleared zombie worker (port ${port} down)`)
  serviceLastSpawn.set(name, Date.now())
  spawnService(name, dir)
}

function spawnDevServer(): void {
  log('dev server down — spawning `bun run dev`')
  const child = spawn('bun', ['run', 'dev'], {
    cwd: PROJECT,
    detached: true,
    stdio: 'ignore', // the dev script itself pipes to dev.log via tee
  })
  child.unref()
  log(`spawned bun run dev (pid ${child.pid})`)
}

let lastSpawnAt = 0
let lastBridgeSpawnAt = 0

async function bridgeUp(): Promise<boolean> {
  try {
    const res = await fetch(BRIDGE_HEALTH, { signal: AbortSignal.timeout(3000) })
    return res.ok
  } catch {
    return false
  }
}

function spawnBridge(): void {
  log('bridge down — spawning `node db/bridge/mist-bridge.js`')
  try {
    const out = openSync(BRIDGE_LOG, 'a')
    const child = spawn('node', ['db/bridge/mist-bridge.js'], {
      cwd: PROJECT,
      detached: true,
      stdio: ['ignore', out, out],
    })
    child.unref()
    log(`spawned sandbox bridge (pid ${child.pid})`)
  } catch (err) {
    log(`bridge spawn failed: ${err instanceof Error ? err.message : String(err)}`)
  }
}

async function bridgeTick(): Promise<void> {
  if (!existsSync(BRIDGE_AUTOSTART_FLAG)) return // sandbox-only opt-in
  if (Date.now() - lastBridgeSpawnAt < 30_000) return // respawn grace
  if (await bridgeUp()) return
  lastBridgeSpawnAt = Date.now()
  spawnBridge()
}

async function tick(): Promise<void> {
  if (existsSync(DISABLE_FLAG)) return
  const up = await devServerUp()
  if (up) {
    await bridgeTick()
  } else if (Date.now() - lastSpawnAt >= SPAWN_GRACE_MS) {
    lastSpawnAt = Date.now()
    spawnDevServer()
  }
  // mini-services are supervised regardless of dev-server state
  for (const s of SERVICES) await serviceTick(s.name, s.dir, s.port)
}

log('dev-guard v3 online (12s interval, dev+bridge+mini-services, disable via .zscripts/dev-guard-disabled)')
void tick()
setInterval(() => {
  void tick()
}, CHECK_INTERVAL_MS)
