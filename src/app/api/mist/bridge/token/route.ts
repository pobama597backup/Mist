// /api/mist/bridge/token — show this machine's bridge token to the OWNER.
//
// Phase 1 · S1: the bridge daemon (v3.6+) demands `Authorization: Bearer
// <token>`; the token lives in ~/.mist/bridge.json (0600). This route lets
// the owner read it from Settings → Local Bridge (copy button) — e.g. to
// paste into MIST_BRIDGE_TOKEN on another machine whose bridge they point
// Mist at. Session required: the token IS a credential for the daemon.
import { NextRequest, NextResponse } from 'next/server'
import { hasValidSessionCookie } from '@/lib/perimeter/shared'
import { bridgeToken } from '@/lib/services/bridge-service'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function GET(req: NextRequest) {
  if (!hasValidSessionCookie(req.headers.get('cookie'))) {
    return NextResponse.json({ error: 'session required' }, { status: 403 })
  }
  return NextResponse.json(
    {
      ok: true,
      token: bridgeToken(),
      hint: 'same-machine bridges pick this up automatically. Pointing Mist at a bridge on ANOTHER machine? copy this token into MIST_BRIDGE_TOKEN in .env there.',
    },
    { headers: { 'Cache-Control': 'no-store' } }
  )
}
