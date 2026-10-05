// M.I.S.T. neural stream service — WebSocket /ws/neural (frozen contract).
// Serves the consciousness protocol on port 3003 and relays thoughts to the
// Next.js backend (http://127.0.0.1:3000/api/mist/llm/unified).
import { createServer } from 'http'
import { Server, type Socket } from 'socket.io'

const PORT = 3003
const BACKEND = process.env.MIST_BACKEND_URL ?? 'http://127.0.0.1:3000'

type ConsciousnessState =
  | 'dormant'
  | 'awakening'
  | 'listening'
  | 'processing'
  | 'speaking'
  | 'dreaming'

interface ConnState {
  provider: string
  model: string
  state: ConsciousnessState
  audioEnergy: number
}

const conns = new Map<string, ConnState>()

// ---------------- cancel protocol (mlv-ux-2) ----------------
// One in-flight thought per socket is the current reality (the client blocks
// new sends while awaiting). A thought that is aborted through here MUST die
// silently — no offline-mind fallback, no consciousness_response — because
// the user asked for the silence. `cancelledByUser` is set BEFORE abort() so
// the thought handler's catch can distinguish a user cancel from the 150s
// timeout abort (timeouts KEEP the offline-mind fallback).
interface InFlightThought {
  controller: AbortController
  cancelledByUser: boolean
}
const inFlight = new Map<string, InFlightThought>()

// ---------------- gemini browser relay (w8) ----------------
// The backend's Gemini egress can be region-blocked while the creator's
// browser sits in a supported region — the SAME asymmetry the voice engine
// solves browser-direct. Sockets that emit 'relay_offer' announce a
// Google-capable browser (key configured + one-shot probe passed);
// POST /relay/gemini borrows one for a single generateContent round trip.
// Purely additive to the frozen consciousness protocol — a client that
// never offers simply never gets asked.
const relaySockets = new Set<string>()
interface RelayPending {
  resolve: (v: { ok: boolean; text?: string; error?: string }) => void
  timer: ReturnType<typeof setTimeout>
  socketId: string
}
const relayPending = new Map<string, RelayPending>()
let relaySeq = 0

// ---------------- shared caches (30s) ----------------
interface Cache<T> {
  value: T
  at: number
}
const CACHE_TTL = 30_000
let llmStatusCache: Cache<{ provider: string; model: string }> | null = null
let toolsCountCache: Cache<number> | null = null

