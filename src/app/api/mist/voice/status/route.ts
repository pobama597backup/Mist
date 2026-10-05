import { NextResponse } from 'next/server'
import type { VoiceStatus } from '@/lib/types'
import { freeTtsCatalog } from '@/lib/services/tts-free'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function GET(): Promise<NextResponse<VoiceStatus>> {
  const { engines, voices } = freeTtsCatalog()
  return NextResponse.json({
    whisper_loaded: false,
    kokoro_loaded: false,
    sdk_voice: true,
    status: 'sdk',
    voices: ['tongtong', 'chuichui', 'xiaochen', 'jam', 'kazi', 'douji', 'luodo'],
    default_voice: 'tongtong',
    // no-auth English voices (edge neural + gtranslate rescue) — the settings
    // UI picker and her tools render from this catalog
    engines,
    free_voices: voices,
  })
}
