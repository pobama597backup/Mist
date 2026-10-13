import { NextRequest, NextResponse } from 'next/server'
import { executeTool } from '@/lib/services/tools-service'
import type { ToolExecuteResult } from '@/lib/types'
import { checkRateLimit, rateLimitResponse } from '@/lib/perimeter/rate-limit'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

interface ExecuteBody {
  tool?: unknown
  args?: unknown
  confirmed?: unknown // ignored by design (mandate A1) — the Arbiter decides
}

export async function POST(req: NextRequest) {
  // Phase 1 · S12: tool execution is powerful by design — 60 req/min per
  // session stops runaway loops without touching a human work pace.
  const rl = checkRateLimit('tools', req)
  if (!rl.ok) return rateLimitResponse('tools', rl.retryAfter ?? 1)
  try {
    const body = (await req.json().catch(() => null)) as ExecuteBody | null
    if (!body || typeof body.tool !== 'string' || body.tool.length === 0) {
      return NextResponse.json({ error: 'tool name is required' }, { status: 400 })
    }
    const args =
      body.args && typeof body.args === 'object' && !Array.isArray(body.args)
        ? body.args
        : {}
    // Phase 2-b: the perimeter has already gated this route to the owner's
    // session — every call is arbitrated as owner_chat, and a client-asserted
    // `confirmed` changes nothing (the Arbiter asks the bell instead).
    // Phase 3-a · R1: req.signal rides along — a disconnected caller aborts
    // in-flight bridge fetches with honest exec/read semantics.
    const result: ToolExecuteResult = await executeTool(body.tool, args, body.confirmed === true, {
      origin: 'owner_chat',
      interactive: true,
      signal: req.signal,
    })
    return NextResponse.json(result)
  } catch (err) {
    // never 500 without a JSON body
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'tool execution failed' },
      { status: 500 }
    )
  }
}
