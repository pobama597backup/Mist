// M.I.S.T. trends route — trend digests + the self-upgrade cycle.
//
// GET  → {"last": TrendDigest|null, "history": [{generatedAt, headline}, …]}
// POST {"mode": "digest"}  → runTrendDigest()   (~30-120s) → digest JSON
// POST {"mode": "upgrade"} → runSelfUpgradeCycle() (~60-180s) → full result
import { NextRequest, NextResponse } from 'next/server'
import { getLastDigest, listDigestHistory, runSelfUpgradeCycle, runTrendDigest } from '@/lib/services/trend-service'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export const maxDuration = 300

export async function GET() {
  try {
    return NextResponse.json({
      last: getLastDigest(),
      history: await listDigestHistory(20),
    })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'failed to load trend digests' },
      { status: 500 }
    )
  }
}

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as { mode?: unknown } | null
  const mode = body?.mode === 'upgrade' ? 'upgrade' : body?.mode === 'digest' ? 'digest' : null
  if (!mode) {
    return NextResponse.json({ error: 'mode must be "digest" or "upgrade"' }, { status: 400 })
  }

  try {
    if (mode === 'digest') {
      const digest = await runTrendDigest()
      return NextResponse.json({ ok: true, mode, digest })
    }
    const result = await runSelfUpgradeCycle()
    return NextResponse.json({ ok: true, mode, result })
  } catch (err) {
    // the services never throw on purpose — this is a belt-and-braces net
    return NextResponse.json(
      { ok: false, mode, error: err instanceof Error ? err.message : 'trend run failed' },
      { status: 500 }
    )
  }
}
