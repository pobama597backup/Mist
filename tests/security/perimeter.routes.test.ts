// Phase 1 · S3 red-team tests — recover / google / export / env perimeter.
//
// Integration tests against the LIVE dev server (http://127.0.0.1:3000).
// These were written BEFORE the fixes (red-team evidence) and must be green
// after commit "S3". Run: bun test tests/security/
import { test, expect } from 'bun:test'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { issueSession } from '../../src/lib/perimeter/shared'

const BASE = 'http://127.0.0.1:3000'

test('S3 · GET /api/mist/recover is gone (404, route deleted)', async () => {
  const res = await fetch(`${BASE}/api/mist/recover`)
  expect(res.status).toBe(404)
})

test('S3 · GET /api/mist/google never returns the raw key without a session', async () => {
  const res = await fetch(`${BASE}/api/mist/google`)
  expect(res.ok).toBe(true)
  const body = (await res.json()) as { configured?: boolean; key?: unknown }
  expect(typeof body.configured).toBe('boolean')
  // The key must be absent (or null) for a cookieless caller, even when a
  // Gemini key IS configured on the instance.
  expect(body.key === undefined || body.key === null).toBe(true)
})

test('S3 · GET /api/mist/bridge/export demands a session (401 without)', async () => {
  const res = await fetch(`${BASE}/api/mist/bridge/export`)
  expect(res.status).toBe(401)
})

test('S3 · POST /api/mist/bridge/export demands typed confirmation', async () => {
  const cookie = `mist_session=${issueSession()}`
  const wrongConfirm = await fetch(`${BASE}/api/mist/bridge/export`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ confirm: 'yes' }),
  })
  expect(wrongConfirm.status).toBe(400)

  const noConfirm = await fetch(`${BASE}/api/mist/bridge/export`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({}),
  })
  expect(noConfirm.status).toBe(400)
}, 30_000)

test('S3 · export tarball ships no secrets (.env / provider-keys / db / backups)', async () => {
  const cookie = `mist_session=${issueSession()}`
  const res = await fetch(`${BASE}/api/mist/bridge/export`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ confirm: 'EXPORT' }),
  })
  expect(res.status).toBe(200)
  expect(res.headers.get('content-type')).toContain('application/gzip')

  const buf = Buffer.from(await res.arrayBuffer())
  expect(buf.length).toBeGreaterThan(10_000) // a real tarball, not an error page

  const tmp = mkdtempSync(path.join(os.tmpdir(), 'mist-export-test-'))
  const tarPath = path.join(tmp, 'export.tar.gz')
  try {
    writeFileSync(tarPath, buf)
    const proc = Bun.spawn(['tar', '-tzf', tarPath], { stdout: 'pipe', stderr: 'pipe' })
    const text = await new Response(proc.stdout).text()
    await proc.exited
    const entries = text.split('\n').filter(Boolean)
    expect(entries.length).toBeGreaterThan(50) // a full export, not an empty tar
    const violations = entries.filter(
      (e) =>
        /(^|\/)\.env$/.test(e) ||
        /provider-keys\.json$/.test(e) ||
        /(^|\/)custom\.db(-|$)/.test(e) ||
        /db\/backups\//.test(e) ||
        /db\/notes\//.test(e) ||
        /(^|\/)[^/]*token[^/]*$/i.test(e) ||
        /(^|\/)[^/]*secret[^/]*$/i.test(e)
    )
    expect(violations).toEqual([])
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}, 180_000)

test('S3 · POST /api/mist/config/env requires a session (403 without)', async () => {
  // NOTE: confirmed:false — even a buggy pass-through must not write anything.
  const res = await fetch(`${BASE}/api/mist/config/env`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ vars: { MIST_TEST_PROBE: '1' }, confirmed: false }),
  })
  expect(res.status).toBe(403)
})

test('S3 · session cookie values are HMAC-verified (forged cookie rejected)', async () => {
  const forged = `mist_session=${Date.now() + 3_600_000}.deadbeef${'0'.repeat(56)}`
  const res = await fetch(`${BASE}/api/mist/bridge/export`, {
    headers: { Cookie: forged },
  })
  expect(res.status).toBe(401)
})

// ---------------------------------------------------------------------------
// S6 — env/set_url remote-repoint guard (commit 4). Written BEFORE the guard
// exists: today a sessioned caller can repoint *_BASE_URL / MIST_BRIDGE_URL
// at an arbitrary remote host (silent endpoint switch / exfiltration lane).
// MIST_ALLOW_REMOTE_BRIDGE=1 (PC package default for remote gateways) widens.
// ---------------------------------------------------------------------------

