// Mark-LV port: streaming chunked TTS. NDJSON over POST — one line per chunk
// the moment it is synthesized, so the client starts speaking chunk 0 while
// the server synthesizes chunk 1 ("cutting perceived latency by the playback
// duration of all but the last chunk" — Mark-LV, on Kokoro's chunk queue).
//
// Line shapes (each terminated by \n):
//   {"seq":0,"thoughtId":"…","contentType":"audio/wav","audioB64":"...","engineUsed":"glm","trimmedSilenceMs":120}
//   {"done":true,"chunks":3,"engineUsed":"glm"}
//   {"done":true,"chunks":1,"engineUsed":"glm","rescuedBy":"edge"}
//   {"done":true,"chunks":2,"engineUsed":"glm","error":"engine failed mid-stream — partial delivery"}
//   {"done":true,"chunks":0,"droppedStaleChunks":3,"engineUsed":"glm","note":"superseded by a newer speak — chunks dropped server-side"}
//   {"error":"..."}   (total failure before anything played → non-200? No —
//                      the stream already committed 200; total failure before
//                      the first chunk aborts with this line and the client
//                      falls back to the single-blob route.)
//
// Phase 3-a (mandate "TTS ≤150 ms; late-chunk guard per thought id"):
//   · first-audio latency is MEASURED and logged honestly (activity log —
//     the app's telemetry surface — with an explicit over-budget callout);
//     the ≤150 ms budget is a target, not a claim — the number is real.
//   · each request may carry `thoughtId` — the turn the client is speaking.
//     A NEWER speak supersedes this one server-side: late chunks of the OLD
//     stream are dropped silently (counter, honest note on the done line).
//     NOTE FOR 3-b (frontend half): src/lib/speech.ts should thread its
//     current turn id into this field AND keep its client-side supersede
//     guard — the server guard covers the stream lane, the client covers
//     already-buffered local playback.
import { NextRequest } from 'next/server'
import { synthesizeSpeechStream } from '@/lib/services/voice-service'
import { checkRateLimit, rateLimitResponse } from '@/lib/perimeter/rate-limit'
import { recordActivity } from '@/lib/services/activity-service'
import { beginSpeakTurn, noteFirstChunkLatency, shouldDropChunk } from '@/lib/services/tts-turn-guard'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
// streaming a long reply = many sequential SDK calls; give it room
export const maxDuration = 120

export async function POST(req: NextRequest) {
  // Phase 1 · S12: voice lane (streaming TTS) — same 60/min bucket as
  // stt/tts; the stream itself is untouched once started.
  const rl = checkRateLimit('voice', req)
  if (!rl.ok) return rateLimitResponse('voice', rl.retryAfter ?? 1)
  const body = (await req.json().catch(() => null)) as {
    text?: unknown
    voice?: unknown
    speed?: unknown
    engine?: unknown
    thoughtId?: unknown
  } | null
  if (!body || typeof body.text !== 'string' || !body.text.trim()) {
    return new Response(JSON.stringify({ error: 'text is required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    })
  }
  // Phase 3-a: an identified speak becomes the CURRENT spoken turn — any
  // stream still running for an older id is now stale (chunks dropped).
  const thoughtId = typeof body.thoughtId === 'string' && body.thoughtId.trim() ? body.thoughtId.trim() : null
  if (thoughtId) beginSpeakTurn(thoughtId)
  const startedAt = Date.now()

  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false
      let droppedStale = 0
      let firstChunkSent = false
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
            // ---- Phase 3-a late-chunk guard: never send audio for a turn a
            // newer speak has superseded (the client moved on — stale audio
            // after cancel/new turn is the audible lie this deletes).
            if (shouldDropChunk(thoughtId)) {
              droppedStale++
              return
            }
            if (!firstChunkSent) {
              firstChunkSent = true
              // honest first-audio metric (the ≤150ms voice budget) — measured,
              // logged, never faked; over-budget is called out in the line itself
              const ms = Date.now() - startedAt
              noteFirstChunkLatency(ms)
              recordActivity(
                'voice',
                `tts first audio chunk in ${ms}ms${ms > 150 ? ' (over the 150ms voice budget)' : ' (within the 150ms voice budget)'}`
              )
            }
            send({
              seq: chunk.seq,
              ...(thoughtId ? { thoughtId } : {}),
              contentType: chunk.contentType,
              audioB64: chunk.buffer.toString('base64'),
              engineUsed: chunk.engineUsed,
              ...(chunk.rescuedBy ? { rescuedBy: chunk.rescuedBy } : {}),
              trimmedSilenceMs: chunk.trimmedSilenceMs,
            })
          }
        )
        if (droppedStale > 0) {
          // honest done-line: the stream completed but nothing (or only a
          // prefix) shipped because a newer speak superseded this turn
          send({
            done: true,
            chunks: 0,
            engineUsed: result.engineUsed,
            droppedStaleChunks: droppedStale,
            note: 'superseded by a newer speak — late chunks dropped server-side (tts-turn-guard)',
          })
        } else {
          send({
            done: true,
            chunks: result.chunks,
            engineUsed: result.engineUsed,
            ...(result.rescuedBy ? { rescuedBy: result.rescuedBy } : {}),
            ...(result.error ? { error: result.error } : {}),
          })
        }
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
