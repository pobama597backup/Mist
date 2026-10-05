import { NextRequest, NextResponse } from 'next/server'
import { suggestFeatures, ensureEvolutionWatch } from '@/lib/services/evolution-service'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export const maxDuration = 300

export async function POST(req: NextRequest) {
  try {
    ensureEvolutionWatch()
    const body = (await req.json().catch(() => null)) as { origin?: unknown; goal?: unknown } | null
    const origin =
      body?.origin === 'openclaw' || body?.origin === 'user' || body?.origin === 'self-idea'
        ? body.origin
        : 'self-idea'
    const goal = typeof body?.goal === 'string' && body.goal.trim() ? body.goal : undefined
    const proposals = await suggestFeatures(origin, goal)
    return NextResponse.json({
      ok: true,
      proposals,
      message:
        proposals.length > 0
          ? goal
            ? `${proposals.length} directed proposal(s) for the creator's request — review them below.`
            : `${proposals.length} fresh idea(s) proposed — review them below.`
          : 'No new ideas right now — try again later or seed with an OpenClaw sync.',
    })
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        proposals: [],
        message: err instanceof Error ? err.message : 'feature ideation failed',
      },
      { status: 500 }
    )
  }
}
