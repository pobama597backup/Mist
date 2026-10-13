// /api/mist/local-lane — the C4 local-lane wizard surface (Phase 5).
//
// GET  (open)   → the lane status (state loaded/cold/missing/unconfigured,
//                 models, VRAM estimate, cert pin, engine) + the model family
//                 hint list. Never a secret (loopback URLs only).
// POST (session-gated by proxy.ts) → { action }:
//   detect     { baseUrl? }            probe one URL or scan the well-known homes
//   configure  { baseUrl, model?, keepAliveMin?, enabledForCandor? }
//                                      save the lane (loopback-only unless
//                                      MIST_ALLOW_REMOTE_BRIDGE=1; remote
//                                      https lanes get their cert sha256 pinned)
//   select     { model }               pick the serving model
//   warmup                            one tiny completion (keep_alive honored)
//   smoke                             the 5-prompt candor spread + the honest score
//   clear                             forget the lane
import { NextRequest, NextResponse } from 'next/server'
import {
  detectLocalLane,
  localLaneStatus,
  configureLocalLane,
  clearLocalLane,
  warmLocalLane,
  runLocalCandorSmoke,
  LOCAL_MODEL_FAMILIES,
  LOCAL_LANE_CANDIDATES,
} from '@/lib/services/local-lane'
import { routeError } from '@/lib/route-error'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function GET() {
  try {
    const status = await localLaneStatus(true) // force a fresh probe — the wizard wants truth, not cache
    return NextResponse.json({
      status,
      candidates: LOCAL_LANE_CANDIDATES,
      families: LOCAL_MODEL_FAMILIES,
    })
  } catch (err) {
    return routeError(err, 'failed to read the local lane')
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => null)) as {
      action?: unknown
      baseUrl?: unknown
      model?: unknown
      keepAliveMin?: unknown
      enabledForCandor?: unknown
    } | null
    const action = typeof body?.action === 'string' ? body.action : ''

    switch (action) {
      case 'detect': {
        const baseUrl = typeof body?.baseUrl === 'string' && body.baseUrl.trim() ? body.baseUrl.trim() : undefined
        const status = await detectLocalLane(baseUrl, true)
        return NextResponse.json({ ok: true, status })
      }
      case 'configure': {
        if (typeof body?.baseUrl !== 'string' || !body.baseUrl.trim()) {
          return NextResponse.json({ error: 'baseUrl is required' }, { status: 400 })
        }
        const res = await configureLocalLane({
          baseUrl: body.baseUrl,
          model: typeof body.model === 'string' ? body.model : undefined,
          keepAliveMin: typeof body.keepAliveMin === 'number' ? body.keepAliveMin : undefined,
          enabledForCandor: typeof body.enabledForCandor === 'boolean' ? body.enabledForCandor : undefined,
        })
        if (!res.ok) return NextResponse.json({ error: res.error }, { status: 400 })
        return NextResponse.json({ ok: true, status: res.status })
      }
      case 'select': {
        if (typeof body?.model !== 'string' || !body.model.trim()) {
          return NextResponse.json({ error: 'model is required' }, { status: 400 })
        }
        const current = await localLaneStatus(false)
        if (!current.baseUrl) {
          return NextResponse.json({ error: 'configure the lane first (no base URL saved)' }, { status: 400 })
        }
        const res = await configureLocalLane({
          baseUrl: current.baseUrl,
          model: body.model.trim(),
          keepAliveMin: current.keepAliveMinutes,
          enabledForCandor: current.enabledForCandor,
        })
        if (!res.ok) return NextResponse.json({ error: res.error }, { status: 400 })
        return NextResponse.json({ ok: true, status: res.status })
      }
      case 'warmup': {
        const res = await warmLocalLane()
        return NextResponse.json(res, { status: res.ok ? 200 : 400 })
      }
      case 'smoke': {
        const report = await runLocalCandorSmoke()
        return NextResponse.json({ ok: true, report })
      }
      case 'clear': {
        const res = await clearLocalLane()
        return NextResponse.json({ ok: res.ok })
      }
      default:
        return NextResponse.json({ error: 'action must be detect | configure | select | warmup | smoke | clear' }, { status: 400 })
    }
  } catch (err) {
    return routeError(err, 'local-lane action failed')
  }
}
