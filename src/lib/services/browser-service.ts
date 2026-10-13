// M.I.S.T. browser service — server-side proxy to the Browser Pilot mini-service (:3030).
// Gives MIST real browser computer-use: navigate, click, type, screenshot, extract.
// All calls are try/catch-wrapped so a downed pilot NEVER crashes the brain.
//
// Phase 2-d: the pilot is v2.0 — every task endpoint requires the machine
// Bearer token (same ~/.mist/bridge.json scheme as the bridge daemon), every
// command rides a per-task incognito context, and the pilot's HONEST refusal
// errors (SSRF refusals, scheme blocks) surface verbatim to the LLM instead
// of being rewritten into a generic "unavailable" line. The current task id
// threads through consecutive commands so one computer-use chain shares one
// incognito context; the pilot's reaper force-closes it at the task cap.

import { getMistSecrets } from '@/lib/perimeter/shared'

const PILOT_URL = process.env.BROWSER_PILOT_URL ?? 'http://127.0.0.1:3030'
const ACTION_TIMEOUT_MS = 45_000
const PROBE_TTL_MS = 30_000

export interface PilotElements {
  ref: number
  tag: string
  role: string
  text: string
  x: number
  y: number
  w: number
  h: number
}

export interface PilotStatus {
  available: boolean
  page_open: boolean
  current_url: string | null
  title: string | null
  /** pilot v2.0 fields (absent on a downed/legacy pilot) */
  version?: string
  contexts?: number
}

interface Cache<T> {
  value: T
  at: number
}
let availableCache: Cache<boolean> | null = null

/** The live pilot task this app-side chain is riding. Sequential browser
 * commands (navigate → elements → click → type …) share ONE incognito
 * context; the pilot returns the current taskId on every response and
 * transparently hands out a fresh context when this one is reaped/closed. */
let currentTask: { id: string; at: number } | null = null

function withTaskId(body: Record<string, unknown>): Record<string, unknown> {
  return currentTask ? { ...body, taskId: currentTask.id } : body
}

/** Remember the pilot's live task id from a response (best-effort). */
function noteTaskId(data: { taskId?: unknown }): void {
  if (typeof data.taskId === 'string' && data.taskId) {
    if (!currentTask || currentTask.id !== data.taskId) currentTask = { id: data.taskId, at: Date.now() }
    else currentTask.at = Date.now()
  }
}

async function pilotFetch<T>(path: string, body?: unknown): Promise<T> {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), ACTION_TIMEOUT_MS)
  try {
    const res = await fetch(`${PILOT_URL}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers:
        body === undefined
          ? { Authorization: `Bearer ${getMistSecrets().bridgeToken}` }
          : { 'Content-Type': 'application/json', Authorization: `Bearer ${getMistSecrets().bridgeToken}` },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ac.signal,
      cache: 'no-store',
    })
    if (!res.ok) {
      // the pilot's refusals are HONEST strings ("refused: …") — surface them
      // verbatim instead of collapsing them into a generic HTTP error
      let detail = ''
      try {
        const parsed = (await res.json()) as { error?: unknown }
        if (typeof parsed.error === 'string') detail = parsed.error
      } catch {
        /* no body — fall back to the status line */
      }
      throw new Error(detail || `pilot HTTP ${res.status}`)
    }
    const data = (await res.json()) as T
    noteTaskId(data as { taskId?: unknown })
    return data
  } finally {
    clearTimeout(timer)
  }
}

/** Cheap availability probe, cached 30s (prevents retry storms while the pilot is down). */
export async function pilotAvailable(): Promise<boolean> {
  if (availableCache && Date.now() - availableCache.at < PROBE_TTL_MS) return availableCache.value
  let ok = false
  try {
    const h = await pilotFetch<{ status?: string }>('/health')
    ok = h?.status === 'ok'
  } catch {
    ok = false
  }
  availableCache = { value: ok, at: Date.now() }
  return ok
}

async function guarded<T>(action: () => Promise<T>): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  try {
    return { ok: true, data: await action() }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown pilot error'
    // pilot refusal strings pass through VERBATIM (they explain themselves);
    // connectivity failures get the honest start-it hint
    if (msg.startsWith('refused:') || msg.startsWith('unauthorized')) return { ok: false, error: msg }
    return { ok: false, error: `Browser Pilot unavailable (${msg}). Start it with: mini-services/browser-pilot → bun run dev` }
  }
}

// ---------- pilot actions ----------

export function pilotNavigate(url: string) {
  return guarded(() => pilotFetch<{ ok: boolean; url: string; title: string }>('/navigate', withTaskId({ url })))
}

export function pilotClick(args: { ref?: number; x?: number; y?: number; selector?: string }) {
  return guarded(() =>
    pilotFetch<{ ok: boolean; clicked: string; url: string; title: string }>('/click', withTaskId(args)),
  )
}

export function pilotType(args: { text: string; ref?: number; selector?: string; submit?: boolean }) {
  return guarded(() => pilotFetch<{ ok: boolean; url: string; title: string }>('/type', withTaskId(args)))
}

export function pilotKey(key: string) {
  return guarded(() => pilotFetch<{ ok: boolean }>('/key', withTaskId({ key })))
}

export function pilotScroll(direction: 'up' | 'down', amount?: number) {
  return guarded(() => pilotFetch<{ ok: boolean }>('/scroll', withTaskId({ direction, amount })))
}

export function pilotScreenshot() {
  return guarded(() =>
    pilotFetch<{ ok: boolean; image: string; url: string; title: string; width: number; height: number }>(
      '/screenshot',
      withTaskId({}),
    ),
  )
}

export function pilotElements() {
  return guarded(() =>
    pilotFetch<{ ok: boolean; url: string; title: string; elements: PilotElements[] }>('/elements', withTaskId({})),
  )
}

export function pilotExtract() {
  return guarded(() => pilotFetch<{ ok: boolean; url: string; title: string; text: string }>('/extract', withTaskId({})))
}

export function pilotReset() {
  return guarded(() => pilotFetch<{ ok: boolean; closed: number }>('/reset', withTaskId({})))
}

/** Explicit task end — closes the current incognito context (the pilot's
 * reaper force-closes at the task cap when nobody calls this). */
export function pilotTaskClose() {
  return guarded(() => pilotFetch<{ ok: boolean; closed: number }>('/task/close', withTaskId({})))
}

export async function pilotStatus(): Promise<PilotStatus> {
  const available = await pilotAvailable()
  if (!available) return { available: false, page_open: false, current_url: null, title: null }
  try {
    const h = await pilotFetch<{
      status: string
      contexts: number
      version?: string
      browser_up?: boolean
    }>('/health')
    // no shared page in v2.0 — "page_open" honestly reflects live task contexts
    return {
      available: true,
      page_open: h.contexts > 0,
      current_url: null,
      title: null,
      version: h.version,
      contexts: h.contexts,
    }
  } catch {
    return { available: false, page_open: false, current_url: null, title: null }
  }
}
