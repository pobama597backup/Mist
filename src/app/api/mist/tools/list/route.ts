import { NextResponse } from 'next/server'
import { listTools } from '@/lib/services/tools-service'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function GET() {
  try {
    const tools = await listTools()
    return NextResponse.json(tools)
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'failed to list tools' },
      { status: 500 }
    )
  }
}
