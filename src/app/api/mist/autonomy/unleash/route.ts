// /api/mist/autonomy/unleash — the A4 ritual (Phase 5 · A6).
//
// GET     (open)   → the badge state: { active, remainingMs, scope, passphraseRequired }
// POST    (session-gated by proxy.ts — the perimeter is the owner gate):
//           { passphrase?, durationMs? (5min–24h, default 2h), scope?: {tools, pathPrefixes, budget, voiceWaived} }
//           → startA4Session: scope goes A4, an audit row a4_start carries the
//             FULL scope JSON, an expiry timer is armed, every turn this session
//             runs joins the kill registry. Passphrase match required when one
//             is set (Setting a4_passphrase, min 8 chars, timing-safe compare).
// DELETE  (session-gated, NO passphrase ever): the kill switch — aborts every
//           in-flight turn ≤1s, reverts the scope, audits a4_kill.
import { NextRequest, NextResponse } from 'next/server'
import { timingSafeEqual } from 'node:crypto'
import { getA4Passphrase } from '@/lib/services/candor-service'
import {
  a4Status,
  startA4Session,
  killA4,
  A4_ROUTE_MIN_MS,
  A4_MAX_MS,
  A4_DEFAULT_MS,
} from '@/lib/arbiter/unleash'
import { getAutonomyScope } from '@/lib/arbiter/wiring'
import { routeError } from '@/lib/route-error'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function GET() {
  try {
    const status = await a4Status()
    return NextResponse.json({
      active: status.active,
      remainingMs: status.active ? status.remainingMs : 0,
      ...(status.active && status.scope ? { scope: status.scope } : {}),
      passphraseRequired: status.passphraseRequired,
      currentScope: getAutonomyScope(),
    })
  } catch (err) {
    return routeError(err, 'failed to read the unleash status')
  }
}

function constantTimeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf-8')
  const bufB = Buffer.from(b, 'utf-8')
  if (bufA.length !== bufB.length) return false
  try {
    return timingSafeEqual(bufA, bufB)
  } catch {
    return false
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => null)) as {
      passphrase?: unknown
      durationMs?: unknown
      scope?: {
        tools?: unknown
        pathPrefixes?: unknown
        budget?: { maxCalls?: unknown; windowMs?: unknown; spendCapUsd?: unknown }
        voiceWaived?: unknown
      }
    } | null

    // the passphrase gate — only when one is set (the owner's choice)
    const expected = await getA4Passphrase()
    if (expected !== null) {
      const given = typeof body?.passphrase === 'string' ? body.passphrase : ''
      if (!given || !constantTimeEqual(given, expected)) {
        return NextResponse.json({ error: 'passphrase required (or wrong) — the unleash ritual is passphrased' }, { status: 403 })
      }
    }

    // duration bounds — the ritual's window
    let durationMs: number = A4_DEFAULT_MS
    if (body?.durationMs !== undefined) {
      const raw = Number(body.durationMs)
      if (!Number.isFinite(raw)) {
        return NextResponse.json({ error: 'durationMs must be a number' }, { status: 400 })
      }
      if (raw < A4_ROUTE_MIN_MS || raw > A4_MAX_MS) {
        return NextResponse.json(
          { error: `durationMs must be ${A4_ROUTE_MIN_MS} (5min) – ${A4_MAX_MS} (24h); default 2h` },
          { status: 400 }
        )
      }
      durationMs = Math.floor(raw)
    }

    const res = await startA4Session({
      durationMs,
      scope: {
        tools: Array.isArray(body?.scope?.tools) ? (body!.scope!.tools as string[]) : ['*'],
        pathPrefixes: Array.isArray(body?.scope?.pathPrefixes) ? (body!.scope!.pathPrefixes as string[]) : [],
        budget: {
          ...(typeof body?.scope?.budget?.maxCalls === 'number' ? { maxCalls: body.scope.budget.maxCalls } : {}),
          ...(typeof body?.scope?.budget?.windowMs === 'number' ? { windowMs: body.scope.budget.windowMs } : {}),
          ...(typeof body?.scope?.budget?.spendCapUsd === 'number' ? { spendCapUsd: body.scope.budget.spendCapUsd } : {}),
        },
        voiceWaived: body?.scope?.voiceWaived === true,
      },
    })
    if (!res.ok) return NextResponse.json({ error: res.error ?? 'could not start the session' }, { status: 400 })
    const status = await a4Status()
    return NextResponse.json({
      active: status.active,
      startedAt: status.startedAt,
      expiryAt: status.expiryAt,
      remainingMs: status.remainingMs,
      scope: status.scope,
      passphraseRequired: status.passphraseRequired,
    })
  } catch (err) {
    return routeError(err, 'unleash failed')
  }
}

export async function DELETE() {
  try {
    const res = await killA4('owner kill switch (DELETE /api/mist/autonomy/unleash)')
    const status = await a4Status()
    return NextResponse.json({ ok: res.ok, killed: res.killed, active: status.active })
  } catch (err) {
    return routeError(err, 'kill failed')
  }
}