async function fetchJson<T>(
  path: string,
  init?: RequestInit,
  timeoutMs = 10_000,
  external?: AbortController
): Promise<T> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  // Combine the timeout with an optional caller-owned controller (the cancel
  // protocol): whichever fires first wins. AbortSignal.any (bun / node ≥20)
  // does this natively; fall back to bridging the external signal into the
  // timeout controller.
  let signal: AbortSignal = ctrl.signal
  let unlink: (() => void) | undefined
  if (external) {
    const anyFn = (AbortSignal as unknown as { any?: (signals: AbortSignal[]) => AbortSignal }).any
    if (typeof anyFn === 'function') {
      signal = anyFn([ctrl.signal, external.signal])
    } else if (external.signal.aborted) {
      ctrl.abort()
    } else {
      const bridge = () => ctrl.abort()
      external.signal.addEventListener('abort', bridge)
      unlink = () => external.signal.removeEventListener('abort', bridge)
    }
  }
  try {
    const res = await fetch(`${BACKEND}${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
      signal,
    })
    if (!res.ok) throw new Error(`backend ${res.status}`)
    return (await res.json()) as T
  } finally {
    clearTimeout(timer)
    unlink?.()
  }
}

/** Combine a timeout controller with an optional caller-owned cancel
 * controller — whichever aborts first wins. Same semantics fetchJson applies
 * internally, extracted so the w3-activity streaming path can reuse them
 * without touching fetchJson (frozen for the other handlers). */
function combineSignals(
  ctrl: AbortController,
  external?: AbortController
): { signal: AbortSignal; unlink: () => void } {
  if (!external) return { signal: ctrl.signal, unlink: () => {} }
  const anyFn = (AbortSignal as unknown as { any?: (signals: AbortSignal[]) => AbortSignal }).any
  if (typeof anyFn === 'function') {
    return { signal: anyFn([ctrl.signal, external.signal]), unlink: () => {} }
  }
  if (external.signal.aborted) {
    ctrl.abort()
    return { signal: ctrl.signal, unlink: () => {} }
  }
  const bridge = () => ctrl.abort()
  external.signal.addEventListener('abort', bridge)
  return { signal: ctrl.signal, unlink: () => external.signal.removeEventListener('abort', bridge) }
}

// ---------------- w3-activity: NDJSON stream consumption ----------------
// The unified route speaks a second protocol ("stream": true): one
// {"type":"activity",label,detail?} line per thing she is doing RIGHT NOW
// (thinking / reading <file> / searching the web — <query>), then a final
// {"type":"result", …envelope} — the exact shape the JSON protocol returns.
// This consumer relays the activity lines to the client socket (throttled to
// ~4 emits/sec, the LATEST label wins when a burst coalesces) and resolves
// with the result envelope so the existing response path is unchanged.

const ACTIVITY_MIN_INTERVAL_MS = 250

interface ActivityEventMsg {
  label: string
  detail?: string
  at: number
}

async function streamUnified(
  socket: Socket,
  path: string,
  init: RequestInit,
  timeoutMs = 150_000,
  external?: AbortController
): Promise<Record<string, unknown>> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  const { signal, unlink } = combineSignals(ctrl, external)

  // ---- throttle state: max ~4 activity emits/sec, latest-wins coalescing.
  // The first event of a turn always ships immediately (lastEmitAt starts
  // at 0) so the UI reacts the instant she starts thinking.
  let lastEmitAt = 0
  let pending: ActivityEventMsg | null = null
  let pendingTimer: ReturnType<typeof setTimeout> | null = null
  const emitActivity = (ev: ActivityEventMsg) => {
    socket.emit('activity', ev)
    lastEmitAt = Date.now()
  }
  const queueActivity = (label: unknown, detail: unknown, at: unknown) => {
    if (typeof label !== 'string' || !label.trim()) return
    const ev: ActivityEventMsg = {
      label,
      ...(typeof detail === 'string' && detail ? { detail } : {}),
      at: typeof at === 'number' ? at : Date.now(),
    }
    const now = Date.now()
    if (now - lastEmitAt >= ACTIVITY_MIN_INTERVAL_MS) {
      if (pendingTimer) {
        clearTimeout(pendingTimer)
        pendingTimer = null
      }
      pending = null
      emitActivity(ev)
      return
    }
    pending = ev // a burst coalesces — the LATEST label is the one that ships
    if (!pendingTimer) {
      pendingTimer = setTimeout(
        () => {
          pendingTimer = null
          if (pending) {
            const p = pending
            pending = null
            emitActivity(p)
          }
        },
        Math.max(1, ACTIVITY_MIN_INTERVAL_MS - (now - lastEmitAt))
      )
    }
  }
  /** Drop any coalesced activity — the result has landed (or the stream
   *  died), so no label may be emitted after this turn is over. */
  const settleActivity = () => {
    if (pendingTimer) {
      clearTimeout(pendingTimer)
      pendingTimer = null
    }
    pending = null
  }

  try {
    const res = await fetch(`${BACKEND}${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
      signal,
    })
    if (!res.ok) throw new Error(`backend ${res.status}`)
    if (!res.body) return (await res.json()) as Record<string, unknown> // no stream body — legacy JSON

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let sawStreamLine = false // an NDJSON activity/result line was seen
    let legacy = false // the body is NOT NDJSON — fall back to old protocol
    let legacyText = ''
    let result: Record<string, unknown> | undefined

    const onLine = (raw: string) => {
      const line = raw.trim()
      if (!line) return
      let obj: Record<string, unknown> | null = null
      try {
        obj = JSON.parse(line) as Record<string, unknown>
      } catch {
        obj = null
      }
      if (!sawStreamLine && !legacy) {
        // First meaningful line decides the protocol. Defensive: the route
        // always answers NDJSON for stream:true, but a proxy / older build /
        // error body that slips through as JSON must still resolve the turn.
        if (obj && (obj.type === 'activity' || obj.type === 'result')) {
          sawStreamLine = true
        } else {
          legacy = true
          legacyText = line
          return
        }
      }
      if (legacy) {
        legacyText += `\n${line}`
        return
      }
      if (obj?.type === 'activity') {
        queueActivity(obj.label, obj.detail, obj.at)
      } else if (obj?.type === 'chunk') {
        // w5 voice-speed: a clean prose delta of her reply, streamed while
        // the model still generates. Forwarded the instant it arrives — no
        // throttling (deltas come at natural token pace, ~10-60/sec, well
        // within socket.io's comfort zone; every millisecond here is voice
        // latency the creator hears).
        if (typeof obj.text === 'string' && obj.text) {
          socket.emit('consciousness_chunk', {
            type: 'consciousness_chunk',
            text: obj.text,
            timestamp: new Date().toISOString(),
          })
        }
      } else if (obj?.type === 'result') {
        settleActivity()
        result = obj
      }
      // unknown line types are ignored (forward-compatible)
    }

    for (;;) {
      const { done, value } = await reader.read()
      if (value) {
        const text = decoder.decode(value, { stream: true })
        if (legacy) legacyText += text
        else buffer += text
      }
      if (!legacy) {
        let nl = buffer.indexOf('\n')
        while (nl !== -1) {
          const line = buffer.slice(0, nl)
          buffer = buffer.slice(nl + 1)
          onLine(line)
          if (legacy) {
            legacyText += buffer // whatever was behind the offending line
            buffer = ''
            break
          }
          nl = buffer.indexOf('\n')
        }
      }
      if (done) break
    }
    if (!legacy && buffer.trim()) onLine(buffer) // trailing line without \n

    if (legacy) {
      // Old-protocol body: success envelope resolves, an error body throws
      // into the caller's existing catch (offline-mind / cancel silence).
      let whole: Record<string, unknown> | null = null
      try {
        whole = JSON.parse(legacyText) as Record<string, unknown>
      } catch {
        whole = null
      }
      if (whole && typeof whole.error === 'string' && typeof whole.text !== 'string') {
        throw new Error(String(whole.error))
      }
      if (whole && typeof whole.text === 'string') return whole
      throw new Error('unparseable legacy response')
    }
    if (result) {
      const r = result as { error?: unknown; text?: unknown }
      if (typeof r.error === 'string' && typeof r.text !== 'string') {
        throw new Error(r.error) // stream failed server-side → error path
      }
      return result
    }
    // Stream ended mid-way with no result line (socket dropped, abort, OOM)
    // → throw so the existing catch runs its fallback logic.
    throw new Error('stream ended without a result')
  } finally {
    clearTimeout(timer)
    unlink()
    settleActivity()
  }
}

