// /api/mist/data-boundary — the TRUTHFUL 24h egress ledger (Phase 5 · C6,
// rebuilt after the 3-a deletion killed the decorative version).
//
// GET ?sinceMs=<epoch> →
//   {
//     dial: { mode },                       — the candor dial right now
//     watchers: { enabled },                — the outbound-watcher opt-in
//     window: { sinceMs, untilMs },
//     entries: [{host, lane, klass, count, bytes, loopback, lastTs}],
//     totals: { calls, nonLoopbackCalls },
//     sources: { ring, persisted },         — in-memory detail + hourly EgressEvent snapshots
//     note: honesty about what this ledger covers
//   }
//
// Every instrumented outbound call (LLM lanes, keyless lanes, the local lane,
// watchers, cloud voice, google-direct server-side) lands here — grouped by
// host+class+lane. In Unfiltered the tripwire refuses non-loopback BEFORE the
// socket opens, so a turn run under Unfiltered shows ~zero non-loopback rows.
import { NextRequest, NextResponse } from 'next/server'
import { egressSummary24h, ensureEgressFlushWatch } from '@/lib/services/egress'
import { getGlobalCandorMode } from '@/lib/services/candor-service'
import { outboundWatchersEnabled } from '@/lib/services/settings-service'
import { routeError } from '@/lib/route-error'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function GET(req: NextRequest) {
  try {
    ensureEgressFlushWatch() // idempotent — arms the hourly snapshot timer
    const sinceRaw = req.nextUrl.searchParams.get('sinceMs')
    let sinceMs: number | undefined
    if (sinceRaw) {
      const n = Number(sinceRaw)
      if (Number.isFinite(n) && n > 0) sinceMs = n
    }
    const [summary, mode, watchers] = await Promise.all([
      egressSummary24h(sinceMs),
      getGlobalCandorMode(),
      outboundWatchersEnabled(),
    ])
    return NextResponse.json({
      dial: { mode },
      watchers: { enabled: watchers },
      window: { sinceMs: summary.windowStartMs, untilMs: Date.now() },
      entries: summary.entries,
      totals: { calls: summary.totalCalls, nonLoopbackCalls: summary.nonLoopbackCalls },
      sources: summary.sources,
      note:
        'every instrumented outbound call this process made (LLM/keyless/local lanes, watchers, cloud voice, google-direct) — ' +
        'hourly snapshots persist across restarts. Unfiltered trips non-loopback at the door, so an Unfiltered window shows ~zero non-loopback rows. ' +
        'Honest scope: the browser pilot and the bridge are loopback daemons on this machine (their own sockets are theirs); ' +
        'SDK-transported calls (z-ai core/voice) expose no fetch handle and are excluded from Unfiltered structurally instead.',
    })
  } catch (err) {
    return routeError(err, 'failed to read the egress ledger')
  }
}
