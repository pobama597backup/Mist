import { NextRequest, NextResponse } from 'next/server'
import { syncOpenClaw, getOpenClawStatus, ensureOpenClawWatch } from '@/lib/services/openclaw-service'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export const maxDuration = 120

export async function GET() {
  try {
    ensureOpenClawWatch()
    return NextResponse.json(await getOpenClawStatus())
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'failed to read openclaw status' },
      { status: 500 }
    )
  }
}

export async function POST(req: NextRequest) {
  try {
    ensureOpenClawWatch()
    const body = (await req.json().catch(() => null)) as { action?: unknown } | null
    if (body?.action === 'sync') {
      const result = await syncOpenClaw(true)
      const status = await getOpenClawStatus()
      return NextResponse.json({ ok: result.ok, sync: result, openclaw: status })
    }
    return NextResponse.json({ error: 'unknown action — use {"action":"sync"}' }, { status: 400 })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'openclaw sync failed' },
      { status: 500 }
    )
  }
}
