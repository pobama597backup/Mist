// M.I.S.T. approval decision API (OpenJarvis tiered-approval port, oj-ops-3).
//
// POST /api/mist/approvals/[id] {decision: "approve"|"deny",
//                                remember?: "always_approve"|"always_deny"}
//   → 200 {ok: true, status, remembered}
//   remember writes a PermissionMemory row for the action fingerprint, so the
//   same action shape is never asked about twice.
import { NextRequest, NextResponse } from 'next/server'
import { decide } from '@/lib/oj/approval-service'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function POST(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  let body: Record<string, unknown>
  try {
    body = (await request.json()) as Record<string, unknown>
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 })
  }
  const decision = body.decision
  if (decision !== 'approve' && decision !== 'deny') {
    return NextResponse.json({ error: 'decision must be "approve" or "deny"' }, { status: 400 })
  }
  const remember =
    body.remember === 'always_approve' || body.remember === 'always_deny' ? body.remember : undefined
  try {
    const res = await decide(id, { decision, remember })
    if (!res.ok) {
      return NextResponse.json({ error: res.error ?? 'failed to decide approval' }, { status: 400 })
    }
    return NextResponse.json({ ok: true, status: res.status, remembered: res.remembered ?? false })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'failed to decide approval' },
      { status: 500 }
    )
  }
}
