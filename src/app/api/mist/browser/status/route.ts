// M.I.S.T. browser routes — status of the Browser Pilot (computer-use engine).
import { NextResponse } from 'next/server'
import { pilotStatus } from '@/lib/services/browser-service'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function GET() {
  try {
    const status = await pilotStatus()
    return NextResponse.json(status)
  } catch (err) {
    return NextResponse.json(
      { available: false, error: err instanceof Error ? err.message : 'pilot status failed' },
      { status: 200 }
    )
  }
}
