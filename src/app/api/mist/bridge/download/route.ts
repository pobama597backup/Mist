// M.I.S.T. bridge download route — serves the Mist Bridge daemon script
// (db/bridge/mist-bridge.js) as a downloadable file so the owner can run it
// on their own machine. The same file also lives on disk for direct access.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { NextResponse } from 'next/server'
import { projectRoot } from '@/lib/services/telemetry-service'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const BRIDGE_FILE = path.join(projectRoot(), 'db', 'bridge', 'mist-bridge.js')

export async function GET(): Promise<NextResponse> {
  try {
    const script = readFileSync(BRIDGE_FILE, 'utf-8')
    return new NextResponse(script, {
      status: 200,
      headers: {
        'Content-Type': 'text/javascript; charset=utf-8',
        'Content-Disposition': 'attachment; filename="mist-bridge.js"',
        'Cache-Control': 'no-store',
      },
    })
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : 'bridge script unavailable' },
      { status: 500 }
    )
  }
}
