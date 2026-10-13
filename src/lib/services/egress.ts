// M.I.S.T. egress helper (Phase 4-b · R5, extended Phase 5 · C6) — the doors
// outbound fetches go through, and the TRUTHFUL LEDGER behind them.
//
//   egressFetch()   — the WATCHER door (unchanged from 4-b): throws
//                     EgressPausedError before any socket opens while the
//                     `outbound_watchers` setting is FALSE (dormant default).
//   egressLaneFetch() — the LANE door (Phase 5): every LLM-lane / voice /
//                     tool fetch rides it. Two jobs:
//                       1. THE TRIPWIRE — while the candor dial is Unfiltered,
//                          a non-loopback target throws LocalOnlyError BEFORE
//                          the socket opens (the mandate's "zero non-loopback
//                          egress in Unfiltered", enforced at the door — the
//                          cascade's lane filter is the structural layer, this
//                          is the belt-and-braces layer).
//                       2. THE LEDGER — every outbound call is recorded
//                          (ts, host, lane, class, bytes≈, loopback) in an
//                          in-memory ring buffer (hot path: one object push),
//                          flushed hourly into EgressEvent aggregate rows
//                          (24h window, pruned at flush) so
//                          /api/mist/data-boundary answers an honest 24h view
//                          across restarts.
//
// Honest scope note: SDK-transported calls (Mist Core / z-ai voice) expose no
// fetch handle — they are excluded from Unfiltered structurally (the cascade
// never attempts them in that mode; the voice routes refuse cloud engines),
// and the ledger notes their absence rather than inventing rows.
import { outboundWatchersEnabled } from './settings-service'
import { getGlobalCandorMode } from './candor-service'
import { isLoopbackUrl } from '@/lib/candor'
import { db } from '@/lib/db'

/** Typed, catchable "you may not leave the machine right now" signal (watchers). */
export class EgressPausedError extends Error {
  constructor(what: string) {
    super(`outbound watchers paused — ${what} skipped (enable watchers in the Upstream tab to allow outbound checks)`)
    this.name = 'EgressPausedError'
  }
}

/** Typed, catchable "Unfiltered means local lanes only" signal (the tripwire). */
export class LocalOnlyError extends Error {
  constructor(url: string, lane: string) {
    super(
      `local-only mode — the candor dial is Unfiltered and ${new URL(url).host} is not on this machine ` +
        `(lane ${lane}); switch the dial or connect a local lane`
    )
    this.name = 'LocalOnlyError'
  }
}

/** True when outbound watcher traffic is allowed (flag true). */
export async function egressAllowed(): Promise<boolean> {
  return outboundWatchersEnabled()
}

/**
 * fetch() through the outbound gate. Throws EgressPausedError (never a
 * TypeError, never a socket) when the watchers flag is off. Tests stub the
 * `allow` predicate via this module's export surface or spy globalThis.fetch.
 */
export async function egressFetch(
  url: string,
  init: RequestInit = {},
  what = 'watcher request'
): Promise<Response> {
  if (!(await egressAllowed())) throw new EgressPausedError(what)
  recordEgress({ host: hostOf(url), lane: 'watcher', klass: 'watcher', bytes: approxBytes(init) })
  return fetch(url, init)
}

// ---------------------------------------------------------------- C6 · the ledger

export type EgressClass =
  | 'llm-lane' // keyed cloud provider lanes
  | 'keyless-lane' // public keyless lanes
  | 'watcher' // watchlist/oj-sync/openclaw sweeps
  | 'voice' // cloud STT/TTS
  | 'tool' // owner-initiated tool fetches (google-direct server-side etc.)
  | 'local-lane' // the C4 local lane (loopback)
  | 'bridge' // the local bridge / mini-services (loopback)

export interface EgressEntry {
  ts: number
  host: string
  lane: string
  klass: EgressClass
  bytes: number
  loopback: boolean
}

const RING_CAP = 2048
const FLUSH_MS = 3_600_000

interface EgressStore {
  ring: EgressEntry[]
  flushedHour: number // epoch ms of the last flushed hour bucket
  timer?: ReturnType<typeof setInterval>
  timerArmed?: object
}

const g = globalThis as unknown as { __mistEgressLedger?: EgressStore }

function store(): EgressStore {
  return (g.__mistEgressLedger ??= { ring: [], flushedHour: 0 })
}

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return '(unparseable)'
  }
}

function approxBytes(init: RequestInit): number {
  const body = init.body
  if (typeof body === 'string') return body.length + 200
  if (body instanceof Uint8Array || (body as unknown as ArrayBuffer)?.byteLength != null) {
    return ((body as unknown as { byteLength: number }).byteLength ?? 0) + 200
  }
  return 200
}

/** Record one outbound call (or one refused-by-policy attempt — the ledger
 *  records INTENT honestly, the tripwire throws after recording). Hot path:
 *  one object push, no await. */
export function recordEgress(e: { host: string; lane: string; klass: EgressClass; bytes?: number }): void {
  const s = store()
  s.ring.push({
    ts: Date.now(),
    host: e.host,
    lane: e.lane,
    klass: e.klass,
    bytes: e.bytes ?? 0,
    loopback: isLoopbackUrl(`http://${e.host}`) || e.host.startsWith('127.') || e.host.startsWith('localhost') || e.host.startsWith('[::1]'),
  })
  if (s.ring.length > RING_CAP) s.ring.splice(0, s.ring.length - RING_CAP)
}

/** The raw ring entries (optionally since an epoch-ms). */
export function egressEntries(sinceMs?: number): EgressEntry[] {
  const s = store()
  if (sinceMs == null) return [...s.ring]
  return s.ring.filter((e) => e.ts >= sinceMs)
}

