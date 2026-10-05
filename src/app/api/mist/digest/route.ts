// M.I.S.T. digest API (OpenJarvis morning-digest port, oj-ops-3).
//
// GET  /api/mist/digest           → {digests: [...], latest?} (+ schedule status)
// POST /api/mist/digest {speak?}  → {digest} — generates a fresh on-demand
//                                   digest; speak:true adds TTS-ready text
//                                   (no TTS call — the voice route exists).
import { NextRequest, NextResponse } from 'next/server'
import { generateDigest, getLatestDigest, listDigests, speakableDigest, digestScheduleStatus } from '@/lib/oj/digest-service'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function GET() {
  try {
    const [digests, latest, schedule] = await Promise.all([
      listDigests(10),
      getLatestDigest(),
      digestScheduleStatus(),
    ])
    return NextResponse.json({ digests, latest: latest ?? undefined, schedule })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'failed to list digests' },
      { status: 500 }
    )
  }
}

export async function POST(request: NextRequest) {
  let speak = false
  try {
    const body = (await request.json()) as Record<string, unknown>
    speak = body.speak === true
  } catch {
    // empty body is fine — generate without speech text
  }
  try {
    const digest = await generateDigest('on_demand')
    if (speak) digest.speakText = speakableDigest(digest)
    return NextResponse.json({ digest })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'failed to generate digest' },
      { status: 500 }
    )
  }
}
