import { NextRequest, NextResponse } from 'next/server'
import { getTelemetry } from '@/lib/services/telemetry-service'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function GET(_req: NextRequest) {
  try {
    const data = await getTelemetry()
    return NextResponse.json(data)
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'telemetry failed' },
      { status: 500 }
    )
  }
}
