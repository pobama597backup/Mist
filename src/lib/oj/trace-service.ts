// M.I.S.T. × OpenJarvis — trace service (port of openjarvis/traces/store.py +
// collector.py + analyzer.py @ 5e5f5ef, oj-spine-1).
//
// The trace store is the LEARNING SUBSTRATE of OpenJarvis: every chat turn,
// mission, operator tick and tool loop lands as typed steps (route / retrieve
// / generate / tool_call / respond) with per-step input+output, tokens and
// latency — so the Traces viewer, efficiency analytics, learned routing and
// skill optimization all read from ONE table instead of ad-hoc logging.
//
// M.I.S.T. port: persists to the frozen Prisma models Trace + TraceStep and
// emits trace_started / trace_step / trace_completed on the event bus.
// Ambient-trace correlation uses AsyncLocalStorage — every executeTool /
// cascadeComplete invoked INSIDE a trace scope appends to that trace without
// any plumbing through call signatures.
//
// HONESTY RULES (mirrors OpenJarvis's telemetry discipline):
//   - token counts are ESTIMATES (chars/4, the OpenJarvis fallback when a lane
//     reports no usage) and marked as such in trace meta — never presented as
//     gateway-reported numbers
//   - a trace failure NEVER breaks the completion it observes: every public
//     path is self-guarded, errors are logged and swallowed
//   - outcome vocabulary: success | failure | degraded (offline-mind or
//     fallback served) | blocked (guardrail) | running (in-flight)

import { AsyncLocalStorage } from 'node:async_hooks'
import { db } from '@/lib/db'
import { bus } from './event-bus'

export type TraceOutcome = 'success' | 'failure' | 'degraded' | 'blocked' | 'running'
export type TraceStepType = 'route' | 'retrieve' | 'generate' | 'tool_call' | 'respond'

const INPUT_CAP = 4096 // per-step input/output persisted (bytes of JSON)
const OUTPUT_CAP = 4096
const RESULT_CAP = 4096

/** Chars/4 token estimate — OpenJarvis's fallback when lanes report no usage. */
export function estimateTokens(text: string): number {
  if (!text) return 0
  return Math.ceil(text.length / 4)
}

function truncateForStore(value: string, cap: number): string {
  if (value.length <= cap) return value
  return `${value.slice(0, cap)}…[truncated ${value.length - cap} chars]`
}

function safeJson(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value ?? {})
  } catch {
    try {
      return JSON.stringify(String(value))
    } catch {
      return '{}'
    }
  }
}

// ---------- honest cost table ----------
//
// ASSUMPTIONS (documented, deliberate):
//   - `core` is the free z-ai-web-dev-sdk lane: $0 by definition.
//   - keyless lanes (kilo, pollinations, llm7, ovh) and curated free lanes
//     (hermes, theoldapi, github_models free tier, huggingface, nvidia NIM
//     free endpoints) cost the creator $0 in this sandbox — priced at $0.
//   - keyed BYO-key lanes (openrouter, anthropic, gemini, groq, …) are priced
//     at public list prices for the model class that lane typically serves.
//     These are EQUIVALENT-COST ESTIMATES for the efficiency dashboard, not
//     invoices: the lane's real cost depends on the model it served, which
//     the trace records (see trace.model) but this per-provider table
//     approximates at provider granularity.
//   - offline-mind is deterministic local code: $0.
const PRICE_PER_MTOK: Record<string, { in: number; out: number }> = {
  core: { in: 0, out: 0 },
  'offline-mind': { in: 0, out: 0 },
  kilo: { in: 0, out: 0 },
  pollinations: { in: 0, out: 0 },
  llm7: { in: 0, out: 0 },
  ovh: { in: 0, out: 0 },
  hermes: { in: 0, out: 0 },
  theoldapi: { in: 0, out: 0 },
  nvidia: { in: 0, out: 0 },
  github_models: { in: 0, out: 0 },
  huggingface: { in: 0, out: 0 },
  omniroute: { in: 0, out: 0 }, // self-hosted curated gateway
  openai_compatible: { in: 0.5, out: 1.5 },
  openrouter: { in: 0.3, out: 0.9 },
  qwen: { in: 0.5, out: 1.5 },
  groq: { in: 0.05, out: 0.1 },
  cerebras: { in: 0.1, out: 0.3 },
  together: { in: 0.2, out: 0.6 },
  mistral: { in: 0.5, out: 1.5 },
  anthropic: { in: 3, out: 15 },
  gemini: { in: 1.25, out: 5 },
}

