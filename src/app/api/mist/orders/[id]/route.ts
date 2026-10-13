// /api/mist/orders/[id] — revoke one standing order (Phase 6-a Control Room).
//
// DELETE (session-gated by proxy.ts — the candor-route owner-command
//   convention; a bodyless DELETE is legal through the perimeter):
//     200 → { ok: true, order }  — soft revoke: active=false, revokedAt=now,
//           engine cache dropped (the next arbitrate() forgets the card)
//     404 → unknown id
//     409 → DESIGN DECISION: revoking an already-revoked order answers an
//           honest 409 carrying the original revokedAt, NOT a silent 200 —
//           the owner deserves to know the second tap changed nothing (the
//           double-click case) and the UI can say so instead of implying a
//           fresh revoke. The audit row is only appended on a REAL transition.
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { appendAuditEvent } from '@/lib/arbiter/audit'
import { invalidateStandingOrderCache } from '@/lib/arbiter/wiring'
import { routeError } from '@/lib/route-error'
import type { StandingOrder } from '@prisma/client'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

interface OrderView {
  id: string
  title: string
  active: boolean
  revokedAt: string | null
}

function toView(row: StandingOrder): OrderView {
  return {
    id: row.id,
    title: row.title,
    active: row.active,
    revokedAt: row.revokedAt ? row.revokedAt.toISOString() : null,
  }
}

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params
    const row = await db.standingOrder.findUnique({ where: { id } })
    if (!row) {
      return NextResponse.json({ error: 'order not found' }, { status: 404 })
    }
    if (!row.active) {
      return NextResponse.json(
        { error: `order already revoked${row.revokedAt ? ` at ${row.revokedAt.toISOString()}` : ''} — nothing changed` },
        { status: 409 }
      )
    }
    const updated = await db.standingOrder.update({
      where: { id },
      data: { active: false, revokedAt: new Date() },
    })
    // the engine forgets the card on the very next decision — no 30s TTL stall
    invalidateStandingOrderCache()
    await appendAuditEvent({
      tool: 'standing_order.revoke',
      argsJson: JSON.stringify({ id: updated.id, title: updated.title }),
      risk: 'persist',
      origin: 'owner_chat',
      tainted: false,
      decision: 'allow',
      reason: 'control room — standing order revoked',
      turnId: null,
    }).catch(() => undefined)
    return NextResponse.json({ ok: true, order: toView(updated) })
  } catch (err) {
    return routeError(err, 'failed to revoke standing order')
  }
}
