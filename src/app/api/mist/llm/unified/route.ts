import { NextRequest } from 'next/server'
import { timingSafeEqual } from 'node:crypto'
import { unified } from '@/lib/services/llm-service'
import type { ActivityEvent } from '@/lib/services/llm-service'
import { tryFastPath, classifyMessage, fastReplyKey } from '@/lib/services/fast-path'
import type { UnifiedLlmRequest, UnifiedLlmResponse } from '@/lib/types'
import { db } from '@/lib/db'
import { checkRateLimit, rateLimitResponse } from '@/lib/perimeter/rate-limit'
import { getMistSecrets, SERVICE_HEADER } from '@/lib/perimeter/shared'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/**
 * w3 spine — the unified route now speaks TWO protocols:
 *
 *  1. (default, unchanged) JSON — every existing caller keeps its contract.
 *  2. stream:true → NDJSON — one {"type":"activity","label":…} line per thing
 *     she is doing (thinking / reading file X / searching the web), then a
 *     final {"type":"result", …envelope}. neural-service opts in and forwards
 *     the activity lines to the client socket so the UI can show what she is
 *     doing RIGHT NOW (Mark-LV status-line philosophy).
 *
 * The fast-path (w3-speed) runs BEFORE any cascade work: canned smalltalk /
 * cached replies / direct system snapshot answer in milliseconds with zero
 * provider tokens — in both protocols, so chat and voice both get instant.
 *
 * w3-speed addition — LEARN AFTER ANSWERING: when the real brain answers a
 * conversational simple prompt (same recognizer, no tools used, honest lane,
 * short reply), the answer is seeded into FastReply under the same normalized
 * key the instant layer reads. The FIRST ask costs a real turn; the SECOND
 * ask of the same words is milliseconds with her own words replayed.
 */

function fastEnvelope(req: UnifiedLlmRequest, text: string, kind: 'smalltalk' | 'status' | 'cached', emotion = 'warm'): UnifiedLlmResponse {
  return {
    text,
    provider: 'mist-instant',
    model: 'instant-recall',
    fallback: false,
    emotion,
    memory_context: { facts_recalled: 0, vectors_searched: 0, tools_available: 0 },
    tools_used: [],
    skills_used: [],
    skill_hint: null,
    elapsed_ms: 0,
    mode: req.mode ?? 'consciousness',
    fast_path: { kind, saved_ms: 0 },
  }
}

/** Phase 2-b Arbiter origin: a request carrying the intra-machine service
 *  secret (the neural relay — her voice path) is arbitrated as owner_voice;
 *  every other caller is owner_chat. Timing-safe, same as the perimeter. */
function arbiterOriginFor(req: NextRequest): 'owner_voice' | 'owner_chat' {
  const header = req.headers.get(SERVICE_HEADER)
  if (!header) return 'owner_chat'
  const secret = getMistSecrets().sessionSecret
  const a = Buffer.from(header)
  const b = Buffer.from(secret)
  return a.length === b.length && (() => {
    try {
      return timingSafeEqual(a, b)
    } catch {
      return false
    }
  })()
    ? 'owner_voice'
    : 'owner_chat'
}

