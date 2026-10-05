// M.I.S.T. local voice engines route — discovery, adoption, listing, selection.
// The bridge v3.6 surface: the user may ALREADY have faster-whisper (e.g. the
// python env Hermes uses) or a piper binary + voice files on their machine.
// This route lets the frontend (and her) find them, adopt them (reuse — no
// second download), list every selectable voice across all dirs, and pick the
// active voice/model/engine. POST { action: 'discover' | 'adopt' | 'voices' | 'select', ... }
import { NextRequest, NextResponse } from 'next/server'
import { bridgeExec } from '@/lib/services/bridge-service'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const ACTIONS = new Set(['discover', 'adopt', 'voices', 'select'])

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => null)) as {
      action?: unknown
      fwPython?: unknown
      fwModel?: unknown
      piperBin?: unknown
      extraVoicesDir?: unknown
      sttEngine?: unknown
      ttsVoice?: unknown
      sttModel?: unknown
    } | null
    const action = typeof body?.action === 'string' ? body.action.trim() : ''
    if (!ACTIONS.has(action)) {
      return NextResponse.json(
        { error: `action must be one of: ${[...ACTIONS].join(', ')}` },
        { status: 400 }
      )
    }
    const s = (v: unknown): string | undefined =>
      typeof v === 'string' && v.trim() ? v.trim() : undefined

    let res
    if (action === 'discover') {
      res = await bridgeExec('voice_discover')
    } else if (action === 'adopt') {
      const args: Record<string, string> = {}
      if (s(body?.fwPython)) args.fwPython = s(body?.fwPython)!
      if (s(body?.fwModel)) args.fwModel = s(body?.fwModel)!
      if (s(body?.piperBin)) args.piperBin = s(body?.piperBin)!
      if (s(body?.extraVoicesDir)) args.extraVoicesDir = s(body?.extraVoicesDir)!
      if (s(body?.sttEngine)) args.sttEngine = s(body?.sttEngine)!
      if (Object.keys(args).length === 0) {
        return NextResponse.json(
          { error: 'adopt needs at least one of: fwPython, fwModel, piperBin, extraVoicesDir, sttEngine' },
          { status: 400 }
        )
      }
      res = await bridgeExec('voice_adopt', args)
    } else if (action === 'voices') {
      res = await bridgeExec('voice_voices')
    } else {
      // select
      const args: Record<string, string> = {}
      if (s(body?.ttsVoice)) args.ttsVoice = s(body?.ttsVoice)!
      if (s(body?.sttModel)) args.sttModel = s(body?.sttModel)!
      if (s(body?.sttEngine)) args.sttEngine = s(body?.sttEngine)!
      if (Object.keys(args).length === 0) {
        return NextResponse.json(
          { error: 'select needs at least one of: ttsVoice, sttModel, sttEngine' },
          { status: 400 }
        )
      }
      res = await bridgeExec('voice_select', args)
    }

    if (!res.ok) {
      return NextResponse.json(
        { ok: false, error: res.error ?? 'bridge action failed', bridgeConnected: res.bridgeConnected },
        { status: res.error === 'bridge-disconnected' ? 503 : 400 }
      )
    }
    return NextResponse.json({ ok: true, ...(res.data ?? {}), bridgeConnected: true })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'engines action failed' },
      { status: 500 }
    )
  }
}
