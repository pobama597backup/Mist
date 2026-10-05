// M.I.S.T. operators API (OpenJarvis always-on operator port, oj-ops-3).
//
// GET /api/mist/operators → {operators: [{slug, name, status, schedule,
//                                humanSchedule, lastRunAt, lastStatus, runCount}]}
//   (+ description, budget, tools, enabled, nextRunAt — additive). Also arms
//   seeding + one operator tick (the 60s cadence is driven by the heartbeat).
import { NextResponse } from 'next/server'
import { listOperators, ensureOperatorWatch } from '@/lib/oj/operator-service'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function GET() {
  try {
    ensureOperatorWatch()
    const operators = await listOperators()
    return NextResponse.json({ operators })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'failed to list operators' },
      { status: 500 }
    )
  }
}
