// OpenJarvis workflow DAG port (oj-ops-3) — library-grade, no route of its own.
// Ported from openjarvis/workflow/{types,graph,engine}.py:
//   - DAG with DFS cycle validation (graph.py)
//   - stage-ordered execution (Kahn), node states pending/running/done/failed/skipped
//   - max depth 20 (honest error beyond), conditional edges, honest degradation
// Node kinds here (TS adaptation): 'tool' | 'llm' | 'approval' | 'delay'.
// 'tool' nodes resolve through registerWorkflowTools() — the executor itself
// stays pure; callers (operators, missions) inject their own tool surface.

import { getZai } from '@/lib/services/zai'
import { createApproval } from './approval-service'

export type WorkflowNodeKind = 'tool' | 'llm' | 'approval' | 'delay'
export type WorkflowNodeState = 'pending' | 'running' | 'done' | 'failed' | 'skipped'

export interface WorkflowNodeDef {
  id: string
  kind: WorkflowNodeKind
  config: Record<string, unknown>
}

export interface WorkflowEdgeDef {
  from: string
  to: string
  /** Matched against the source node's result: 'ok'/'error' special-case, else
   *  compared with result.route (object results) or the stringified result. */
  condition?: string
}

export interface WorkflowDef {
  id: string
  name: string
  nodes: WorkflowNodeDef[]
  edges: WorkflowEdgeDef[]
  createdAt: string
}

export interface WorkflowNodeResult {
  id: string
  kind: WorkflowNodeKind
  state: WorkflowNodeState
  output?: unknown
  error?: string
  durationMs: number
}

export interface WorkflowTrace {
  id: string
  name: string
  status: 'done' | 'failed' | 'error'
  inputs: Record<string, unknown>
  nodes: WorkflowNodeResult[]
  finalOutput?: unknown
  error?: string
  startedAt: string
  endedAt: string
  durationMs: number
}

export type WorkflowTool = (args: Record<string, unknown>) => Promise<unknown> | unknown

export interface DefineWorkflowInput {
  id?: string
  name?: string
  nodes: Array<{ id: string; kind: WorkflowNodeKind; config?: Record<string, unknown> }>
  edges: Array<{ from: string; to: string; condition?: string }>
}

export type DefineWorkflowResult = { ok: true; id: string } | { ok: false; error: string }

const MAX_NODES = 64
const MAX_DEPTH = 20
const MAX_TRACE_HISTORY = 50

// ---------- globalThis registry (survives per-route module compiles in dev) ----------

interface WorkflowGlobal {
  defs: Map<string, WorkflowDef>
  traces: WorkflowTrace[]
  tools: Map<string, WorkflowTool>
}
function workflowGlobal(): WorkflowGlobal {
  const g = globalThis as unknown as { __mistWorkflowRegistry?: WorkflowGlobal }
  return (g.__mistWorkflowRegistry ??= {
    defs: new Map(),
    traces: [],
    tools: new Map(),
  })
}

/** Inject the tool surface available to 'tool' nodes. Later calls override. */
export function registerWorkflowTools(tools: Record<string, WorkflowTool>): void {
  const g = workflowGlobal()
  for (const [name, fn] of Object.entries(tools)) {
    if (typeof fn === 'function') g.tools.set(name, fn)
  }
}

// ---------- validation ----------

/** DFS cycle detection — direct port of graph.py's validate(). */
function hasCycle(nodes: string[], adjacency: Map<string, string[]>): string | null {
  const visited = new Set<string>()
  const inStack = new Set<string>()
  const dfs = (id: string): string | null => {
    visited.add(id)
    inStack.add(id)
    for (const next of adjacency.get(id) ?? []) {
      if (inStack.has(next)) return next
      if (!visited.has(next)) {
        const found = dfs(next)
        if (found) return found
      }
    }
    inStack.delete(id)
    return null
  }
  for (const id of nodes) {
    if (visited.has(id)) continue
    const found = dfs(id)
    if (found) return found
  }
  return null
}

