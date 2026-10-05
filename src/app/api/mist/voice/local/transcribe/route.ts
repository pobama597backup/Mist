// M.I.S.T. local voice transcription route — a 16kHz mono WAV captured in the
// browser (base64) transcribed OFFLINE by whisper.cpp on the user's own
// machine through the Mist Bridge. Mic audio never leaves the PC.
//
// POST {wav_b64} → {transcription, elapsedMs, model, bridgeConnected}
// 503 {error:'bridge-disconnected'|'not-installed', bridgeConnected} when the
// engines aren't usable — the frontend then falls back to the cloud path.
import { NextRequest, NextResponse } from 'next/server'
import { bridgeExec } from '@/lib/services/bridge-service'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const MAX_B64_CHARS = 16 * 1024 * 1024 // ≤ ~12MB decoded WAV

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => null)) as { wav_b64?: unknown } | null
    if (!body || typeof body.wav_b64 !== 'string' || !body.wav_b64.trim()) {
      return NextResponse.json({ error: 'wav_b64 is required' }, { status: 400 })
    }
    if (body.wav_b64.length > MAX_B64_CHARS) {
      return NextResponse.json({ error: 'wav_b64 exceeds the 16MB character limit' }, { status: 413 })
    }

    const res = await bridgeExec('voice_stt', { wav_b64: body.wav_b64 })
    if (!res.bridgeConnected) {
      return NextResponse.json(
        { error: 'bridge-disconnected', bridgeConnected: false },
        { status: 503 }
      )
    }
    if (!res.ok) {
      const error = typeof res.error === 'string' ? res.error : 'transcription failed'
      return NextResponse.json({ error, bridgeConnected: true }, { status: 503 })
    }
    const data = (res.data ?? {}) as { text?: unknown; elapsedMs?: unknown; model?: unknown }
    return NextResponse.json({
      transcription: typeof data.text === 'string' ? data.text : '',
      elapsedMs: typeof data.elapsedMs === 'number' ? data.elapsedMs : null,
      model: typeof data.model === 'string' ? data.model : null,
      bridgeConnected: true,
    })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'local transcription failed' },
      { status: 500 }
    )
  }
}
