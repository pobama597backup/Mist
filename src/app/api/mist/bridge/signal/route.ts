// M.I.S.T. bridge signal route — the voice stage's live emission endpoint.
//
// The consciousness voice loop POSTs here on every orb state change and (while
// speaking) at a throttled ~4 Hz with real waveform samples from the shared
// audio analyser. We forward to the user's Mist Bridge v2 daemon, which writes
// the backtalk/ai-visualizer ".voice_*" file contract into the resolved signal
// dir — so every companion face on the OWNER's machine (circuit board, radial,
// rain, neural core, barehands ring) performs Mist's live voice state.
//
// POST {state?, samples?, alert?, thinking?} → {ok, emitted?, reason?}
//   state:    'idle' | 'listening' | 'thinking' | 'speaking'
//   samples:  number[] (≤64 int16-scale floats, written as .voice_waveform)
//   alert:    boolean (all faces turn red / clear)
//   thinking: boolean (thinking-sound deference pid file)
//
// NEVER throws; when the bridge is offline this answers {ok:true, emitted:false}
// fast so the voice loop never blocks on it.
import { NextRequest, NextResponse } from 'next/server'
import { bridgeExec, getBridgeStatus } from '@/lib/services/bridge-service'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export const maxDuration = 30

const BUS_STATES = new Set(['idle', 'listening', 'thinking', 'speaking'])

interface SignalBody {
  state?: unknown
  samples?: unknown
  alert?: unknown
  thinking?: unknown
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: SignalBody | null = null
  try {
    body = (await req.json()) as SignalBody | null
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid JSON body' }, { status: 400 })
  }
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ ok: false, error: 'invalid body' }, { status: 400 })
  }

  const args: Record<string, unknown> = {}

  if (typeof body.state === 'string') {
    const state = body.state.trim().toLowerCase()
    if (!BUS_STATES.has(state)) {
      return NextResponse.json(
        { ok: false, error: `state must be one of ${[...BUS_STATES].join('|')}` },
        { status: 400 }
      )
    }
    args.state = state
  }

  if (Array.isArray(body.samples)) {
    const samples = body.samples
      .filter((v) => typeof v === 'number' && Number.isFinite(v))
      .slice(0, 64)
      .map((v) => Math.max(-32768, Math.min(32767, Math.round(v as number))))
    if (samples.length > 0) args.samples = samples
  }

  if (typeof body.alert === 'boolean') args.alert = body.alert
  if (typeof body.thinking === 'boolean') args.thinking = body.thinking

  if (Object.keys(args).length === 0) {
    return NextResponse.json({ ok: true, emitted: false, reason: 'nothing to emit' })
  }

  // Fast no-op when the bridge is down — the voice loop must never wait.
  const status = await getBridgeStatus()
  if (!status.connected) {
    return NextResponse.json({ ok: true, emitted: false, reason: 'bridge-offline' })
  }

  const res = await bridgeExec('signal_emit', args)
  if (!res.ok) {
    return NextResponse.json({ ok: true, emitted: false, reason: res.error ?? 'emit-failed' })
  }
  return NextResponse.json({ ok: true, emitted: true, data: res.data ?? null })
}
