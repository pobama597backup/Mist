// M.I.S.T. bridge service — talks to the user's own Mist Bridge daemon
// (db/bridge/mist-bridge.js, downloadable from /api/mist/bridge/download).
//
// The bridge is a zero-dependency Node.js process the OWNER runs on their own
// machine; it exposes /health + /exec on 127.0.0.1. It is the trust boundary:
// the user launched it, so system-control actions routed through it are
// authorized by definition. This service NEVER throws — every failure comes
// back as a structured result so tools/routes/LLM loops can act on it.
//
// - getBridgeUrl(): env read at CALL time (MIST_BRIDGE_URL, default
//   http://127.0.0.1:8734) so set_url applies without a server restart.
// - getBridgeStatus(force?): GET /health, 2500ms AbortController timeout,
//   cached on globalThis for 30s (Next dev gives each route its own module
//   registry — globalThis keeps one shared cache per server).
// - bridgeExec(action, args): POST /exec, 20s timeout (60s for run_command);
//   disconnected → {ok:false, error:'bridge-disconnected', bridgeConnected:false}.

export interface BridgeStatus {
  connected: boolean
  url: string
  version?: string
  platform?: string
  hostname?: string
  checkedAt: number
}

export interface BridgeExecResult {
  ok: boolean
  data?: unknown
  error?: string
  bridgeConnected: boolean
}

export const BRIDGE_ACTIONS = [
  'status',
  'system_info',
  'list_apps',
  'open_app',
  'open_url',
  'run_command',
  'list_dir',
  'read_file',
  'write_file',
  // v3.3 — full file operations on the owner's machine
  'move_file',
  'copy_file',
  'delete_file',
  'make_dir',
  // v3.4 — mission-grade file intelligence: stat (dates/sizes for date-based
  // filtering), recursive search (pattern + ext + date + size filters),
  // zip/unzip (PowerShell Compress-Archive on Windows, tar.gz elsewhere)
  'stat_path',
  'search_files',
  'zip_files',
  'unzip_file',
  // v2 — companion agent stack
  'companions',
  'hermes_status',
  'hermes_ask',
  'hermes_sessions',
  'hermes_memory',
  'hermes_skills',
  'hermes_cron',
  'signal_setup',
  'signal_emit',
  'signal_status',
  // v3 — local offline voice (whisper.cpp STT + piper TTS on the owner's PC)
  'voice_status',
  'voice_setup',
  'voice_stt',
  'voice_tts',
  // v3.1 — proactive machine guardian (full health snapshot of the owner's PC)
  'system_watch',
  // v3.2 — native Windows UI automation (Settings, metered connection, …)
  'ui_automate',
] as const

export type BridgeAction = (typeof BRIDGE_ACTIONS)[number]

/** Bridge base URL — runtime override (globalThis) → env → default. */
export function getBridgeUrl(): string {
  return bridgeGlobal().__mistBridgeUrl || process.env.MIST_BRIDGE_URL || 'http://127.0.0.1:8734'
}

/** Persist a runtime bridge URL override (Settings → Local Bridge). Also
 *  mirrors to process.env so freshly-spawned workers see it within this
 *  process's lifetime; .env persistence (route) covers restarts. */
export function setBridgeUrl(url: string): void {
  bridgeGlobal().__mistBridgeUrl = url
  try {
    process.env.MIST_BRIDGE_URL = url
  } catch {
    /* best effort */
  }
}

// ---------- shared status cache (globalThis, 30s) ----------

interface BridgeCacheGlobal {
  __mistBridgeStatus?: { value: BridgeStatus; at: number }
  /** Runtime URL override — survives across requests in the same server
   *  process (process.env writes are NOT durable in Turbopack dev: each
   *  request can get a fresh module instance with the compile-time env). */
  __mistBridgeUrl?: string
}

const STATUS_TTL_MS = 30_000

function bridgeGlobal(): BridgeCacheGlobal {
  return globalThis as unknown as BridgeCacheGlobal
}

/** Probe the bridge daemon. NEVER throws — always returns a BridgeStatus. */
export async function getBridgeStatus(force = false): Promise<BridgeStatus> {
  const url = getBridgeUrl()
  const g = bridgeGlobal()
  if (!force && g.__mistBridgeStatus && Date.now() - g.__mistBridgeStatus.at < STATUS_TTL_MS) {
    // a cached entry for a different URL is stale for routing purposes
    if (g.__mistBridgeStatus.value.url === url) return g.__mistBridgeStatus.value
  }
  const status = await probeOnce(url)
  g.__mistBridgeStatus = { value: status, at: Date.now() }
  return status
}

