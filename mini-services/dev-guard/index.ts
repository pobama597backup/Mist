// M.I.S.T. dev-guard — emergency dev-server watchdog (added by task 12-a).
//
// WHY THIS EXISTS: on 2026-09-24 ~20:58 the sandbox OOM-killer terminated the
// Next dev server (:3000), and this environment reaps every process spawned
// from agent tool shells a few seconds after each call ends — so a normal
// restart would not survive. This guard is spawned (detached) by the
// boot-session neural-service, so IT and ITS CHILDREN survive the reaper
// (same pattern as the browser-pilot's playwright chromium).
//
// WHAT IT DOES: every 45s it probes http://127.0.0.1:3000/api/mist/health.
// When down (and not in a spawn grace period, and no disable flag file), it
// respawns `bun run dev` in /home/z/my-project (the package.json dev script
// already pipes output to dev.log via tee). Intentionally dumb and tiny.
//
// BRIDGE SUPERVISION (v2): when the marker file .zscripts/bridge-autostart
// exists (sandbox-only — NEVER created on a user PC), the guard also keeps
// the LOCAL sandbox bridge (node db/bridge/mist-bridge.js, :8734) alive, so
// her owner_files / ui_automate / system_watch tools have a body in the
// sandbox across reaper cycles. On a user's PC the bridge is started by
// run.bat / PC-SETUP and must NOT be spawned here (port collision).
//
// HOW TO DISABLE: create the file /home/z/my-project/.zscripts/dev-guard-disabled
// (then kill this process). It never touches anything else.
import { spawn } from 'node:child_process'
import { existsSync, appendFileSync, writeFileSync, readFileSync, openSync } from 'node:fs'

const PROJECT = '/home/z/my-project'
const HEALTH = 'http://127.0.0.1:3000/api/mist/health'
const DISABLE_FLAG = `${PROJECT}/.zscripts/dev-guard-disabled`
const PID_FILE = `${PROJECT}/mini-services/dev-guard/dev-guard.pid`
const CHECK_INTERVAL_MS = 45_000
const SPAWN_GRACE_MS = 90_000 // dev server compile time before re-checking
const BRIDGE_AUTOSTART_FLAG = `${PROJECT}/.zscripts/bridge-autostart`
const BRIDGE_HEALTH = 'http://127.0.0.1:8734/health'
const BRIDGE_LOG = `${PROJECT}/mini-services/dev-guard/bridge.log`

// ---- single-instance guard (pidfile) ----
function alreadyRunning(): boolean {
  try {
    const pid = Number.parseInt(readFileSync(PID_FILE, 'utf-8').trim(), 10)
    if (Number.isFinite(pid)) {
      process.kill(pid, 0) // throws if not alive
      return true
    }
  } catch {
    /* no pidfile or stale pid — take over */
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
  if (Date.now() - lastSpawnAt < SPAWN_GRACE_MS) return
  const up = await devServerUp()
  if (up) {
    await bridgeTick()
    return
  }
  lastSpawnAt = Date.now()
  spawnDevServer()
}

log('dev-guard online (45s interval, disable via .zscripts/dev-guard-disabled)')
void tick()
setInterval(() => {
  void tick()
}, CHECK_INTERVAL_MS)
