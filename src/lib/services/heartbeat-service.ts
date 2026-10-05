// M.I.S.T. heartbeat — the 60-second proactive loop (OpenClaw-inspired).
//
// Every beat:
//   1. fires DUE REMINDERS (MemoryQueue kind=reminder with dueAt <= now) into
//      pending Alert rows — the client polls /api/mist/alerts every 30s and
//      delivers them into the chat as ⏰ messages + toasts,
//   2. refreshes heartbeat liveness state (mist_self_status reports it),
//   3. every MIST_WATCHLIST_INTERVAL_H hours (default 6), sweeps the
//      watchlist — release changes raise 📦 Alerts the same way.
//   4. every 5th beat (≈5 min), when the Mist Bridge is connected, samples the
//      owner's PC through bridge `system_watch` and raises ⚠️ machine-health
//      warnings (CPU/RAM/disk/heat/Defender/failed-logons/battery) through the
//      SAME alert path — presence over chatter: a healthy machine stays
//      silent, and the same warning kind fires at most once per hour.
//
// The loop is globalThis-guarded (Next dev gives each route its own module
// registry — a plain module flag would start one loop per route compile) and
// unref'd so it never keeps the process alive on its own.

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { db } from '@/lib/db'
import type { AlertInfo, HeartbeatStatus, WatchlistEntry } from '@/lib/types'
import { recordActivity } from './activity-service'
import { sweepWatchlist, watchlistIntervalHours, watchlistAutoUpdate } from './watchlist-service'
import { getTelemetry } from './telemetry-service'

const HEARTBEAT_INTERVAL_S = 60
const STATE_FILE = path.join(process.cwd(), 'db', 'heartbeat-state.json')

/** The guardian samples the machine every Nth beat (≈5 minutes). */
const WATCH_EVERY_N_BEATS = 5
/** The same warning kind never repeats within this window. */
const REWARN_AFTER_MS = 60 * 60_000
/** The self-doctor sweeps her own body+mind every Nth beat (≈30 minutes). */
const INTROSPECT_EVERY_N_BEATS = 30
/** The Hermes watch samples the creator's business agent every Nth beat
 * (≈10 minutes) — presence over chatter: state CHANGES alert, steady state
 * stays silent, bridge disconnected is silent (normal). */
const HERMES_WATCH_EVERY_N_BEATS = 10

interface HeartbeatState {
  last_beat_at: string | null
  reminders_fired: number
  last_sweep_at: string | null
  started_at: string | null
  /** Monotonic beat counter — the guardian fires on every 5th beat. */
  beat_count?: number
  /** kind → ISO timestamp of the last ⚠️ machine-health warning raised. */
  last_warned?: Record<string, string>
  /** ISO timestamp of the last introspection sweep (self-doctor). */
  last_introspect_at?: string | null
}

const EMPTY_STATE: HeartbeatState = {
  last_beat_at: null,
  reminders_fired: 0,
  last_sweep_at: null,
  started_at: null,
  beat_count: 0,
  last_warned: {},
}

async function readState(): Promise<HeartbeatState> {
  try {
    const raw = await fs.readFile(STATE_FILE, 'utf-8')
    return { ...EMPTY_STATE, ...(JSON.parse(raw) as HeartbeatState) }
  } catch {
    return { ...EMPTY_STATE }
  }
}

async function writeState(state: HeartbeatState): Promise<void> {
  try {
    await fs.mkdir(path.dirname(STATE_FILE), { recursive: true })
    await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2), 'utf-8')
  } catch {
    // state file is best-effort — the DB is the source of truth for alerts
  }
}

// ---------- alerts ----------

function toAlertInfo(row: {
  id: string
  kind: string
  title: string
  body: string
  status: string
  meta: string
  conversationId: string | null
  createdAt: Date
  deliveredAt: Date | null
}): AlertInfo {
  let meta: Record<string, unknown> = {}
  try {
    const parsed = JSON.parse(row.meta) as Record<string, unknown>
    if (parsed && typeof parsed === 'object') meta = parsed
  } catch {
    // keep empty meta
  }
  return {
    id: row.id,
    kind: (['reminder', 'release', 'system'] as const).includes(row.kind as AlertInfo['kind'])
      ? (row.kind as AlertInfo['kind'])
      : 'system',
    title: row.title,
    body: row.body,
    status: row.status === 'delivered' ? 'delivered' : 'pending',
    meta,
    conversation_id: row.conversationId,
    created_at: row.createdAt.toISOString(),
    delivered_at: row.deliveredAt ? row.deliveredAt.toISOString() : null,
  }
}

