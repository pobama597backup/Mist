import { NextRequest, NextResponse } from 'next/server'
import { llmActiveWithin, recentActivityLog } from '@/lib/services/activity-service'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const CHANNEL_NAMES = ['language', 'memory', 'tools', 'vision', 'audio', 'autonomy'] as const
const INTERVAL_MS = 1500

/** Synthetic-but-alive channel values: sine waves + jitter, clamped to (0, 1). */
function channelValue(name: string, t: number, seedPhase: number): number {
  const freqs: Record<string, number> = {
    language: 0.9,
    memory: 0.35,
    tools: 0.5,
    vision: 0.22,
    audio: 1.3,
    autonomy: 0.16,
  }
  const amps: Record<string, number> = {
    language: 0.22,
    memory: 0.18,
    tools: 0.2,
    vision: 0.14,
    audio: 0.28,
    autonomy: 0.12,
  }
  const freq = freqs[name] ?? 0.5
  const amp = amps[name] ?? 0.18
  const value = 0.5 + amp * Math.sin(t * freq + seedPhase) + (Math.random() - 0.5) * 0.06
  return Math.round(Math.min(0.98, Math.max(0.02, value)) * 100) / 100
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
          const t = Date.now() / 1000
          const boostLanguage = llmActiveWithin(8000)
          const channels = CHANNEL_NAMES.map((name, index) => {
            let value = channelValue(name, t, index * 1.7)
            if (name === 'language' && boostLanguage) {
              value = Math.round(Math.min(0.98, value + 0.3) * 100) / 100
            }
            return { name, value }
          })
          const payload = {
            channels,
            log: recentActivityLog(5),
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
