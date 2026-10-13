// Phase 1 · commit 3a red-team tests — proxy.ts perimeter (S2/S10/S12-core).
//
// Integration tests against the LIVE dev server (http://127.0.0.1:3000).
// Written BEFORE the proxy exists (red-team evidence: unified POST answers,
// no security headers, no Set-Cookie, pair 404s) and must be green after.
// ADR-0002 gate lives here too: a GET / with a foreign Host header MUST stay
// 200 — strict-host is opt-in (MIST_STRICT_HOST=1) and OFF by default.
import { test, expect } from 'bun:test'
import { issueSession, pairCode, getMistSecrets } from '../../src/lib/perimeter/shared'

const BASE = 'http://127.0.0.1:3000'
const JSON_HEADERS = { 'Content-Type': 'application/json' }

/** "hi" is fast-path smalltalk — a passing perimeter call answers in
 * milliseconds without touching any provider lane. */
function postUnified(extra?: { cookie?: string; origin?: string; serviceHeader?: boolean; noContentType?: boolean; contentType?: string }) {
  const headers: Record<string, string> = {}
  if (!extra?.noContentType) headers['Content-Type'] = extra?.contentType ?? 'application/json'
  if (extra?.cookie) headers.Cookie = extra.cookie
  if (extra?.origin) headers.Origin = extra.origin
  if (extra?.serviceHeader) headers['x-mist-service'] = getMistSecrets().sessionSecret
  return fetch(`${BASE}/api/mist/llm/unified`, {
    method: 'POST',
    headers,
    body: extra?.noContentType ? JSON.stringify({ message: 'hi' }) : JSON.stringify({ message: 'hi' }),
  })
}

test('S2 · POST /api/mist/llm/unified without a session cookie → 403 session required', async () => {
  const res = await postUnified()
  expect(res.status).toBe(403)
  const body = (await res.json()) as { error?: string }
  expect(body.error).toContain('session required')
})

test('S2 · a forged mist_session cookie is rejected (403), not trusted', async () => {
  const forged = `mist_session=${Date.now() + 3_600_000}.deadbeef${'0'.repeat(56)}`
  const res = await postUnified({ cookie: forged })
  expect(res.status).toBe(403)
})

test('S2 · a real mist_session cookie passes the perimeter (200, fast-path lane)', async () => {
  const res = await postUnified({ cookie: `mist_session=${issueSession()}` })
  expect(res.status).toBe(200)
}, 30_000)

test('S2 · the intra-machine x-mist-service header passes the perimeter', async () => {
  const res = await postUnified({ serviceHeader: true })
  expect(res.status).toBe(200)
}, 30_000)

test('S10 · a POST with a foreign Origin is blocked — even with a valid session cookie', async () => {
  const res = await postUnified({
    cookie: `mist_session=${issueSession()}`,
    origin: 'https://evil.example.com',
  })
  expect(res.status).toBe(403)
})

test('S10 · a same-origin POST (Origin === Host) is NOT blocked', async () => {
  const res = await postUnified({
    cookie: `mist_session=${issueSession()}`,
    origin: 'http://127.0.0.1:3000',
  })
  expect(res.status).toBe(200)
}, 30_000)

test('S12 · a POST with no Content-Type → 415', async () => {
  const res = await postUnified({ cookie: `mist_session=${issueSession()}`, noContentType: true })
  expect(res.status).toBe(415)
})

test('S12 · a POST with text/plain Content-Type → 415', async () => {
  const res = await postUnified({
    cookie: `mist_session=${issueSession()}`,
    contentType: 'text/plain',
  })
  expect(res.status).toBe(415)
})

test('S12 · /voice/stt multipart/form-data reaches the route (400 missing audio, never 415/403)', async () => {
  const fd = new FormData()
  const res = await fetch(`${BASE}/api/mist/voice/stt`, {
    method: 'POST',
    headers: { Cookie: `mist_session=${issueSession()}` },
    body: fd,
  })
  expect(res.status).toBe(400) // audio_file field is required — but the perimeter let it through
})

test('S12 · /voice/tts/stream speaks application/json (400 missing text, never 415)', async () => {
  const res = await fetch(`${BASE}/api/mist/voice/tts/stream`, {
    method: 'POST',
    headers: { ...JSON_HEADERS, Cookie: `mist_session=${issueSession()}` },
    body: JSON.stringify({}),
  })
  expect(res.status).toBe(400)
})