/** Pending + recent alerts for the client poller. `history` feeds the
 *  notification bell — the creator's catch-up panel for anything missed. */
export async function listAlerts(): Promise<{
  pending: AlertInfo[]
  recent: AlertInfo[]
  history: AlertInfo[]
}> {
  const [pending, recent, history] = await Promise.all([
    db.alert.findMany({ where: { status: 'pending' }, orderBy: { createdAt: 'asc' }, take: 20 }),
    db.alert.findMany({ where: { status: 'delivered' }, orderBy: { deliveredAt: 'desc' }, take: 10 }),
    db.alert.findMany({ orderBy: { createdAt: 'desc' }, take: 40 }),
  ])
  return {
    pending: pending.map(toAlertInfo),
    recent: recent.map(toAlertInfo),
    history: history.map(toAlertInfo),
  }
}

/** Mark alerts delivered (the client appends them to a thread first, then calls this). */
export async function markAlertsDelivered(
  ids: string[],
  conversationId: string | null
): Promise<number> {
  if (!ids.length) return 0
  const res = await db.alert.updateMany({
    where: { id: { in: ids }, status: 'pending' },
    data: { status: 'delivered', deliveredAt: new Date(), conversationId },
  })
  return res.count
}

/** Create a system alert (used by services that want to reach the chat). */
export async function raiseSystemAlert(title: string, body: string, meta: Record<string, unknown> = {}): Promise<void> {
  await db.alert.create({
    data: { kind: 'system', title, body, meta: JSON.stringify(meta) },
  })
  recordActivity('heartbeat', `system alert queued: ${title.slice(0, 70)}`)
}

/** Create a 📦 release alert (called by the watchlist sweep on version change). */
export async function raiseReleaseAlert(
  entry: WatchlistEntry,
  fromVersion: string,
  toVersion: string,
  versionLabel: string | null,
  updatedAt: string | null
): Promise<void> {
  const short = toVersion.slice(0, 24)
  await db.alert.create({
    data: {
      kind: 'release',
      title: `📦 ${entry.repo} released ${short}`,
      body:
        `${entry.label} moved ${fromVersion.slice(0, 24)} → ${short}` +
        (versionLabel ? `\n${versionLabel}` : '') +
        (updatedAt ? `\nupdated ${updatedAt}` : '') +
        `\nWant me to review the changelog and propose improvements to adopt? (ask me to run evolution_suggest with origin=openclaw)`,
      meta: JSON.stringify({ repo: entry.repo, from: fromVersion, to: toVersion, channel: entry.channel }),
    },
  })
  recordActivity('heartbeat', `📦 release alert queued: ${entry.repo} ${short}`)
}

// ---------- the system guardian (bridge system_watch, every 5th beat) ----------

/** Defensive mirror of bridge system_watch's `system` payload. */
interface GuardianSnapshot {
  cpu?: { loadPct?: number | null; cores?: number } | null
  ram?: { usedPct?: number | null; totalGb?: number | null } | null
  disk?: { freePct?: number | null; totalGb?: number | null } | null
  thermalC?: number | null
  battery?: { pct?: number; charging?: boolean } | null
  security?: {
    defender?: {
      realTimeProtection?: boolean
      antivirusEnabled?: boolean
      signaturesAgeDays?: number | null
    } | null
    failedLogons24h?: number | null
    source?: string | null
  } | null
  topProcesses?: Array<{ name?: string; cpuPct?: number }>
}

interface GuardianWarning {
  kind: string
  title: string
  body: string
}

const pct = (n: number | null | undefined): string =>
  typeof n === 'number' && Number.isFinite(n) ? `${Math.round(n)}%` : '—'

