// Browser-direct Gemini TTS key service (Mark-LV wave-2, task mlv-voice-1).
//
// WHY THIS EXISTS: this instance's SERVER egress sits in a region Google
// region-blocks for API-key Gemini use — every live model answers
// "User location is not supported for the API use" (verified by the lead,
// 2026-09-30 probe). The key CANNOT serve server-side from here. The creator's
// BROWSER is (typically) in a supported region, so the client fetches the key
// from this same-origin route ONCE and calls Google directly.
//
// The key never enters the JS bundle: it is served only to the creator's own
// session over the same origin, never cached, never logged.

import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function GET() {
  const key = process.env.GEMINI_API_KEY?.trim() ?? ''
  return NextResponse.json(
    { configured: Boolean(key), key: key || null },
    { headers: { 'Cache-Control': 'no-store' } }
  )
}
