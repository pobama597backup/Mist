import { NextRequest, NextResponse } from 'next/server'
import { transcribeAudio } from '@/lib/services/voice-service'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const MAX_AUDIO_BYTES = 15 * 1024 * 1024 // 15MB

export async function POST(req: NextRequest) {
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
