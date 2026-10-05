import { NextRequest, NextResponse } from 'next/server'
import { deleteFact } from '@/lib/services/memory-service'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ key: string }> }) {
  try {
    const { key } = await ctx.params
    await deleteFact(key)
    return NextResponse.json({ success: true })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'failed to delete fact' },
      { status: 500 }
    )
  }
}
