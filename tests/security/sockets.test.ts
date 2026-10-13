// Phase 1 · commit 3b red-team tests — socket + bind perimeter (S10/S12).
//
// Integration tests against the LIVE mini-services (neural :3003, mesh :3004,
// browser-pilot :3030). Written BEFORE the gates exist: today neural accepts
// every upgrade (cors *), mesh answers unauthenticated /mcp, and all three
// bind 0.0.0.0/*. These must be green after the commit.
//
// The socket paths covered (ADR-0002 — the two ways the owner reaches her):
//   · direct PC / test tooling: no Origin, loopback remote            → allow
//   · direct PC browser: Origin loopback, Host loopback               → allow
//   · sandbox gateway: Origin host === Host + valid mist_session cookie → allow
//   · sandbox gateway: Origin host === Host WITHOUT a cookie (ADR-0003 —
//     the preview-iframe app when its cookie is unreplayable)        → allow
//   · foreign origin (evil.example.com)                              → refuse
import { test, expect } from 'bun:test'
import { io } from 'socket.io-client'
import { issueSession } from '../../src/lib/perimeter/shared'

const NEURAL = 'http://127.0.0.1:3003'
const MESH = 'http://127.0.0.1:3004'
const COOKIE = () => `mist_session=${issueSession()}`

function connectSocket(
  url: string,
  extraHeaders: Record<string, string>,
  timeoutMs = 4_000
): Promise<'connected' | Error> {
  return new Promise((resolve) => {
    const socket = io(url, {
      transports: ['websocket'],
      reconnection: false,
      timeout: timeoutMs,
      extraHeaders,
    })
    const done = (outcome: 'connected' | Error) => {
      socket.close()
      resolve(outcome)
    }
    socket.on('connect', () => done('connected'))
    socket.on('connect_error', (err: Error) => done(err))
    setTimeout(() => done(new Error('timeout waiting for connect/connect_error')), timeoutMs + 500)
  })
}

/** Raw engine.io handshake (status-level) — what allowRequest actually sees. */
async function handshake(
  headers: Record<string, string>
): Promise<{ status: number; body: string }> {
  const res = await fetch(`${NEURAL}/?EIO=4&transport=polling`, { headers })
  return { status: res.status, body: await res.text() }
}

test('sockets · a foreign Origin is refused at the door (connect_error)', async () => {
  const outcome = await connectSocket(NEURAL, { Origin: 'https://evil.example.com' })
  expect(outcome).not.toBe('connected')
  expect(outcome).toBeInstanceOf(Error)
}, 10_000)

test('sockets · a loopback client without Origin connects (tooling / direct-PC path)', async () => {
  const outcome = await connectSocket(NEURAL, {})
  expect(outcome).toBe('connected')
}, 10_000)

test('sockets · loopback Origin + loopback Host connects (direct-PC browser path)', async () => {
  const outcome = await connectSocket(NEURAL, { Origin: 'http://localhost:3000', Host: 'localhost:3003' })
  expect(outcome).toBe('connected')
}, 10_000)

test('sockets · gateway path (Origin === Host + mist_session cookie) connects', async () => {
  const outcome = await connectSocket(NEURAL, {
    Origin: 'https://preview.example.com',
    Host: 'preview.example.com',
    Cookie: COOKIE(),
  })
  expect(outcome).toBe('connected')
}, 10_000)

test('sockets · ADR-0003 · gateway-shaped request WITHOUT a cookie but Origin===Host connects (the preview-iframe app itself)', async () => {
  // Design change (ADR-0003): the Origin===Host match is the browser voucher.
  // The preview panel embeds her in a cross-site iframe whose SameSite=None
  // cookie may be unreplayable (Safari/ITP, Chrome 3PC, headless browsers
  // without fetch-metadata) — the app's own document must still command her.
  // Cross-origin pages always carry their true Origin and stay refused above.
  const outcome = await connectSocket(NEURAL, {
    Origin: 'https://preview.example.com',
    Host: 'preview.example.com',
  })
  expect(outcome).toBe('connected')
}, 10_000)

test('sockets · raw handshake: cookieless foreign origin → 403', async () => {
  const hs = await handshake({ Origin: 'https://evil.example.com' })
  expect(hs.status).toBe(403)
})

test('sockets · raw handshake: gateway + cookie → 200 engine.io open packet', async () => {
  const hs = await handshake({
    Origin: 'https://preview.example.com',
    Host: 'preview.example.com',
    Cookie: COOKIE(),
  })
  expect(hs.status).toBe(200)
  expect(hs.body.startsWith('0')).toBe(true) // engine.io "open" payload
})

test('mesh · POST /mcp without a service credential → 401', async () => {
  const res = await fetch(`${MESH}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  })
  expect(res.status).toBe(401)
})

test('mesh · POST /mcp with x-mist-service executes the call (200 JSON-RPC)', async () => {
  const { getMistSecrets } = await import('../../src/lib/perimeter/shared')
  const res = await fetch(`${MESH}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-mist-service': getMistSecrets().sessionSecret },
    body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/list' }),
  })
  expect(res.status).toBe(200)
  const body = (await res.json()) as { result?: { tools?: unknown[] } }
  expect(Array.isArray(body.result?.tools)).toBe(true)
})

test('binds · neural/mesh/pilot listen on loopback only (127.0.0.1, not 0.0.0.0/*)', async () => {
  const proc = Bun.spawn(['ss', '-tlnp'], { stdout: 'pipe' })
  const ss = await new Response(proc.stdout).text()
  await proc.exited
  const lanMode = process.env.MIST_LAN === '1'
  for (const port of [3003, 3004, 3030]) {
    const line = ss.split('\n').find((l) => new RegExp(`:${port}\\s`).test(l))
    expect(line).toBeDefined()
    if (lanMode) continue // MIST_LAN=1 widens by design (PC LAN, visible warning)
    expect(line).not.toMatch(/0\.0\.0\.0:\d+/)
    expect(line).not.toMatch(/^\s*LISTEN\s+\d+\s+\d+\s+\*:/)
    expect(line ?? '').toMatch(/127\.0\.0\.1/)
  }
})
