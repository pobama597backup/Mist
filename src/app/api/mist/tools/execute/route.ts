import { NextRequest, NextResponse } from 'next/server'
import { executeTool } from '@/lib/services/tools-service'
import type { ToolExecuteResult } from '@/lib/types'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

interface ExecuteBody {
  tool?: unknown
  args?: unknown
  confirmed?: unknown
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => null)) as ExecuteBody | null
    if (!body || typeof body.tool !== 'string' || body.tool.length === 0) {
      return NextResponse.json({ error: 'tool name is required' }, { status: 400 })
    }
    const args =
      body.args && typeof body.args === 'object' && !Array.isArray(body.args)
        ? body.args
        : {}
    const result: ToolExecuteResult = await executeTool(body.tool, args, body.confirmed === true)
    return NextResponse.json(result)
  } catch (err) {
    // never 500 without a JSON body
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'tool execution failed' },
      { status: 500 }
    )
  }
}
