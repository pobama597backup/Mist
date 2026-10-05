import { NextRequest, NextResponse } from 'next/server'
import { synthesizeSpeech } from '@/lib/services/voice-service'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function POST(req: NextRequest) {
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
