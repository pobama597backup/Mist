// M.I.S.T. operator action API (OpenJarvis always-on operator port, oj-ops-3).
//
// POST /api/mist/operators/[id] {action: "run"|"pause"|"resume"} → {ok}
//   run fires the operator immediately (manual runs ignore due-ness and leave
//   the schedule untouched); pause/resume flip the operator's status.
import { NextRequest, NextResponse } from 'next/server'
import { runOperator, setOperatorStatus } from '@/lib/oj/operator-service'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function POST(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id: slug } = await ctx.params
  let body: Record<string, unknown>
  try {
    body = (await request.json()) as Record<string, unknown>
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 })
  }
  const action = typeof body.action === 'string' ? body.action : ''
  if (action !== 'run' && action !== 'pause' && action !== 'resume') {
    return NextResponse.json({ error: 'action must be "run" | "pause" | "resume"' }, { status: 400 })
  }
  try {
    if (action === 'pause' || action === 'resume') {
      const res = await setOperatorStatus(slug, action === 'pause' ? 'paused' : 'active')
      if (!res.ok) return NextResponse.json({ error: res.error ?? 'failed to update operator' }, { status: 400 })
      return NextResponse.json({ ok: true })
    }
    const res = await runOperator(slug, { origin: 'manual' })
    if (!res.ok) {
      return NextResponse.json({ ok: false, status: res.status, error: res.result }, { status: 400 })
    }
    return NextResponse.json({ ok: true, status: res.status, result: res.result })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'operator action failed' },
      { status: 500 }
    )
  }
}
