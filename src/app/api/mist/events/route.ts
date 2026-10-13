// M.I.S.T. events route — Phase 4-a · R11: ONE change-driven channel that
// replaces the UI's per-mount pollers (alerts 30s, approvals 30s, health 10s×2).
//
// GET /api/mist/events?panels=chat,diagnostics[&sampleMs=5000][&heartbeatMs=30000]
//   → SSE stream:
//     {type:'snapshot',  topics, serverTs}   once, immediately after connect
//     {type:'change',    topics, serverTs}   when a sampled topic changed
//     {type:'heartbeat', topics, serverTs}   every heartbeatMs (keep-alive)
//
// Coalescing: a single SHARED server-side sampler (one timer per process, no
// matter how many connections) samples the poll-shaped data every sampleMs
// and compares the last-emitted JSON per topic (the mandate's accepted
// 5s-sampler pattern — no new DB watcher layer; it reads the same service
// functions the old poll endpoints read). A topic whose source fails keeps
// its previous value (sticky) — a transient DB error never claims a change.
//
// Panel scoping (v1): missions/evolution/automations are drawer-scoped — the
// route drops them unless 'diagnostics' is in the panels signal. The app-wide
// surfaces (alerts/approvals/health) always ride: their consumers (toasts,
// the approval chip, the CORE status) live on every view.
//
// The old poll endpoints stay untouched (tests + direct API) — only the UI
// stopped polling them.
import { NextRequest, NextResponse } from 'next/server'
import { listAlerts } from '@/lib/services/heartbeat-service'
import { listApprovals } from '@/lib/oj/approval-service'
import { getEvolutionStats } from '@/lib/services/evolution-service'
import { runningMissionCount } from '@/lib/services/mission-service'
import { listCronJobs } from '@/lib/services/scheduler-service'
import { outboundWatchersEnabled } from '@/lib/services/settings-service'
import { getGlobalCandorMode } from '@/lib/services/candor-service'
import { a4Status } from '@/lib/arbiter/unleash'
import { localLaneProviderConfig } from '@/lib/services/local-lane'
import { db } from '@/lib/db'
import {
  filterTopics,
  parsePanels,
  type MistEventTopics,
} from '@/lib/events-protocol'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const SAMPLE_MS_DEFAULT = 5_000
const SAMPLE_MS_MIN = 1_000
const SAMPLE_MS_MAX = 60_000
const HEARTBEAT_MS_DEFAULT = 30_000
const HEARTBEAT_MS_MIN = 1_000
const HEARTBEAT_MS_MAX = 120_000

function clampNum(raw: string | null, fallback: number, min: number, max: number): number {
  const v = Number(raw)
  if (!Number.isFinite(v)) return fallback
  return Math.max(min, Math.min(max, Math.round(v)))
}

// ---------------------------------------------------------------- sampler

interface SamplerState {
  timer?: ReturnType<typeof setInterval>
  /** The shortest interval any live connection has asked for. */
  intervalMs: number
  latest: Partial<MistEventTopics> | null
  subscribers: Set<() => void>
  sampling: boolean
  /** Which module instance armed the timer — a fresh dev-mode compile
   *  replaces a stale timer so NEW sampler code actually runs (the
   *  heartbeat-service ARM_TOKEN pattern; production has one module). */
  armedBy?: object
}

const g = globalThis as unknown as { __mistEventsSampler?: SamplerState }
const ARM_TOKEN = {}

function sampler(): SamplerState {
  return (g.__mistEventsSampler ??= { intervalMs: SAMPLE_MS_DEFAULT, latest: null, subscribers: new Set(), sampling: false })
}

/** One sampling pass — every source is independently fault-tolerant: a
 *  rejected source keeps the topic's previous value (sticky, no false
 *  change), a missing previous value simply omits the topic this round. */
async function runSample(state: SamplerState): Promise<void> {
  if (state.sampling) return // one in-flight pass, ticks never queue up
  state.sampling = true
  try {
    const prev = state.latest ?? {}
    const [alerts, approvals, missions, evolution, automations, missionRows] =
      await Promise.allSettled([
        listAlerts(),
        listApprovals({ status: 'pending' }),
        Promise.resolve(runningMissionCount()),
        getEvolutionStats(),
        listCronJobs(),
        db.mission.groupBy({ by: ['status'], _count: { _all: true } }),
      ])

    const next: Partial<MistEventTopics> = {}

    if (alerts.status === 'fulfilled') {
      next.alerts = {
        pending: alerts.value.pending.length,
        pendingIds: alerts.value.pending.slice(0, 20).map((a) => a.id),
      }
    } else if (prev.alerts) next.alerts = prev.alerts

    if (approvals.status === 'fulfilled') {
      next.approvals = {
        pending: approvals.value.length,
        pendingIds: approvals.value.slice(0, 20).map((a) => a.id),
      }
    } else if (prev.approvals) next.approvals = prev.approvals

    if (missions.status === 'fulfilled' && missionRows.status === 'fulfilled') {
      const statuses: Record<string, number> = {}
      for (const row of missionRows.value) statuses[row.status] = row._count._all
      next.missions = { running: missions.value, statuses }
    } else if (prev.missions) next.missions = prev.missions

    if (evolution.status === 'fulfilled') {
      next.evolution = {
        pending: evolution.value.pending,
        applied: evolution.value.applied,
        rolledBack: evolution.value.rolled_back,
        total: evolution.value.total,
      }
    } else if (prev.evolution) next.evolution = prev.evolution

    if (automations.status === 'fulfilled') {
      const jobs = automations.value as Array<{ enabled?: boolean }>
      next.automations = {
        total: jobs.length,
        enabled: jobs.filter((j) => j.enabled !== false).length,
      }
    } else if (prev.automations) next.automations = prev.automations

    // server self-report — free, never fails. COARSE by design: raw uptime
    // and RSS flap every sample and would turn the topic into a per-tick
    // "change" (defeating the whole point); a minute-resolution uptime only
    // ticks once per minute. The channel being open IS the liveness signal.
    // Phase 4-b · R5: the outbound-watchers opt-in rides here too (the
    // settings read is a ~2s-cached row — cheap, and it only changes on an
    // owner toggle, so it never turns the topic into a flapper).
    // Phase 5 · C2/A6: the candor dial + the A4 badge — coarse fields only
    // (remainingMs is minute-resolution; the scope/A4 flips are owner actions).
    const [candorMode, a4, localLane] = await Promise.all([
      getGlobalCandorMode(),
      a4Status(),
      localLaneProviderConfig().catch(() => null),
    ])
    next.health = {
      online: true,
      uptimeMin: Math.round(process.uptime() / 60),
      watchers: { enabled: await outboundWatchersEnabled() },
      candor: { mode: candorMode, localLane: localLane !== null },
      a4: {
        active: a4.active,
        remainingMin: a4.active ? Math.floor((a4.remainingMs ?? 0) / 60_000) : 0,
      },
    }

    state.latest = next
  } finally {
    state.sampling = false
  }
}

