// GET /api/mist/environment — "where am I?" Machine awareness for the status
// bar chip, the welcome briefing, and anyone asking. On a machine's FIRST
// boot she also writes a longterm fact (her own memory carries where she
// now lives) and records an activity line — the "I woke up somewhere new"
// moment. Home boots stay silent: no noise, no greeting changes.
import { NextResponse } from 'next/server'
import { getEnvironment } from '@/lib/env'
import { upsertFact } from '@/lib/services/memory-service'
import { recordActivity } from '@/lib/services/activity-service'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function GET() {
  try {
    const env = getEnvironment()
    if (env.firstBoot) {
      const where = env.isHome
        ? `her home sandbox (${env.hostname})`
        : `a new machine — ${env.hostname} (${env.platform})`
      await upsertFact(
        'environment:current',
        JSON.stringify({
          hostname: env.hostname,
          platform: env.platform,
          root: env.root,
          isHome: env.isHome,
          machineId: env.machineId,
          notedAt: new Date().toISOString(),
        }),
        'auto'
      ).catch(() => undefined)
      try {
        recordActivity('heartbeat', `woke up on ${where}`)
      } catch {
        /* best-effort */
      }
    }
    return NextResponse.json(env)
  } catch (err) {
    // awareness must never break the app
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'environment check failed' },
      { status: 200 }
    )
  }
}
