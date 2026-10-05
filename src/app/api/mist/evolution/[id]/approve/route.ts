import { NextRequest, NextResponse } from 'next/server'
import { applyProposal } from '@/lib/services/evolution-service'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export const maxDuration = 300

export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params
    const result = await applyProposal(id)
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