async function probeOnce(url: string): Promise<BridgeStatus> {
  const base: BridgeStatus = { connected: false, url, checkedAt: Date.now() }
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), 2500)
  try {
    const res = await fetch(`${url.replace(/\/+$/, '')}/health`, {
      signal: ac.signal,
      cache: 'no-store',
      headers: { Accept: 'application/json' },
    })
    if (!res.ok) return base
    const body = (await res.json().catch(() => null)) as Record<string, unknown> | null
    if (!body || typeof body !== 'object') return base
    return {
      connected: true,
      url,
      version: typeof body.version === 'string' ? body.version : undefined,
      platform: typeof body.platform === 'string' ? body.platform : undefined,
      hostname: typeof body.hostname === 'string' ? body.hostname : undefined,
      checkedAt: Date.now(),
    }
  } catch {
    return base
  } finally {
    clearTimeout(timer)
  }
}

// ---------- exec ----------

/** Per-action timeout overrides (ms) — long-running agent work gets room. */
const ACTION_TIMEOUT_MS: Record<string, number> = {
  run_command: 60_000,
  hermes_ask: 150_000,
  hermes_sessions: 40_000,
  hermes_cron: 60_000,
  hermes_status: 30_000,
  companions: 45_000,
  // voice: engine installs download ~25-85MB per piece, whisper transcribes
  // on the user's own (possibly very weak) CPU, piper synthesizes in seconds
  voice_setup: 600_000,
  voice_stt: 120_000,
  voice_tts: 60_000,
  voice_status: 15_000,
  // v3.6 engine reuse — discover probes up to ~10 candidate pythons at 12s
  // each (sequential, spawn-fail fast when absent), so give it real headroom
  voice_discover: 180_000,
  voice_adopt: 20_000,
  voice_voices: 20_000,
  voice_select: 20_000,
  // system_watch: 8 individually timeout-capped probes, several of them
  // spawning PowerShell on the user's machine (cold start can be slow)
  system_watch: 45_000,
  // ui_automate: open_settings is fire-and-forget (instant, like open_url);
  // the walk commands (inspect/find/set_toggle/click) run under a 30s
  // bridge-side psQuery hard timeout with internal 20-22s stopwatch caps +
  // cold PowerShell start — give headroom. The slow sub-commands are meant
  // to run through run_in_background anyway.
  ui_automate: 40_000,
  // v3.4 — file intelligence + archives. search walks a tree recursively
  // (stat-per-match — slow on big folders); zip/unzip shells out to
  // PowerShell Compress-Archive on Windows / tar elsewhere.
  search_files: 60_000,
  zip_files: 120_000,
  unzip_file: 120_000,
  stat_path: 15_000,
}

/**
 * Run an action on the user's machine through the bridge. NEVER throws.
 * Unknown/failed/daemon-down all come back as structured BridgeExecResult.
 */
export async function bridgeExec(
  action: string,
  args: Record<string, unknown> = {}
): Promise<BridgeExecResult> {
  const url = getBridgeUrl().replace(/\/+$/, '')
  const timeoutMs = ACTION_TIMEOUT_MS[action] ?? 20_000
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  try {
    const res = await fetch(`${url}/exec`, {
      method: 'POST',
      signal: ac.signal,
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ action, args }),
    })
    if (!res.ok) {
      const errBody = (await res.json().catch(() => null)) as { error?: unknown } | null
      const error =
        errBody && typeof errBody.error === 'string' ? errBody.error : `bridge responded ${res.status}`
      return { ok: false, error, bridgeConnected: true }
    }
    const body = (await res.json().catch(() => null)) as Record<string, unknown> | null
    if (!body || typeof body !== 'object') {
      return { ok: false, error: 'bridge returned an unreadable response', bridgeConnected: true }
    }
    // The daemon answers {ok, ...actionFields} — surface the action fields as
    // `data` (apps, stdout, suggestion, …) so tools and the LLM can act on them.
    const { ok, error, ...rest } = body
    return {
      ok: ok === true,
      ...(Object.keys(rest).length > 0 ? { data: rest } : {}),
      ...(typeof error === 'string' ? { error } : {}),
      bridgeConnected: true,
    }
  } catch {
    return { ok: false, error: 'bridge-disconnected', bridgeConnected: false }
  } finally {
    clearTimeout(timer)
  }
}
