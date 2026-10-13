import { NextRequest, NextResponse } from 'next/server'
import { synthesizeSpeech } from '@/lib/services/voice-service'
import { checkRateLimit, rateLimitResponse } from '@/lib/perimeter/rate-limit'
import { getGlobalCandorMode } from '@/lib/services/candor-service'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function POST(req: NextRequest) {
  // Phase 1 · S12: voice lane (TTS) — 60/min per session.
  const rl = checkRateLimit('voice', req)
  if (!rl.ok) return rateLimitResponse('voice', rl.retryAfter ?? 1)
  // Phase 5 · C2 (Unfiltered): cloud STT/TTS engines are OFF — the GLM and
  // keyless engines all leave the machine. The local voice path (the bridge's
  // Piper TTS, /api/mist/voice/local/tts) stays open. Honest refusal, never a
  // silent cloud fallback.
  if ((await getGlobalCandorMode()) === 'unfiltered') {
    return NextResponse.json(
      {
        error:
          'voice is local-only in Unfiltered — the cloud TTS engines are off (no cloud egress while the dial is Unfiltered). Connect a local voice engine via the bridge, or switch the dial.',
      },
      { status: 403 }
    )
  }
  try {
    const body = (await req.json().catch(() => null)) as {
      text?: unknown
      voice?: unknown
      speed?: unknown
      engine?: unknown // 'glm' (default) | 'edge' | 'gtranslate' — the two no-auth English engines
    } | null
    if (!body || typeof body.text !== 'string' || !body.text.trim()) {
      return NextResponse.json({ error: 'text is required' }, { status: 400 })
    }
    const { buffer, contentType, engineUsed, rescuedBy } = await synthesizeSpeech(
      body.text,
      body.voice,
      body.speed,
      body.engine ?? 'glm'
    )
    const payload = new Uint8Array(buffer)
    return new NextResponse(payload, {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'no-store',
        // honest provenance: which engine actually spoke (and whether a
        // keyless engine rescued a failing GLM utterance)
        'X-Mist-Engine': engineUsed,
        ...(rescuedBy ? { 'X-Mist-Rescued-By': rescuedBy } : {}),
      },
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'text-to-speech failed'
    // 429s are real and frequent under voice bursts — surface the true status
    // so the client (and she) can back off instead of treating it as a bug
    if (/429|too many requests/i.test(message)) {
      return NextResponse.json(
        { error: 'voice engine rate-limited — wait a few seconds and try again' },
        { status: 429 }
      )
    }
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
