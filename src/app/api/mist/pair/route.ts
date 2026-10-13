// /api/mist/pair — mint a mist_session cookie from a pair code.
//
// The pair code is hmac(sessionSecret, "pair") — printed by run.bat on the
// owner's PC (and derivable in any terminal from ~/.mist/mist.json). GET
// /api/mist/pair?code=<code> from a browser on THIS machine pairs that
// browser with the app: 30-day HttpOnly SameSite=Strict session cookie.
// Wrong code → honest 403, no cookie. This route is one of the two
// session-gate exemptions in the proxy (it must be: it MINTS sessions).
import { NextRequest, NextResponse } from 'next/server'
import { timingSafeEqual } from 'node:crypto'
import {
  SESSION_COOKIE,
  SESSION_TTL_MS,
  issueSession,
  pairCode,
} from '@/lib/perimeter/shared'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get('code') ?? ''
  const expected = pairCode()
  let ok = false
  if (/^[a-f0-9]{64}$/.test(code)) {
    try {
      const a = Buffer.from(code, 'hex')
      const b = Buffer.from(expected, 'hex')
      ok = a.length === b.length && timingSafeEqual(a, b)
    } catch {
      ok = false
    }
  }
  if (!ok) {
    return NextResponse.json(
      { error: 'invalid pair code — run.bat prints the current one, or read ~/.mist/mist.json' },
      { status: 403, headers: { 'Cache-Control': 'no-store' } }
    )
  }
  const res = NextResponse.json(
    { ok: true, hint: 'session minted — this browser is paired with this machine for 30 days' },
    { headers: { 'Cache-Control': 'no-store' } }
  )
  res.cookies.set({
    name: SESSION_COOKIE,
    value: issueSession(SESSION_TTL_MS),
    httpOnly: true,
    sameSite: 'strict',
    path: '/',
    maxAge: SESSION_TTL_MS / 1000,
    secure: req.headers.get('x-forwarded-proto') === 'https',
  })
  return res
}