/** Notify every subscriber with the freshest snapshot (shared helper for the
 *  timer tick and the immediate first pass). */
function notify(state: SamplerState): void {
  for (const fn of state.subscribers) {
    try {
      fn()
    } catch {
      /* one bad subscriber never breaks the sampler */
    }
  }
}

/** Subscribe to sampler ticks. The FIRST subscriber starts the timer and
 *  kicks an immediate pass (the post-connect snapshot lands <1s); the LAST
 *  unsubscribe stops the timer. Returns the unsubscribe fn. */
function subscribeSampler(sampleMs: number, cb: () => void): () => void {
  const state = sampler()
  state.subscribers.add(cb)
  if (state.timer && state.armedBy === ARM_TOKEN && sampleMs >= state.intervalMs) {
    return () => unsubscribeSampler(state, cb)
  }
  // (re)arm with the shortest requested interval
  if (state.timer) clearInterval(state.timer)
  state.intervalMs = Math.min(state.intervalMs, sampleMs)
  state.armedBy = ARM_TOKEN
  state.timer = setInterval(() => {
    void runSample(state).then(() => notify(state))
  }, state.intervalMs)
  // immediate first pass → the connecting client gets its snapshot fast
  void runSample(state).then(() => notify(state))
  return () => unsubscribeSampler(state, cb)
}

function unsubscribeSampler(state: SamplerState, cb: () => void): void {
  state.subscribers.delete(cb)
  if (state.subscribers.size === 0 && state.timer) {
    clearInterval(state.timer)
    state.timer = undefined
    state.armedBy = undefined
    state.intervalMs = SAMPLE_MS_DEFAULT
  }
}

// ---------------------------------------------------------------- route

export async function GET(req: NextRequest) {
  const url = req.nextUrl
  const panels = parsePanels(url.searchParams.get('panels'))
  const sampleMs = clampNum(url.searchParams.get('sampleMs'), SAMPLE_MS_DEFAULT, SAMPLE_MS_MIN, SAMPLE_MS_MAX)
  const heartbeatMs = clampNum(
    url.searchParams.get('heartbeatMs'),
    HEARTBEAT_MS_DEFAULT,
    HEARTBEAT_MS_MIN,
    HEARTBEAT_MS_MAX
  )

  const encoder = new TextEncoder()
  let closed = false
  let unsubSampler: (() => void) | null = null
  let heartbeat: ReturnType<typeof setInterval> | null = null

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      /** The connection's last-emitted payload key (change detection is
       *  PER CONNECTION because panels differ). */
      let lastSent: string | null = null
      let first = true

      const emit = (type: 'snapshot' | 'change' | 'heartbeat', topics: Partial<MistEventTopics>) => {
        if (closed) return
        try {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify({ type, topics, serverTs: Date.now() })}\n\n`)
          )
        } catch {
          cleanup()
        }
      }

      /** Filter the shared snapshot to this connection's panels; emit as a
       *  change only when it actually differs from what we last sent. */
      const push = (forceType?: 'snapshot' | 'heartbeat') => {
        const state = sampler()
        if (!state.latest) return
        const filtered = filterTopics(state.latest, panels)
        const key = JSON.stringify(filtered)
        if (!forceType && key === lastSent) return
        lastSent = key
        emit(first ? 'snapshot' : (forceType ?? 'change'), filtered)
        first = false
      }

      const cleanup = () => {
        if (closed) return
        closed = true
        if (unsubSampler) unsubSampler()
        if (heartbeat) clearInterval(heartbeat)
        try {
          controller.close()
        } catch {
          /* already closed */
        }
      }

      unsubSampler = subscribeSampler(sampleMs, () => push())
      // If the sampler already holds a snapshot (warm server), the initial
      // event goes out NOW; otherwise the immediate first pass delivers it
      // (well under a second).
      push('snapshot')
      heartbeat = setInterval(() => push('heartbeat'), heartbeatMs)
      req.signal.addEventListener('abort', cleanup)
    },
    cancel() {
      closed = true
      if (unsubSampler) unsubSampler()
      if (heartbeat) clearInterval(heartbeat)
    },
  })

  return new NextResponse(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  })
}
