// M.I.S.T. × OpenJarvis — single trace route (oj-spine-1).
// GET /api/mist/traces/[id] →
//   { trace: { ...full trace fields, steps: [{idx, type, name, ok, durationMs,
//              tokens, input, output}] } }
import { NextRequest, NextResponse } from 'next/server'
import { getTrace } from '@/lib/oj/trace-service'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  try {
    const trace = await getTrace(id)
    if (!trace) {
      return NextResponse.json({ error: 'trace not found' }, { status: 404 })
    }
    return NextResponse.json({ trace })
  } catch (err) {
    console.error('[trace route] failed:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'failed to load trace' }, { status: 500 })
  }
}
