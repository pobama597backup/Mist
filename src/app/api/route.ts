// M.I.S.T. API root (Phase 3-a · R12).
//
// The phase-0 audit called this scaffold out: it answered the "Hello,
// world!" Next template line — noise on an API surface. This is the honest
// replacement: a one-line JSON service banner pointing at the real health
// endpoint. Not a 404 (the API surface itself is alive; pretending otherwise
// would be the opposite of honest).
import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function GET() {
  return NextResponse.json({
    service: 'mist-unified',
    status: 'ok',
    health: '/api/mist/health',
    note: 'M.I.S.T. API surface — see /api/mist/health for live status',
  })
}
