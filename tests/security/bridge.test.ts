// Phase 1 · S1 red-team tests — the Mist Bridge daemon itself.
//
// Spawns db/bridge/mist-bridge.js on a TEST port with HOME pointed at a temp
// dir (the bridge reads/writes ~/.mist/bridge.json for its token). Written
// BEFORE the hardening (red-team evidence). Run: bun test tests/security/
import { test, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, rmSync, readFileSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const TEST_PORT = 18934
const BASE = `http://127.0.0.1:${TEST_PORT}`
const BRIDGE = 'db/bridge/mist-bridge.js'

let proc: ReturnType<typeof Bun.spawn> | null = null
let tmpHome = ''
let token = ''

async function waitUp(): Promise<void> {
  for (let i = 0; i < 100; i++) {
    try {
      const res = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(500) })
      if (res.ok || res.status === 401) return
    } catch {
      /* booting */
    }
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error('bridge did not come up on the test port')
}

beforeAll(async () => {
  tmpHome = mkdtempSync(path.join(os.tmpdir(), 'mist-bridge-test-'))
  proc = Bun.spawn(['node', BRIDGE], {
    cwd: '/home/z/my-project',
    env: { ...process.env, HOME: tmpHome, MIST_BRIDGE_PORT: String(TEST_PORT) },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  await waitUp()
  // the daemon must have created ~/.mist/bridge.json (the token's home)
  token = String(JSON.parse(readFileSync(path.join(tmpHome, '.mist', 'bridge.json'), 'utf-8')).token ?? '')
})

afterAll(() => {
  proc?.kill()
  if (tmpHome) rmSync(tmpHome, { recursive: true, force: true })
})

test('S1 · bridge token file ~/.mist/bridge.json exists, 256-bit, mode 0600', () => {
  expect(token).toMatch(/^[a-f0-9]{64}$/)
  const mode = statSync(path.join(tmpHome, '.mist', 'bridge.json')).mode & 0o777
  expect(mode).toBe(0o600)
})

test('S1 · POST /exec without Bearer token → 401', async () => {
  const res = await fetch(`${BASE}/exec`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Host: `127.0.0.1:${TEST_PORT}` },
    body: JSON.stringify({ action: 'system_info', args: {} }),
  })
  expect(res.status).toBe(401)
})

test('S1 · POST /exec with Bearer but ANY Origin header → 403 (browsers never drive the bridge)', async () => {
  const res = await fetch(`${BASE}/exec`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      Origin: 'https://evil.example',
      Host: `127.0.0.1:${TEST_PORT}`,
    },
    body: JSON.stringify({ action: 'system_info', args: {} }),
  })
  expect(res.status).toBe(403)
})

test('S1 · run_command is gated until the Phase 2 Arbiter (403, honest message)', async () => {
  const res = await fetch(`${BASE}/exec`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      Host: `127.0.0.1:${TEST_PORT}`,
    },
    body: JSON.stringify({ action: 'run_command', args: { command: 'echo hi' } }),
  })
  expect(res.status).toBe(403)
  const body = (await res.json()) as { error?: string }
  expect(body.error ?? '').toContain('gated')
})

test('S1 · gated set covers every write/exec actuator (write_file, delete_file, ui_automate, hermes_ask, open_app, owner_files write ops)', async () => {
  for (const action of [
    'write_file',
    'move_file',
    'copy_file',
    'delete_file',
    'make_dir',
    'zip_files',
    'unzip_file',
    'ui_automate',
    'hermes_ask',
    'open_app',
  ]) {
    const res = await fetch(`${BASE}/exec`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        Host: `127.0.0.1:${TEST_PORT}`,
      },
      body: JSON.stringify({ action, args: {} }),
    })
    expect(res.status).toBe(403)
    const body = (await res.json()) as { error?: string }
    expect(body.error ?? '').toContain('gated')
  }
})

test('S1 · read-only actions keep working with a valid Bearer (system_info, status)', async () => {
  for (const action of ['system_info', 'status']) {
    const res = await fetch(`${BASE}/exec`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        Host: `127.0.0.1:${TEST_PORT}`,
      },
      body: JSON.stringify({ action, args: {} }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok?: boolean }
    expect(body.ok).toBe(true)
  }
})

test('S1 · no Access-Control-Allow-Origin header on any response', async () => {
  const res = await fetch(`${BASE}/health`, { headers: { Host: `127.0.0.1:${TEST_PORT}` } })
  expect(res.headers.get('access-control-allow-origin')).toBeNull()
  const res2 = await fetch(`${BASE}/exec`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, Host: `127.0.0.1:${TEST_PORT}` },
    body: JSON.stringify({ action: 'status', args: {} }),
  })
  expect(res2.headers.get('access-control-allow-origin')).toBeNull()
})

test('S1 · wrong Host header (DNS-rebind style) → 421/403', async () => {
  const res = await fetch(`${BASE}/exec`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      Host: 'evil.example',
    },
    body: JSON.stringify({ action: 'status', args: {} }),
  })
  expect([421, 403]).toContain(res.status)
})

test('S1 · /health advertises v3 auth + gated set (with Bearer)', async () => {
  const res = await fetch(`${BASE}/health`, {
    headers: { Authorization: `Bearer ${token}`, Host: `127.0.0.1:${TEST_PORT}` },
  })
  expect(res.status).toBe(200)
  const body = (await res.json()) as { auth?: string; gated?: unknown; version?: unknown }
  expect(body.auth).toBe('bearer')
  expect(Array.isArray(body.gated)).toBe(true)
  expect((body.gated as string[]).length).toBeGreaterThan(5)
  expect(body.version).toBeTruthy()
})

test('S1 · wrong Bearer token → 401 (timing-safe rejection)', async () => {
  const res = await fetch(`${BASE}/exec`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${'0'.repeat(64)}`,
      Host: `127.0.0.1:${TEST_PORT}`,
    },
    body: JSON.stringify({ action: 'status', args: {} }),
  })
  expect(res.status).toBe(401)
})

test('S1 · the token the APP would send (same HOME) matches the daemon token', async () => {
  // same-machine convergence: the app-side helper (mini-services/lib or
  // src/lib/perimeter) reads-or-creates the SAME ~/.mist/bridge.json.
  // (MIST_HOME redirect — bun's os.homedir() ignores $HOME at runtime.)
  const { getMistSecrets } = await import('../../mini-services/lib/perimeter')
  const prevHome = process.env.MIST_HOME
  process.env.MIST_HOME = tmpHome
  try {
    const secrets = getMistSecrets()
    expect(secrets.bridgeToken).toBe(token)
  } finally {
    process.env.MIST_HOME = prevHome
  }
})