/** Turn one snapshot into the warnings worth the user's attention. */
function evaluateGuardianSnapshot(sys: GuardianSnapshot): GuardianWarning[] {
  const out: GuardianWarning[] = []
  const procNames = (sys.topProcesses ?? [])
    .map((p) => p?.name)
    .filter((n): n is string => typeof n === 'string' && n.length > 0)
    .slice(0, 3)

  const cpuLoad = sys.cpu?.loadPct
  if (typeof cpuLoad === 'number' && cpuLoad >= 90) {
    out.push({
      kind: 'cpu',
      title: `⚠️ CPU sustained at ${pct(cpuLoad)}`,
      body:
        `All ${sys.cpu?.cores ?? '?'} cores have been busy (load ${pct(cpuLoad)}).` +
        (procNames.length > 0 ? ` Heaviest right now: ${procNames.join(', ')}.` : '') +
        ' If nothing heavy was expected, something may be stuck — I can dig in if you want.',
    })
  }

  const ramUsed = sys.ram?.usedPct
  if (typeof ramUsed === 'number' && ramUsed >= 90) {
    out.push({
      kind: 'ram',
      title: `⚠️ RAM at ${pct(ramUsed)} of ${sys.ram?.totalGb ?? '?'}GB`,
      body:
        'Memory is nearly full — the machine is about to start swapping and everything will feel slow. ' +
        'Close the heavy stuff, or ask me to list what is eating it.',
    })
  }

  const diskFree = sys.disk?.freePct
  if (typeof diskFree === 'number') {
    if (diskFree <= 5) {
      out.push({
        kind: 'disk',
        title: `⚠️ Disk nearly full — only ${pct(diskFree)} free (critical)`,
        body: `The system drive (${sys.disk?.totalGb ?? '?'}GB) is almost out of space — updates and saves can start failing below ~5%. Free some room soon.`,
      })
    } else if (diskFree <= 10) {
      out.push({
        kind: 'disk',
        title: `⚠️ Disk space low — ${pct(diskFree)} free`,
        body: `The system drive (${sys.disk?.totalGb ?? '?'}GB) is filling up. Worth a cleanup before it gets critical.`,
      })
    }
  }

  const thermal = sys.thermalC
  if (typeof thermal === 'number') {
    if (thermal >= 95) {
      out.push({
        kind: 'thermal',
        title: `⚠️ CPU running hot — ${thermal}°C (critical)`,
        body: 'That is throttle/shutdown territory. Check the vents, stop the heavy work, and let it cool down.',
      })
    } else if (thermal >= 85) {
      out.push({
        kind: 'thermal',
        title: `⚠️ CPU temperature ${thermal}°C`,
        body: 'Running warm. Make sure the vents are clear and nothing is pinned at 100% for long stretches.',
      })
    }
  }

  const defender = sys.security?.defender
  if (defender && defender.realTimeProtection === false) {
    out.push({
      kind: 'defender',
      title: '⚠️ Windows Defender real-time protection is OFF',
      body:
        `Antivirus itself reports ${defender.antivirusEnabled ? 'enabled' : 'DISABLED'}.` +
        (typeof defender.signaturesAgeDays === 'number'
          ? ` Signature age: ${Math.round(defender.signaturesAgeDays)} days.`
          : '') +
        ' Windows Security → Virus & threat protection → Real-time protection, unless you turned it off on purpose.',
    })
  }

  const failed = sys.security?.failedLogons24h
  if (typeof failed === 'number' && failed >= 10) {
    out.push({
      kind: 'logons',
      title: `⚠️ ${failed} failed logon attempts in the last 24h`,
      body:
        `That is a lot of failures (${sys.security?.source === 'eventlog' ? 'Windows Security log, event 4625' : 'auth log'}). ` +
        'If those were not you, it may be someone trying accounts — check your passwords and lock screen.',
    })
  }

  const battery = sys.battery
  if (battery && typeof battery.pct === 'number' && battery.pct <= 15 && battery.charging !== true) {
    out.push({
      kind: 'battery',
      title: `⚠️ Battery at ${battery.pct}% — not charging`,
      body: 'Plug in soon if you want to keep working (and keep my voice alive).',
    })
  }

  return out
}

/**
 * One guardian pass: sample the machine through the bridge, evaluate the
 * thresholds, raise ⚠️ alerts through the SAME path reminders use — debounced
 * per warning kind. NEVER throws; a disconnected/failed bridge falls back to
 * the LOCAL host sample (Mark-LV's system_monitor pattern — the machine the
 * sandbox actually runs on still deserves RAM/disk warnings, honestly
 * labeled). Mutates `lastWarned` with what it raised.
 * Returns the number of warnings raised.
 */
