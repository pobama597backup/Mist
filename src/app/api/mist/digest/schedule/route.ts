// M.I.S.T. digest schedule API (OpenJarvis morning-digest port, oj-ops-3).
//
// POST /api/mist/digest/schedule {enabled: boolean, cron?: "0 8 * * *"}
//   → 200 {ok: true, nextRunAt?} — creates/updates/disables the digest CronJob
//   (origin 'digest'); firing is claim-guarded and shared between the scheduler
//   watch loop and the 60s heartbeat beat.
import { NextRequest, NextResponse } from 'next/server'
import { scheduleDigest } from '@/lib/oj/digest-service'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function POST(request: NextRequest) {
  let body: Record<string, unknown>
  try {
    body = (await request.json()) as Record<string, unknown>
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 })
  }
  if (typeof body.enabled !== 'boolean') {
    return NextResponse.json({ error: 'enabled (boolean) is required' }, { status: 400 })
  }
  const cron = typeof body.cron === 'string' ? body.cron : undefined
  if (body.enabled && !cron) {
    return NextResponse.json(
      { error: 'cron is required when enabling — a 5-field cron expression, e.g. "0 8 * * *"' },
      { status: 400 }
    )
  }
  try {
    const res = await scheduleDigest(body.enabled, cron)
    if (!res.ok) {
      return NextResponse.json({ error: res.error ?? 'failed to schedule digest' }, { status: 400 })
    }
    return NextResponse.json({ ok: true, nextRunAt: res.nextRunAt })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'failed to schedule digest' },
      { status: 500 }
    )
  }
}
