// M.I.S.T. research job route — poll a single job's live status.
//
// GET /api/mist/research/<id> → full job JSON (phases, sources, report when
// done); 404 when the id is unknown or the job was GC'd (>30 min / map cap).
import { NextRequest, NextResponse } from 'next/server'
import { getResearchJob, serializeResearchJob } from '@/lib/services/research-service'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  const job = getResearchJob(id)
  if (!job) {
    return NextResponse.json({ error: 'research job not found (unknown or expired)' }, { status: 404 })
  }
  return NextResponse.json(serializeResearchJob(job))
}
