import { NextRequest, NextResponse } from 'next/server'
import { developProposal } from '@/lib/services/evolution-service'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export const maxDuration = 300

export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params
    const proposal = await developProposal(id)
    if (!proposal) return NextResponse.json({ error: 'proposal not found' }, { status: 404 })
    return NextResponse.json({
      ok: true,
      proposal,
      message:
        proposal.changes.length > 0
          ? `Developed ${proposal.changes.length} exact change step(s) — review the diff, then approve.`
          : 'Development produced no applicable changes — the idea may need rephrasing.',
    })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'development failed' },
      { status: 500 }
    )
  }
}
