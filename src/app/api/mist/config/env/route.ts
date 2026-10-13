import { NextRequest, NextResponse } from 'next/server'
import { getEnvPresence, setEnvVars } from '@/lib/services/config-service'
import { hasValidSessionCookie } from '@/lib/perimeter/shared'
import { checkRateLimit, rateLimitResponse } from '@/lib/perimeter/rate-limit'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function GET() {
  try {
    // secret keys report presence only — values are never exposed
    return NextResponse.json(getEnvPresence())
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'failed to read env presence' },
      { status: 500 }
    )
  }
}

export async function POST(req: NextRequest) {
  // Phase 1 (S6 first slice): writing env vars (which includes provider keys
  // and *_BASE_URL overrides) is an owner-only action. Session cookie first —
  // the proxy.ts perimeter (commit 3) adds the cross-origin/content-type
  // layers on top of this same check.
  if (!hasValidSessionCookie(req.headers.get('cookie'))) {
    return NextResponse.json({ error: 'session required' }, { status: 403 })
  }
  // Phase 1 · S12: env writes move every lane's credentials — 10/min.
  const rl = checkRateLimit('config', req)
  if (!rl.ok) return rateLimitResponse('config', rl.retryAfter ?? 1)
  try {
    const body = (await req.json().catch(() => null)) as {
      vars?: unknown
      confirmed?: unknown
    } | null
    const result = await setEnvVars(body?.vars, body?.confirmed)
    if (!result.success) {
      return NextResponse.json(
        { success: false, applied: result.applied, error: result.error },
        { status: 400 }
      )
    }
    // Phase 1 · S6: masked diff {key:{from,to}} — secrets are `***`, the
    // owner sees exactly which knobs moved without ever echoing raw values.
    return NextResponse.json({ success: true, applied: result.applied, diff: result.diff })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'failed to set env vars' },
      { status: 500 }
    )
  }
}