/** Estimated equivalent cost in USD for a provider's token usage. */
export function estimateCostUsd(provider: string | null | undefined, tokensIn: number, tokensOut: number): number {
  const price = PRICE_PER_MTOK[provider ?? ''] ?? { in: 0, out: 0 }
  return (tokensIn / 1_000_000) * price.in + (tokensOut / 1_000_000) * price.out
}

// ---------- ambient trace scope (AsyncLocalStorage) ----------

export interface TraceHandle {
  readonly id: string
  readonly agent: string
  readonly startedAtMs: number
  addStep(step: Omit<TraceStepInput, 'idx'>): void
  complete(info: CompleteInfo): Promise<void>
}

export interface TraceStepInput {
  idx: number
  type: TraceStepType
  name: string
  ok: boolean
  durationMs: number
  tokens?: number
  input?: unknown
  output?: unknown
  meta?: Record<string, unknown>
}

export interface CompleteInfo {
  outcome: Exclude<TraceOutcome, 'running'>
  result?: string
  model?: string | null
  provider?: string | null
  tokensIn?: number
  tokensOut?: number
  feedback?: number
  meta?: Record<string, unknown>
}

const traceAls = new AsyncLocalStorage<TraceHandle>()

/** The trace wrapping the current async context, if any. */
export function ambientTrace(): TraceHandle | undefined {
  return traceAls.getStore()
}

/** Run `fn` with `handle` as the ambient trace (steps auto-attach to it). */
export async function runWithTrace<T>(handle: TraceHandle, fn: () => Promise<T>): Promise<T> {
  return traceAls.run(handle, fn)
}

// ---------- start / step / complete ----------

export interface StartTraceOptions {
  query: string
  agent: string // chat | mission | operator | subagent | research | voice | digest
  model?: string | null
  provider?: string | null
  tier?: string
  complexity?: number
  tokenBudget?: number
  meta?: Record<string, unknown>
}

/**
 * Open a trace: persists the Trace row (outcome=running) first, then returns
 * the handle (so every step persists — no lost early steps). NEVER throws —
 * on DB failure a no-op handle is returned so the observed completion
 * proceeds untouched.
 */
export async function startTrace(opts: StartTraceOptions): Promise<TraceHandle> {
  const startedAtMs = Date.now()
  const query = String(opts.query ?? '').slice(0, 2000)
  const metaJson = safeJson({ ...(opts.meta ?? {}), tokenBasis: 'chars/4-estimate' })
  let id = ''
  try {
    const row = await db.trace.create({
      data: {
        query,
        agent: opts.agent,
        model: opts.model ?? null,
        provider: opts.provider ?? null,
        outcome: 'running',
        tier: opts.tier ?? '',
        complexity: opts.complexity ?? 0,
        tokenBudget: opts.tokenBudget ?? 0,
        meta: metaJson,
      },
    })
    id = row.id
  } catch (err) {
    console.warn('[oj-trace] startTrace persist failed:', err instanceof Error ? err.message : err)
  }

  let stepIdx = 0
  let tokensIn = 0
  let tokensOut = 0
  let completed = false

  const handle: TraceHandle = {
    get id() {
      return id
    },
    get agent() {
      return opts.agent
    },
    get startedAtMs() {
      return startedAtMs
    },
    addStep(step) {
      const idx = stepIdx++
      if (typeof step.tokens === 'number' && step.tokens > 0) {
        // generate steps report prompt+completion split via meta; tool steps
        // report a single consumption number counted as output-side estimate
        tokensIn += Number(step.meta?.tokensIn ?? 0)
        tokensOut += Number(step.meta?.tokensOut ?? step.tokens ?? 0)
      }
      // emit on the bus even if the DB write fails — telemetry first
      try {
        bus.emit('trace_step', {
          traceId: id || '(pending)',
          idx,
          type: step.type,
          name: step.name,
          ok: step.ok,
          durationMs: step.durationMs,
          tokens: step.tokens ?? 0,
        })
      } catch {
        /* bus is already crash-safe */
      }
      if (!id) {
        // row creation failed — steps stay bus-visible but unpersisted
        return
      }
      void db.traceStep
        .create({
          data: {
            traceId: id,
            idx,
            type: step.type,
            name: String(step.name ?? '').slice(0, 200),
            input: truncateForStore(safeJson(step.input), INPUT_CAP),
            output: truncateForStore(safeJson(step.output), OUTPUT_CAP),
            ok: step.ok !== false,
            durationMs: Math.max(0, Math.round(step.durationMs ?? 0)),
            tokens: Math.max(0, Math.round(step.tokens ?? 0)),
            meta: truncateForStore(safeJson(step.meta ?? {}), INPUT_CAP),
          },
        })
        .catch((err) => console.warn('[oj-trace] step persist failed:', err instanceof Error ? err.message : err))
    },
    async complete(info) {
      if (completed) return
      completed = true
      const latencyMs = Date.now() - startedAtMs
      try {
        bus.emit('trace_completed', {
          traceId: id || '(pending)',
          agent: opts.agent,
          outcome: info.outcome,
          model: info.model ?? opts.model ?? null,
          provider: info.provider ?? opts.provider ?? null,
          latencyMs,
          tokensIn: info.tokensIn ?? tokensIn,
          tokensOut: info.tokensOut ?? tokensOut,
        })
      } catch {
        /* ignore */
      }
      if (!id) return
      try {
        await db.trace.update({
          where: { id },
          data: {
            outcome: info.outcome,
            result: truncateForStore(String(info.result ?? ''), RESULT_CAP),
            model: info.model ?? opts.model ?? null,
            provider: info.provider ?? opts.provider ?? null,
            tokensIn: Math.round(info.tokensIn ?? tokensIn),
            tokensOut: Math.round(info.tokensOut ?? tokensOut),
            latencyMs,
            costUsd: estimateCostUsd(
              info.provider ?? opts.provider ?? null,
              info.tokensIn ?? tokensIn,
              info.tokensOut ?? tokensOut
            ),
            feedback: typeof info.feedback === 'number' ? info.feedback : null,
            endedAt: new Date(),
            meta: safeJson({ ...(opts.meta ?? {}), ...(info.meta ?? {}), tokenBasis: 'chars/4-estimate' }),
          },
        })
      } catch (err) {
        console.warn('[oj-trace] complete failed:', err instanceof Error ? err.message : err)
      }
    },
  }

  try {
    bus.emit('trace_started', {
      traceId: id || '(pending)',
      query: query.slice(0, 300),
      agent: opts.agent,
      tier: opts.tier ?? '',
      complexity: opts.complexity ?? 0,
      tokenBudget: opts.tokenBudget ?? 0,
      meta: opts.meta,
    })
  } catch {
    /* ignore */
  }
  return handle
}