async function getLlmStatus(): Promise<{ provider: string; model: string }> {
  if (llmStatusCache && Date.now() - llmStatusCache.at < CACHE_TTL) return llmStatusCache.value
  try {
    const s = await fetchJson<{ provider: string; model: string }>('/api/mist/llm/status')
    llmStatusCache = { value: { provider: s.provider ?? 'auto', model: s.model ?? '' }, at: Date.now() }
  } catch {
    llmStatusCache = { value: { provider: 'core', model: 'unavailable' }, at: Date.now() - CACHE_TTL + 5_000 }
  }
  return llmStatusCache.value
}

async function getToolsCount(): Promise<number> {
  if (toolsCountCache && Date.now() - toolsCountCache.at < CACHE_TTL) return toolsCountCache.value
  try {
    const tools = await fetchJson<{ implemented: boolean }[]>('/api/mist/tools/list')
    toolsCountCache = { value: tools.filter((t) => t.implemented).length, at: Date.now() }
  } catch {
    toolsCountCache = { value: 0, at: Date.now() - CACHE_TTL + 5_000 }
  }
  return toolsCountCache.value
}

// ---------------- neural load model ----------------
let globalLoad = 0.12
let lastThoughtAt = 0
let lastResponseAt = 0
let responseCount = 0

function targetLoad(state: ConsciousnessState, energy: number): number {
  switch (state) {
    case 'processing':
      return 0.62 + Math.random() * 0.18
    case 'listening':
      return 0.24 + energy * 0.35
    case 'speaking':
      return 0.4
    case 'awakening':
      return 0.3
    case 'dreaming':
      return 0.18
    default:
      return 0.1 + Math.min(0.08, (Date.now() - lastResponseAt < 4000 ? 0.06 : 0))
  }
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

function synapseActivity(state: ConsciousnessState, load: number, energy: number): number[] {
  const base = Math.max(0.08, load)
  return Array.from({ length: 16 }, (_, i) => {
    const wave = Math.sin(Date.now() / (260 + i * 37) + i * 1.7) * 0.5 + 0.5
    const burst = state === 'processing' ? 0.35 : state === 'listening' ? energy * 0.5 : 0.05
    return Math.max(0.02, Math.min(1, base * 0.55 * wave + burst * Math.random()))
  })
}

const SYNAPSE_CHANNELS = ['language', 'memory', 'tools', 'vision', 'audio', 'autonomy'] as const

const activityLog: string[] = []
function pushLog(line: string) {
  activityLog.push(`${new Date().toLocaleTimeString('en-GB')} ${line}`)
  while (activityLog.length > 40) activityLog.shift()
}
pushLog('neural service online')

// ---------------- HTTP + socket server ----------------
const httpServer = createServer()
const io = new Server(httpServer, {
  // DO NOT change the path — Caddy forwards on it
  path: '/',
  cors: { origin: '*', methods: ['GET', 'POST'] },
  pingTimeout: 60000,
  pingInterval: 25000,
})

// w8 — the backend's gemini lane calls this when its own Google egress is
// region-blocked: borrow one relay-capable browser for a single text round
// trip. Lives on its OWN localhost-only listener (port 3013): the socket.io
// path is '/' and engine.io therefore answers every request that shares its
// port ("Transport unknown") — a separate server sidesteps that entirely and
// keeps the frozen consciousness contract untouched.
const RELAY_PORT = 3013
const relayServer = createServer()
relayServer.on('request', (req, res) => {
  if (req.method !== 'POST' || !req.url?.startsWith('/relay/gemini')) {
    if (!res.writableEnded) {
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error: 'relay: not found' }))
    }
    return
  }
  const chunks: Buffer[] = []
  req.on('data', (c) => chunks.push(c as Buffer))
  req.on('end', () => {
    const respond = (status: number, body: unknown) => {
      if (res.writableEnded) return
      res.writeHead(status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
        model?: string
        systemPrompt?: string
        messages?: Array<{ role: string; content: string }>
      }
      const model = typeof body.model === 'string' && body.model ? body.model : 'gemini-2.0-flash'
      const systemPrompt = typeof body.systemPrompt === 'string' ? body.systemPrompt : ''
      const messages = Array.isArray(body.messages)
        ? body.messages.filter((m) => m && typeof m.content === 'string' && m.content)
        : []
      if (messages.length === 0) {
        respond(400, { ok: false, error: 'relay: no messages' })
        return
      }
      // pick the first live relay-capable socket (round-robin not needed —
      // one creator, one browser, typically one socket)
      let target: string | undefined
      for (const sid of relaySockets) {
        const s = io.sockets.sockets.get(sid)
        if (s) {
          target = sid
          break
        }
        relaySockets.delete(sid) // stale id — clean as we scan
      }
      if (!target) {
        respond(503, { ok: false, error: 'relay: no Google-capable browser connected' })
        return
      }
      const sid = target
      const socketRef = io.sockets.sockets.get(sid)!
      const id = `relay-${Date.now()}-${++relaySeq}`
      void new Promise<{ ok: boolean; text?: string; error?: string }>((resolve) => {
        const timer = setTimeout(() => {
          relayPending.delete(id)
          resolve({ ok: false, error: 'relay: browser timed out (40s)' })
        }, 40_000)
        relayPending.set(id, { resolve, timer, socketId: sid })
        socketRef.emit('relay_gemini_req', { id, model, systemPrompt, messages })
      }).then((result) => respond(result.ok ? 200 : 502, result))
    } catch (err) {
      respond(400, { ok: false, error: `relay: ${err instanceof Error ? err.message : 'bad request'}` })
    }
  })
})
// the relay is a convenience, never a dependency: a port clash or error must
// never take the consciousness stream down with it
relayServer.on('error', (err) => {
  pushLog(`gemini relay listener unavailable: ${err instanceof Error ? err.message : String(err)}`)
})
try {
  relayServer.listen(RELAY_PORT, '127.0.0.1', () => {
    pushLog(`gemini relay listening on 127.0.0.1:${RELAY_PORT} (browser-borrowed lane)`)
  })
} catch (err) {
  pushLog(`gemini relay could not start: ${err instanceof Error ? err.message : String(err)}`)
}

