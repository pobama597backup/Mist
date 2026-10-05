import { NextResponse } from 'next/server'
import { scanForIssues, ensureEvolutionWatch } from '@/lib/services/evolution-service'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export const maxDuration = 300

export async function POST() {
  try {
    ensureEvolutionWatch()
    const result = await scanForIssues()
    return NextResponse.json({
      ok: true,
      issues: result.issues,
      proposal: result.proposal,
      message: result.message,
    })
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        issues: [],
        proposal: null,
        message: err instanceof Error ? err.message : 'self-audit failed',
      },
      { status: 500 }
    )
  }
}
