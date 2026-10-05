// M.I.S.T. autonomy ledger API — every action MIST takes on her own.
//
// GET /api/mist/autonomy?limit=60&type=cron_run
//   → 200 { events: AutonomyEvent[], stats: { total, last24h, byType, lastEventAt } }
// limit is clamped to 1..200 (default 60); type filters by autonomy event type
// (skill_created | skill_refined | memory_curated | user_model_updated |
//  self_review | trend_digest | upgrade_proposed | cron_run | vault_event).
import { NextRequest, NextResponse } from 'next/server'
import { listAutonomyEvents, autonomyStats } from '@/lib/services/autonomy-service'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const limitRaw = searchParams.get('limit')
    let limit = 60
    if (limitRaw) {
      const n = parseInt(limitRaw, 10)
      if (Number.isFinite(n) && n >= 1) limit = n
    }
    const typeRaw = searchParams.get('type')
    const type = typeof typeRaw === 'string' && typeRaw.trim() ? typeRaw.trim() : undefined
    const [events, stats] = await Promise.all([listAutonomyEvents(limit, type), autonomyStats()])
    return NextResponse.json({ events, stats })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'failed to read autonomy ledger' },
      { status: 500 }
    )
  }
}