export async function POST(req: NextRequest) {
  // Phase 1 · S12: the cascade is the most expensive lane in the app —
  // 30 req/min per session (MIST_RATE_LIMIT_OFF=1 disables).
  const rl = checkRateLimit('llm', req)
  if (!rl.ok) return rateLimitResponse('llm', rl.retryAfter ?? 1)
  try {
    const body = (await req.json().catch(() => null)) as UnifiedLlmRequest | null
    if (!body || typeof body.message !== 'string' || !body.message.trim()) {
      return Response.json({ error: 'message is required' }, { status: 400 })
    }

    // ---- w3 fast-path: milliseconds, zero tokens, both protocols ----
    let fast: Awaited<ReturnType<typeof tryFastPath>> = null
    try {
      fast = await tryFastPath(body)
    } catch {
      fast = null // the instant layer must never break a turn
    }

    if (body.stream === true) {
      const encoder = new TextEncoder()
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          const send = (obj: unknown) => {
            try {
              controller.enqueue(encoder.encode(JSON.stringify(obj) + '\n'))
            } catch {
              /* client gone — the unified() call still completes */
            }
          }
          try {
            if (fast) {
              send({ type: 'activity', label: fast.kind === 'status' ? 'checking the machine' : 'instant recall', at: Date.now() })
              const env = fastEnvelope(body, fast.text, fast.kind, fast.emotion)
              env.fast_path = { kind: fast.kind, saved_ms: 0 }
              await rememberFastReply(body.message, fast)
              send({ type: 'result', ...env })
            } else {
              const onActivity = (ev: ActivityEvent) => send({ type: 'activity', ...ev, at: Date.now() })
              // w5 voice-speed: clean prose deltas stream as they're generated
              // (the client's voice path starts TTS on the first sentence —
              // voice in milliseconds instead of after the full completion)
              const onChunk = (text: string) => send({ type: 'chunk', text, at: Date.now() })
              // Phase 3-a · R1: req.signal is the CLIENT's lifeline — aborting
              // the fetch (or the TCP connection dying: the neural relay's
              // cancel protocol kills its fetch on 'cancel_thought'/disconnect)
              // fires it, unified() stops the cascade + tool loop, and in-flight
              // provider fetches die. Best-effort relay path documented in
              // mini-services/neural-service/index.ts (its controller is the
              // signal source, not this server).
              const result = await unified(
                { ...body, origin: arbiterOriginFor(req) },
                onActivity,
                onChunk,
                req.signal
              )
              send({ type: 'result', ...result })
              // a cancelled turn's text is not a cache-worthy answer
              if (!req.signal.aborted) await seedFastReplyAfterCascade(body, result)
            }
          } catch (err) {
            send({
              type: 'result',
              error: err instanceof Error ? err.message : 'unified call failed',
            })
          } finally {
            controller.close()
          }
        },
      })
      return new Response(stream, {
        headers: {
          'Content-Type': 'application/x-ndjson; charset=utf-8',
          'Cache-Control': 'no-store, no-transform',
          'X-Accel-Buffering': 'no',
        },
      })
    }

    // ---- default JSON protocol (unchanged shape) ----
    if (fast) {
      const env = fastEnvelope(body, fast.text, fast.kind, fast.emotion)
      env.fast_path = { kind: fast.kind, saved_ms: 0 }
      await rememberFastReply(body.message, fast)
      return Response.json(env)
    }
    const result = await unified(
      {
        message: body.message,
        mode: body.mode,
        history: body.history,
        extra: body.extra,
        provider: body.provider,
        thinking: body.thinking,
        origin: arbiterOriginFor(req),
      },
      undefined,
      undefined,
      req.signal // Phase 3-a · R1: client disconnect cancels the cascade + tool loop
    )
    if (!req.signal.aborted) await seedFastReplyAfterCascade(body, result)
    return Response.json(result)
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : 'unified call failed' },
      { status: 500 }
    )
  }
}

/** Seed the FastReply table when the instant layer answers (canned lines land
 *  here so the "cacheable" flag is honored). The key is the SAME normalized
 *  sha256 the instant layer reads on the next ask (fastReplyKey). */
async function rememberFastReply(rawPrompt: string, fast: NonNullable<Awaited<ReturnType<typeof tryFastPath>>>): Promise<void> {
  if (!fast.cacheable) return
  try {
    const cls = classifyMessage(rawPrompt)
    const key = fastReplyKey(rawPrompt)
    await db.fastReply.upsert({
      where: { cacheKey: key },
      update: { hits: { increment: 1 } },
      create: { cacheKey: key, prompt: rawPrompt.slice(0, 200), text: fast.text, kind: cls ?? fast.kind },
    })
  } catch {
    /* cache seeding is best-effort — never break the reply */
  }
}

/** w3-speed learn-after-answering: the real brain answered a conversational
 *  simple prompt with no tools and no fallback — her own words are worth
 *  keeping, so the SECOND ask of the same words replays in milliseconds.
 *  Status prompts never land here (the fast-path answers them live), and tool
 *  answers are never cached — a cached tool answer would be a stale lie. */
async function seedFastReplyAfterCascade(body: UnifiedLlmRequest, res: UnifiedLlmResponse): Promise<void> {
  try {
    if (res.fallback || res.tools_used.length > 0) return
    const text = typeof res.text === 'string' ? res.text.trim() : ''
    if (!text || text.length >= 400) return
    const cls = classifyMessage(body.message)
    if (cls === null || cls === 'status') return // conversational classes only — never a stale status/tool answer
    const key = fastReplyKey(body.message)
    await db.fastReply.upsert({
      where: { cacheKey: key },
      update: { text, hits: { increment: 1 } },
      create: { cacheKey: key, prompt: body.message.slice(0, 200), text, kind: cls },
    })
  } catch {
    /* seeding is best-effort — never break the reply */
  }
}
