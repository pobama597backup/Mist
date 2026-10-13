// /api/mist/candor — the candor dial + the autonomy scope dial (Phase 5).
//
// GET  (open)  → { mode, autonomyScope, a4: {active, remainingMs}, localLane: {state, baseUrl, model} }
//                — the chips' status surface (status bar, settings).
// POST (session-gated by proxy.ts) → one of:
//   { mode: 'standard'|'frank'|'unfiltered' }            the GLOBAL dial
//   { conversationId, mode }                              a per-conversation override (mode null clears)
//   { autonomyScope: 'A0'|'A1'|'A2'|'A3' }                the A0–A3 dial (A4 is the unleash ritual ONLY)
//   { a4Passphrase: string | null }                       set/clear the unleash passphrase (min 8)
//
// Route-side writes invalidate the settings cache in THIS process instantly
// (setSetting) — the dev server sees the flip on the very next read.
import { NextRequest, NextResponse } from 'next/server'
import { isCandorMode } from '@/lib/candor'
import {
  getGlobalCandorMode,
  setGlobalCandorMode,
  setConversationCandor,
  resolveCandorMode,
  getAutonomyScopeSetting,
  setAutonomyScopeSetting,
  getA4Passphrase,
  setA4Passphrase,
} from '@/lib/services/candor-service'
import { a4Status } from '@/lib/arbiter/unleash'
import { localLaneStatus } from '@/lib/services/local-lane'
import { routeError } from '@/lib/route-error'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function GET() {
  try {
    const [mode, autonomyScope, a4, localLane] = await Promise.all([
      getGlobalCandorMode(),
      getAutonomyScopeSetting(),
      a4Status(),
      localLaneStatus().catch(() => null),
    ])
    return NextResponse.json({
      mode,
      autonomyScope,
      a4: {
        active: a4.active,
        remainingMs: a4.active ? a4.remainingMs : 0,
        passphraseRequired: a4.passphraseRequired,
        ...(a4.active && a4.scope ? { scope: a4.scope } : {}),
      },
      localLane: localLane
        ? { state: localLane.state, baseUrl: localLane.baseUrl, model: localLane.selectedModel, engine: localLane.engine }
        : { state: 'unconfigured', baseUrl: null, model: null, engine: null },
    })
  } catch (err) {
    return routeError(err, 'failed to read candor status')
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => null)) as {
      mode?: unknown
      conversationId?: unknown
      autonomyScope?: unknown
      a4Passphrase?: unknown
    } | null
    if (!body) return NextResponse.json({ error: 'body required' }, { status: 400 })

    // per-conversation override (mode null clears it)
    if (typeof body.conversationId === 'string' && body.conversationId) {
      if (body.mode !== null && body.mode !== undefined && !isCandorMode(body.mode)) {
        return NextResponse.json({ error: 'mode must be standard | frank | unfiltered (or null to clear)' }, { status: 400 })
      }
      const mode = body.mode === null || body.mode === undefined ? null : (body.mode as 'standard' | 'frank' | 'unfiltered')
      const res = await setConversationCandor(body.conversationId, mode)
      if (!res.ok) return NextResponse.json({ error: 'conversation not found' }, { status: 404 })
      return NextResponse.json({
        ok: true,
        conversationId: body.conversationId,
        resolvedMode: await resolveCandorMode(body.conversationId),
      })
    }

    // the global dial
    if (body.mode !== undefined && body.mode !== null) {
      if (!isCandorMode(body.mode)) {
        return NextResponse.json({ error: 'mode must be standard | frank | unfiltered' }, { status: 400 })
      }
      const res = await setGlobalCandorMode(body.mode)
      if (!res.ok) return NextResponse.json({ error: 'could not persist the candor mode' }, { status: 500 })
      let warning: string | undefined
      if (body.mode === 'unfiltered') {
        const lane = await localLaneStatus().catch(() => null)
        if (!lane || (lane.state !== 'loaded' && lane.state !== 'cold')) {
          warning =
            'Unfiltered is ON but no local lane is reachable — every chat turn will honestly fail until one is connected (the local-lane wizard can help)'
        }
      }
      return NextResponse.json({ ok: true, mode: body.mode, ...(warning ? { warning } : {}) })
    }

    // the A0–A3 autonomy dial (A4 is refused here by design — the unleash ritual only)
    if (body.autonomyScope !== undefined) {
      const scope = body.autonomyScope
      if (scope === 'A4') {
        return NextResponse.json(
          { error: 'A4 is the unleash ritual only — POST /api/mist/autonomy/unleash (passphrase + time-boxed session)' },
          { status: 400 }
        )
      }
      if (scope !== 'A0' && scope !== 'A1' && scope !== 'A2' && scope !== 'A3') {
        return NextResponse.json({ error: 'autonomyScope must be A0 | A1 | A2 | A3' }, { status: 400 })
      }
      const res = await setAutonomyScopeSetting(scope)
      if (!res.ok) return NextResponse.json({ error: 'could not persist the autonomy scope' }, { status: 500 })
      return NextResponse.json({ ok: true, autonomyScope: scope })
    }

    // the A4 passphrase
    if (body.a4Passphrase !== undefined) {
      const res = await setA4Passphrase(body.a4Passphrase === null ? null : String(body.a4Passphrase))
      if (!res.ok) return NextResponse.json({ error: res.error ?? 'could not set the passphrase' }, { status: 400 })
      return NextResponse.json({ ok: true, passphraseRequired: (await getA4Passphrase()) !== null })
    }

    return NextResponse.json({ error: 'nothing to do — pass mode, conversationId, autonomyScope or a4Passphrase' }, { status: 400 })
  } catch (err) {
    return routeError(err, 'failed to apply the candor setting')
  }
}
