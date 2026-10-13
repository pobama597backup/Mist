// Browser-direct Gemini TTS key service (Mark-LV wave-2, task mlv-voice-1).
//
// WHY THIS EXISTS: this instance's SERVER egress sits in a region Google
// region-blocks for API-key Gemini use — every live model answers
// "User location is not supported for the API use" (verified by the lead,
// 2026-09-30 probe). The key CANNOT serve server-side from here. The creator's
// BROWSER is (typically) in a supported region, so the client fetches the key
// from this same-origin route and calls Google directly.
//
// PHASE 1 (S3): the raw key is now SESSION-GATED. A cookieless caller learns
// only whether a key is configured; the key itself is served exclusively to
// requests carrying a valid mist_session cookie (the owner's own browser —
// auto-paired by the perimeter proxy on first page load). The browser-direct
// TTS lane (src/lib/google-direct.ts) keeps working for the owner and quietly
// degrades to the server chain for anyone else.

import { NextRequest, NextResponse } from 'next/server'
import { hasValidSessionCookie } from '@/lib/perimeter/shared'
import { getGlobalCandorMode } from '@/lib/services/candor-service'
import { routeError } from '@/lib/route-error'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function GET(req: NextRequest) {
  // Phase 3-a · R12: JSON errors only — an unhandled throw here used to be an
  // HTML 500 page on a JSON API route.
  try {
    const key = process.env.GEMINI_API_KEY?.trim() ?? ''
    const owner = hasValidSessionCookie(req.headers.get('cookie'))
    // Phase 5 · C2 (Unfiltered): no cloud lane leaves the machine — and that
    // includes the BROWSER-DIRECT Google tool. The key is simply not served
    // while the dial is Unfiltered; the client falls back to its local chain.
    const unfiltered = (await getGlobalCandorMode()) === 'unfiltered'
    const body: { configured: boolean; key?: string; reason?: string } = {
      configured: Boolean(key) && !unfiltered,
    }
    if (unfiltered) {
      body.reason = 'candor dial is Unfiltered — the browser-direct Google tool is off (no cloud, no relay; local voice only)'
    } else if (key && owner) {
      body.key = key
    }
    return NextResponse.json(body, { headers: { 'Cache-Control': 'no-store' } })
  } catch (err) {
    return routeError(err, 'google key route failed')
  }
}