const S6_COOKIE = () => `mist_session=${issueSession()}`

function postEnv(vars: Record<string, string>) {
  return fetch(`${BASE}/api/mist/config/env`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: S6_COOKIE() },
    body: JSON.stringify({ vars, confirmed: true }),
  })
}

test('S6 · a non-loopback *_BASE_URL is refused (400) without MIST_ALLOW_REMOTE_BRIDGE', async () => {
  const res = await postEnv({ MIST_TEST_BASE_URL: 'https://api.remote.example.com/v1' })
  expect(res.status).toBe(400)
  const body = (await res.json()) as { error?: string }
  expect(body.error).toContain('MIST_ALLOW_REMOTE_BRIDGE')
})

test('S6 · a loopback *_BASE_URL applies and the response carries the masked diff (URLs in clear)', async () => {
  const value = `http://127.0.0.1:9377/r${Date.now()}`
  const res = await postEnv({ MIST_TEST_BASE_URL: value })
  expect(res.status).toBe(200)
  const body = (await res.json()) as { diff?: Record<string, { from: string; to: string }> }
  expect(body.diff?.MIST_TEST_BASE_URL?.to).toBe(value)
})

test('S6 · secret-named keys are masked (***) in the diff, BASE_URLs are not', async () => {
  const res = await postEnv({
    MIST_TEST_API_KEY: `probe-${Date.now()}`,
    MIST_TEST_BASE_URL: `http://localhost:9378/r${Date.now()}`,
  })
  expect(res.status).toBe(200)
  const body = (await res.json()) as { diff?: Record<string, { from: string; to: string }> }
  expect(body.diff?.MIST_TEST_API_KEY?.to).toBe('***')
  expect(body.diff?.MIST_TEST_BASE_URL?.to).toMatch(/^http:\/\/localhost:9378\//)
})

test('S6 · bridge set_url to a non-loopback host is refused (400), URL unchanged', async () => {
  const res = await fetch(`${BASE}/api/mist/bridge`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: S6_COOKIE() },
    body: JSON.stringify({ action: 'set_url', url: 'https://remote-bridge.example.com:8734' }),
  })
  expect(res.status).toBe(400)
  const body = (await res.json()) as { error?: string }
  expect(body.error).toContain('MIST_ALLOW_REMOTE_BRIDGE')
  const status = (await (await fetch(`${BASE}/api/mist/bridge`)).json()) as {
    status?: { url?: string }
  }
  expect(status.status?.url ?? '').not.toContain('remote-bridge.example.com')
})

test('S6 · bridge set_url back to the loopback default still applies (200)', async () => {
  const res = await fetch(`${BASE}/api/mist/bridge`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: S6_COOKIE() },
    body: JSON.stringify({ action: 'set_url', url: 'http://127.0.0.1:8734' }),
  })
  expect(res.status).toBe(200)
  const body = (await res.json()) as { ok?: boolean }
  expect(body.ok).toBe(true)
})

// ---------------------------------------------------------------------------
// S12 — rate limits (commit 5). Written BEFORE the limiter exists: today a
// runaway loop, hijacked tab, or stolen session can hammer every wired lane
// without ever being slowed. Buckets: llm 30/min, tools 60/min, voice 60/min,
// export 5/min, config 10/min — keyed by session cookie (fallback IP).
// ---------------------------------------------------------------------------

test('S12 · config/env rate limit: 15 POSTs → 429 by the 11th (10/min window)', async () => {
  const cookie = `mist_session=${issueSession()}` // ONE identity for all 15
  let first429 = -1
  let retryAfter = 0
  for (let i = 1; i <= 15; i++) {
    const res = await fetch(`${BASE}/api/mist/config/env`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ vars: { MIST_TEST_RATE_PROBE: String(i) }, confirmed: true }),
    })
    if (res.status === 429) {
      if (first429 === -1) {
        first429 = i
        retryAfter = Number(((await res.json()) as { retryAfter?: number }).retryAfter ?? 0)
        expect(Number(res.headers.get('Retry-After') ?? 0)).toBeGreaterThan(0)
      }
    } else {
      // requests 1..10 succeed — and once throttled, always throttled (same window)
      expect(res.status).toBe(200)
      expect(first429).toBe(-1)
    }
  }
  expect(first429).toBe(11)
  expect(retryAfter).toBeGreaterThan(0)
}, 20_000) // 2026-10-12: each POST persists to .env (Next reloads env per write)
// and runs 300-800ms on this memory-pressured box — 15 requests can exceed the
// 5s default; the LOGIC under test is the 429-by-the-11th sequence, not speed.
