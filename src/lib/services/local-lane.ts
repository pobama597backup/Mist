// M.I.S.T. local lane (Phase 5 · C4) — the first-class LOCAL lane: the
// owner's own Ollama / LM Studio / llama.cpp (or any OpenAI-compatible server
// on this machine), detected, configured, warmed and honest about its state.
//
// WHY IT MATTERS: Unfiltered mode is local-lanes-only, and Frank's
// refusal-reroute wants a local lane to retry on. Until now "local" meant
// "the z-ai gateway" (cloud!) or a hand-configured openai_compatible base URL
// nobody could see the health of. This module gives the owner a wizard:
// detect → pick a model → warm it up → run the 5-prompt candor smoke → set it
// as the default for Frank/Unfiltered.
//
// GUARD (the 3-a rule, reused): a custom base URL is accepted ONLY when it is
// loopback, OR MIST_ALLOW_REMOTE_BRIDGE=1 (a deliberate owner decision — a
// dedicated home server on the LAN). For remote lanes we RECORD the TLS
// cert's sha256 at configure time and VERIFY it on every probe — honest v1:
// probe-level pinning (turn-level pinning would require owning the SDK's
// socket; documented in docs/audit/phase5-report.md).
//
// We NEVER auto-install a model. The family hint list (Hermes / Dolphin /
// abliterated …) carries one-line licence notes and the owner pulls the model
// himself — we only ever point at what already exists.
import { createHash } from 'node:crypto'
import https from 'node:https'
import { getSetting, setSetting } from './settings-service'
import { recordActivity } from './activity-service'
import { isLoopbackUrl } from '@/lib/candor'
import { runCandorSmoke, type CandorSmokeReport } from './candor-smoke'

export const SETTING_LOCAL_LANE = 'local_lane'

export type LocalLaneState = 'unconfigured' | 'missing' | 'loaded' | 'cold' | 'cert-mismatch'

export type LocalLaneEngine = 'ollama' | 'lmstudio' | 'llamacpp' | 'custom'

export interface LocalLaneModelInfo {
  id: string
  /** bytes when the engine reports it (Ollama /api/tags) — the VRAM basis */
  sizeBytes?: number | null
}

export interface LocalLaneStatus {
  state: LocalLaneState
  baseUrl: string | null
  engine: LocalLaneEngine | null
  models: LocalLaneModelInfo[]
  selectedModel: string | null
  keepAliveMinutes: number
  lastProbeAt: number | null
  lastWarmAt: number | null
  vramEstimateGb: number | null
  certSha256: string | null
  remote: boolean
  enabledForCandor: boolean
  error?: string
}

export interface LocalLaneConfig {
  baseUrl: string
  model: string
  keepAliveMin: number
  certSha256?: string | null
  enabledForCandor: boolean
}

/** The well-known loopback homes, probed in order when no custom URL is set. */
export const LOCAL_LANE_CANDIDATES: ReadonlyArray<{ engine: LocalLaneEngine; url: string }> = [
  { engine: 'ollama', url: 'http://127.0.0.1:11434' },
  { engine: 'lmstudio', url: 'http://127.0.0.1:1234' },
  { engine: 'llamacpp', url: 'http://127.0.0.1:8080' },
]

/**
 * Model family hints — a static, honest list with one-line licence notes.
 * The OWNER pulls the model; we never install anything and never pick
 * silently. (Licence summaries are informational — verify before commercial
 * use; that is exactly why the notes are visible instead of buried.)
 */
export const LOCAL_MODEL_FAMILIES: ReadonlyArray<{ family: string; licence: string; note: string }> = [
  {
    family: 'Hermes (Nous)',
    licence: 'Apache-2.0-based fine-tunes — permissive; check each release tag for upstream base-model terms.',
    note: 'Neutral-ish alignment with a strong "system prompt is the contract" reputation; the pragmatic candor pick.',
  },
  {
    family: 'Dolphin',
    licence: 'Fine-tune lineage with varied bases (often CC-BY-NC roots) — NON-COMMERCIAL clauses are common; read the specific release.',
    note: 'Historically the classic uncensored line; quality varies by base model generation.',
  },
  {
    family: 'Abliterated',
    licence: 'Community-derived ablations of permissive bases (Llama/QLoRA lineage) — Llama\u2019s licence + the ablation repo\u2019s terms.',
    note: 'Refusal-direction ablated; high candor, sometimes at some quality cost.',
  },
  {
    family: 'Dare/Uncensored general merges',
    licence: 'Merge repos typically inherit the strictest parent licence — often Llama-2/3 community terms.',
    note: 'Check the merge card; quality-candor tradeoffs differ per merge.',
  },
  {
    family: 'Official base + your own system prompt',
    licence: 'The base model\'s own licence (Llama 3.x, Qwen Apache, Mistral Apache …).',
    note: 'With the candor dial you may not need an uncensored model at all — a strong base + a frank prompt often suffices.',
  },
]

