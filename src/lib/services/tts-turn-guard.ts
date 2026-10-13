// M.I.S.T. TTS turn guard (Phase 3-a — mandate: "TTS ≤150 ms; late-chunk
// guard per thought id").
//
// SERVER half of the guard. When a client starts speaking a NEW thought, that
// thought id becomes the current spoken turn. Any TTS stream still running
// for an OLDER id is stale by definition: its chunks must NEVER play after
// the owner moved on (a superseded voice turn's stale audio is the audible
// lie this guard deletes). Late chunks from superseded streams are dropped
// SILENTLY server-side — not sent to any client — with an honest counter.
//
// The ids: whatever the caller uses as its thought/turn identity (the client
// speech layer passes the chat turn id it started speaking for; Phase 3-b
// will thread it end-to-end from the UI — the SERVER side is complete here
// and harmless when no id is supplied, which is documented honestly below).
//
// State on globalThis: dev hot-reload must not fork the registry (the
// activity-service pattern).

interface TtsGuardState {
  /** the id of the newest speak that has begun */
  currentId: string | null
  currentAt: number
  /** total late chunks dropped since boot (honest metric, never reset) */
  droppedStaleChunks: number
  /** last measured first-chunk latency (ms) — honest budget telemetry */
  lastFirstChunkMs: number | null
}

const g = globalThis as unknown as { __mistTtsTurnGuard?: TtsGuardState }
const state = (g.__mistTtsTurnGuard ??= {
  currentId: null,
  currentAt: 0,
  droppedStaleChunks: 0,
  lastFirstChunkMs: null,
})

/** A new speak began for `id` — it is now the current spoken turn; every
 *  other in-flight stream became stale. Idempotent for the same id (a
 *  re-send of the same turn does not supersede itself). */
export function beginSpeakTurn(id: string): void {
  if (state.currentId === id) return
  state.currentId = id
  state.currentAt = Date.now()
}

/** True when a NEWER speak began after `id`'s stream — its chunks are stale. */
export function isStaleSpeakTurn(id: string): boolean {
  return state.currentId !== null && state.currentId !== id
}

/** Guard decision for one outgoing chunk: true = drop it silently (stale);
 *  false = send it. Counts every drop for the honest debug field. */
export function shouldDropChunk(id: string | null | undefined): boolean {
  if (!id) return false // no identity supplied — pre-3-a behavior, cannot guard
  if (!isStaleSpeakTurn(id)) return false
  state.droppedStaleChunks++
  return true
}

/** First-audio latency bookkeeping (the ≤150 ms voice budget): the caller
 *  records the ms from ITS start-of-turn to the first chunk actually sent. */
export function noteFirstChunkLatency(ms: number): void {
  state.lastFirstChunkMs = ms
}

/** Honest surface snapshot (health/debug). */
export function ttsGuardSnapshot(): {
  currentSpeakId: string | null
  droppedStaleChunks: number
  lastFirstChunkMs: number | null
} {
  return {
    currentSpeakId: state.currentId,
    droppedStaleChunks: state.droppedStaleChunks,
    lastFirstChunkMs: state.lastFirstChunkMs,
  }
}
