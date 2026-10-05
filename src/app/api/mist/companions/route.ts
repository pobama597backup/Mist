// M.I.S.T. companions route — detects the OWNER's local agent stack through
// the Mist Bridge v2 daemon: Hermes agent (CLI version, gateway health, skills,
// memory), backtalk (the push-to-talk voice loop for Claude Code agents),
// ai-visualizer (the browser faces), barehands (touchless control), Claude
// Code itself, plus the resolved signal-bus dir and the Hermes→Mist MCP
// registration command.
//
// GET  → {ok, connected, companions?}   (companions null when bridge offline)
// POST {action:'signal_setup', dir?}    → configure the signal-bus dir
// POST {action:'signal_test'}           → 4s speaking performance on the bus
//                                         (state + synthetic waveform) so the
//                                         user can watch every face react live.
//
// NEVER throws.
import { NextRequest, NextResponse } from 'next/server'
import { bridgeExec, getBridgeStatus } from '@/lib/services/bridge-service'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export const maxDuration = 60

export async function GET(): Promise<NextResponse> {
  try {
    const status = await getBridgeStatus(true)
    if (!status.connected) {
      return NextResponse.json({ ok: true, connected: false, companions: null })
    }
    const res = await bridgeExec('companions')
    const companions =
      res.ok && res.data && typeof res.data === 'object'
        ? (res.data as Record<string, unknown>)
        : { error: res.error ?? 'companions scan failed' }
    return NextResponse.json({ ok: true, connected: true, companions })
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : 'companions failed' },
      { status: 500 }
    )
  }
}

/** A gentle synthetic speaking waveform (two drifting sines, int16 scale). */
function synthWaveform(t: number): number[] {
  const samples: number[] = []
  for (let i = 0; i < 64; i++) {
    const v =
      Math.sin(t * 6.3 + i * 0.55) * 2600 +
      Math.sin(t * 11.7 + i * 0.21) * 1500 * Math.sin(t * 1.9)
    samples.push(Math.max(-32768, Math.min(32767, Math.round(v))))
  }
  return samples
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: Record<string, unknown> | null = null
  try {
    body = (await req.json()) as Record<string, unknown> | null
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid JSON body' }, { status: 400 })
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return NextResponse.json({ ok: false, error: 'invalid body' }, { status: 400 })
  }
  const action = typeof body.action === 'string' ? body.action : ''

  if (action === 'signal_setup') {
    const dir = typeof body.dir === 'string' && body.dir.trim() ? body.dir.trim() : undefined
    const res = await bridgeExec('signal_setup', dir ? { dir } : {})
    return NextResponse.json({ ok: res.ok, result: res.data ?? null, error: res.error })
  }

  if (action === 'signal_test') {
    const status = await getBridgeStatus()
    if (!status.connected) {
      return NextResponse.json({ ok: false, error: 'bridge-offline' }, { status: 200 })
    }
    // perform: thinking → speaking (with live waveform ~4Hz for 4s) → idle
    const emit = (args: Record<string, unknown>) => bridgeExec('signal_emit', args)
    await emit({ state: 'thinking' })
    await new Promise((r) => setTimeout(r, 1200))
    const started = Date.now()
    while (Date.now() - started < 4000) {
      const t = (Date.now() - started) / 1000
      await emit({ state: 'speaking', samples: synthWaveform(t) })
      await new Promise((r) => setTimeout(r, 250))
    }
    await emit({ state: 'idle' })
    return NextResponse.json({ ok: true, performed: 'thinking → speaking → idle' })
  }

  return NextResponse.json(
    { ok: false, error: `unknown action "${action || '(missing)'}" (use signal_setup|signal_test)` },
    { status: 400 }
  )
}
