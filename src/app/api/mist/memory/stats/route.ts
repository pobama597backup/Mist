import { NextResponse } from 'next/server'
import { memoryStats } from '@/lib/services/memory-service'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function GET() {
  try {
    return NextResponse.json(await memoryStats())
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'failed to compute memory stats' },
      { status: 500 }
    )
  }
}