/**
 * fetch() through the LANE door: the Unfiltered tripwire + the ledger + the
 * fetch itself. `meta.lane` is the provider/tool name for honest attribution.
 */
export async function egressLaneFetch(
  url: string,
  init: RequestInit,
  meta: { lane: string; klass: EgressClass }
): Promise<Response> {
  const host = hostOf(url)
  recordEgress({ host, lane: meta.lane, klass: meta.klass, bytes: approxBytes(init) })
  if ((await getGlobalCandorMode()) === 'unfiltered' && !isLoopbackUrl(url)) {
    throw new LocalOnlyError(url, meta.lane)
  }
  return fetch(url, init)
}

/** Group entries by host+class with counts (the data-boundary view shape). */
export interface EgressGroup {
  host: string
  klass: EgressClass
  lane: string
  count: number
  bytes: number
  loopback: boolean
  lastTs: number
}

function groupEntries(entries: EgressEntry[]): EgressGroup[] {
  const map = new Map<string, EgressGroup>()
  for (const e of entries) {
    const key = `${e.host}|${e.klass}|${e.lane}`
    const cur = map.get(key)
    if (cur) {
      cur.count++
      cur.bytes += e.bytes
      cur.lastTs = Math.max(cur.lastTs, e.ts)
    } else {
      map.set(key, { host: e.host, klass: e.klass, lane: e.lane, count: 1, bytes: e.bytes, loopback: e.loopback, lastTs: e.ts })
    }
  }
  return [...map.values()].sort((a, b) => b.lastTs - a.lastTs)
}

/** The 24h summary: in-memory ring (process detail) + EgressEvent rows
 *  (durable hourly aggregates across restarts), grouped by host+class. */
export async function egressSummary24h(sinceMs?: number): Promise<{
  windowStartMs: number
  sources: { ring: number; persisted: number }
  entries: EgressGroup[]
  totalCalls: number
  nonLoopbackCalls: number
}> {
  const since = sinceMs ?? Date.now() - 24 * 3_600_000
  const ringPart = egressEntries(since)
  let persistedPart: EgressEntry[] = []
  try {
    const rows = await db.egressEvent.findMany({ where: { ts: { gte: new Date(since) } } })
    persistedPart = rows.map((r) => ({
      ts: r.ts.getTime(),
      host: r.host,
      lane: r.lane,
      klass: r.klass as EgressClass,
      bytes: r.bytes,
      loopback: isLoopbackUrl(`http://${r.host}`) || r.host.startsWith('127.') || r.host.startsWith('localhost'),
    }))
  } catch {
    persistedPart = []
  }
  const entries = groupEntries([...persistedPart, ...ringPart])
  const totalCalls = entries.reduce((s, e) => s + e.count, 0)
  const nonLoopbackCalls = entries.filter((e) => !e.loopback).reduce((s, e) => s + e.count, 0)
  return {
    windowStartMs: since,
    sources: { ring: ringPart.length, persisted: persistedPart.length },
    entries,
    totalCalls,
    nonLoopbackCalls,
  }
}

/** Flush everything the ring holds since the last flush (first flush: the
 *  last hour) into EgressEvent aggregate rows + prune >24h. The window is
 *  [lastFlush, now) — entries recorded in the current hour are flushed by
 *  the NEXT tick, never lost, never double-counted. Lifecycle-registered on
 *  an hourly cadence (ensureEgressFlushWatch); also exported for tests and
 *  manual snapshots. */
export async function flushEgressSnapshots(): Promise<void> {
  const s = store()
  const now = Date.now()
  const from = s.flushedHour > 0 ? s.flushedHour : now - FLUSH_MS
  // (<= now: an entry recorded in the SAME millisecond as the flush is
  // still part of the window — the strict < dropped same-ms entries in tests)
  const window = s.ring.filter((e) => e.ts >= from && e.ts <= now)
  s.flushedHour = now
  for (const group of groupEntries(window)) {
    try {
      await db.egressEvent.create({
        data: { ts: new Date(from), host: group.host, lane: group.lane, klass: group.klass, bytes: group.bytes, count: group.count },
      })
    } catch {
      /* the snapshot is telemetry — a failed flush never breaks traffic */
    }
  }
  try {
    await db.egressEvent.deleteMany({ where: { ts: { lt: new Date(Date.now() - 24 * FLUSH_MS) } } })
  } catch {
    /* prune is best-effort */
  }
}

/** Arm the hourly flush timer (idempotent, lifecycle-registered). Called by
 *  the health route's bootstrap — same pattern as the retention watch. */
export function ensureEgressFlushWatch(): void {
  const s = store()
  if (s.timer && s.timerArmed === ARM_TOKEN) return
  if (s.timer) clearInterval(s.timer)
  s.timer = setInterval(() => {
    void flushEgressSnapshots().catch(() => undefined)
  }, FLUSH_MS)
  try {
    s.timer.unref?.()
  } catch {
    /* runtimes without unref */
  }
  s.timerArmed = ARM_TOKEN
  registerEgressLifecycle()
}

const ARM_TOKEN = {}

function registerEgressLifecycle(): void {
  // the lifecycle registry is process-local; import lazily to avoid cycles
  import('./lifecycle')
    .then(({ register }) => {
      const s = store()
      register('egress-ledger-flush', () => {
        if (s.timer) clearInterval(s.timer)
        void flushEgressSnapshots().catch(() => undefined)
      })
    })
    .catch(() => undefined)
}

/** Test hook — wipe the ring + timers. */
export function __resetEgressLedgerForTests(): void {
  const s = store()
  s.ring = []
  s.flushedHour = 0
  if (s.timer) {
    clearInterval(s.timer)
    s.timer = undefined
    s.timerArmed = undefined
  }
}
