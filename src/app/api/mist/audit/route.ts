// /api/mist/audit — the "Why did she do that?" read surface (Phase 6-a).
//
// The hash-chained AuditEvent trail (Phase 2-a A3) had NO read API and NO
// viewer until now. GET only, session-gated in-route (GETs do not ride the
// proxy's non-GET gate, and decision history is the owner's alone), read-only
// — this route never writes an audit row about reads (that would be an
// unbounded feedback loop) and never mutates the chain.
//
// Query params:
//   ?limit    default 50, max 200 (integer 1–200 — honest 400 outside)
//   ?before   cursor: only rows with seq < before (the "load more" walk)
//   ?tool     exact tool-name filter (free string — the registry grows)
//   ?decision allow | ask | deny | defer (validated — the column's vocabulary)
//   ?origin   free string (owner_chat, owner_voice, web, …)
//   ?since    ISO datetime lower bound on ts
//
// Response: { events: [...newest first...], chain: {valid, checkedCount,
// brokenAtSeq?, reason?}, nextBefore }.
//
// CHAIN VERIFICATION — the tamper-evidence surface: for the seq window the
// returned events span, re-fetch the rows UNFILTERED in ascending seq order
// (a filtered subset has seq gaps by design — walking it would false-positive),
// then recompute EVERY row's hash with the exact append-time function
// (chainHash, exported from audit.ts for exactly this reuse — never trust a
// stored hash alone), verify each prevHash equals the previous row's hash,
// and name the first broken seq on any mismatch. The walk is capped at
// MAX_CHAIN_WALK rows (a sparse filter over a huge table must not turn the
// owner's status chip into a full-table scan) — today's chain is far below
// the cap; the cap is future-proofing, documented here.
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { chainHash } from '@/lib/arbiter/audit'
import { hasValidSessionCookie } from '@/lib/perimeter/shared'
import { routeError } from '@/lib/route-error'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const DECISIONS = new Set(['allow', 'ask', 'deny', 'defer'])
const MAX_CHAIN_WALK = 1000

function nonEmpty(v: string | null): string | null {
  const t = v?.trim()
  return t && t.length > 0 ? t : null
}

export async function GET(req: NextRequest) {
  try {
    if (!hasValidSessionCookie(req.headers.get('cookie'))) {
      return NextResponse.json({ error: 'session required' }, { status: 403 })
    }
    const sp = req.nextUrl.searchParams

    // limit: integer 1–200
    let limit = 50
    const limitRaw = sp.get('limit')
    if (limitRaw !== null && limitRaw !== '') {
      const n = Number(limitRaw)
      if (!Number.isInteger(n) || n < 1 || n > 200) {
        return NextResponse.json({ error: 'limit must be an integer 1–200' }, { status: 400 })
      }
      limit = n
    }

    // before: positive integer seq cursor
    let before: number | null = null
    const beforeRaw = sp.get('before')
    if (beforeRaw !== null && beforeRaw !== '') {
      const n = Number(beforeRaw)
      if (!Number.isInteger(n) || n < 1) {
        return NextResponse.json({ error: 'before must be a positive integer seq cursor' }, { status: 400 })
      }
      before = n
    }

    // since: ISO datetime
    let since: Date | null = null
    const sinceRaw = sp.get('since')
    if (sinceRaw !== null && sinceRaw !== '') {
      const d = new Date(sinceRaw)
      if (Number.isNaN(d.getTime())) {
        return NextResponse.json({ error: 'since must be a valid ISO datetime' }, { status: 400 })
      }
      since = d
    }

    // decision: the column's own vocabulary (validated — a typo'd filter that
    // silently returns nothing looks like "she did nothing", which is worse
    // than an honest 400)
    const decision = nonEmpty(sp.get('decision'))
    if (decision && !DECISIONS.has(decision)) {
      return NextResponse.json({ error: 'decision must be allow | ask | deny | defer' }, { status: 400 })
    }

    const tool = nonEmpty(sp.get('tool'))
    const origin = nonEmpty(sp.get('origin'))

    // ---- the display page: newest first ----
    const events = await db.auditEvent.findMany({
      where: {
        ...(before !== null ? { seq: { lt: before } } : {}),
        ...(tool ? { tool } : {}),
        ...(decision ? { decision } : {}),
        ...(origin ? { origin } : {}),
        ...(since ? { ts: { gte: since } } : {}),
      },
      orderBy: { seq: 'desc' },
      take: limit,
    })

    // ---- the verification pass over the same seq window, unfiltered ----
    let chain: { valid: boolean; checkedCount: number; brokenAtSeq?: number; reason?: string } = {
      valid: true,
      checkedCount: 0,
    }
    if (events.length > 0) {
      const minSeq = events[events.length - 1].seq
      const maxSeq = events[0].seq
      let rows = await db.auditEvent.findMany({
        where: { seq: { gte: minSeq, lte: maxSeq } },
        orderBy: { seq: 'asc' },
      })
      // cap the walk: keep the NEWEST portion of the span (the part nearest
      // the tamper the owner is looking at), never a full-table scan
      if (rows.length > MAX_CHAIN_WALK) {
        rows = rows.slice(rows.length - MAX_CHAIN_WALK)
      }
      let checkedCount = 0
      let brokenAtSeq: number | undefined
      let reason: string | undefined
      let prevHash: string | null = null
      let prevSeq = 0
      for (const row of rows) {
        if (prevHash !== null && row.seq !== prevSeq + 1) {
          brokenAtSeq = row.seq
          reason = `seq gap before ${row.seq} — rows were removed`
          break
        }
        if (prevHash !== null && row.prevHash !== prevHash) {
          brokenAtSeq = row.seq
          reason = `prev-hash mismatch at seq ${row.seq}`
          break
        }
        const expect = chainHash({
          prevHash: row.prevHash,
          seq: row.seq,
          ts: row.ts.toISOString(),
          tool: row.tool,
          risk: row.risk,
          origin: row.origin,
          tainted: row.tainted,
          decision: row.decision,
          reason: row.reason,
          argsJson: row.argsJson,
        })
        if (expect !== row.hash) {
          brokenAtSeq = row.seq
          reason = `hash mismatch at seq ${row.seq} — row modified after append`
          break
        }
        prevHash = row.hash
        prevSeq = row.seq
        checkedCount++
      }
      chain = brokenAtSeq !== undefined ? { valid: false, checkedCount, brokenAtSeq, reason } : { valid: true, checkedCount }
    }

    // nextBefore: the "load more" cursor — the oldest seq of a FULL page
    // (a short page means the filter's window is exhausted)
    const nextBefore = events.length === limit ? events[events.length - 1].seq : null

    return NextResponse.json({
      events: events.map((e) => ({
        id: e.id,
        seq: e.seq,
        ts: e.ts.toISOString(),
        tool: e.tool,
        risk: e.risk,
        origin: e.origin,
        tainted: e.tainted,
        decision: e.decision,
        reason: e.reason,
        argsJson: e.argsJson,
        orderRef: e.orderRef,
        turnId: e.turnId,
        // ticket is deliberately omitted: single-use bridge tickets have no
        // read value after 60s and no business in a viewer payload.
      })),
      chain,
      nextBefore,
    })
  } catch (err) {
    return routeError(err, 'failed to read the audit trail')
  }
}
