import { NextRequest, NextResponse } from 'next/server'
import { transcribeAudio } from '@/lib/services/voice-service'
import { checkRateLimit, rateLimitResponse } from '@/lib/perimeter/rate-limit'
import { getGlobalCandorMode } from '@/lib/services/candor-service'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const MAX_AUDIO_BYTES = 15 * 1024 * 1024 // 15MB

export async function POST(req: NextRequest) {
  // Phase 1 · S12: voice lane (STT) — 60/min per session.
  const rl = checkRateLimit('voice', req)
  if (!rl.ok) return rateLimitResponse('voice', rl.retryAfter ?? 1)
  // Phase 5 · C2 (Unfiltered): cloud ASR is OFF (mic audio never leaves the
  // machine while the dial is Unfiltered). The local path (the bridge's
  // whisper.cpp, /api/mist/voice/local/transcribe) stays open.
  if ((await getGlobalCandorMode()) === 'unfiltered') {
    return NextResponse.json(
      {
        error:
          'voice is local-only in Unfiltered — cloud speech-to-text is off (mic audio stays on this machine). Connect a local voice engine via the bridge, or switch the dial.',
      },
      { status: 403 }
    )
  }
  try {
    const form = await req.formData().catch(() => null)
    const file = form?.get('audio_file')
    if (!file || typeof file === 'string' || typeof (file as Blob).arrayBuffer !== 'function') {
      return NextResponse.json({ error: 'audio_file field is required' }, { status: 400 })
    }
    const blob = file as Blob
    if (blob.size > MAX_AUDIO_BYTES) {
      return NextResponse.json({ error: 'audio file exceeds 15MB limit' }, { status: 413 })
    }
    const buffer = Buffer.from(new Uint8Array(await blob.arrayBuffer()))
    if (buffer.length === 0) {
      return NextResponse.json({ error: 'empty audio upload' }, { status: 400 })
    }
    const { text, duration } = await transcribeAudio(buffer)
    return NextResponse.json({
      transcription: text,
      language: null,
      duration_seconds: duration,
    })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'speech-to-text failed' },
      { status: 500 }
    )
  }
}
