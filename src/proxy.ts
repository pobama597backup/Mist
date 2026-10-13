// M.I.S.T. perimeter proxy — Phase 1 · S2/S10/S12-core (commit 3).
//
// Next 16 runs src/proxy.ts on every matched request (the middleware
// convention, renamed). Everything here is gateway-aware per ADR-0002:
// origin checks compare the request's OWN Origin against its OWN Host
// (dynamic same-origin) — NEVER a static host allowlist, because the owner
// reaches this app through the platform gateway under an external Host.
//
// Gateway-aware CSP + cookies + session fallback (ADR-0003): requests whose
// Host is NOT loopback arrive through the platform gateway — the preview
// panel embeds her in a cross-site IFRAME, so (a) frame-ancestors 'none'
// would make the browser refuse to render her at all, (b) SameSite=Strict
// cookies are never replayed from a cross-site iframe, and (c) browsers that
// block third-party cookies outright (Safari/ITP, Chrome 3PC) can't carry
// ANY cookie — for those the browser's own Sec-Fetch-Site: same-origin
// voucher (unforgeable from page JS) satisfies the session gate. Loopback
// (PC / direct) keeps the strict posture unchanged.
//
// Layers (in order):
//   1. MIST_STRICT_HOST=1 (opt-in, PC default): Host must be loopback → 421.
//      DEFAULT OFF — the preview gateway's foreign Host must stay 200.
//   2. Non-GET cross-origin block: Origin present AND origin-host ≠ host AND
//      origin-host not loopback → 403 (the CSRF class).
//   3. Non-GET /api/mist/** (except /health, /pair): needs a valid
//      mist_session cookie OR the intra-machine x-mist-service secret OR
//      MIST_OPEN_API=1 OR a browser-forced Sec-Fetch-Site: same-origin
//      voucher with Origin===Host → else 403 session required.
//   4. Non-GET /api/mist/** Content-Type must be application/json
//      (multipart/form-data for /voice/stt — the mic upload;
//       + application/x-ndjson for /voice/tts/stream) → else 415.
//   5. Security headers on every response (CSP, nosniff, referrer,
//      permissions-policy).
//   6. Auto-pair: any request without a valid session cookie gets one issued
//      (Set-Cookie, HttpOnly, SameSite=Strict — browsers refuse to replay
//      Strict cookies cross-site, which IS the enforcement).
import { NextRequest, NextResponse } from 'next/server'
import { timingSafeEqual } from 'node:crypto'
import {
  SESSION_COOKIE,
  SESSION_TTL_MS,
  getMistSecrets,
  hasValidSessionCookie,
  issueSession,
} from '@/lib/perimeter/shared'

const SERVICE_HEADER = 'x-mist-service'
/** Non-GET /api/mist paths that stay open (health is the identity-free probe;
 * pair is the bootstrap that MINTS sessions and can't require one). */
const SESSION_EXEMPT = new Set(['/api/mist/health', '/api/mist/pair'])

/**
 * script-src per mode — Phase 6-a · CSP tightening (the phase-2 backlog item).
 * DEV keeps BOTH relaxations: Next's HMR client needs eval and the dev
 * bootstrap rides inline scripts. PROD drops unsafe-eval — the compiled
 * server/client bundles never eval — but keeps unsafe-inline, honestly:
 * App Router hydration emits inline <script> chunks without nonce plumbing,
 * so 'unsafe-inline' stays until nonce-based CSP lands (the remaining
 * backlog item, tracked in the Phase 6 worklog). Exported for unit tests
 * (both shapes pinned in tests/security/control-room.test.ts).
 */
export function cspScriptSrc(mode: string | undefined = process.env.NODE_ENV): string {
  return mode === 'production'
    ? "script-src 'self' 'unsafe-inline'"
    : "script-src 'self' 'unsafe-inline' 'unsafe-eval'"
}

