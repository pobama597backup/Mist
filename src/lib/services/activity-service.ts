// M.I.S.T. activity log — module-level rolling log + last-LLM-activity tracker
// Feeds the /api/mist/synapse/stream SSE endpoint with alive telemetry.
//
// The state lives on globalThis (same guard pattern as the scheduler and
// evolution watch): Next dev hot-reloads route modules, and a module-scoped
// array would FORK on every reload — the synapse stream would then read a
// stale copy while reloaded routes write to a fresh one (lost telemetry).

const MAX_LINES = 60

interface ActivityState {
  lines: string[]
  lastLlmActivity: number
}

const g = globalThis as unknown as { __mistActivity?: ActivityState }
const state: ActivityState = (g.__mistActivity ??= {
  lines: [],
  lastLlmActivity: 0,
})

function stamp(): string {
  return new Date().toISOString().slice(11, 19)
}

export function recordActivity(kind: string, detail: string): void {
  state.lines.push(`[${stamp()}] ${kind}: ${detail}`)
  if (state.lines.length > MAX_LINES) state.lines.splice(0, state.lines.length - MAX_LINES)
}

/** Mark that a unified LLM call just happened (boosts the 'language' synapse channel). */
export function markLlmActivity(): void {
  state.lastLlmActivity = Date.now()
}

export function getLastLlmActivity(): number {
  return state.lastLlmActivity
}

/** True when a unified LLM call happened within the given window (ms). */
export function llmActiveWithin(windowMs = 8000): boolean {
  return state.lastLlmActivity > 0 && Date.now() - state.lastLlmActivity < windowMs
}

export function recentActivityLog(n = 5): string[] {
  return state.lines.slice(-n)
}

// Boot seed so the synapse stream never renders an empty mind (guarded —
// hot reloads must not re-seed and push the real history out)
if (state.lines.length === 0) {
  recordActivity('system', 'M.I.S.T. UNIFIED backend online — sovereign core initialized')
  recordActivity('memory', 'vector + long-term memory stores mounted')
}
