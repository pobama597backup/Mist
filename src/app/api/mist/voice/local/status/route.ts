// M.I.S.T. local voice status route — the offline engines on the user's own
// machine (whisper.cpp hearing + piper speaking), reported through the Mist
// Bridge daemon. GET is the single cheap probe the frontend uses to decide
// whether voice runs locally: when the bridge is down it answers 503 with
// {error:'bridge-disconnected'} so the UI can render an offline state
// instead of a 500 crash.
import { NextResponse } from 'next/server'
import { bridgeExec } from '@/lib/services/bridge-service'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function GET() {
  const res = await bridgeExec('voice_status')
  if (!res.bridgeConnected) {
    return NextResponse.json(
      { error: 'bridge-disconnected', bridgeConnected: false },
      { status: 503 }
    )
  }
  const data = (res.data ?? {}) as Record<string, unknown>
  const voice = data.voice && typeof data.voice === 'object' ? data.voice : null
  return NextResponse.json({ ok: res.ok, voice, bridgeConnected: true })
}
