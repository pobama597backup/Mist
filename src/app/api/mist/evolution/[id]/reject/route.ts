import { NextRequest, NextResponse } from 'next/server'
import { rejectProposal } from '@/lib/services/evolution-service'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params
    const proposal = await rejectProposal(id)
    if (!proposal) return NextResponse.json({ error: 'proposal not found' }, { status: 404 })
    return NextResponse.json({ ok: true, proposal, message: 'Proposal rejected.' })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'reject failed' },
      { status: 500 }
    )
  }
}
