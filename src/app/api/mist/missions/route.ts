// /api/mist/missions — the mission control surface.
// GET  → list missions (newest first, 50)
// POST → { goal, title?, maxSteps?, maxMinutes? } create + start a mission
import { NextRequest, NextResponse } from 'next/server'
import { startMission, missionStatus } from '@/lib/services/mission-service'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function GET() {
  try {
    const missions = await missionStatus()
    return NextResponse.json({ missions })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'failed to list missions' },
      { status: 500 }
    )
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => null)) as {
      goal?: string
      title?: string
      maxSteps?: number
      maxMinutes?: number
      origin?: string
    } | null
    const goal = typeof body?.goal === 'string' ? body.goal.trim() : ''
    if (!goal) {
      return NextResponse.json({ error: 'goal is required' }, { status: 400 })
    }
    // origin: 'user' (default) | 'training' (the w4 training catalog — carries
    // the teach-1-learn-10 / no-petting / no-repeat pedagogy in the prompts)
    const origin = body?.origin === 'training' ? 'training' : 'user'
    const mission = await startMission({
      goal,
      title: body?.title,
      origin,
      maxSteps: body?.maxSteps,
      maxMinutes: body?.maxMinutes,
    })
    return NextResponse.json({ mission })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'failed to start mission' },
      { status: 500 }
    )
  }
}
