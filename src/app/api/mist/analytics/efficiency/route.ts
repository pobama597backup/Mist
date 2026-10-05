// M.I.S.T. × OpenJarvis — efficiency analytics route (oj-spine-1).
// GET /api/mist/analytics/efficiency →
//   { totals: {requests, tokensIn, tokensOut, avgLatencyMs, costUsd},
//     perProvider: [{provider, requests, tokensIn, tokensOut, avgLatencyMs, costUsd}],
//     perAgent: [...same with agent],
//     perDay: [{day, requests, tokens}] }
//
// HONESTY NOTES (see trace-service.ts for the full price table):
//   - costUsd is an EQUIVALENT-COST ESTIMATE at public list prices per
//     provider class; the core lane (z-ai SDK) and all keyless lanes are $0
//     real spend in this sandbox.
//   - token counts are chars/4 estimates (lanes report no usage) — marked in
//     every trace's meta.tokenBasis.
import { NextResponse } from 'next/server'
import { efficiencyAnalytics } from '@/lib/oj/trace-service'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function GET() {
  try {
    const analytics = await efficiencyAnalytics()
    return NextResponse.json(analytics)
  } catch (err) {
    console.error('[efficiency route] failed:', err instanceof Error ? err.message : err)
    return NextResponse.json(
      {
        totals: { requests: 0, tokensIn: 0, tokensOut: 0, avgLatencyMs: 0, costUsd: 0 },
        perProvider: [],
        perAgent: [],
        perDay: [],
        error: 'failed to compute efficiency analytics',
      },
      { status: 500 }
    )
  }
}