const CSP_CORE =
  `default-src 'self'; ${cspScriptSrc()}; ` +
  "style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; " +
  "connect-src 'self' ws://127.0.0.1:* ws://localhost:* http://127.0.0.1:* http://localhost:*; " +
  "frame-src 'self'; base-uri 'self'; form-action 'self'; object-src 'none'"
// Loopback keeps frame-ancestors 'none' (PC anti-clickjacking). Gateway mode
// omits the directive entirely — the preview iframe must render, and the
// platform parent origin is unknowable from inside the machine (ADR-0003).
const CSP_STRICT = CSP_CORE + "; frame-ancestors 'none'"

/** Hostname of a Host header value — port-stripped, bracket-IPv6 aware
 * ('localhost:3000' → 'localhost', '[::1]:81' → '::1', 'a.b' → 'a.b'). */
function hostnameOf(raw: string | null | undefined): string {
  if (!raw) return ''
  let host = raw.trim().toLowerCase()
  if (host.startsWith('[')) {
    const end = host.indexOf(']')
    return end > 0 ? host.slice(1, end) : host.slice(1)
  }
  const first = host.indexOf(':')
  if (first >= 0 && host.indexOf(':', first + 1) === -1) host = host.slice(0, first)
  return host
}

function isLoopbackHostname(host: string): boolean {
  return (
    host === 'localhost' ||
    host === '::1' ||
    host === '127.0.0.1' ||
    /^127\.\d+\.\d+\.\d+$/.test(host)
  )
}