/** Kahn stages — also the execution order (deterministic, breadth-first). */
function kahnStages(nodes: string[], edges: Array<{ from: string; to: string }>): string[][] | null {
  const inDegree = new Map<string, number>(nodes.map((n) => [n, 0]))
  const adjacency = new Map<string, string[]>(nodes.map((n) => [n, [] as string[]]))
  for (const e of edges) {
    adjacency.get(e.from)?.push(e.to)
    const d = inDegree.get(e.to)
    if (typeof d === 'number') inDegree.set(e.to, d + 1)
  }
  const stages: string[][] = []
  let ready = nodes.filter((n) => (inDegree.get(n) ?? 0) === 0)
  while (ready.length) {
    stages.push([...ready].sort())
    const next: string[] = []
    for (const id of ready) {
      for (const target of adjacency.get(id) ?? []) {
        const d = (inDegree.get(target) ?? 0) - 1
        inDegree.set(target, d)
        if (d === 0) next.push(target)
      }
    }
    ready = next
  }
  if (stages.reduce((acc, s) => acc + s.length, 0) !== nodes.length) return null // cycle
  return stages
}

// ---------- template substitution ----------

/** Substitute {{inputs.x}} and {{nodes.<id>.y}} in string config values. */
function substitute(value: unknown, ctx: { inputs: Record<string, unknown>; results: Map<string, WorkflowNodeResult> }): unknown {
  if (typeof value === 'string') {
    return value.replace(/\{\{\s*(inputs|nodes)\.([a-zA-Z0-9_.-]+)\s*\}\}/g, (_m, scope: string, path: string) => {
      let base: unknown
      if (scope === 'inputs') base = ctx.inputs
      else {
        const dot = path.indexOf('.')
        if (dot === -1) return ''
        const nodeId = path.slice(0, dot)
        const res = ctx.results.get(nodeId)
        if (!res) return ''
        base = res.output
        path = path.slice(dot + 1)
        // accept both {{nodes.<id>.field}} and {{nodes.<id>.output.field}}
        if (
          path.startsWith('output.') &&
          !(base && typeof base === 'object' && 'output' in (base as Record<string, unknown>))
        ) {
          path = path.slice('output.'.length)
        }
      }
      const resolved = path.split('.').reduce<unknown>((acc, key) => {
        if (acc && typeof acc === 'object' && key in (acc as Record<string, unknown>)) {
          return (acc as Record<string, unknown>)[key]
        }
        return undefined
      }, base)
      return resolved === undefined || resolved === null ? '' : typeof resolved === 'object' ? JSON.stringify(resolved) : String(resolved)
    })
  }
  if (Array.isArray(value)) return value.map((v) => substitute(v, ctx))
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = substitute(v, ctx)
    return out
  }
  return value
}

// ---------- edge condition matching ----------

function edgeOpen(edge: WorkflowEdgeDef, source: WorkflowNodeResult | undefined): boolean {
  if (!source) return false
  const cond = (edge.condition ?? '').trim()
  if (!cond) return source.state === 'done'
  if (cond === 'ok') return source.state === 'done'
  if (cond === 'error') return source.state === 'failed'
  if (source.state !== 'done') return false
  const out = source.output
  if (out && typeof out === 'object' && !Array.isArray(out)) {
    const rec = out as Record<string, unknown>
    if ('route' in rec) return String(rec.route) === cond
    if ('ok' in rec && typeof rec.ok === 'boolean') {
      if (cond === 'true') return rec.ok === true
      if (cond === 'false') return rec.ok === false
    }
  }
  return String(out) === cond
}

// ---------- node execution ----------

