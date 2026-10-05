import { NextRequest, NextResponse } from 'next/server'
import { saveSkill } from '@/lib/services/skills-service'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => null)) as {
      name?: unknown
      trigger?: unknown
      steps?: unknown
      tool_chain?: unknown
      notes?: unknown
    } | null
    if (
      !body ||
      typeof body.name !== 'string' ||
      !body.name.trim() ||
      typeof body.trigger !== 'string' ||
      !body.trigger.trim()
    ) {
      return NextResponse.json({ error: 'name and trigger are required' }, { status: 400 })
    }
    const skill = await saveSkill({
      name: body.name.trim().slice(0, 120),
      trigger: body.trigger.trim().slice(0, 400),
      steps: typeof body.steps === 'string' ? body.steps : '',
      tool_chain: Array.isArray(body.tool_chain)
        ? body.tool_chain.filter((t): t is string => typeof t === 'string')
        : [],
      notes: typeof body.notes === 'string' ? body.notes : '',
    })
    return NextResponse.json({ success: true, skill })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'failed to save skill' },
      { status: 500 }
    )
  }
}
