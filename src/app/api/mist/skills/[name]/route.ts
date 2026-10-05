import { NextRequest, NextResponse } from 'next/server'
import { deleteSkill } from '@/lib/services/skills-service'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ name: string }> }) {
  try {
    const { name } = await ctx.params
    await deleteSkill(name)
    return NextResponse.json({ success: true })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'failed to delete skill' },
      { status: 500 }
    )
  }
}