async function execNode(node: WorkflowNodeDef, ctx: { inputs: Record<string, unknown>; results: Map<string, WorkflowNodeResult> }): Promise<WorkflowNodeResult> {
  const config = substitute(node.config ?? {}, ctx) as Record<string, unknown>
  const startedAt = Date.now()
  const base = { id: node.id, kind: node.kind }
  try {
    if (node.kind === 'tool') {
      const name = String(config.tool ?? '').trim()
      if (!name) return { ...base, state: 'failed', error: "tool node requires config.tool", durationMs: 0 }
      const fn = workflowGlobal().tools.get(name)
      if (!fn) {
        return {
          ...base,
          state: 'failed',
          error: `tool '${name}' has no resolver registered — call registerWorkflowTools() first`,
          durationMs: 0,
        }
      }
      const out = await fn((config.args ?? {}) as Record<string, unknown>)
      return { ...base, state: 'done', output: out, durationMs: Date.now() - startedAt }
    }
    if (node.kind === 'llm') {
      const prompt = String(config.prompt ?? '').trim()
      if (!prompt) return { ...base, state: 'failed', error: 'llm node requires config.prompt', durationMs: 0 }
      const maxTokens = Math.max(64, Math.min(4096, Number(config.maxTokens ?? 700) | 0))
      const zai = await getZai()
      const completion = await zai.chat.completions.create({
        messages: [
          ...(config.system
            ? [{ role: 'assistant' as const, content: String(config.system) }]
            : []),
          { role: 'user' as const, content: prompt },
        ],
        max_tokens: maxTokens,
        thinking: { type: 'disabled' },
      })
      const text = completion.choices[0]?.message?.content ?? ''
      if (!String(text).trim()) {
        return { ...base, state: 'failed', error: 'llm node produced no text', durationMs: Date.now() - startedAt }
      }
      return { ...base, state: 'done', output: { text: String(text).trim(), model: completion.model ?? null }, durationMs: Date.now() - startedAt }
    }
    if (node.kind === 'approval') {
      const res = await createApproval({
        actionType: String(config.actionType ?? 'tool_exec'),
        title: String(config.title ?? 'Workflow action'),
        payload: (config.payload ?? {}) as Record<string, unknown>,
        tier: config.tier === 'auto' || config.tier === 'standard' || config.tier === 'destructive' ? config.tier : undefined,
        origin: config.origin === 'operator' || config.origin === 'mission' || config.origin === 'subagent' ? config.origin : 'mist',
      })
      if (!res.ok || res.deniedByMemory) {
        // remembered denial is not a workflow failure — it is an honest skip
        return { ...base, state: 'skipped', output: res, durationMs: Date.now() - startedAt }
      }
      return { ...base, state: 'done', output: res, durationMs: Date.now() - startedAt }
    }
    if (node.kind === 'delay') {
      const ms = Math.max(0, Math.min(30_000, Number(config.ms ?? 250) | 0))
      await new Promise((resolve) => setTimeout(resolve, ms))
      return { ...base, state: 'done', output: { waitedMs: ms }, durationMs: Date.now() - startedAt }
    }
    return { ...base, state: 'failed', error: `unknown node kind '${node.kind}'`, durationMs: 0 }
  } catch (err) {
    return {
      ...base,
      state: 'failed',
      error: err instanceof Error ? err.message : `${node.kind} node failed`,
      durationMs: Date.now() - startedAt,
    }
  }
}

// ---------- define + run ----------

export function defineWorkflow(spec: DefineWorkflowInput): DefineWorkflowResult {
  const nodes = Array.isArray(spec.nodes) ? spec.nodes : []
  const edges = Array.isArray(spec.edges) ? spec.edges : []
  if (!nodes.length) return { ok: false, error: 'workflow needs at least one node' }
  if (nodes.length > MAX_NODES) return { ok: false, error: `workflow has ${nodes.length} nodes — the limit is ${MAX_NODES}` }

  const ids = nodes.map((n) => String(n?.id ?? '').trim()).filter(Boolean)
  if (ids.length !== nodes.length) return { ok: false, error: 'every node needs a non-empty id' }
  if (new Set(ids).size !== ids.length) return { ok: false, error: 'duplicate node ids are not allowed' }

  for (const kind of nodes.map((n) => n.kind)) {
    if (kind !== 'tool' && kind !== 'llm' && kind !== 'approval' && kind !== 'delay') {
      return { ok: false, error: `unknown node kind '${String(kind)}' — expected tool | llm | approval | delay` }
    }
  }
  const adjacency = new Map<string, string[]>(ids.map((id) => [id, [] as string[]]))
  for (const e of edges) {
    const from = String(e?.from ?? '').trim()
    const to = String(e?.to ?? '').trim()
    if (!ids.includes(from)) return { ok: false, error: `edge references unknown source node '${from}'` }
    if (!ids.includes(to)) return { ok: false, error: `edge references unknown target node '${to}'` }
    adjacency.get(from)?.push(to)
  }
  const cycleNode = hasCycle(ids, adjacency)
  if (cycleNode) return { ok: false, error: `cycle detected involving node '${cycleNode}'` }

  const id = String(spec.id ?? `wf_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`)
  const def: WorkflowDef = {
    id,
    name: String(spec.name ?? id).slice(0, 120),
    nodes: nodes.map((n) => ({ id: String(n.id), kind: n.kind, config: n.config ?? {} })),
    edges: edges.map((e) => ({ from: String(e.from), to: String(e.to), condition: e.condition })),
    createdAt: new Date().toISOString(),
  }
  workflowGlobal().defs.set(id, def)
  return { ok: true, id }
}