test('S12 · /voice/tts/stream also accepts application/x-ndjson', async () => {
  const res = await fetch(`${BASE}/api/mist/voice/tts/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-ndjson', Cookie: `mist_session=${issueSession()}` },
    body: JSON.stringify({}),
  })
  expect(res.status).toBe(400)
})

test('S2 · auto-pair: a first GET / issues a mist_session cookie', async () => {
  // 5-fix: GET / renders the FULL app page — on a cold dev server (or one
  // still healing from an OOM cycle mid-suite) the first hit can take >5s
  // just to compile, and the socket can drop mid-compile. Honest retry ONCE
  // on a connection failure — the assertions are unchanged and still all
  // must hold on the retried response.
  const attempt = (): Promise<Response> => fetch(`${BASE}/`, { redirect: 'manual' })
  const res = await attempt().catch(() => attempt())
  expect(res.status).toBe(200)
  const setCookie = res.headers.get('set-cookie') ?? ''
  expect(setCookie).toContain('mist_session=')
  expect(setCookie).toContain('HttpOnly')
  expect(setCookie).toContain('SameSite=Strict')
}, 30_000)

test('S2 · the auto-paired cookie then passes the POST perimeter (end-to-end pairing)', async () => {
  const page = await fetch(`${BASE}/`, { redirect: 'manual' })
  const setCookie = page.headers.get('set-cookie') ?? ''
  const m = /mist_session=([^;]+)/.exec(setCookie)
  expect(m).not.toBeNull()
  const res = await postUnified({ cookie: `mist_session=${m![1]}` })
  expect(res.status).toBe(200)
}, 30_000)

test('S12 · GET / carries the security headers (CSP, nosniff, referrer, permissions, frame-ancestors)', async () => {
  const res = await fetch(`${BASE}/`)
  expect(res.status).toBe(200)
  const csp = res.headers.get('content-security-policy') ?? ''
  expect(csp).toContain("default-src 'self'")
  expect(csp).toContain("frame-ancestors 'none'")
  expect(csp).toContain("connect-src 'self'")
  expect(res.headers.get('x-content-type-options')).toBe('nosniff')
  expect(res.headers.get('referrer-policy')).toBe('no-referrer')
  const perms = res.headers.get('permissions-policy') ?? ''
  expect(perms).toContain('microphone=(self)')
  expect(perms).toContain('camera=()')
})

test('ADR-0002 · GET / with a foreign Host header stays 200 (strict-host is opt-in, default OFF)', async () => {
  const proc = Bun.spawn(
    ['curl', '-s', '-o', '/dev/null', '-w', '%{http_code}', '-H', 'Host: preview.example.com', `${BASE}/`],
    { stdout: 'pipe', stderr: 'pipe' }
  )
  const code = (await new Response(proc.stdout).text()).trim()
  await proc.exited
  expect(code).toBe('200')
})

test('pair · GET /api/mist/pair?code=<pairCode> mints a session cookie', async () => {
  const res = await fetch(`${BASE}/api/mist/pair?code=${pairCode()}`, { redirect: 'manual' })
  expect(res.status).toBe(200)
  const setCookie = res.headers.get('set-cookie') ?? ''
  expect(setCookie).toContain('mist_session=')
  // the minted cookie must actually work on the perimeter
  const m = /mist_session=([^;]+)/.exec(setCookie)
  expect(m).not.toBeNull()
  const used = await postUnified({ cookie: `mist_session=${m![1]}` })
  expect(used.status).toBe(200)
}, 30_000)

test('pair · a wrong pair code is rejected (403) with an honest error', async () => {
  const res = await fetch(`${BASE}/api/mist/pair?code=${'0'.repeat(64)}`, { redirect: 'manual' })
  expect(res.status).toBe(403)
  const body = (await res.json()) as { error?: string }
  expect(body.error).toContain('invalid pair code')
  // NOTE: the auto-pair layer (by design — "pair ANY request") may still have
  // issued a mist_session on this response; the ROUTE minted nothing. The
  // enforcement is SameSite=Strict: browsers never replay it cross-site.
})

test('welcome · GET returns state only (no composed briefing text); POST greet composes it', async () => {
  const tz = 'Africa/Lagos'
  const get = (await fetch(`${BASE}/api/mist/welcome?tz=${encodeURIComponent(tz)}`).then((r) =>
    r.json()
  )) as { greet: boolean; text?: string }
  expect(typeof get.greet).toBe('boolean')
  // the side-effecting compose moved to POST — GET is state-only
  expect(get.text).toBeUndefined()

  const post = (await fetch(`${BASE}/api/mist/welcome`, {
    method: 'POST',
    headers: { ...JSON_HEADERS, Cookie: `mist_session=${issueSession()}` },
    body: JSON.stringify({ action: 'greet', tz }),
  }).then((r) => r.json())) as { greet: boolean; text?: string }
  // the gate is re-evaluated server-side with the same semantics — the GET's
  // verdict must hold for the immediately-following POST
  expect(post.greet).toBe(get.greet)
  if (get.greet) expect(typeof post.text).toBe('string')
}, 60_000)
