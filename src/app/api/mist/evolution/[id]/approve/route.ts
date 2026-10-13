import { NextRequest, NextResponse } from 'next/server'
import { applyProposal } from '@/lib/services/evolution-service'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
// Phase 2-c: the full apply battery (staged gates + tsc + ESLint + security
// suite) can legitimately take minutes on this box — 600s ceiling.
export const maxDuration = 600

export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params
    // ownerApproved: this route IS the owner-authenticated UI (session-gated
    // by the perimeter) — the only lane that may apply protected-path
    // proposals, and exempt from the A3 auto-apply floor (Phase 2-c, A5).
    const result = await applyProposal(id, { ownerApproved: true })
    if (!result.proposal) return NextResponse.json({ error: 'proposal not found' }, { status: 404 })
    return NextResponse.json({
      ok: result.proposal.status === 'applied',
      proposal: result.proposal,
      message: result.message,
    })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'apply failed' },
      { status: 500 }
    )
  }
}