export async function runWorkflow(id: string, inputs: Record<string, unknown> = {}): Promise<WorkflowTrace> {
  const startedAt = new Date()
  const g = workflowGlobal()
  const def = g.defs.get(String(id ?? ''))
  const trace: WorkflowTrace = {
    id: String(id ?? ''),
    name: def?.name ?? String(id ?? ''),
    status: 'error',
    inputs,
    nodes: [],
    error: def ? undefined : `workflow '${id}' is not defined — call defineWorkflow() first`,
    startedAt: startedAt.toISOString(),
    endedAt: '',
    durationMs: 0,
  }
  const finish = (status: WorkflowTrace['status']): WorkflowTrace => {
    trace.status = status
    trace.endedAt = new Date().toISOString()
    trace.durationMs = Date.now() - startedAt.getTime()
    g.traces.unshift(trace)
    if (g.traces.length > MAX_TRACE_HISTORY) g.traces.length = MAX_TRACE_HISTORY
    return trace
  }
  if (!def) return finish('error')

  const stages = kahnStages(
    def.nodes.map((n) => n.id),
    def.edges.map((e) => ({ from: e.from, to: e.to }))
  )
  if (!stages) return finish('error') // defensive — defineWorkflow already validates
  if (stages.length > MAX_DEPTH) {
    trace.error = `workflow needs ${stages.length} stages — the max depth is ${MAX_DEPTH}`
    return finish('error')
  }

  const results = new Map<string, WorkflowNodeResult>()
  const incoming = new Map<string, WorkflowEdgeDef[]>(def.nodes.map((n) => [n.id, [] as WorkflowEdgeDef[]]))
  for (const e of def.edges) incoming.get(e.to)?.push(e)

  for (let depth = 0; depth < stages.length; depth++) {
    for (const nodeId of stages[depth]) {
      const node = def.nodes.find((n) => n.id === nodeId)
      if (!node) continue
      const incomingEdges = incoming.get(nodeId) ?? []
      // gate: at least one open incoming edge (nodes with no incoming edges start free)
      if (incomingEdges.length > 0) {
        const open = incomingEdges.some((e) => edgeOpen(e, results.get(e.from)))
        if (!open) {
          const result: WorkflowNodeResult = {
            id: nodeId,
            kind: node.kind,
            state: 'skipped',
            error: 'no incoming edge was satisfied',
            durationMs: 0,
          }
          results.set(nodeId, result)
          trace.nodes.push(result)
          continue
        }
      }
      const result = await execNode(node, { inputs, results })
      results.set(nodeId, result)
      trace.nodes.push(result)
      if (result.state === 'failed') {
        trace.error = `node '${nodeId}' failed: ${result.error ?? 'unknown error'}`
        // remaining nodes are honestly skipped below by the stage break
        break
      }
    }
    if (trace.error) break
  }

  // anything not yet resolved after a failure/short-circuit → skipped
  for (const n of def.nodes) {
    if (!results.has(n.id)) {
      const result: WorkflowNodeResult = { id: n.id, kind: n.kind, state: 'skipped', error: 'upstream node failed or was skipped', durationMs: 0 }
      results.set(n.id, result)
      trace.nodes.push(result)
    }
  }

  const lastDone = [...def.nodes].reverse().find((n) => results.get(n.id)?.state === 'done')
  trace.finalOutput = lastDone ? results.get(lastDone.id)?.output : undefined
  return finish(trace.error ? 'failed' : 'done')
}

/** Recent workflow traces (newest first). */
export function listWorkflowTraces(limit = 20): WorkflowTrace[] {
  return workflowGlobal().traces.slice(0, Math.max(1, Math.min(100, limit)))
}

/** All defined workflow defs (newest first by definition time not tracked — map order). */
export function listWorkflows(): WorkflowDef[] {
  return [...workflowGlobal().defs.values()]
}
