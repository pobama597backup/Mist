// GET  /api/mist/connectors — full connector catalog (frozen shape):
//        {connectors: [{id, name, kind, connected, available, items, lastSyncAt, note}]}
// POST /api/mist/connectors — {id, action: "sync", config?} → honest sync result.
//        Config (owner/repo for github, subreddit for reddit) persists per
//        connector; OAuth connectors refuse with the real reason — never faked.
import { NextRequest, NextResponse } from 'next/server'
import { listConnectors, syncConnector, CONNECTOR_IDS } from '@/lib/oj/connectors'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function GET(): Promise<NextResponse> {
  try {
    const { connectors } = await listConnectors()
    return NextResponse.json({ connectors })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'connector listing failed'
    return NextResponse.json(
      { connectors: [], ok: false, error: message },
      { status: 500 }
    )
  }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    let body: Record<string, unknown>
    try {
      body = JSON.parse(await req.text()) as Record<string, unknown>
    } catch {
      return NextResponse.json({ ok: false, error: 'invalid JSON body' }, { status: 400 })
    }

    const id = typeof body.id === 'string' ? body.id.trim() : ''
    const action = typeof body.action === 'string' ? body.action.trim().toLowerCase() : ''
    if (!id || !CONNECTOR_IDS.includes(id)) {
      return NextResponse.json(
        { ok: false, error: `unknown connector '${id}' — valid: ${CONNECTOR_IDS.join(', ')}` },
        { status: 400 }
      )
    }
    if (action !== 'sync') {
      return NextResponse.json({ ok: false, error: 'only action "sync" is supported' }, { status: 400 })
    }

    const config =
      body.config && typeof body.config === 'object' && !Array.isArray(body.config)
        ? (body.config as Record<string, unknown>)
        : undefined

    const result = await syncConnector(id, config)
    // fresh listing so the response carries the post-sync status (items, connected)
    const { connectors } = await listConnectors()
    const status = connectors.find((c) => c.id === id) ?? null
    return NextResponse.json({ ok: result.ok, result, connector: status })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'connector sync failed'
    return NextResponse.json({ ok: false, error: message }, { status: 500 })
  }
}
