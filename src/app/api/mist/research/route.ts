// M.I.S.T. research route v2 — async job-based deep research.
//
// POST {query: string, depth?: 1|2} → {ok: true, jobId} — the research runs
//   DETACHED in the background; poll GET /api/mist/research/<id> for phases.
// GET → {jobs: [...]} — recent jobs (newest first, trimmed).
import { NextRequest, NextResponse } from 'next/server'
import { listResearchJobs, startResearchJob } from '@/lib/services/research-service'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export const maxDuration = 300

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as {
    query?: unknown
    question?: unknown
    depth?: unknown
  } | null
  // "query" is the v2 contract; "question" kept so the v1 client shape still works
  const query = typeof body?.query === 'string' ? body.query.trim() : typeof body?.question === 'string' ? body.question.trim() : ''
  const depthRaw = Number(body?.depth ?? 1)
  const depth = Number.isFinite(depthRaw) ? Math.max(1, Math.min(2, Math.round(depthRaw))) : 1

  if (!query) {
    return NextResponse.json({ error: 'query is required' }, { status: 400 })
  }

  try {
    const job = startResearchJob(query, depth)
    return NextResponse.json({ ok: true, jobId: job.id })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'failed to start research job' },
      { status: 500 }
    )
  }
}

export async function GET() {
  try {
    return NextResponse.json({ jobs: listResearchJobs(15) })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'failed to list research jobs' },
      { status: 500 }
    )
  }
}
