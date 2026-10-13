// /api/mist/orders — the Control Room standing-orders surface (Phase 6-a).
//
// The orders existed in schema + engine since Phase 2 (the wiring loads active
// rows as arbiter cards); THIS route is the owner surface the phase2-closeout
// entry backlogged to "Phase 6 control room".
//
// GET  (session-gated IN-ROUTE — GETs do not ride the proxy's non-GET gate,
//       and the owner's rule cards are not a public surface):
//       → { orders: OrderView[] } — active + revoked, newest first, with the
//         DERIVED fields the engine's cards carry (parsed tools/pathPrefixes/
//         budget, windowed usage, the expired flag).
// POST (session-gated by proxy.ts — the candor-route convention for owner
//       commands): { title, tools, pathPrefixes?, budget?, expiryAt? }
//       → { ok: true, order } — creates an ACTIVE order, drops the engine's
//         30s standing-order cache (invalidateStandingOrderCache — the next
//         arbitrate() sees it immediately), and appends the owner-command
//         audit row (tool standing_order.create · risk persist · decision
//         allow · origin owner_chat — the owner-command convention from
//         unleash.ts's a4_start rows).
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { appendAuditEvent } from '@/lib/arbiter/audit'
import { invalidateStandingOrderCache } from '@/lib/arbiter/wiring'
import { listTools } from '@/lib/services/tools-service'
import { hasValidSessionCookie } from '@/lib/perimeter/shared'
import { routeError } from '@/lib/route-error'
import type { StandingOrder } from '@prisma/client'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

// ---------- the view (row → the fields the engine + the UI both read) ----------

interface OrderBudget {
  maxCalls?: number
  windowMs?: number
  spendCapUsd?: number
}

interface OrderView {
  id: string
  title: string
  tools: string[]
  pathPrefixes: string[]
  budget: OrderBudget
  expiryAt: string | null
  active: boolean
  /** derived: active but past expiryAt — the wiring drops these at load */
  expired: boolean
  createdAt: string
  revokedAt: string | null
  createdBy: string
  /** windowed allowed-call count, counted exactly like loadStandingOrderCards
   *  counts it (orderRef rows, decision allow, inside budget.windowMs) */
  usage: { calls: number }
}

/** Parse a JSON column the way the wiring does — a corrupt card is never a
 *  crash on the read surface (it renders honestly empty; the engine already
 *  refuses to authorize from it). */
function parseStringArray(json: string): string[] {
  try {
    const parsed = JSON.parse(json) as unknown
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : []
  } catch {
    return []
  }
}

function parseBudget(json: string): OrderBudget {
  try {
    const parsed = JSON.parse(json) as Record<string, unknown>
    const out: OrderBudget = {}
    if (typeof parsed.maxCalls === 'number') out.maxCalls = parsed.maxCalls
    if (typeof parsed.windowMs === 'number') out.windowMs = parsed.windowMs
    if (typeof parsed.spendCapUsd === 'number') out.spendCapUsd = parsed.spendCapUsd
    return out
  } catch {
    return {}
  }
}

async function toView(row: StandingOrder): Promise<OrderView> {
  const budget = parseBudget(row.budget)
  const now = Date.now()
  const expired = row.active && row.expiryAt !== null && now >= row.expiryAt.getTime()
  let calls = 0
  // windowed usage, mirrored from the wiring: counted only where the engine
  // counts it (a maxCalls budget); revoked/expired cards show their spent
  // budget for honesty, they authorize nothing.
  if (typeof budget.maxCalls === 'number') {
    const windowMs = typeof budget.windowMs === 'number' && budget.windowMs > 0 ? budget.windowMs : Infinity
    const since = windowMs === Infinity ? undefined : new Date(now - windowMs)
    calls = await db.auditEvent
      .count({ where: { orderRef: row.id, decision: 'allow', ...(since ? { ts: { gt: since } } : {}) } })
      .catch(() => 0)
  }
  return {
    id: row.id,
    title: row.title,
    tools: parseStringArray(row.tools),
    pathPrefixes: parseStringArray(row.pathPrefixes),
    budget,
    expiryAt: row.expiryAt ? row.expiryAt.toISOString() : null,
    active: row.active,
    expired,
    createdAt: row.createdAt.toISOString(),
    revokedAt: row.revokedAt ? row.revokedAt.toISOString() : null,
    createdBy: row.createdBy,
    usage: { calls },
  }
}

