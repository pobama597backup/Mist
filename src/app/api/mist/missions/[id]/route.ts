// /api/mist/missions/[id] — one mission.
// GET  → full detail (plan, step transcript, verification, capability gaps)
// POST → { action: 'pause' | 'resume' | 'cancel' | 'reverify', reason? }
//   reverify re-runs the skeptical pass against LIVE state (proposal statuses
//   NOW + fresh reads of applied files) — for missions finalized before the
//   fairness fixes, or after a pending proposal got applied late.
import { NextRequest, NextResponse } from 'next/server'
import { missionDetail, pauseMission, resumeMission, cancelMission, reverifyMission } from '@/lib/services/mission-service'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const detail = await missionDetail(id)
    return NextResponse.json(detail)
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'mission not found' },
      { status: 404 }
    )
  }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const body = (await req.json().catch(() => ({}))) as { action?: string; reason?: string }
    const action = String(body.action ?? '').trim().toLowerCase()
    const reason = typeof body.reason === 'string' ? body.reason : ''
    if (action === 'pause') {
      return NextResponse.json({ mission: await pauseMission(id, reason) })
    }
    if (action === 'resume') {
      return NextResponse.json({ mission: await resumeMission(id) })
    }
    if (action === 'cancel') {
      return NextResponse.json({ mission: await cancelMission(id) })
    }
    if (action === 'reverify') {
      // runs the LLM verification pass (up to ~60s) — respond when it's done
      const mission = await reverifyMission(id)
      return NextResponse.json({ mission })
    }
    return NextResponse.json({ error: `unknown action "${action}" — use pause | resume | cancel | reverify` }, { status: 400 })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'mission control failed' },
      { status: 500 }
    )
  }
}