// ---------- spine helpers (used by tools-service / llm-service) ----------

/**
 * Record a tool step on the AMBIENT trace (if any). Called by executeTool —
 * outside a trace scope this is a no-op (the bus event still fired there).
 */
export function appendToolStep(info: {
  tool: string
  ok: boolean
  durationMs: number
  args?: Record<string, unknown>
  output?: unknown
  error?: string | null
  errorCategory?: string
  tokens?: number
}): void {
  const trace = ambientTrace()
  if (!trace) return
  trace.addStep({
    type: 'tool_call',
    name: info.tool,
    ok: info.ok,
    durationMs: info.durationMs,
    tokens: info.tokens,
    input: { tool: info.tool, args: info.args ?? {} },
    output: info.ok
      ? { output: info.output }
      : { error: info.error ?? 'tool failed', category: info.errorCategory ?? 'unknown' },
    meta: info.errorCategory ? { errorCategory: info.errorCategory } : {},
  })
}

/**
 * Record a generate step (one provider attempt) on the ambient trace.
 * Returns nothing; never throws.
 */
export function appendGenerateStep(info: {
  provider: string
  model?: string | null
  ok: boolean
  durationMs: number
  tokensIn?: number
  tokensOut?: number
  error?: string | null
  errorCategory?: string
  attempt?: number
  traceId?: string
}): void {
  const trace = ambientTrace()
  const tokens = (info.tokensIn ?? 0) + (info.tokensOut ?? 0)
  try {
    bus.emit('llm_result', {
      provider: info.provider,
      model: info.model ?? null,
      ok: info.ok,
      durationMs: info.durationMs,
      tokensIn: info.tokensIn ?? 0,
      tokensOut: info.tokensOut ?? 0,
      error: info.error ?? null,
      errorCategory: info.errorCategory,
      traceId: info.traceId ?? trace?.id,
    })
  } catch {
    /* ignore */
  }
  if (!trace) return
  trace.addStep({
    type: 'generate',
    name: info.provider,
    ok: info.ok,
    durationMs: info.durationMs,
    tokens,
    input: { provider: info.provider, model: info.model ?? null, attempt: info.attempt ?? 0 },
    output: info.ok
      ? { tokensIn: info.tokensIn ?? 0, tokensOut: info.tokensOut ?? 0, model: info.model ?? null }
      : { error: info.error ?? 'lane failed', category: info.errorCategory ?? 'unknown' },
    meta: { tokensIn: info.tokensIn ?? 0, tokensOut: info.tokensOut ?? 0 },
  })
}

