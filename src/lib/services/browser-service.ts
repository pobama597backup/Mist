// M.I.S.T. browser service — server-side proxy to the Browser Pilot mini-service (:3030).
// Gives MIST real browser computer-use: navigate, click, type, screenshot, extract.
// All calls are try/catch-wrapped so a downed pilot NEVER crashes the brain.

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
}

interface Cache<T> {
  value: T
  at: number
}
let availableCache: Cache<boolean> | null = null

async function pilotFetch<T>(path: string, body?: unknown): Promise<T> {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), ACTION_TIMEOUT_MS)
  try {
    const res = await fetch(`${PILOT_URL}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ac.signal,
      cache: 'no-store',
    })
    if (!res.ok) throw new Error(`pilot HTTP ${res.status}`)
    return (await res.json()) as T
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
    return { ok: false, error: `Browser Pilot unavailable (${msg}). Start it with: mini-services/browser-pilot → bun run dev` }
  }
}

// ---------- pilot actions ----------

export function pilotNavigate(url: string) {
  return guarded(() => pilotFetch<{ ok: boolean; url: string; title: string }>('/navigate', { url }))
}

export function pilotClick(args: { ref?: number; x?: number; y?: number; selector?: string }) {
  return guarded(() => pilotFetch<{ ok: boolean; clicked: string; url: string; title: string }>('/click', args))
}

export function pilotType(args: { text: string; ref?: number; selector?: string; submit?: boolean }) {
  return guarded(() => pilotFetch<{ ok: boolean; url: string; title: string }>('/type', args))
}

export function pilotKey(key: string) {
  return guarded(() => pilotFetch<{ ok: boolean }>('/key', { key }))
}

export function pilotScroll(direction: 'up' | 'down', amount?: number) {
  return guarded(() => pilotFetch<{ ok: boolean }>('/scroll', { direction, amount }))
}

export function pilotScreenshot() {
  return guarded(() =>
    pilotFetch<{ ok: boolean; image: string; url: string; title: string; width: number; height: number }>('/screenshot', {})
  )
}

export function pilotElements() {
  return guarded(() => pilotFetch<{ ok: boolean; url: string; title: string; elements: PilotElements[] }>('/elements', {}))
}

export function pilotExtract() {
  return guarded(() => pilotFetch<{ ok: boolean; url: string; title: string; text: string }>('/extract', {}))
}

export function pilotReset() {
  return guarded(() => pilotFetch<{ ok: boolean }>('/reset', {}))
}

export async function pilotStatus(): Promise<PilotStatus> {
  const available = await pilotAvailable()
  if (!available) return { available: false, page_open: false, current_url: null, title: null }
  try {
    const h = await pilotFetch<{ status: string; page_open: boolean; current_url: string | null; title: string | null }>('/health')
    return { available: true, page_open: h.page_open, current_url: h.current_url, title: h.title }
  } catch {
    return { available: false, page_open: false, current_url: null, title: null }
  }
}
