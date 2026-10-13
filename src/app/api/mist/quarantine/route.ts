// /api/mist/quarantine — the S11 quarantine inbox (Phase 2-c).
//
// GET  (open like every memory GET) → pending items newest-first (cap 50) +
//       lifetime counts — the memory drawer polls this.
// POST (session-gated by proxy.ts, like every non-GET) → the owner's
//       decision on one item: accept | edit | drop. Accepting performs the
//       write with trust 'derived' + source quarantine:<id>; dropping writes
//       nothing. Never injects until accepted — by construction the items
//       live in their own table, recall never reads them.
import { NextRequest, NextResponse } from 'next/server'
import { listQuarantine, decideQuarantineItem } from '@/lib/arbiter/quarantine'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function GET() {
  try {
    const data = await listQuarantine(50)
    return NextResponse.json(data)
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'failed to list quarantine items' },
      { status: 500 }
    )
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => null)) as {
      action?: unknown
      id?: unknown
      decision?: unknown
      content?: unknown
    } | null
    if (!body || body.action !== 'decide') {
      return NextResponse.json({ error: 'action must be "decide"' }, { status: 400 })
    }
    if (typeof body.id !== 'string' || !body.id.trim()) {
      return NextResponse.json({ error: 'id is required' }, { status: 400 })
    }
    if (body.decision !== 'accept' && body.decision !== 'edit' && body.decision !== 'drop') {
      return NextResponse.json({ error: 'decision must be accept | edit | drop' }, { status: 400 })
    }
    const content = typeof body.content === 'string' ? body.content : undefined
    const result = await decideQuarantineItem(body.id.trim(), body.decision, content)
    if (!result.ok) {
      const status = result.error?.includes('not found') ? 404 : result.error?.includes('already') ? 409 : 400
      return NextResponse.json({ error: result.error }, { status })
    }
    return NextResponse.json(result)
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'failed to decide quarantine item' },
      { status: 500 }
    )
  }
}
