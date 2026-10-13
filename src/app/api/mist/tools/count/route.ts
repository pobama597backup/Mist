import { NextResponse } from 'next/server'
import { countTools } from '@/lib/services/tools-service'

// Phase 3-b · P9: the cheap count for surfaces that only need numbers (the
// status bar's "N TOOLS" chip). Same registry listTools() counts, minus the
// ToolInfo serialization and the gateway/pilot probes — see countTools().
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function GET() {
  try {
    const counts = await countTools()
    return NextResponse.json(counts)
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'failed to count tools' },
      { status: 500 }
    )
  }
}