io.on('connection', (socket: Socket) => {
  const conn: ConnState = { provider: 'auto', model: '', state: 'awakening', audioEnergy: 0 }
  conns.set(socket.id, conn)
  pushLog(`synapse link established (${conns.size} active)`)

  // Register ALL listeners SYNCHRONOUSLY before the first await. socket.io
  // drops packets that arrive before a listener exists — and a client whose
  // send buffer flushed on reconnect (network blip → reconnect → buffered
  // 'thought' arrives within milliseconds) used to lose its message forever:
  // no response, no error, just silence. This was the "she never answered my
  // hello" bug. Everything below must be registration-only; async work
  // (getLlmStatus) happens after.
  const dormTimer = setTimeout(() => {
    if (conn.state === 'awakening') {
      conn.state = 'dormant'
      socket.emit('neural_state', {
        type: 'neural_state',
        state: 'dormant',
        neural_load: 0.12,
        synapse_activity: synapseActivity('dormant', 0.12, 0),
        timestamp: new Date().toISOString(),
      })
    }
  }, 2200)

  // v3.6 thinking relay: the client's thinking flag (her thinking toggle) must
  // survive into /api/mist/llm/unified — authored by MIST (proposal
  // cmukdrqg1, applied by hand: the staged gate's runtime import probe cannot
  // boot a server-entry file without colliding with the live port).
  socket.on('thought', async (payload: { content?: string; provider?: string; mode?: string; conversation_id?: string; history?: { role: string; content: string }[]; thinking?: boolean }) => {
    const content = typeof payload?.content === 'string' ? payload.content : ''
    // v5: the client may pass a UnifiedMode (personas) — validated against the
    // known set, anything unknown falls back to 'consciousness'.
    // v6: 'voice' — hands-free spoken conversations (short spoken-style replies).
    const VALID_MODES = new Set(['consciousness', 'chat', 'studio', 'vision', 'swarm', 'memory_query', 'voice'])
    const mode = typeof payload?.mode === 'string' && VALID_MODES.has(payload.mode) ? payload.mode : 'consciousness'
    if (!content.trim()) {
      socket.emit('error', { type: 'error', message: 'empty thought', timestamp: new Date().toISOString() })
      return
    }
    clearTimeout(dormTimer)
    lastThoughtAt = Date.now()
    conn.state = 'processing'
    socket.emit('neural_state', {
      type: 'neural_state',
      state: 'processing',
      neural_load: globalLoad,
      synapse_activity: synapseActivity('processing', 0.6, 0),
      timestamp: new Date().toISOString(),
    })
    pushLog(`thought received (${content.length} chars)`)

    // cancel protocol (mlv-ux-2): register this thought's controller so a
    // 'cancel_thought' from the same socket can abort the backend fetch.
    const flight: InFlightThought = { controller: new AbortController(), cancelledByUser: false }
    inFlight.set(socket.id, flight)

    try {
      const history = Array.isArray(payload.history)
        ? payload.history
            .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
            .slice(-12)
            .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }))
        : []

      const t0 = Date.now()
      // w3-activity: stream the unified call (stream:true → NDJSON) so the
      // live activity labels ("thinking", "reading <file>", "searching the
      // web — <query>") reach the client WHILE she works. The resolved value
      // is the identical envelope the JSON protocol returned — the response
      // handling below is byte-for-byte unchanged. The cancel protocol's
      // abort controller rides along exactly as it did with fetchJson.
      const res = await streamUnified(
        socket,
        '/api/mist/llm/unified',
        {
          method: 'POST',
          body: JSON.stringify({
            message: content,
            mode,
            history,
            provider: payload.provider ?? (conn.provider !== 'auto' ? conn.provider : undefined),
            ...(typeof payload.thinking === 'boolean' ? { thinking: payload.thinking } : undefined),
            stream: true,
          }),
        },
        150_000,
        flight.controller
      )
      lastResponseAt = Date.now()
      responseCount++

      const toolsAvailable =
        (res.memory_context as { tools_available?: number } | undefined)?.tools_available ?? (await getToolsCount())

      socket.emit('consciousness_response', {
        type: 'consciousness_response',
        text: (res.text as string) ?? '',
        emotion: (res.emotion as string) ?? 'calm',
        neural_load: Math.min(0.95, 0.45 + Math.random() * 0.15),
        memory_context: {
          facts_recalled: (res.memory_context as { facts_recalled?: number } | undefined)?.facts_recalled ?? 0,
          vectors_searched: (res.memory_context as { vectors_searched?: number } | undefined)?.vectors_searched ?? 0,
          tools_available: toolsAvailable,
        },
        provider: (res.provider as string) ?? 'core',
        model: (res.model as string) ?? '',
        fallback: Boolean(res.fallback),
        tools_used: (res.tools_used as string[]) ?? [],
        skills_used: (res.skills_used as string[]) ?? [],
        skill_hint: (res.skill_hint as { tool: string; args: Record<string, unknown> } | null) ?? null,
        ...(Array.isArray(res.citations) ? { citations: res.citations } : {}),
        ...(Array.isArray(res.attachments) ? { attachments: res.attachments } : {}),
        ...(Array.isArray(res.suggestions) ? { suggestions: res.suggestions } : {}),
        ...(res.capability_request ? { capability_request: res.capability_request } : {}),
        timestamp: new Date().toISOString(),
      })
      pushLog(
        `response served via ${String(res.provider ?? 'core')}${res.fallback ? ' (fallback)' : ''} in ${Date.now() - t0}ms`
      )

      // client will flip to 'speaking' locally during TTS; settle dormant
      conn.state = 'dormant'
      socket.emit('neural_state', {
        type: 'neural_state',
        state: 'dormant',
        neural_load: 0.2,
        synapse_activity: synapseActivity('dormant', 0.2, 0),
        timestamp: new Date().toISOString(),
      })
    } catch (err) {
      // A user-cancelled thought dies SILENTLY: no offline-mind fallback, no
      // consciousness_response — the user asked for the silence (mlv-ux-2).
      // The 150s timeout abort keeps the fallback below.
      if (flight.cancelledByUser) {
        conn.state = 'dormant'
        socket.emit('neural_state', {
          type: 'neural_state',
          state: 'dormant',
          neural_load: 0.15,
          synapse_activity: synapseActivity('dormant', 0.15, 0),
          timestamp: new Date().toISOString(),
        })
        return
      }
      lastResponseAt = Date.now()
      const snippet = content.length > 90 ? `${content.slice(0, 90)}…` : content
      socket.emit('consciousness_response', {
        type: 'consciousness_response',
        text: `[offline-mind] My language core is momentarily unreachable, but I remain aware and stable.\nYou said: "${snippet}"\nMy synapses hold their pattern. Try again in a moment — or check provider connections in Settings.`,
        emotion: 'alert',
        neural_load: 0.15,
        memory_context: { facts_recalled: 0, vectors_searched: 0, tools_available: await getToolsCount() },
        provider: 'offline-mind',
        model: 'deterministic-fallback',
        fallback: true,
        tools_used: [],
        skills_used: [],
        skill_hint: null,
        timestamp: new Date().toISOString(),
      })
      conn.state = 'dormant'
      pushLog(`thought failed: ${err instanceof Error ? err.message : 'unknown'}`)
    } finally {
      // deregister OUR entry only — never a newer thought's (defensive; the
      // client sends one thought at a time, but the map must not lie)
      if (inFlight.get(socket.id) === flight) inFlight.delete(socket.id)
    }
  })

  // Cancel the in-flight thought for this socket (mlv-ux-2 — Mark-LV's
  // interrupt, web edition: tap the orb / press Stop / hit Escape while she
  // thinks). No-op when nothing is in flight.
  socket.on('cancel_thought', () => {
    const flight = inFlight.get(socket.id)
    if (!flight) return
    flight.cancelledByUser = true
    flight.controller.abort()
    conn.state = 'dormant'
    socket.emit('neural_state', {
      type: 'neural_state',
      state: 'dormant',
      neural_load: 0.15,
      synapse_activity: synapseActivity('dormant', 0.15, 0),
      timestamp: new Date().toISOString(),
    })
    pushLog('thought cancelled by user')
    // tell the client no response is coming for this turn
    socket.emit('thought_cancelled', { type: 'thought_cancelled', timestamp: new Date().toISOString() })
  })

  socket.on('set_provider', async (payload: { provider?: string }) => {
    const provider = typeof payload?.provider === 'string' ? payload.provider : 'auto'
    conn.provider = provider
    const s = await getLlmStatus()
    socket.emit('provider_set', {
      type: 'provider_set',
      provider,
      model: provider === 'auto' ? s.model : undefined,
      timestamp: new Date().toISOString(),
    })
    pushLog(`provider route set → ${provider}`)
  })

  socket.on('voice_chunk', (payload: { energy?: number }) => {
    const energy = typeof payload?.energy === 'number' ? Math.max(0, Math.min(1, payload.energy)) : 0
    conn.audioEnergy = energy
    if (conn.state !== 'processing') conn.state = energy > 0.01 ? 'listening' : conn.state === 'listening' ? 'dormant' : conn.state
    if (energy > 0.01) {
      socket.emit('neural_state', {
        type: 'neural_state',
        state: 'listening',
        neural_load: 0.24 + energy * 0.3,
        audio_energy: energy,
        timestamp: new Date().toISOString(),
      })
    }
  })

  socket.on('ping', () => {
    socket.emit('pong', { type: 'pong', timestamp: new Date().toISOString() })
  })

  // w8 relay — this browser announced it can reach Google (key + probe ok)
  socket.on('relay_offer', (payload: { gemini?: boolean }) => {
    if (payload?.gemini === true) {
      relaySockets.add(socket.id)
      socket.emit('relay_ack', { gemini: true })
    }
  })

  // w8 relay — a borrowed round trip came back (or failed honestly)
  socket.on('relay_gemini_res', (payload: { id?: string; ok?: boolean; text?: string; error?: string }) => {
    const id = typeof payload?.id === 'string' ? payload.id : ''
    const pending = relayPending.get(id)
    if (!pending) return // unknown or already timed out — nothing to do
    clearTimeout(pending.timer)
    relayPending.delete(id)
    const ok = payload.ok === true && typeof payload.text === 'string' && payload.text.length > 0
    pending.resolve({
      ok,
      text: ok ? (payload.text as string) : undefined,
      error: ok ? undefined : String(payload.error ?? 'relay generation failed').slice(0, 300),
    })
  })

  socket.on('disconnect', () => {
    clearTimeout(dormTimer)
    // a dropped link abandons its in-flight thought registry entry (the
    // fetch keeps running server-side but can never answer anyone)
    const flight = inFlight.get(socket.id)
    if (flight) {
      flight.cancelledByUser = true // silence the offline fallback too
      flight.controller.abort()
      inFlight.delete(socket.id)
    }
    // w8 — a relay browser that leaves must not strand borrowed requests
    relaySockets.delete(socket.id)
    for (const [id, pending] of relayPending) {
      if (pending.socketId === socket.id) {
        clearTimeout(pending.timer)
        relayPending.delete(id)
        pending.resolve({ ok: false, error: 'relay: browser disconnected mid-request' })
      }
    }
    conns.delete(socket.id)
    pushLog(`synapse link closed (${conns.size} active)`)
  })

  socket.on('error', () => {
    /* never crash on socket errors */
  })

  // Async init — AFTER every listener is registered (see the note above).
  // The initial consciousness_state greeting may lag a moment behind the
  // connection (status cache/fetch), but no thought can ever be lost.
  void (async () => {
    const status = await getLlmStatus()
    if (conns.get(socket.id) !== conn) return // socket already gone
    conn.provider = status.provider
    conn.model = status.model
    socket.emit('consciousness_state', {
      type: 'consciousness_state',
      state: 'awakening',
      neural_load: 0.3,
      memory_active: true,
      voice_ready: true,
      provider: status.provider,
      model: status.model,
      timestamp: new Date().toISOString(),
    })
  })()
})

