import { NextRequest, NextResponse } from 'next/server'
import { vectorSearch } from '@/lib/services/vector-service'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => null)) as { query?: unknown; n_results?: unknown } | null
    if (!body || typeof body.query !== 'string' || !body.query.trim()) {
      return NextResponse.json({ error: 'query is required' }, { status: 400 })
    }
    const n =
      typeof body.n_results === 'number' && Number.isFinite(body.n_results)
        ? Math.max(1, Math.min(25, Math.floor(body.n_results)))
        : 5
    // graceful when the store is empty or unavailable
    const results = await vectorSearch(body.query, n)
    return NextResponse.json({ results })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'vector search failed' },
      { status: 500 }
    )
  }
}