async function guardianTick(lastWarned: Record<string, string>): Promise<number> {
  let sys: GuardianSnapshot | null = null
  let source = 'bridge'
  try {
    const { bridgeExec } = await import('./bridge-service')
    const res = await bridgeExec('system_watch', {})
    if (res.bridgeConnected && res.ok === true) {
      const data = res.data as { system?: GuardianSnapshot } | undefined
      if (data?.system && typeof data.system === 'object') sys = data.system
    }
  } catch {
    // bridge down → local fallback below
  }
  if (!sys) {
    // ---- local-host fallback (honest: this is the sandbox host, not the
    // creator's PC) — CPU/RAM/disk from getTelemetry, same thresholds ----
    try {
      const t = await getTelemetry()
      sys = {
        cpu: { loadPct: t.cpu_percent, cores: os.cpus().length },
        ram: {
          usedPct: t.ram_percent,
          totalGb: Math.round((t.ram_total_mb / 1024) * 10) / 10,
        },
        disk: {
          freePct: t.disk_total_gb > 0 ? Math.max(0, 100 - t.disk_percent) : null,
          totalGb: t.disk_total_gb,
        },
      }
      source = 'local-host'
    } catch {
      return 0 // nothing sampleable — silence
    }
  }

  let raised = 0
  for (const warning of evaluateGuardianSnapshot(sys)) {
    const last = lastWarned[warning.kind] ? Date.parse(lastWarned[warning.kind]) : 0
    if (Number.isFinite(last) && Date.now() - last < REWARN_AFTER_MS) continue
    await raiseSystemAlert(warning.title, warning.body, {
      kind: warning.kind,
      source: 'guardian',
      sampledFrom: source,
      snapshot: {
        cpu: sys.cpu?.loadPct ?? null,
        ram: sys.ram?.usedPct ?? null,
        disk: sys.disk?.freePct ?? null,
        thermalC: sys.thermalC ?? null,
      },
    })
    lastWarned[warning.kind] = new Date().toISOString()
    raised++
  }
  return raised
}

// ---------- the Hermes watch (creator's business agent, every 10th beat) ----------

interface HermesWatchState {
  lastState: {
    installed?: boolean | null
    version?: string | null
    gatewayHealthy?: boolean | null
    skillsCount?: number | null
  } | null
  lastCheckAt: string | null
}

const HERMES_STATE_FILE = path.join(process.cwd(), 'db', 'hermes-watch.json')

async function readHermesWatch(): Promise<HermesWatchState> {
  try {
    const raw = await fs.readFile(HERMES_STATE_FILE, 'utf-8')
    const parsed = JSON.parse(raw) as Partial<HermesWatchState>
    return { lastState: parsed.lastState ?? null, lastCheckAt: parsed.lastCheckAt ?? null }
  } catch {
    return { lastState: null, lastCheckAt: null }
  }
}

/** Defensive read of the hermes_status bridge payload. */
function hermesFingerprint(data: unknown): HermesWatchState['lastState'] {
  try {
    const d = data as Record<string, unknown>
    const inner = (d.data ?? d) as Record<string, unknown>
    const installed = typeof inner.installed === 'boolean' ? inner.installed : null
    const version = typeof inner.version === 'string' ? inner.version : null
    const gateway = inner.gateway as Record<string, unknown> | undefined
    const gatewayHealthy = gateway ? gateway.healthy === true : null
    const skills = inner.skills as Record<string, unknown> | unknown[] | undefined
    const skillsCount = Array.isArray(skills)
      ? skills.length
      : skills && typeof skills === 'object' && 'count' in skills
        ? Number((skills as { count: unknown }).count)
        : null
    return { installed, version, gatewayHealthy, skillsCount: Number.isFinite(skillsCount) ? skillsCount : null }
  } catch {
    return null
  }
}