/** Emit an llm_call event for the start of a provider attempt. */
export function noteLlmCall(provider: string, model?: string | null): void {
  try {
    bus.emit('llm_call', { provider, model: model ?? null, traceId: ambientTrace()?.id })
  } catch {
    /* ignore */
  }
}

// ---------- queries (routes + future learning loops) ----------

export interface TraceListFilter {
  agent?: string
  outcome?: string
  limit?: number
  offset?: number
}

export interface TraceListItem {
  id: string
  query: string
  agent: string
  model: string | null
  provider: string | null
  outcome: string
  tier: string
  complexity: number
  tokensIn: number
  tokensOut: number
  latencyMs: number
  steps: number
  createdAt: string
}

export async function listTraces(filter: TraceListFilter = {}): Promise<TraceListItem[]> {
  const limit = Math.max(1, Math.min(500, Math.round(Number(filter.limit ?? 50) || 50)))
  const offset = Math.max(0, Math.round(Number(filter.offset ?? 0) || 0))
  const where: Record<string, string> = {}
  if (filter.agent) where.agent = filter.agent
  if (filter.outcome) where.outcome = filter.outcome
  try {
    const rows = await db.trace.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: limit,
      skip: offset,
      include: { _count: { select: { steps: true } } },
    })
    return rows.map((r) => ({
      id: r.id,
      query: r.query,
      agent: r.agent,
      model: r.model,
      provider: r.provider,
      outcome: r.outcome,
      tier: r.tier,
      complexity: r.complexity,
      tokensIn: r.tokensIn,
      tokensOut: r.tokensOut,
      latencyMs: r.latencyMs,
      steps: r._count.steps,
      createdAt: r.createdAt.toISOString(),
    }))
  } catch (err) {
    console.warn('[oj-trace] listTraces failed:', err instanceof Error ? err.message : err)
    return []
  }
}

export interface FullTraceStep {
  idx: number
  type: string
  name: string
  ok: boolean
  durationMs: number
  tokens: number
  input: string
  output: string
  meta: string
  createdAt: string
}

export interface FullTrace {
  id: string
  query: string
  agent: string
  model: string | null
  provider: string | null
  result: string
  outcome: string
  feedback: number | null
  tokensIn: number
  tokensOut: number
  latencyMs: number
  costUsd: number
  complexity: number
  tier: string
  tokenBudget: number
  meta: Record<string, unknown>
  startedAt: string
  endedAt: string | null
  createdAt: string
  steps: FullTraceStep[]
}

export async function getTrace(id: string): Promise<FullTrace | null> {
  try {
    const row = await db.trace.findUnique({
      where: { id },
      include: { steps: { orderBy: { idx: 'asc' } } },
    })
    if (!row) return null
    let meta: Record<string, unknown> = {}
    try {
      meta = JSON.parse(row.meta) as Record<string, unknown>
    } catch {
      meta = {}
    }
    return {
      id: row.id,
      query: row.query,
      agent: row.agent,
      model: row.model,
      provider: row.provider,
      result: row.result,
      outcome: row.outcome,
      feedback: row.feedback,
      tokensIn: row.tokensIn,
      tokensOut: row.tokensOut,
      latencyMs: row.latencyMs,
      costUsd: row.costUsd,
      complexity: row.complexity,
      tier: row.tier,
      tokenBudget: row.tokenBudget,
      meta,
      startedAt: row.startedAt.toISOString(),
      endedAt: row.endedAt ? row.endedAt.toISOString() : null,
      createdAt: row.createdAt.toISOString(),
      steps: row.steps.map((s) => ({
        idx: s.idx,
        type: s.type,
        name: s.name,
        ok: s.ok,
        durationMs: s.durationMs,
        tokens: s.tokens,
        input: s.input,
        output: s.output,
        meta: s.meta,
        createdAt: s.createdAt.toISOString(),
      })),
    }
  } catch (err) {
    console.warn('[oj-trace] getTrace failed:', err instanceof Error ? err.message : err)
    return null
  }
}

// ---------- efficiency analytics (port of traces/analyzer.py) ----------

export interface ProviderBuckets {
  provider: string
  requests: number
  tokensIn: number
  tokensOut: number
  avgLatencyMs: number
  costUsd: number
}

export interface AgentBuckets extends ProviderBuckets {
  agent: string
}

export interface DayBuckets {
  day: string
  requests: number
  tokens: number
}

