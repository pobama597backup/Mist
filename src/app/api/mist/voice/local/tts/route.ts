// M.I.S.T. local voice TTS route — text synthesized OFFLINE by Piper on the
// user's own machine through the Mist Bridge. The response contract is
// IDENTICAL to the cloud /api/mist/voice/tts route (audio/wav bytes,
// no-store), so the frontend player code is reusable as-is.
//
// POST {text, voice?} → audio/wav | 503 {error, bridgeConnected}
import { NextRequest, NextResponse } from 'next/server'
import { bridgeExec } from '@/lib/services/bridge-service'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const MAX_TEXT = 1000 // the client chunks — same contract as the cloud route
const RE_VOICE = /^en_[A-Z]{2}(-[a-z]+)?-(low|medium|x_low)$/

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => null)) as { text?: unknown; voice?: unknown } | null
    if (!body || typeof body.text !== 'string' || !body.text.trim()) {
      return NextResponse.json({ error: 'text is required' }, { status: 400 })
    }
    if (body.text.length > MAX_TEXT) {
      return NextResponse.json(
        { error: 'text exceeds the 1000-character limit (the client chunks)' },
        { status: 400 }
      )
    }
    let voice: string | undefined
    if (typeof body.voice === 'string' && body.voice.trim()) {
      if (!RE_VOICE.test(body.voice.trim())) {
        return NextResponse.json(
          { error: 'voice must look like en_US-amy-low (or be omitted for the default)' },
          { status: 400 }
        )
      }
      voice = body.voice.trim()
    }

    const res = await bridgeExec('voice_tts', { text: body.text, ...(voice ? { voice } : {}) })
    if (!res.bridgeConnected) {
      return NextResponse.json(
        { error: 'bridge-disconnected', bridgeConnected: false },
        { status: 503 }
      )
    }
    if (!res.ok) {
      return NextResponse.json(
        { error: res.error ?? 'local synthesis failed', bridgeConnected: true },
        { status: 503 }
      )
    }
    const data = (res.data ?? {}) as { wav_b64?: unknown }
    if (typeof data.wav_b64 !== 'string' || !data.wav_b64) {
      return NextResponse.json(
        { error: 'bridge returned no audio', bridgeConnected: true },
        { status: 502 }
      )
    }
    const bytes = Buffer.from(data.wav_b64, 'base64')
    if (bytes.length < 44) {
      return NextResponse.json(
        { error: 'bridge returned invalid audio', bridgeConnected: true },
        { status: 502 }
      )
    }
    return new NextResponse(new Uint8Array(bytes), {
      status: 200,
      headers: {
        'Content-Type': 'audio/wav',
        'Cache-Control': 'no-store',
      },
    })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'local text-to-speech failed' },
      { status: 500 }
    )
  }
}
