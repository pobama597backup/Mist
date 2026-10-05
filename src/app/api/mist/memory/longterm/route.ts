import { NextRequest, NextResponse } from 'next/server'
import { listFacts, upsertFact } from '@/lib/services/memory-service'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function GET() {
  try {
    return NextResponse.json(await listFacts())
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'failed to list facts' },
      { status: 500 }
    )
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => null)) as { key?: unknown; value?: unknown } | null
    if (
      !body ||
      typeof body.key !== 'string' ||
      !body.key.trim() ||
      typeof body.value !== 'string' ||
      !body.value.trim()
    ) {
      return NextResponse.json({ error: 'key and value are required' }, { status: 400 })
    }
    await upsertFact(body.key.trim(), body.value)
    return NextResponse.json({ success: true })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'failed to store fact' },
      { status: 500 }
    )
  }
}
