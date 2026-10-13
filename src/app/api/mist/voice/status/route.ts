import { NextResponse } from 'next/server'
import type { VoiceStatus } from '@/lib/types'
import { freeTtsCatalog } from '@/lib/services/tts-free'
import { routeError } from '@/lib/route-error'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function GET(): Promise<NextResponse<VoiceStatus | { error: string }>> {
  // Phase 3-a · R12: JSON errors only — a catalog throw used to be an HTML 500.
  try {
    const { engines, voices } = freeTtsCatalog()
    const status: VoiceStatus = {
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
    }
    return NextResponse.json(status)
  } catch (err) {
    return routeError(err, 'voice status failed')
  }
}
