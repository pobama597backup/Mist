// M.I.S.T. cron job API — run a job immediately (awaits the LLM result).
//
// POST /api/mist/cron/[id]/run → 200 { ok: true, result: string }
//                              | 404 { ok: false, error: 'job not found' }
//                              | 409 { ok: false, error: 'job is already running' }
//                              | 500 { ok: false, error }
// The run goes through the same execution path as a scheduled fire (Alert row
// for delivery 'alert', autonomy ledger entry, lastRun/nextRun bookkeeping,
// one_time jobs disabled after firing).
import { NextRequest, NextResponse } from 'next/server'
import { runCronJobNow } from '@/lib/services/scheduler-service'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function POST(_request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  const res = await runCronJobNow(id)
  if (res.ok) {
    return NextResponse.json({ ok: true, result: res.result ?? '' })
  }
  if (res.error === 'job not found') {
    return NextResponse.json({ ok: false, error: res.error }, { status: 404 })
  }
  if (res.error === 'job is already running') {
    return NextResponse.json({ ok: false, error: res.error }, { status: 409 })
  }
  return NextResponse.json({ ok: false, error: res.error ?? 'failed to run job' }, { status: 500 })
}
