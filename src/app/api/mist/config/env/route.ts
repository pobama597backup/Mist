import { NextRequest, NextResponse } from 'next/server'
import { getEnvPresence, setEnvVars } from '@/lib/services/config-service'

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
    return NextResponse.json({ success: true, applied: result.applied })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'failed to set env vars' },
      { status: 500 }
    )
  }
}
