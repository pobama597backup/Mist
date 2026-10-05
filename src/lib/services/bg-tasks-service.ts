// M.I.S.T. background tasks — LONG system work without freezing the chat.
//
// Mist's tool loop is synchronous per turn: a 45-second bridge action means a
// 45-second frozen conversation. This service fixes that: startBgTask() fires
// the bridge call WITHOUT awaiting it (void promise), returns the task record
// immediately so the LLM can reply + keep bantering, and when the work lands
// the completion is delivered through the EXACT same chat path heartbeat
// reminders and guardian warnings use (raiseSystemAlert → pending Alert row →
// the client's 30s alerts poller → toast + message appended into the thread).
// The next turn (or the alert itself) reports the result.
//
// The registry lives on globalThis — one Map per server process, surviving
// Next dev hot reloads (each route compile gets a fresh module instance but
// shares the global). No persistence: tasks are ephemeral by design (capped
// at 50, finished ones pruned after an hour).

import { bridgeExec, type BridgeExecResult } from './bridge-service'
import { raiseSystemAlert } from './heartbeat-service'
import { recordActivity } from './activity-service'

export type BgTaskState = 'running' | 'done' | 'failed'

export interface BgTask {
  id: string
  label: string
  action: string
  args: Record<string, unknown>
  status: BgTaskState
  result?: unknown
  error?: string
  startedAt: number
  finishedAt?: number
}

const MAX_TASKS = 50
const FINISHED_TTL_MS = 60 * 60_000 // finished tasks live 1h for reference

/** Bridge actions allowed to run in the background — the LONG ones only.
 *  Quick actions (status, system_watch, open_settings, …) answer in seconds
 *  and belong in a direct tool call; backgrounding them would only hide their
 *  result from the current turn. Single source of truth for the LLM tool gate
 *  (tools-service imports this). */
export const LONG_ACTIONS: readonly string[] = [
  'ui_automate',
  'run_command',
  'hermes_ask',
  'hermes_status',
]

const bgGlobal = globalThis as unknown as {
  __mistBgTasks?: Map<string, BgTask>
}

/** The shared task registry (created once per server process). */
function registry(): Map<string, BgTask> {
  return (bgGlobal.__mistBgTasks ??= new Map<string, BgTask>())
}

/** Cap at MAX_TASKS + drop finished tasks older than 1h. Running tasks are
 *  never evicted — their promise still holds a reference and will finalize. */
function pruneTasks(map: Map<string, BgTask>): void {
  const now = Date.now()
  for (const [id, t] of map) {
    if (t.status !== 'running' && typeof t.finishedAt === 'number' && now - t.finishedAt > FINISHED_TTL_MS) {
      map.delete(id)
    }
  }
  if (map.size <= MAX_TASKS) return
  const finishedOldestFirst = [...map.values()]
    .filter((t) => t.status !== 'running')
    .sort((a, b) => (a.finishedAt ?? a.startedAt) - (b.finishedAt ?? b.startedAt))
  let overflow = map.size - MAX_TASKS
  for (const t of finishedOldestFirst) {
    if (overflow <= 0) break
    map.delete(t.id)
    overflow--
  }
}

/** Compact any result into ≤200 chars of single-line text for the alert body. */
function compactResult(value: unknown): string {
  let text = ''
  try {
    text = value === undefined ? '' : JSON.stringify(value)
  } catch {
    text = String(value)
  }
  text = String(text || '').replace(/\s+/g, ' ').trim()
  return text.length > 200 ? `${text.slice(0, 197)}…` : text
}

/** Mark the task done/failed and deliver the chat-visible completion message
 *  through the reminder/guardian alert path. NEVER throws into the void. */
async function finalizeTask(task: BgTask, res: BridgeExecResult): Promise<void> {
  task.finishedAt = Date.now()
  if (res.ok === true) {
    task.status = 'done'
    task.result = res.data ?? { ok: true }
    recordActivity('bg-task', `done ${task.action} — ${task.label}`)
    try {
      await raiseSystemAlert(`✅ Task complete — ${task.label}`, compactResult(task.result), {
        source: 'bg-task',
        task_id: task.id,
        action: task.action,
      })
    } catch {
      // the alert is best-effort — the task record is still queryable
    }
  } else {
    task.status = 'failed'
    // Some bridge actions fail as {ok:false, ...fields} with no error string
    // (e.g. run_command's exit code + stderr) — compose an honest message.
    let message = typeof res.error === 'string' && res.error ? res.error : ''
    if (!message) {
      const data = res.data as Record<string, unknown> | null | undefined
      const bits: string[] = []
      if (data && typeof data === 'object') {
        if (typeof data.code === 'number') bits.push(`exit code ${data.code}`)
        if (typeof data.stderr === 'string' && data.stderr.trim()) bits.push(data.stderr.trim().slice(0, 150))
        if (typeof data.stdout === 'string' && data.stdout.trim()) bits.push(data.stdout.trim().slice(0, 150))
      }
      message = bits.join(' — ') || 'the action reported failure without details'
    }
    task.error = message
    recordActivity('bg-task', `failed ${task.action} — ${task.label}: ${task.error}`)
    try {
      await raiseSystemAlert(`⚠️ Task failed — ${task.label}`, task.error.slice(0, 300), {
        source: 'bg-task',
        task_id: task.id,
        action: task.action,
      })
    } catch {
      // best-effort
    }
  }
}

/**
 * Start a LONG bridge action in the background. Validates the action against
 * the LONG_ACTIONS allowlist, registers the task, fires the call WITHOUT
 * awaiting (the conversation never blocks on it), and returns the running task
 * record immediately. Completion (or failure) lands in the chat as an alert.
 */
export function startBgTask(
  action: string,
  args: Record<string, unknown>,
  label: string
): BgTask {
  const act = String(action ?? '').trim()
  if (!LONG_ACTIONS.includes(act)) {
    throw new Error(
      `run_in_background is for LONG actions only (${LONG_ACTIONS.join(', ')}) — "${
        act || '(missing)'
      }" is either quick (run it direct) or not a bridge action`
    )
  }
  const safeArgs =
    args && typeof args === 'object' && !Array.isArray(args) ? args : {}
  const task: BgTask = {
    id: `bg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    label: String(label ?? '').trim().slice(0, 120) || act,
    action: act,
    args: safeArgs,
    status: 'running',
    startedAt: Date.now(),
  }
  const map = registry()
  map.set(task.id, task)
  pruneTasks(map)
  recordActivity('bg-task', `started ${act} — ${task.label}`)
  // fire-and-forget: this promise resolves long after the reply was sent
  void bridgeExec(act, safeArgs)
    .then((res) => finalizeTask(task, res))
    .catch((err: unknown) =>
      finalizeTask(task, {
        ok: false,
        error: err instanceof Error ? err.message : 'background task crashed',
        bridgeConnected: true,
      })
    )
  return task
}

/** One task by id (throws when unknown), or every task newest-first. */
export function bgTaskStatus(id?: string): BgTask | BgTask[] {
  const map = registry()
  pruneTasks(map)
  const wanted = typeof id === 'string' ? id.trim() : ''
  if (wanted) {
    const task = map.get(wanted)
    if (!task) throw new Error(`no background task with id ${wanted}`)
    return task
  }
  return [...map.values()].sort((a, b) => b.startedAt - a.startedAt)
}
