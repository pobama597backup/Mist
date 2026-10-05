// M.I.S.T. × OpenJarvis — traces list route (oj-spine-1).
// GET /api/mist/traces?agent=&outcome=&limit= →
//   { traces: [{id, query, agent, model, provider, outcome, tier, complexity,
//               tokensIn, tokensOut, latencyMs, steps: count, createdAt}] }
import { NextRequest, NextResponse } from 'next/server'
import { listTraces, reapStaleTraces } from '@/lib/oj/trace-service'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function GET(req: NextRequest) {
  try {
    const params = req.nextUrl.searchParams
    const agent = params.get('agent') ?? undefined
    const outcome = params.get('outcome') ?? undefined
    const limit = params.get('limit') ?? undefined
    const offset = params.get('offset') ?? undefined

    // honest cleanup: traces stuck `running` >1h are dead runs (restarts)
    await reapStaleTraces()

    const traces = await listTraces({
      agent: agent || undefined,
      outcome: outcome || undefined,
      limit: limit ? Number(limit) : 50,
      offset: offset ? Number(offset) : 0,
    })
    return NextResponse.json({ traces })
  } catch (err) {
    console.error('[traces route] failed:', err instanceof Error ? err.message : err)
    return NextResponse.json({ traces: [], error: 'failed to list traces' }, { status: 500 })
  }
}