/** One Hermes watch pass: probe → diff → alert on CHANGE only. NEVER fatal. */
async function hermesWatchTick(): Promise<number> {
  const { bridgeExec } = await import('./bridge-service')
  const res = await bridgeExec('hermes_status', {})
  if (!res.bridgeConnected || res.ok !== true) return 0 // bridge off is normal
  const next = hermesFingerprint(res.data)
  const prev = await readHermesWatch()
  await fs.mkdir(path.dirname(HERMES_STATE_FILE), { recursive: true }).catch(() => undefined)
  await fs.writeFile(
    HERMES_STATE_FILE,
    JSON.stringify({ lastState: next, lastCheckAt: new Date().toISOString() } satisfies HermesWatchState, null, 2),
    'utf-8'
  ).catch(() => undefined)
  if (!next || !prev.lastState) return 0 // first observation — baseline only
  let raised = 0
  if (prev.lastState.gatewayHealthy === true && next.gatewayHealthy === false) {
    await raiseSystemAlert(
      '⚠️ Hermes gateway went down',
      'The business agent\u2019s gateway on your PC stopped responding. I will keep watching — restart it if this was not planned.',
      { kind: 'hermes', source: 'guardian', severity: 'critical' }
    )
    raised++
  } else if (prev.lastState.gatewayHealthy === false && next.gatewayHealthy === true) {
    await raiseSystemAlert(
      '✅ Hermes gateway is back',
      'The business agent\u2019s gateway is responding again.',
      { kind: 'hermes', source: 'guardian', severity: 'info' }
    )
    raised++
  }
  if (
    typeof prev.lastState.skillsCount === 'number' &&
    typeof next.skillsCount === 'number' &&
    prev.lastState.skillsCount !== next.skillsCount
  ) {
    const up = next.skillsCount > prev.lastState.skillsCount
    await raiseSystemAlert(
      `Hermes skills ${up ? 'grew' : 'shrank'}: ${prev.lastState.skillsCount} → ${next.skillsCount}`,
      up
        ? 'Your Hermes agent learned new skills since the last check.'
        : 'Some Hermes skills were removed since the last check.',
      { kind: 'hermes', source: 'guardian', severity: 'info' }
    )
    raised++
  }
  if (prev.lastState.version && next.version && prev.lastState.version !== next.version) {
    await raiseSystemAlert(
      `Hermes updated: ${prev.lastState.version} → ${next.version}`,
      'The business agent itself moved versions.',
      { kind: 'hermes', source: 'guardian', severity: 'info' }
    )
    raised++
  }
  return raised
}

// ---------- the beat ----------

/** One heartbeat: fire due reminders, note liveness, sweep the watchlist on
 *  schedule, and every 5th beat let the guardian watch the machine. */
export async function heartbeatTick(): Promise<{ fired: number; swept: boolean; warned: number }> {
  const now = new Date()
  const state = await readState()

  // 1) due reminders → ⏰ alerts
  const due = await db.memoryQueue.findMany({
    where: { kind: 'reminder', status: 'pending', dueAt: { lte: now } },
    orderBy: { dueAt: 'asc' },
    take: 10,
  })
  for (const item of due) {
    await db.alert.create({
      data: {
        kind: 'reminder',
        title: '⏰ Reminder',
        body: item.content,
        meta: JSON.stringify({ queue_id: item.id }),
      },
    })
    await db.memoryQueue.update({
      where: { id: item.id },
      data: { status: 'fired', firedAt: now },
    })
    recordActivity('heartbeat', `reminder fired: ${item.content.slice(0, 70)}`)
  }

  // 2) watchlist sweep on schedule (skip if swept within the interval)
  let swept = false
  const intervalMs = watchlistIntervalHours() * 3600_000
  const lastSweep = state.last_sweep_at ? new Date(state.last_sweep_at).getTime() : 0
  if (watchlistAutoUpdate() && Date.now() - lastSweep >= intervalMs) {
    try {
      await sweepWatchlist(true)
      swept = true
    } catch {
      // sweep failures are non-fatal — next beat retries on schedule
    }
  }

  // 3) the guardian: every Nth beat, watch the machine through the bridge.
  // Bridge down / probe failed / nothing to say → completely silent — this
  // must NEVER crash the beat.
  const beatCount = typeof state.beat_count === 'number' && Number.isFinite(state.beat_count)
    ? state.beat_count
    : 0
  const lastWarned: Record<string, string> = { ...(state.last_warned ?? {}) }
  let warned = 0
  if ((beatCount + 1) % WATCH_EVERY_N_BEATS === 0) {
    try {
      warned = await guardianTick(lastWarned)
    } catch {
      // the guardian is never fatal
    }
  }

  // 4) the self-doctor: every Nth beat, sweep her own systems (probes +
  // repair lanes). Runs fully sandboxed inside the introspection service —
  // a crash there is contained; here it is doubly never fatal. The loop is
  // guarded by its own state file so a dev-mode double-arm cannot double-run.
  if ((beatCount + 1) % INTROSPECT_EVERY_N_BEATS === 0) {
    const last = state.last_introspect_at ? Date.parse(state.last_introspect_at) : 0
    if (!Number.isFinite(last) || Date.now() - last > 25 * 60_000) {
      try {
        const { runIntrospection } = await import('./introspection-service')
        await runIntrospection({ repair: true, source: 'heartbeat' })
        state.last_introspect_at = now.toISOString()
      } catch {
        // the self-doctor is never fatal either
      }
    }
  }

  // 5) the mission engine: recover missions orphaned by a restart and pump
  // the queue when concurrency slots are free. Cheap (2 indexed queries)
  // and never fatal — the engine itself is crash-safe with its transcript.
  try {
    const { missionHeartbeatSweep } = await import('./mission-service')
    await missionHeartbeatSweep()
  } catch {
    // mission pumping is never fatal to the beat
  }

  // 6) OpenJarvis oj layer (oj-ops-3): operator tick (always-on scheduled
  // agents — 50s self-throttle inside operatorTick makes double-driving
  // harmless) + due digest firing (claim-guarded, shared with the scheduler
  // watch loop). Both are additive, guarded and NEVER fatal to the beat.
  try {
    const { operatorTick } = await import('../oj/operator-service')
    await operatorTick()
  } catch {
    // the operator tick is never fatal
  }
  try {
    const { digestDueCheck } = await import('../oj/digest-service')
    await digestDueCheck()
  } catch {
    // the digest due check is never fatal
  }

  // 7) the Hermes watch (w4): every 10th beat, sample the creator's business
  // agent through the bridge and alert on STATE CHANGES only. Bridge
  // disconnected is silent — that is the normal sandbox case.
  if ((beatCount + 1) % HERMES_WATCH_EVERY_N_BEATS === 0) {
    try {
      await hermesWatchTick()
    } catch {
      // the Hermes watch is never fatal
    }
  }

  await writeState({
    last_beat_at: now.toISOString(),
    reminders_fired: state.reminders_fired + due.length,
    last_sweep_at: swept ? now.toISOString() : state.last_sweep_at,
    started_at: state.started_at ?? now.toISOString(),
    beat_count: beatCount + 1,
    last_warned: lastWarned,
    last_introspect_at: state.last_introspect_at ?? null,
  })

  return { fired: due.length, swept, warned }
}