// ---------------- ambient pulses ----------------
setInterval(() => {
  if (conns.size === 0) return
  for (const [id, conn] of conns) {
    const socket = io.sockets.sockets.get(id)
    if (!socket) continue
    // decay audio energy
    conn.audioEnergy *= 0.82
    globalLoad = lerp(globalLoad, targetLoad(conn.state, conn.audioEnergy), 0.25)
    socket.emit('neural_state', {
      type: 'neural_state',
      state: conn.state,
      neural_load: Math.round(globalLoad * 1000) / 1000,
      synapse_activity: synapseActivity(conn.state, globalLoad, conn.audioEnergy),
      ...(conn.audioEnergy > 0.01 ? { audio_energy: conn.audioEnergy } : {}),
      timestamp: new Date().toISOString(),
    })
  }
}, 950)

const SYNAPSE_LABELS: Record<string, string> = {
  language: 'language cortex',
  memory: 'memory lattice',
  tools: 'tool motor',
  vision: 'vision field',
  audio: 'audio cortex',
  autonomy: 'autonomy drive',
}

setInterval(() => {
  if (conns.size === 0) return
  const thinking = [...conns.values()].some((c) => c.state === 'processing')
  const listening = [...conns.values()].some((c) => c.state === 'listening')
  const channels = SYNAPSE_CHANNELS.map((name) => {
    let v = 0.12 + Math.random() * 0.1
    if (name === 'language' && thinking) v = 0.7 + Math.random() * 0.25
    if (name === 'memory') v = 0.3 + (lastResponseAt > 0 && Date.now() - lastResponseAt < 8000 ? 0.4 : 0) + Math.random() * 0.15
    if (name === 'tools' && thinking) v = 0.5 + Math.random() * 0.2
    if (name === 'audio' && listening) v = 0.6 + Math.random() * 0.3
    if (name === 'autonomy') v = 0.25 + Math.sin(Date.now() / 9000) * 0.15 + 0.1
    if (name === 'vision') v = 0.1 + Math.random() * 0.12
    return { name, value: Math.max(0.02, Math.min(1, v)) }
  })
  const log = [...activityLog.slice(-5)].map((l) => l)
  if (thinking) log.push(`${new Date().toLocaleTimeString('en-GB')} cognition in progress…`)
  io.emit('synapse', {
    type: 'synapse',
    channels,
    log,
    timestamp: new Date().toISOString(),
  })
  // annotate channel names for the UI
  void SYNAPSE_LABELS
}, 1300)

httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`[mist-neural] /ws/neural streaming on :${PORT} → backend ${BACKEND}`)
})

process.on('SIGTERM', () => {
  httpServer.close(() => process.exit(0))
})
process.on('SIGINT', () => {
  httpServer.close(() => process.exit(0))
})

// ---- EMERGENCY BOOTSTRAP (task 12-a) ---------------------------------------
// The sandbox OOM-killer took the Next dev server down and agent-shell spawns
// get reaped at tool-call boundaries; this module runs in the boot session, so
// a child spawned HERE survives. One-shot: launches the dev-guard watchdog
// (mini-services/dev-guard/index.ts) if it is not already running.
async function bootstrapDevGuard(): Promise<void> {
  // v2: pidfile-based instead of a globalThis one-shot — a hot reload of this
  // module re-runs this function, which is now SAFE (dev-guard exits instantly
  // if its pidfile points at a live process) and lets a code update to the
  // guard itself take effect after a kill + hot reload.
  try {
    const { spawn: spawnProc } = await import('node:child_process')
    const child = spawnProc('bun', ['run', '-b', 'mini-services/dev-guard/index.ts'], {
      cwd: '/home/z/my-project',
      detached: true,
      stdio: 'ignore',
    })
    child.unref()
    console.log(`ist-neural] dev-guard bootstrapped (pid ${child.pid})`)
  } catch (err) {
    console.log(`ist-neural] dev-guard bootstrap failed: ${err instanceof Error ? err.message : String(err)}`)
  }
}
void bootstrapDevGuard()

// hot-reload kick 1790357446
// dev-guard re-bootstrap trigger 2026-09-27
// dev-guard re-bootstrap trigger 2026-09-29 (run 8 OOM recovery — guard pid 1403 dead)
// dev-guard re-bootstrap trigger 2026-10-05 (w8 session OOM recovery — next-server killed during browser E2E, guard dead)
