// Mark-LV port: streaming chunked TTS. NDJSON over POST — one line per chunk
// the moment it is synthesized, so the client starts speaking chunk 0 while
// the server synthesizes chunk 1 ("cutting perceived latency by the playback
// duration of all but the last chunk" — Mark-LV, on Kokoro's chunk queue).
//
// Line shapes (each terminated by \n):
//   {"seq":0,"contentType":"audio/wav","audioB64":"...","engineUsed":"glm","trimmedSilenceMs":120}
//   {"done":true,"chunks":3,"engineUsed":"glm"}
//   {"done":true,"chunks":1,"engineUsed":"glm","rescuedBy":"edge"}
//   {"done":true,"chunks":2,"engineUsed":"glm","error":"engine failed mid-stream — partial delivery"}
//   {"error":"..."}   (total failure before anything played → non-200? No —
//                      the stream already committed 200; total failure before
//                      the first chunk aborts with this line and the client
//                      falls back to the single-blob route.)
import { NextRequest } from 'next/server'
import { synthesizeSpeechStream } from '@/lib/services/voice-service'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
// streaming a long reply = many sequential SDK calls; give it room
export const maxDuration = 120

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as {
    text?: unknown
    voice?: unknown
    speed?: unknown
    engine?: unknown
  } | null
  if (!body || typeof body.text !== 'string' || !body.text.trim()) {
    return new Response(JSON.stringify({ error: 'text is required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false
      const send = (obj: Record<string, unknown>) => {
        if (closed) return
        controller.enqueue(encoder.encode(JSON.stringify(obj) + '\n'))
      }
      try {
        const result = await synthesizeSpeechStream(
          body.text as string,
          body.voice,
          body.speed,
          body.engine ?? 'glm',
          (chunk) => {
            send({
              seq: chunk.seq,
              contentType: chunk.contentType,
              audioB64: chunk.buffer.toString('base64'),
              engineUsed: chunk.engineUsed,
              ...(chunk.rescuedBy ? { rescuedBy: chunk.rescuedBy } : {}),
              trimmedSilenceMs: chunk.trimmedSilenceMs,
            })
          }
        )
        send({
          done: true,
          chunks: result.chunks,
          engineUsed: result.engineUsed,
          ...(result.rescuedBy ? { rescuedBy: result.rescuedBy } : {}),
          ...(result.error ? { error: result.error } : {}),
        })
      } catch (err) {
        const message = err instanceof Error ? err.message : 'text-to-speech stream failed'
        if (/429|too many requests/i.test(message)) {
          send({ error: 'voice engine rate-limited — wait a few seconds and try again' })
        } else {
          send({ error: message })
        }
      } finally {
        closed = true
        controller.close()
      }
    },
  })

  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'application/x-ndjson',
      'Cache-Control': 'no-store',
      'X-Accel-Buffering': 'no', // never let a proxy hold the chunks back
    },
  })
}