export async function getHeartbeatStatus(): Promise<HeartbeatStatus> {
  const state = await readState()
  const g = heartbeatGlobal.__mistHeartbeat
  const pending = await db.alert.count({ where: { status: 'pending' } }).catch(() => 0)
  const lastBeat = state.last_beat_at ? new Date(state.last_beat_at).getTime() : 0
  const alive = g?.started === true && Date.now() - lastBeat < 5 * 60_000
  return {
    beating: alive,
    interval_s: HEARTBEAT_INTERVAL_S,
    last_beat_at: state.last_beat_at,
    reminders_fired: state.reminders_fired,
    pending_alerts: pending,
    note: alive
      ? `beating every ${HEARTBEAT_INTERVAL_S}s — due reminders, 📦 releases and ⚠️ machine-health warnings land in the chat`
      : state.last_beat_at
        ? 'loop idle — starts on the first /health or /alerts request after boot'
        : 'waiting for first beat',
  }
}

// ---------- guarded watch loop ----------

const heartbeatGlobal = globalThis as unknown as {
  __mistHeartbeat?: {
    started: boolean
    timer?: ReturnType<typeof setInterval>
    beating?: boolean
    /** Which module instance armed the loop — a fresh compile (Next dev
     *  recompiles per route) replaces a stale timer so NEW heartbeat code
     *  actually runs without a server restart. Production has one module,
     *  so this never churns there. */
    armedBy?: object
  }
}

// unique per module instance (per dev-mode compile)
const ARM_TOKEN = {}

export function ensureHeartbeatWatch(): void {
  const g = (heartbeatGlobal.__mistHeartbeat ??= { started: false })
  if (g.started && g.armedBy === ARM_TOKEN) return
  if (g.timer) {
    try {
      clearInterval(g.timer)
    } catch {
      /* already gone */
    }
  }
  g.started = true
  g.armedBy = ARM_TOKEN

  // first beat shortly after boot, then every 60s
  setTimeout(() => {
    void heartbeatTick().catch(() => undefined)
  }, 15_000).unref?.()

  g.timer = setInterval(
    () => {
      void heartbeatTick().catch(() => undefined)
    },
    HEARTBEAT_INTERVAL_S * 1000
  )
  g.timer.unref?.()
  recordActivity('heartbeat', 'proactive loop armed (60s)')
}
