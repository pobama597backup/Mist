import { NextRequest, NextResponse } from 'next/server'
import { llmActiveWithin, recentActivityLog } from '@/lib/services/activity-service'
import { laneCooldownSnapshot } from '@/lib/services/lane-cooldowns'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const CHANNEL_NAMES = ['language', 'memory', 'tools', 'vision', 'audio', 'autonomy'] as const
const INTERVAL_MS = 1500

// ---------------------------------------------------------------------------
// Phase 3-a · R2 — TELEMETRY TRUTH. This route used to emit sine waves +
// Math.random() jitter as "neural channels" — synthetic-but-alive theater.
// The channels are now DERIVED FROM REAL SIGNAL the app already produces:
//
//   · every activity-service line ("[HH:MM:SS] kind: detail") is a real
//     event with a real timestamp — channel value = a decaying recency bump
//     per matching kind (language←llm, memory←memory, tools←tool,
//     vision←browser, audio←voice, autonomy←heartbeat/scheduler/cron/
//     evolution/oj-sync). Quiet machine ⇒ honest near-floor values, NOT
//     fake activity.
//   · `llmActiveWithin` (the language boost) and the lane-cooldown snapshot
//     (real cascade health: how many lanes are resting, round trips saved)
//     are appended to the payload — real data, cheap imports, no cycles.
//
// Residual honesty note: the RENDERED curve is still a visualization — a
// 1.5s sample of a decaying real-event signal, not a per-millisecond
// measurement (nothing in the app measures per-ms neural anything, and
// pretending to would be the same lie in a nicer font).
// ---------------------------------------------------------------------------

/** One activity log line → { kind, ageSeconds } (null when unparseable).
 *  Timestamps carry time-of-day only — a midnight rollover reads as
 *  negative age, clamped to 0 (recent); documented, bounded, rare. */
function parseActivityLine(line: string): { kind: string; ageSeconds: number } | null {
  const m = /^\[(\d{2}):(\d{2}):(\d{2})\]\s*([a-z-]+):/.exec(line)
  if (!m) return null
  const now = new Date()
  const lineSec = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])
  const nowSec = now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds()
  let age = nowSec - lineSec
  if (age < -43_200) age = 0 // >12h "in the future" ⇒ midnight rollover — treat as recent
  return { kind: m[4], ageSeconds: Math.max(0, age) }
}

/** Channel value from real event recency: 0.04 floor + a half-life-ish
 *  decay (8s), capped at 0.9. Quiet = near floor — that is the truth. */
function channelFromActivity(kinds: Set<string>, samples: { kind: string; ageSeconds: number }[]): number {
  let best = 0
  for (const s of samples) {
    if (!kinds.has(s.kind)) continue
    const bump = 0.86 * Math.exp(-s.ageSeconds / 8)
    if (bump > best) best = bump
  }
  const value = best > 0 ? Math.max(0.05, best) : 0.04
  return Math.round(Math.min(0.95, value) * 100) / 100
}

const CHANNEL_KINDS: Record<(typeof CHANNEL_NAMES)[number], Set<string>> = {
  language: new Set(['llm']),
  memory: new Set(['memory', 'skill']),
  tools: new Set(['tool']),
  vision: new Set(['browser']),
  audio: new Set(['voice']),
  autonomy: new Set(['heartbeat', 'scheduler', 'cron', 'evolution', 'oj-sync', 'mark-lv-sync', 'approvals']),
}

export async function GET(req: NextRequest) {
  const encoder = new TextEncoder()
  let interval: ReturnType<typeof setInterval> | null = null
  let closed = false

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const emit = () => {
        if (closed) return
        try {
          // real signal #1: activity-log recency (see header)
          const log = recentActivityLog(60)
          const samples = log
            .map(parseActivityLine)
            .filter((s): s is { kind: string; ageSeconds: number } => s !== null)
          const boostLanguage = llmActiveWithin(8000)
          const channels = CHANNEL_NAMES.map((name) => {
            let value = channelFromActivity(CHANNEL_KINDS[name], samples)
            if (name === 'language' && boostLanguage) {
              value = Math.round(Math.min(0.95, value + 0.25) * 100) / 100
            }
            return { name, value }
          })
          // real signal #2: cascade health from the lane-cooldown store
          const lanes = laneCooldownSnapshot()
          const payload = {
            channels,
            log: recentActivityLog(5),
            lanesResting: lanes.lanes.length,
            laneSkipsSaved: lanes.skipsSaved,
            signalSource: 'activity-log + lane-cooldowns', // honest: derived, not synthesized
            timestamp: new Date().toISOString(),
          }
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`))
        } catch {
          // controller already closed — stop emitting
          cleanup()
        }
      }

      const cleanup = () => {
        if (closed) return
        closed = true
        if (interval) clearInterval(interval)
        try {
          controller.close()
        } catch {
          // already closed
        }
      }

      emit() // one event immediately on connect
      interval = setInterval(emit, INTERVAL_MS)
      req.signal.addEventListener('abort', cleanup)
    },
    cancel() {
      closed = true
      if (interval) clearInterval(interval)
    },
  })

  return new NextResponse(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  })
}
