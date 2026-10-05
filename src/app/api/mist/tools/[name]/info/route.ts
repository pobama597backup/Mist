import { NextRequest, NextResponse } from 'next/server'
import { findTool } from '@/lib/services/tools-service'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function GET(_req: NextRequest, ctx: { params: Promise<{ name: string }> }) {
  try {
    const { name } = await ctx.params
    const tool = await findTool(name)
    if (!tool) {
      return NextResponse.json({ error: `unknown tool: ${name}` }, { status: 404 })
    }
    return NextResponse.json(tool)
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'failed to fetch tool info' },
      { status: 500 }
    )
  }
}
