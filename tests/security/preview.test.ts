// Phase 1 hotfix · ADR-0003 red-team tests — the sandbox preview must open.
//
// Regression this file pins: commit 03995d4 shipped `frame-ancestors 'none'`
// on EVERY response. The platform preview panel embeds the app in an IFRAME
// at the platform's origin — the browser refuses to render her at all
// ("she is not opening in the preview"), even though GET / answers 200.
// Second breaker once the frame loads: the auto-paired cookie is
// SameSite=Strict, which a cross-site iframe never replays → every non-GET
// /api/mist call 403s "session required"; the neural WS door (which requires
// the cookie) refuses too — and browsers that block third-party cookies
// outright (Safari/ITP, Chrome 3PC) are dead even with SameSite=None.
//
// The gateway-aware fix (ADR-0003), all keyed on "Host is non-loopback =
// reached through the platform gateway":
//   · CSP: omit frame-ancestors in gateway mode (loopback keeps 'none')
//   · cookie: SameSite=None; Secure in gateway mode (loopback keeps Strict)
//   · session gate + neural door: a browser that vouches
//     `Sec-Fetch-Site: same-origin` + Origin===Host passes without a cookie
//     (fetch-metadata is browser-forced and unforgeable from page JS — the
//     CSRF class stays blocked; cross-site stays 403)
//
// Tests written BEFORE the fix: 2·3·4·6 are RED (the breakers), 1·5·7 are
// guards that must stay green (PC/loopback posture unchanged, CSRF intact).
import { test, expect } from 'bun:test'
import { io } from 'socket.io-client'

const BASE = 'http://127.0.0.1:3000'
const NEURAL = 'http://127.0.0.1:3003'
const GW_HOST = 'preview.mist-gateway.test' // stand-in for the platform gateway Host

/** curl with a foreign Host — bun fetch refuses to override Host. */
function curl(
  args: string[],
): Promise<{ code: string; headers: string; body: string }> {
  const proc = Bun.spawn(
    ['curl', '-s', '-D', '-', ...args],
    { stdout: 'pipe', stderr: 'pipe' },
  )
  return new Response(proc.stdout).text().then((raw) => {
    const [head, ...rest] = raw.split('\r\n\r\n')
    const lines = head.split('\r\n')
    const code = (lines[0] ?? '').match(/\s(\d{3})\s/)?.[1] ?? '???'
    return { code, headers: head, body: rest.join('\r\n\r\n') }
  })
}

function connectSocket(
  url: string,
  extraHeaders: Record<string, string>,
  timeoutMs = 4_000,
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
    setTimeout(() => done(new Error('timeout')), timeoutMs + 500)
  })
}

test('ADR-0003 · GUARD loopback GET / keeps frame-ancestors none + SameSite=Strict (PC posture unchanged)', async () => {
  const { headers } = await curl([`${BASE}/`])
  const csp = /content-security-policy:\s*(.*)/i.exec(headers)?.[1] ?? ''
  expect(csp).toContain("frame-ancestors 'none'")
  const setCookie = /set-cookie:\s*(.*)/i.exec(headers)?.[1] ?? ''
  expect(setCookie).toContain('SameSite=Strict')
})

test('ADR-0003 · gateway GET / must NOT send frame-ancestors (the preview iframe must render)', async () => {
  const { code, headers } = await curl(['-H', `Host: ${GW_HOST}`, `${BASE}/`])
  expect(code).toBe('200')
  const csp = /content-security-policy:\s*(.*)/i.exec(headers)?.[1] ?? ''
  expect(csp).toContain("default-src 'self'") // the rest of the CSP stays
  expect(csp).not.toContain('frame-ancestors') // ← the preview killer, gone
})

test('ADR-0003 · gateway GET / issues SameSite=None; Secure (a cross-site iframe must be able to replay it)', async () => {
  const { headers } = await curl(['-H', `Host: ${GW_HOST}`, `${BASE}/`])
  const setCookie = /set-cookie:\s*(.*)/i.exec(headers)?.[1] ?? ''
  expect(setCookie).toContain('mist_session=')
  expect(setCookie).toContain('SameSite=None')
  expect(setCookie).toContain('Secure')
})

test('ADR-0003 · gateway POST with Origin===Host + Sec-Fetch-Site same-origin + NO cookie passes (3PC-blocked preview browsers)', async () => {
  const { code } = await curl([
    '-X', 'POST',
    '-H', `Host: ${GW_HOST}`,
    '-H', `Origin: https://${GW_HOST}`,
    '-H', 'Sec-Fetch-Site: same-origin',
    '-H', 'Content-Type: application/json',
    '-d', '{"message":"hi"}',
    `${BASE}/api/mist/llm/unified`,
  ])
  expect(code).toBe('200')
}, 30_000)

test('ADR-0003 · gateway POST with Origin===Host and NO fetch-metadata + NO cookie passes (headless/old browsers omit Sec-Fetch-Site)', async () => {
  // Ground truth from the sandbox browser (HeadlessChrome/153): same-origin
  // POST fetches carry Origin but NOT Sec-Fetch-Site. The Origin===Host
  // voucher must carry them — layer 2 has already rejected every
  // Origin-mismatched non-GET, and cross-origin requests always carry
  // their true Origin, so this shape is unforgeable by third-party pages.
  const { code } = await curl([
    '-X', 'POST',
    '-H', `Host: ${GW_HOST}`,
    '-H', `Origin: https://${GW_HOST}`,
    '-H', 'Content-Type: application/json',
    '-d', '{"message":"hi"}',
    `${BASE}/api/mist/llm/unified`,
  ])
  expect(code).toBe('200')
}, 30_000)

test('ADR-0003 · GUARD gateway POST with Sec-Fetch-Site cross-site + NO cookie stays 403 (CSRF class intact)', async () => {
  const { code } = await curl([
    '-X', 'POST',
    '-H', `Host: ${GW_HOST}`,
    '-H', `Origin: https://evil.example.com`,
    '-H', 'Sec-Fetch-Site: cross-site',
    '-H', 'Content-Type: application/json',
    '-d', '{"message":"hi"}',
    `${BASE}/api/mist/llm/unified`,
  ])
  expect(code).toBe('403')
})

test('ADR-0003 · neural door: gateway Origin===Host + Sec-Fetch-Site same-origin + NO cookie connects', async () => {
  const outcome = await connectSocket(NEURAL, {
    Host: GW_HOST,
    Origin: `https://${GW_HOST}`,
    'Sec-Fetch-Site': 'same-origin',
  })
  expect(outcome).toBe('connected')
})

test('ADR-0003 · GUARD neural door: gateway shape with a FOREIGN Origin is refused (Origin is the anchor)', async () => {
  // Under the Origin===Host voucher the guard rail is the Origin header
  // itself: a page at ANY other origin — even one lying about Sec-Fetch-Site,
  // which browsers cannot forge but curl can — must never pass the door.
  const outcome = await connectSocket(NEURAL, {
    Host: GW_HOST,
    Origin: 'https://evil.example.com',
    'Sec-Fetch-Site': 'same-origin', // the lie — must not matter
  })
  expect(outcome).not.toBe('connected')
})
