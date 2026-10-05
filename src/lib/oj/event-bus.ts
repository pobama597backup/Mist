// M.I.S.T. × OpenJarvis — typed pub/sub event bus (port of
// openjarvis/core/events.py @ 5e5f5ef, oj-spine-1).
//
// OpenJarvis wires its five primitives (Intelligence / Engine / Agents /
// Memory / Learning) through one thread-safe EventBus: any primitive can emit
// (INFERENCE_END, TOOL_CALL_END, …) and any other can react without direct
// coupling. Observers are isolated — a broken subscriber neither interrupts
// the publisher nor starves later subscribers.
//
// TS port: one bus per PROCESS, stored on globalThis (Next dev compiles each
// route into its own module registry — a plain module-level singleton would
// give one bus per route; globalThis guarantees a single shared bus).
// Subscriber callbacks are wrapped in try/catch and never awaited (sync
// dispatch, mirroring the Python synchronous publish).

export type OjEventName =
  | 'trace_started'
  | 'trace_step'
  | 'trace_completed'
  | 'tool_call'
  | 'tool_result'
  | 'llm_call'
  | 'llm_result'
  | 'guardrail_trip'
  | 'approval_requested'
  | 'loop_guard_trip'
  | 'complexity_routed'

/** Payload shapes per event — consumers get full type-safety on `data`. */
export interface OjEventPayloads {
  trace_started: {
    traceId: string
    query: string
    agent: string
    tier: string
    complexity: number
    tokenBudget: number
    meta?: Record<string, unknown>
  }
  trace_step: {
    traceId: string
    idx: number
    type: 'route' | 'retrieve' | 'generate' | 'tool_call' | 'respond'
    name: string
    ok: boolean
    durationMs: number
    tokens?: number
  }
  trace_completed: {
    traceId: string
    agent: string
    outcome: 'success' | 'failure' | 'degraded' | 'blocked' | 'running'
    model: string | null
    provider: string | null
    latencyMs: number
    tokensIn: number
    tokensOut: number
  }
  tool_call: {
    tool: string
    args: Record<string, unknown>
    traceId?: string
  }
  tool_result: {
    tool: string
    ok: boolean
    durationMs: number
    error?: string | null
    errorCategory?: string
    traceId?: string
  }
  llm_call: {
    provider: string
    model?: string | null
    traceId?: string
  }
  llm_result: {
    provider: string
    model: string | null
    ok: boolean
    durationMs: number
    latencyMs?: number
    tokensIn?: number
    tokensOut?: number
    error?: string | null
    errorCategory?: string
    traceId?: string
  }
  guardrail_trip: {
    kind: 'ssrf' | 'injection' | 'capability'
    detail: string
    tool?: string
    url?: string
    severity?: 'low' | 'medium' | 'high' | 'critical'
    traceId?: string
  }
  approval_requested: {
    actionType: string
    fingerprint: string
    tier: string
    origin: string
  }
  loop_guard_trip: {
    reasonType:
      | 'identical_call'
      | 'ping_pong'
      | 'poll_budget'
      | 'max_turns'
      | 'token_budget'
      | 'wall_clock'
    tool?: string
    detail: string
    traceId?: string
  }
  complexity_routed: {
    query: string
    score: number
    tier: string
    tokenBudget: number
    lane: string
    signals: Record<string, unknown>
  }
}

export interface OjEvent<N extends OjEventName = OjEventName> {
  type: N
  timestamp: number
  data: OjEventPayloads[N]
}

export type OjSubscriber<N extends OjEventName> = (event: OjEvent<N>) => void

/** Fan-in subscriber: receives every event on the bus. */
export type OjWildcardSubscriber = (event: OjEvent) => void

class EventBus {
  private subscribers = new Map<OjEventName, Set<OjSubscriber<OjEventName>>>()
  private wildcard = new Set<OjWildcardSubscriber>()

  on<N extends OjEventName>(type: N, callback: OjSubscriber<N>): this {
    let set = this.subscribers.get(type)
    if (!set) {
      set = new Set()
      this.subscribers.set(type, set)
    }
    set.add(callback as OjSubscriber<OjEventName>)
    return this
  }

  once<N extends OjEventName>(type: N, callback: OjSubscriber<N>): this {
    const wrap: OjSubscriber<N> = (event) => {
      this.off(type, wrap)
      callback(event)
    }
    return this.on(type, wrap)
  }

  off<N extends OjEventName>(type: N, callback: OjSubscriber<N>): void {
    this.subscribers.get(type)?.delete(callback as OjSubscriber<OjEventName>)
  }

  onAny(callback: OjWildcardSubscriber): this {
    this.wildcard.add(callback)
    return this
  }

  offAny(callback: OjWildcardSubscriber): void {
    this.wildcard.delete(callback)
  }

  emit<N extends OjEventName>(type: N, data: OjEventPayloads[N]): OjEvent<N> {
    const event: OjEvent<N> = { type, timestamp: Date.now(), data }
    // snapshot under iteration safety: subscribers may unsubscribe mid-dispatch
    const typed = Array.from(this.subscribers.get(type) ?? [])
    for (const cb of typed) {
      try {
        cb(event as OjEvent<OjEventName>)
      } catch (err) {
        // One broken observer must neither interrupt the publisher nor starve
        // later subscribers (openjarvis/core/events.py publish()).
        console.warn(
          `[oj-bus] subscriber failed on ${type}:`,
          err instanceof Error ? err.message : err
        )
      }
    }
    for (const cb of Array.from(this.wildcard)) {
      try {
        cb(event as OjEvent)
      } catch (err) {
        console.warn(
          `[oj-bus] wildcard subscriber failed on ${type}:`,
          err instanceof Error ? err.message : err
        )
      }
    }
    return event
  }

  listenerCount(type?: OjEventName): number {
    if (type) return this.subscribers.get(type)?.size ?? 0
    let n = this.wildcard.size
    for (const set of this.subscribers.values()) n += set.size
    return n
  }
}

// ---------- process-wide singleton (globalThis-guarded) ----------

const busGlobal = globalThis as unknown as { __mistOjEventBus?: EventBus }

/** The one event bus per process (port of openjarvis get_event_bus()). */
export function getEventBus(): EventBus {
  if (!busGlobal.__mistOjEventBus) {
    busGlobal.__mistOjEventBus = new EventBus()
  }
  return busGlobal.__mistOjEventBus
}

/** Test/inspection helper — replaces the singleton with a fresh instance. */
export function resetEventBus(): EventBus {
  busGlobal.__mistOjEventBus = new EventBus()
  return busGlobal.__mistOjEventBus
}

/** Convenience handle to the process bus (same instance as getEventBus()). */
export const bus: EventBus = getEventBus()

// cache-buster: force turbopack to re-read this module (oj-spine-1)
