// /api/mist/introspection — the self-doctor surface.
// GET  → last deep self-check report (or { never_ran: true })
// POST → run a fresh sweep now ({ repair?: boolean }, default true)
import { NextRequest, NextResponse } from 'next/server'
import { getLastIntrospection, runIntrospection } from '@/lib/services/introspection-service'

export async function GET() {
  const last = getLastIntrospection()
  if (!last) {
    return NextResponse.json({ never_ran: true, note: 'POST to run the first deep self-check' })
  }
  return NextResponse.json(last)
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => ({}))) as { repair?: boolean }
    const report = await runIntrospection({
      repair: body.repair !== false,
      source: 'manual',
    })
    return NextResponse.json(report)
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'introspection failed' },
      { status: 500 }
    )
  }
}
