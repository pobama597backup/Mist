import { NextResponse } from 'next/server'
import {
  listProposals,
  getEvolutionStats,
  getEvolutionAutoInfo,
  ensureEvolutionWatch,
} from '@/lib/services/evolution-service'
import { getOpenClawStatus, ensureOpenClawWatch } from '@/lib/services/openclaw-service'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function GET() {
  try {
    // any API touch boots the proactive loops (globalThis-guarded, no dupes)
    ensureEvolutionWatch()
    ensureOpenClawWatch()

    const [proposals, stats, openclaw] = await Promise.all([
      listProposals(),
      getEvolutionStats(),
      getOpenClawStatus(),
    ])
    return NextResponse.json({
      proposals,
      stats,
      openclaw,
      auto: getEvolutionAutoInfo(),
    })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'failed to list evolution proposals' },
      { status: 500 }
    )
  }
}
