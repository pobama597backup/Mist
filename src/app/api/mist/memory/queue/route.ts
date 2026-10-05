import { NextResponse } from 'next/server'
import { listQueue } from '@/lib/services/memory-service'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function GET() {
  try {
    return NextResponse.json(await listQueue())
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'failed to list memory queue' },
      { status: 500 }
    )
  }
}