export interface EfficiencyAnalytics {
  totals: {
    requests: number
    tokensIn: number
    tokensOut: number
    avgLatencyMs: number
    costUsd: number
  }
  perProvider: ProviderBuckets[]
  perAgent: AgentBuckets[]
  perDay: DayBuckets[]
}

/**
 * Aggregate the trace store into efficiency analytics. All numbers derive
 * from recorded traces only — where a lane reported no usage, tokens are
 * chars/4 ESTIMATES (marked in each trace's meta). Cost uses the honest
 * per-provider price table (core + keyless lanes = $0 real spend).
 */
export async function efficiencyAnalytics(): Promise<EfficiencyAnalytics> {
  try {
    const rows = await db.trace.findMany({
      // last 90 days, bounded so aggregation stays cheap
      where: { createdAt: { gte: new Date(Date.now() - 90 * 24 * 3600 * 1000) } },
      select: {
        provider: true,
        agent: true,
        tokensIn: true,
        tokensOut: true,
        latencyMs: true,
        createdAt: true,
      },
      take: 20_000,
      orderBy: { createdAt: 'asc' },
    })
    let requests = 0
    let tokensIn = 0
    let tokensOut = 0
    let latencySum = 0
    let cost = 0
    const byProvider = new Map<string, ProviderBuckets>()
    const byAgent = new Map<string, AgentBuckets>()
    const byDay = new Map<string, DayBuckets>()

    for (const r of rows) {
      requests++
      tokensIn += r.tokensIn
      tokensOut += r.tokensOut
      latencySum += r.latencyMs
      const rowCost = estimateCostUsd(r.provider, r.tokensIn, r.tokensOut)
      cost += rowCost

      const pKey = r.provider ?? 'unknown'
      const p = byProvider.get(pKey) ?? {
        provider: pKey,
        requests: 0,
        tokensIn: 0,
        tokensOut: 0,
        avgLatencyMs: 0,
        costUsd: 0,
      }
      p.requests++
      p.tokensIn += r.tokensIn
      p.tokensOut += r.tokensOut
      p.avgLatencyMs += r.latencyMs
      p.costUsd += rowCost
      byProvider.set(pKey, p)

      const a = byAgent.get(r.agent) ?? {
        agent: r.agent,
        provider: r.agent,
        requests: 0,
        tokensIn: 0,
        tokensOut: 0,
        avgLatencyMs: 0,
        costUsd: 0,
      }
      a.requests++
      a.tokensIn += r.tokensIn
      a.tokensOut += r.tokensOut
      a.avgLatencyMs += r.latencyMs
      a.costUsd += rowCost
      byAgent.set(r.agent, a)

      const day = r.createdAt.toISOString().slice(0, 10)
      const d = byDay.get(day) ?? { day, requests: 0, tokens: 0 }
      d.requests++
      d.tokens += r.tokensIn + r.tokensOut
      byDay.set(day, d)
    }

    const finalize = <T extends { requests: number; avgLatencyMs: number }>(b: T): T => ({
      ...b,
      avgLatencyMs: b.requests > 0 ? Math.round(b.avgLatencyMs / b.requests) : 0,
    })

    return {
      totals: {
        requests,
        tokensIn,
        tokensOut,
        avgLatencyMs: requests > 0 ? Math.round(latencySum / requests) : 0,
        costUsd: Math.round(cost * 1e6) / 1e6,
      },
      perProvider: Array.from(byProvider.values()).map(finalize).sort((a, b) => b.requests - a.requests),
      perAgent: Array.from(byAgent.values()).map(finalize).sort((a, b) => b.requests - a.requests),
      perDay: Array.from(byDay.values()).sort((a, b) => a.day.localeCompare(b.day)),
    }
  } catch (err) {
    console.warn('[oj-trace] efficiencyAnalytics failed:', err instanceof Error ? err.message : err)
    return {
      totals: { requests: 0, tokensIn: 0, tokensOut: 0, avgLatencyMs: 0, costUsd: 0 },
      perProvider: [],
      perAgent: [],
      perDay: [],
    }
  }
}

/**
 * Reap traces stuck `running` for over an hour (process restarts mid-trace).
 * Honest cleanup: marks them failure with a reaped marker. Returns the count.
 */
export async function reapStaleTraces(): Promise<number> {
  try {
    const res = await db.trace.updateMany({
      where: { outcome: 'running', createdAt: { lt: new Date(Date.now() - 3600_000) } },
      data: { outcome: 'failure', endedAt: new Date(), result: '[reaped: trace never completed — process restarted]' },
    })
    return res.count
  } catch {
    return 0
  }
}