// ---------- GET: list ----------

export async function GET(req: NextRequest) {
  try {
    if (!hasValidSessionCookie(req.headers.get('cookie'))) {
      return NextResponse.json({ error: 'session required' }, { status: 403 })
    }
    const rows = await db.standingOrder.findMany({ orderBy: { createdAt: 'desc' } })
    const orders = await Promise.all(rows.map(toView))
    return NextResponse.json({ orders })
  } catch (err) {
    return routeError(err, 'failed to list standing orders')
  }
}

// ---------- POST: create ----------

const MAX_TOOLS = 32
const MAX_PREFIXES = 64
const MAX_WINDOW_MS = 365 * 24 * 3_600_000

/** Levenshtein edit distance — for the close-match suggestions (no deps). */
function editDistance(a: string, b: string): number {
  const m = a.length
  const n = b.length
  if (Math.abs(m - n) > 3) return 4 // cheap early out — we only care ≤3
  let prev = Array.from({ length: n + 1 }, (_, j) => j)
  for (let i = 1; i <= m; i++) {
    const cur = [i]
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1))
    }
    prev = cur
  }
  return prev[n]!
}

/** Helpful unknown-name error: close matches first (edit distance ≤ 3), then
 *  substring hits, then the honest pointer at the registry. */
function unknownToolError(name: string, known: string[]): string {
  const lower = name.toLowerCase()
  const near = known
    .map((k) => ({ k, d: editDistance(lower, k.toLowerCase()) }))
    .filter((x) => x.d <= 3)
    .sort((a, b) => a.d - b.d)
    .slice(0, 5)
    .map((x) => x.k)
  const substr = near.length === 0 ? known.filter((k) => k.toLowerCase().includes(lower)).slice(0, 5) : []
  const hints = [...near, ...substr]
  if (hints.length > 0) {
    return `unknown tool "${name}" — did you mean: ${hints.join(', ')}? (valid names come from the live registry, or "*")`
  }
  return `unknown tool "${name}" — valid names come from the live registry (GET /api/mist/tools/list) or "*"`
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => null)) as {
      title?: unknown
      tools?: unknown
      pathPrefixes?: unknown
      budget?: { maxCalls?: unknown; windowMs?: unknown; spendCapUsd?: unknown } | null
      expiryAt?: unknown
    } | null

    // title
    if (typeof body?.title !== 'string' || body.title.trim().length === 0) {
      return NextResponse.json({ error: 'title is required (non-empty string)' }, { status: 400 })
    }
    const title = body.title.trim().slice(0, 120)

    // tools — names from the LIVE registry (the same listTools() the tools
    // drawer renders) or "*"; unknown names get close-match help, because a
    // silently-never-matching order is a security illusion.
    if (!Array.isArray(body?.tools) || body.tools.length === 0) {
      return NextResponse.json({ error: 'tools is required (array of registry tool names, or ["*"])' }, { status: 400 })
    }
    const rawTools = body.tools
    if (rawTools.length > MAX_TOOLS) {
      return NextResponse.json({ error: `tools accepts at most ${MAX_TOOLS} names` }, { status: 400 })
    }
    const tools: string[] = []
    for (const t of rawTools) {
      if (typeof t !== 'string' || t.trim().length === 0 || t.length > 128) {
        return NextResponse.json({ error: 'every tool name must be a non-empty string (≤128 chars)' }, { status: 400 })
      }
      const name = t.trim()
      if (!tools.includes(name)) tools.push(name)
    }
    if (!tools.includes('*')) {
      const registry = await listTools().catch(() => null)
      if (!registry) {
        return NextResponse.json(
          { error: 'the live tool registry is unreachable — cannot validate tool names; try again shortly' },
          { status: 500 }
        )
      }
      const known = registry.map((t) => t.name)
      const unknown = tools.filter((t) => !known.includes(t))
      if (unknown.length > 0) {
        return NextResponse.json({ error: unknown.map((u) => unknownToolError(u, known)).join(' · ') }, { status: 400 })
      }
    }

    // pathPrefixes
    let pathPrefixes: string[] = []
    if (body?.pathPrefixes !== undefined && body.pathPrefixes !== null) {
      if (!Array.isArray(body.pathPrefixes)) {
        return NextResponse.json({ error: 'pathPrefixes must be an array of path strings' }, { status: 400 })
      }
      if (body.pathPrefixes.length > MAX_PREFIXES) {
        return NextResponse.json({ error: `pathPrefixes accepts at most ${MAX_PREFIXES} entries` }, { status: 400 })
      }
      for (const p of body.pathPrefixes) {
        if (typeof p !== 'string' || p.trim().length === 0 || p.length > 256) {
          return NextResponse.json({ error: 'every pathPrefix must be a non-empty string (≤256 chars)' }, { status: 400 })
        }
        const norm = p.trim()
        if (!pathPrefixes.includes(norm)) pathPrefixes.push(norm)
      }
    }

    // budget
    const budget: OrderBudget = {}
    if (body?.budget !== undefined && body.budget !== null) {
      const b = body.budget
      if (b.maxCalls !== undefined) {
        if (typeof b.maxCalls !== 'number' || !Number.isInteger(b.maxCalls) || b.maxCalls < 1 || b.maxCalls > 1_000_000) {
          return NextResponse.json({ error: 'budget.maxCalls must be an integer 1–1,000,000' }, { status: 400 })
        }
        budget.maxCalls = b.maxCalls
      }
      if (b.windowMs !== undefined) {
        if (typeof b.windowMs !== 'number' || !Number.isFinite(b.windowMs) || b.windowMs < 1_000 || b.windowMs > MAX_WINDOW_MS) {
          return NextResponse.json(
            { error: `budget.windowMs must be a number 1,000–${MAX_WINDOW_MS} (1s–365d)` },
            { status: 400 }
          )
        }
        budget.windowMs = Math.floor(b.windowMs)
      }
      if (b.spendCapUsd !== undefined) {
        if (typeof b.spendCapUsd !== 'number' || !Number.isFinite(b.spendCapUsd) || b.spendCapUsd <= 0 || b.spendCapUsd > 100_000) {
          return NextResponse.json({ error: 'budget.spendCapUsd must be a number 0–100,000' }, { status: 400 })
        }
        budget.spendCapUsd = b.spendCapUsd
      }
    }

    // expiryAt — must be a valid ISO datetime IN THE FUTURE: an order that is
    // expired on arrival authorizes nothing and only clutters the room.
    let expiryAt: Date | null = null
    if (body?.expiryAt !== undefined && body.expiryAt !== null) {
      if (typeof body.expiryAt !== 'string') {
        return NextResponse.json({ error: 'expiryAt must be an ISO datetime string (or null)' }, { status: 400 })
      }
      const d = new Date(body.expiryAt)
      if (Number.isNaN(d.getTime())) {
        return NextResponse.json({ error: 'expiryAt must be a valid ISO datetime string' }, { status: 400 })
      }
      if (d.getTime() <= Date.now()) {
        return NextResponse.json({ error: 'expiryAt must be in the future — an expired-on-arrival order authorizes nothing' }, { status: 400 })
      }
      expiryAt = d
    }

    const row = await db.standingOrder.create({
      data: {
        title,
        tools: JSON.stringify(tools),
        pathPrefixes: JSON.stringify(pathPrefixes),
        budget: JSON.stringify(budget),
        expiryAt,
        active: true,
        createdBy: 'owner',
      },
    })
    // the engine sees the change on the very next decision — no 30s TTL stall
    invalidateStandingOrderCache()
    // the owner-command audit row (unleash.ts convention: an append failure
    // never fails the owner action itself — the row is history, not the gate)
    await appendAuditEvent({
      tool: 'standing_order.create',
      argsJson: JSON.stringify({ id: row.id, title: row.title, tools }),
      risk: 'persist',
      origin: 'owner_chat',
      tainted: false,
      decision: 'allow',
      reason: 'control room — standing order created',
      turnId: null,
    }).catch(() => undefined)
    return NextResponse.json({ ok: true, order: await toView(row) })
  } catch (err) {
    return routeError(err, 'failed to create standing order')
  }
}
