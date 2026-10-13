// M.I.S.T. local voice status route — the offline engines on the user's own
// machine (whisper.cpp hearing + piper speaking), reported through the Mist
// Bridge daemon. GET is the single cheap probe the frontend uses to decide
// whether voice runs locally: when the bridge is down it answers 503 with
// {error:'bridge-disconnected'} so the UI can render an offline state
// instead of a 500 crash.
import { NextResponse } from 'next/server'
import { bridgeExec } from '@/lib/services/bridge-service'
import { routeError } from '@/lib/route-error'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function GET() {
  // Phase 3-a · R12: JSON errors only — never an HTML 500 page.
  try {
    const res = await bridgeExec('voice_status', {}, { origin: 'owner_voice' }) // Phase 2-b
    if (!res.bridgeConnected) {
      return NextResponse.json(
        { error: 'bridge-disconnected', bridgeConnected: false },
        { status: 503 }
      )
    }
    const data = (res.data ?? {}) as Record<string, unknown>
    const voice = data.voice && typeof data.voice === 'object' ? data.voice : null
    return NextResponse.json({ ok: res.ok, voice, bridgeConnected: true })
  } catch (err) {
    return routeError(err, 'local voice status failed')
  }
}