/** Hostname part of an Origin header ('https://a.b:81' → 'a.b'). */
function originHostname(origin: string | null | undefined): string | null {
  if (!origin) return null
  const m = /^https?:\/\/([^/?#]+)/i.exec(origin.trim())
  return m?.[1] ? hostnameOf(m[1]) : null
}

/** Timing-safe compare for the intra-machine service secret. */
function isServiceToken(value: string | null | undefined): boolean {
  if (!value) return false
  const secret = getMistSecrets().sessionSecret
  try {
    const a = Buffer.from(value)
    const b = Buffer.from(secret)
    return a.length === b.length && timingSafeEqual(a, b)
  } catch {
    return false
  }
}

function jsonReject(status: number, error: string, setCookie?: string): NextResponse {
  const headers: Record<string, string> = {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  }
  if (setCookie) headers['set-cookie'] = setCookie
  return new NextResponse(JSON.stringify({ error }), { status, headers })
}

export function proxy(req: NextRequest): NextResponse {
  const method = req.method.toUpperCase()
  const pathname = req.nextUrl.pathname
  const isRead = method === 'GET' || method === 'HEAD'
  const strictHost = process.env.MIST_STRICT_HOST === '1'

  // Gateway detection (ADR-0002/0003): Caddy preserves the external Host on
  // the way in, so a non-loopback Host = the platform preview gateway.
  const hostHn = hostnameOf(req.headers.get('host'))
  const gateway = !isLoopbackHostname(hostHn)

  // --- issue-on-visit session cookie (auto-pair, ANY request) ---
  // Gateway mode MUST be SameSite=None; Secure — a cross-site iframe never
  // replays Strict cookies, and the browser's connection to the platform is
  // https (so Secure is satisfiable even though x-forwarded-proto arrives
  // as http from the internal Caddy hop). CSRF stays handled by layer 2 +
  // the Sec-Fetch-Site voucher, not by the cookie's SameSite.
  const cookieAttrs = gateway
    ? 'SameSite=None; Secure'
    : `SameSite=Strict${req.headers.get('x-forwarded-proto') === 'https' ? '; Secure' : ''}`
  const cookieHeader = req.headers.get('cookie')
  const sessionOk = hasValidSessionCookie(cookieHeader)
  const pairCookie = !sessionOk
    ? `${SESSION_COOKIE}=${issueSession(SESSION_TTL_MS)}; Path=/; Max-Age=${SESSION_TTL_MS / 1000}; HttpOnly; ${cookieAttrs}`
    : undefined

  // --- 1. strict-host (opt-in; OFF by default per ADR-0002) ---
  if (strictHost && !isLoopbackHostname(hostnameOf(req.headers.get('host')))) {
    return jsonReject(421, 'misdirected — MIST_STRICT_HOST requires a loopback Host', pairCookie)
  }

  // --- 2. cross-origin block on state-changing methods ---
  if (!isRead) {
    const originHost = req.headers.get('origin')
    if (originHost) {
      const oh = originHostname(originHost)
      const hh = hostnameOf(req.headers.get('host'))
      if (oh && oh !== hh && !isLoopbackHostname(oh)) {
        return jsonReject(403, 'cross-origin request blocked', pairCookie)
      }
    }
  }

  const isMistApi = pathname === '/api/mist' || pathname.startsWith('/api/mist/')

  if (!isRead && isMistApi) {
    // --- 3. session / service-secret gate ---
    // Browser voucher (ADR-0003): Origin===Host proves the request came from
    // a document served from THIS origin — the app itself, including inside
    // the sandbox preview iframe where the SameSite=None cookie may be
    // unreplayable (Safari/ITP, Chrome 3PC, or headless test browsers that
    // omit fetch-metadata). Safe because layer 2 has already rejected every
    // Origin-mismatched non-GET above, and browsers ALWAYS attach Origin to
    // cross-origin requests — a third-party page can never present this
    // shape. (Sec-Fetch-Site: same-origin, when present, is the same voucher
    // — old headless Chrome omits it, so Origin is the portable anchor.)
    const originHn = originHostname(req.headers.get('origin'))
    const browserVoucher = originHn !== null && originHn === hostHn
    const needsSession =
      !sessionOk &&
      !SESSION_EXEMPT.has(pathname) &&
      process.env.MIST_OPEN_API !== '1' &&
      !isServiceToken(req.headers.get(SERVICE_HEADER)) &&
      !browserVoucher
    if (needsSession) {
      return jsonReject(403, 'session required', pairCookie)
    }

    // --- 4. Content-Type gate (absent → 415 too) ---
    // ONLY when the request actually CARRIES a body. A bodyless non-GET (the
    // A4 kill switch is DELETE /api/mist/autonomy/unleash with no payload —
    // one tap, nothing to type) is legal and must never be 415'd for lacking
    // a Content-Type: there is no body to type-check. (Found live: every
    // bodyless DELETE was refused 415 — the kill switch never fired.)
    const hasBody =
      Number(req.headers.get('content-length') ?? '0') > 0 || req.headers.get('transfer-encoding') !== null
    const ct = (req.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
    let ctOk = ct === 'application/json'
    if (pathname === '/api/mist/voice/stt' && ct === 'multipart/form-data') ctOk = true // mic upload (FormData)
    if (pathname === '/api/mist/voice/tts/stream' && ct === 'application/x-ndjson') ctOk = true // streaming lane
    if (hasBody && !ctOk) {
      return jsonReject(415, `unsupported content-type "${ct || 'none'}" — application/json required`, pairCookie)
    }
  }

  // --- 5. pass through + security headers (+ pairing cookie) ---
  const res = NextResponse.next()
  res.headers.set('Content-Security-Policy', gateway ? CSP_CORE : CSP_STRICT)
  res.headers.set('X-Content-Type-Options', 'nosniff')
  res.headers.set('Referrer-Policy', 'no-referrer')
  res.headers.set('Permissions-Policy', 'microphone=(self), camera=(), geolocation=()')
  if (pairCookie) res.headers.append('Set-Cookie', pairCookie)
  return res
}

export default proxy

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon\\.ico|av/|.*\\.(?:png|jpe?g|gif|svg|webp|ico|txt|xml|woff2?|mp3|wav|ogg)$).*)',
  ],
}
