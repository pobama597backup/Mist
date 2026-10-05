// M.I.S.T. free-lanes route — the researched unlimited/top-model access map.
// GET  → every lane with live activation status (keys never exposed)
// POST → { action: 'discover', lane: '<id>' } lists the REAL models a lane
//        serves right now (public catalogs work without a key).
import { NextRequest, NextResponse } from 'next/server'
import { discoverLaneModels, getFreeLanesInfo } from '@/lib/services/free-lanes'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export const maxDuration = 60

export async function GET() {
  try {
    return NextResponse.json({ lanes: getFreeLanesInfo() })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'failed to read lanes' },
      { status: 500 }
    )
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json().catch(() => null)) as { action?: string; lane?: string } | null
    if (body?.action !== 'discover' || typeof body.lane !== 'string' || !body.lane.trim()) {
      return NextResponse.json({ error: 'body must be { action: "discover", lane: "<id>" }' }, { status: 400 })
    }
    const models = await discoverLaneModels(body.lane.trim())
    return NextResponse.json({ lane: body.lane.trim(), models })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'discovery failed' },
      { status: 400 }
    )
  }
}