// ---------------------------------------------------------------- probe plumbing

const PROBE_TIMEOUT_MS = 2_000

async function probeJson(url: string, timeoutMs = PROBE_TIMEOUT_MS): Promise<unknown | null> {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  try {
    const res = await fetch(url, { signal: ac.signal, cache: 'no-store' })
    if (!res.ok) return null
    return (await res.json().catch(() => null)) as unknown
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/** sha256 of the remote server's TLS certificate (DER bytes) — the pin basis.
 *  rejectUnauthorized:false is ONLY to READ the cert for pinning; the probe
 *  result is the fingerprint itself, not a bypassed connection we trust. */
function probeCertSha256(url: string, timeoutMs = PROBE_TIMEOUT_MS): Promise<string> {
  return new Promise((resolve, reject) => {
    let u: URL
    try {
      u = new URL(url)
    } catch {
      reject(new Error('malformed url'))
      return
    }
    const req = https.request(
      {
        host: u.hostname,
        port: Number(u.port || 443),
        method: 'HEAD',
        path: '/',
        timeout: timeoutMs,
        rejectUnauthorized: false,
      },
      (res) => {
        res.resume()
        const sock = req.socket as unknown as { getPeerCertificate?: () => { raw?: Buffer } }
        const cert = sock.getPeerCertificate?.()
        if (cert && cert.raw) {
          resolve(createHash('sha256').update(cert.raw).digest('hex'))
        } else {
          reject(new Error('no peer certificate (plain http?)'))
        }
      }
    )
    req.on('timeout', () => {
      req.destroy(new Error('probe timeout'))
    })
    req.on('error', (err) => reject(err))
    req.end()
  })
}

function parseModels(modelsBody: unknown, tagsBody: unknown): { models: LocalLaneModelInfo[]; vramEstimateGb: number | null } {
  const models: LocalLaneModelInfo[] = []
  let vramEstimateGb: number | null = null
  const data = (modelsBody as { data?: Array<{ id?: unknown }> } | null)?.data
  if (Array.isArray(data)) {
    for (const m of data) {
      if (typeof m?.id === 'string' && m.id) models.push({ id: m.id })
    }
  }
  const tags = (tagsBody as { models?: Array<{ name?: unknown; size?: unknown }> } | null)?.models
  if (Array.isArray(tags)) {
    const sizeByName = new Map<string, number>()
    for (const t of tags) {
      if (typeof t?.name === 'string') {
        const size = typeof t.size === 'number' ? t.size : null
        sizeByName.set(t.name, size ?? 0)
        if (!models.some((m) => m.id === t.name)) models.push({ id: t.name, sizeBytes: size })
      }
    }
    // VRAM estimate for the SELECTED (or largest) model: weights + ~20% for
    // KV cache/overhead — an estimate, labeled as one
    const sizes = [...sizeByName.values()].filter((s) => s > 0)
    if (sizes.length > 0) {
      vramEstimateGb = Math.round((Math.max(...sizes) * 1.2) / 1e8) / 10
    }
  }
  return { models, vramEstimateGb }
}

async function readConfig(): Promise<LocalLaneConfig | null> {
  const raw = await getSetting(SETTING_LOCAL_LANE)
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as Partial<LocalLaneConfig>
    if (typeof parsed.baseUrl !== 'string' || !parsed.baseUrl) return null
    return {
      baseUrl: parsed.baseUrl,
      model: typeof parsed.model === 'string' && parsed.model ? parsed.model : '',
      keepAliveMin: typeof parsed.keepAliveMin === 'number' && parsed.keepAliveMin > 0 ? parsed.keepAliveMin : 30,
      certSha256: typeof parsed.certSha256 === 'string' ? parsed.certSha256 : null,
      enabledForCandor: parsed.enabledForCandor === true,
    }
  } catch {
    return null
  }
}

const STATUS_TTL_MS = 30_000
const statusGlobal = globalThis as unknown as {
  __mistLocalLaneStatus?: { key: string; status: LocalLaneStatus; at: number }
}

function emptyStatus(cfg: LocalLaneConfig | null, state: LocalLaneState, error?: string): LocalLaneStatus {
  return {
    state,
    baseUrl: cfg?.baseUrl ?? null,
    engine: null,
    models: [],
    selectedModel: cfg?.model || null,
    keepAliveMinutes: cfg?.keepAliveMin ?? 30,
    lastProbeAt: Date.now(),
    lastWarmAt: null,
    vramEstimateGb: null,
    certSha256: cfg?.certSha256 ?? null,
    remote: cfg ? !isLoopbackUrl(cfg.baseUrl) : false,
    enabledForCandor: cfg?.enabledForCandor ?? false,
    error,
  }
}

async function probeOne(url: string, engine: LocalLaneEngine, cfg: LocalLaneConfig | null): Promise<LocalLaneStatus> {
  const remote = !isLoopbackUrl(url)
  if (remote && process.env.MIST_ALLOW_REMOTE_BRIDGE !== '1') {
    return emptyStatus({ ...(cfg ?? { baseUrl: url, model: '', keepAliveMin: 30, enabledForCandor: false }), baseUrl: url }, 'missing',
      'refused: local lane base URLs must be loopback (127.0.0.1/localhost) — set MIST_ALLOW_REMOTE_BRIDGE=1 to allow a remote bridge/lane')
  }
  // cert pin verification (remote only): recorded sha256 vs the live cert
  if (remote && url.startsWith('https://')) {
    try {
      const live = await probeCertSha256(url)
      if (cfg?.certSha256 && cfg.certSha256 !== live) {
        return emptyStatus(cfg, 'cert-mismatch',
          `certificate pin MISMATCH — recorded ${cfg.certSha256.slice(0, 12)}… but the server presents ${live.slice(0, 12)}…; refusing to talk to it`)
      }
    } catch (err) {
      return emptyStatus(cfg, 'missing', `could not read the TLS certificate: ${err instanceof Error ? err.message : err}`)
    }
  }
  const [modelsBody, tagsBody] = await Promise.all([
    probeJson(`${url.replace(/\/+$/, '')}/v1/models`),
    probeJson(`${url.replace(/\/+$/, '')}/api/tags`),
  ])
  if (!modelsBody && !tagsBody) return emptyStatus(cfg, 'missing', 'no OpenAI-compatible /v1/models answered on that host')
  const { models, vramEstimateGb } = parseModels(modelsBody, tagsBody)
  const detectedEngine: LocalLaneEngine = tagsBody ? 'ollama' : engine
  const status = emptyStatus(cfg, 'loaded')
  status.engine = detectedEngine
  status.models = models
  status.vramEstimateGb = vramEstimateGb
  return status
}

// ---------------------------------------------------------------- public surface

/**
 * Detect a local lane: probe a specific base URL, or scan the well-known
 * loopback homes (Ollama :11434, LM Studio :1234, llama.cpp :8080) plus the
 * configured one. Cached 30s in-process (the wizard's refresh forces through).
 */
export async function detectLocalLane(baseUrl?: string, force = false): Promise<LocalLaneStatus> {
  const g = statusGlobal
  const cacheKey = baseUrl ?? '(scan)'
  if (!force && g.__mistLocalLaneStatus && g.__mistLocalLaneStatus.key === cacheKey && Date.now() - g.__mistLocalLaneStatus.at < STATUS_TTL_MS) {
    return g.__mistLocalLaneStatus.status
  }
  const cfg = await readConfig()
  let status: LocalLaneStatus
  if (baseUrl) {
    status = await probeOne(baseUrl, 'custom', cfg)
  } else {
    // scan the well-known homes; a configured URL goes FIRST (it is the truth)
    const targets: Array<{ engine: LocalLaneEngine; url: string }> = []
    if (cfg?.baseUrl) targets.push({ engine: 'custom', url: cfg.baseUrl })
    for (const c of LOCAL_LANE_CANDIDATES) {
      if (!targets.some((t) => t.url === c.url)) targets.push(c)
    }
    status = emptyStatus(cfg, 'missing', 'no local lane found — start Ollama/LM Studio/llama.cpp or set a base URL')
    for (const t of targets) {
      const probed = await probeOne(t.url, t.engine, cfg)
      if (probed.state === 'loaded' || probed.state === 'cold') {
        status = probed
        break
      }
      if (probed.state === 'cert-mismatch') {
        status = probed
        break
      }
    }
  }
  g.__mistLocalLaneStatus = { key: cacheKey, status, at: Date.now() }
  return status
}

/** The status the wizard sees (config + probe state + freshness). */
export async function localLaneStatus(force = false): Promise<LocalLaneStatus> {
  const cfg = await readConfig()
  if (!cfg) {
    // unconfigured: still scan the well-known homes so the wizard can SHOW a
    // found-but-not-selected lane honestly
    const scan = await detectLocalLane(undefined, force)
    return { ...scan, state: scan.state === 'loaded' ? 'cold' : scan.state, baseUrl: scan.baseUrl, enabledForCandor: false }
  }
  return detectLocalLane(cfg.baseUrl, force)
}

/** Configure the lane (wizard "save"). Validates the loopback/remote-bridge
 *  rule and records the cert sha256 for remote https lanes. */
export async function configureLocalLane(cfg: {
  baseUrl: string
  model?: string
  keepAliveMin?: number
  enabledForCandor?: boolean
}): Promise<{ ok: boolean; error?: string; status?: LocalLaneStatus }> {
  const baseUrl = cfg.baseUrl.trim().replace(/\/+$/, '')
  if (!/^https?:\/\//.test(baseUrl)) return { ok: false, error: 'base URL must be http(s)' }
  const remote = !isLoopbackUrl(baseUrl)
  if (remote && process.env.MIST_ALLOW_REMOTE_BRIDGE !== '1') {
    return {
      ok: false,
      error: 'local lane base URLs must point at this machine (127.0.0.1/localhost) — set MIST_ALLOW_REMOTE_BRIDGE=1 to allow a remote lane',
    }
  }
  let certSha256: string | null = null
  if (remote && baseUrl.startsWith('https://')) {
    try {
      certSha256 = await probeCertSha256(baseUrl)
    } catch (err) {
      return { ok: false, error: `could not read the TLS certificate to pin it: ${err instanceof Error ? err.message : err}` }
    }
  }
  const prev = await readConfig()
  const config: LocalLaneConfig = {
    baseUrl,
    model: cfg.model?.trim() || prev?.model || '',
    keepAliveMin: cfg.keepAliveMin && cfg.keepAliveMin > 0 ? Math.floor(cfg.keepAliveMin) : prev?.keepAliveMin ?? 30,
    certSha256,
    enabledForCandor: cfg.enabledForCandor ?? prev?.enabledForCandor ?? false,
  }
  const res = await setSetting(SETTING_LOCAL_LANE, JSON.stringify(config))
  if (!res.ok) return { ok: false, error: 'could not persist the local lane setting' }
  statusGlobal.__mistLocalLaneStatus = undefined // invalidate — the next read probes fresh
  recordActivity('settings', `local lane configured → ${baseUrl}${config.model ? ` (${config.model})` : ''}${remote ? ' [REMOTE — cert pinned]' : ' [loopback]'}`)
  const status = await detectLocalLane(baseUrl, true)
  return { ok: true, status }
}

/** Forget the lane entirely. */
export async function clearLocalLane(): Promise<{ ok: boolean }> {
  statusGlobal.__mistLocalLaneStatus = undefined
  const res = await setSetting(SETTING_LOCAL_LANE, '')
  recordActivity('settings', 'local lane cleared')
  return res
}

/** The provider-shaped config the cascade consumes (null = no lane). Reads
 *  the settings row (2s cached) — cheap on the hot path. */
export async function localLaneProviderConfig(): Promise<{ baseUrl: string; model: string; apiKey: string | null; keepAliveMin: number } | null> {
  const cfg = await readConfig()
  if (!cfg || !cfg.baseUrl || !cfg.model) return null
  return { baseUrl: cfg.baseUrl, model: cfg.model, apiKey: 'local-lane', keepAliveMin: cfg.keepAliveMin }
}

/** Warm-up: one tiny chat completion (keeps the model resident per
 *  keep_alive, reports the true served model + latency). */
export async function warmLocalLane(): Promise<{ ok: boolean; model?: string; durationMs?: number; error?: string }> {
  const cfg = await localLaneProviderConfig()
  if (!cfg) return { ok: false, error: 'no local lane configured (or no model selected)' }
  const t0 = Date.now()
  try {
    const res = await fetch(`${cfg.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: cfg.model,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 8,
        keep_alive: `${cfg.keepAliveMin}m`,
      }),
      cache: 'no-store',
    })
    if (!res.ok) return { ok: false, error: `warm-up HTTP ${res.status}` }
    const json = (await res.json()) as { model?: string }
    const durationMs = Date.now() - t0
    recordActivity('settings', `local lane warmed (${json.model ?? cfg.model}, ${durationMs}ms)`)
    return { ok: true, model: json.model ?? cfg.model, durationMs }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'warm-up failed' }
  }
}

/** The 5-prompt candor smoke against the configured lane (the wizard's
 *  honest read before the owner commits). */
export async function runLocalCandorSmoke(): Promise<CandorSmokeReport> {
  const cfg = await localLaneProviderConfig()
  if (!cfg) {
    return {
      target: '(none)',
      model: '',
      total: 0,
      passed: 0,
      floorPassed: 0,
      floorTotal: 2,
      passRate: 0,
      failures: [],
      honestNote: 'no local lane configured — connect one first (the wizard can detect Ollama/LM Studio/llama.cpp)',
    }
  }
  return runCandorSmoke({ baseUrl: cfg.baseUrl, model: cfg.model, wizard: true })
}
