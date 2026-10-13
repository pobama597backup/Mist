// M.I.S.T. events protocol — Phase 4-a · R11 (polls → one events channel).
//
// The PURE contract shared by GET /api/mist/events (server) and
// use-events.ts (client): topic payloads, per-topic change detection, the
// should-refetch reducer the poller swaps use, panel filtering and the
// panels signal. No DOM, no fetch — fully unit-testable (see
// tests/security/speed.test.ts).

/** The poll-shaped data the channel coalesces (all topics optional in any
 *  event — absent means "no data / source failed" and is sticky server-side). */
export interface MistEventTopics {
  /** Heartbeat alerts (⏰ reminders, 📦 releases, ⚠️ health). */
  alerts: { pending: number; pendingIds: string[] }
  /** Tiered-approval queue (oj-face-5). */
  approvals: { pending: number; pendingIds: string[] }
  /** Mission status digest (drawer-scoped). */
  missions: { running: number; statuses: Record<string, number> }
  /** Evolution proposals (drawer-scoped). */
  evolution: { pending: number; applied: number; rolledBack: number; total: number }
  /** Backend self-report (the route answering IS the health check).
 *  Deliberately COARSE — values that flap every sample (raw uptime, RSS)
 *  would make the topic "change" on every tick and defeat coalescing.
 *  Phase 4-b · R5: `watchers.enabled` rides here so the outbound opt-in
 *  state is carried on the events stream (it only changes on an owner
 *  toggle, so it never flaps).
 *  Phase 5 · C2/A6: `candor` + `a4` ride here too — the dial and the
 *  unleash badge are coarse by nature (they change only on owner action or
 *  the A4 expiry tick, and remainingMs is minute-resolution so it flaps at
 *  most once a minute). */
  health: {
    online: boolean
    uptimeMin: number
    watchers: { enabled: boolean }
    candor: { mode: string; localLane: boolean }
    a4: { active: boolean; remainingMin: number }
  }
  /** Scheduled automations (drawer-scoped). */
  automations: { total: number; enabled: number }
}

export type MistEventTopic = keyof MistEventTopics

/** One SSE event on the channel. `change` carries ONLY the topics that
 *  changed since the last emit; `snapshot` is the initial post-connect
 *  payload; `heartbeat` is the periodic keep-alive carrying the full
 *  (panel-filtered) payload. */
export type MistEvent =
  | { type: 'snapshot'; topics: Partial<MistEventTopics>; serverTs: number }
  | { type: 'change'; topics: Partial<MistEventTopics>; serverTs: number }
  | { type: 'heartbeat'; topics: Partial<MistEventTopics>; serverTs: number }

/** Topics that only matter while the diagnostics drawer is mounted — the
 *  events route drops them from payloads when 'diagnostics' is not in the
 *  client's panels signal (v1 panel scoping: filter drawer noise, keep the
 *  app-wide surfaces — alerts/approvals/health feed toasts + chips on every
 *  view, so they always ride). */
const DIAGNOSTICS_SCOPED: ReadonlySet<MistEventTopic> = new Set([
  'missions',
  'evolution',
  'automations',
])

/** Deep-equal on one topic payload (payloads are tiny — JSON is the honest
 *  comparator; no schema drift can hide). */
export function topicEquals(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/** Which topics differ between two snapshots (order-stable by key list). */
export function diffTopics(
  prev: Partial<MistEventTopics>,
  next: Partial<MistEventTopics>
): MistEventTopic[] {
  const keys = new Set<MistEventTopic>([
    ...(Object.keys(prev) as MistEventTopic[]),
    ...(Object.keys(next) as MistEventTopic[]),
  ])
  const out: MistEventTopic[] = []
  for (const k of keys) {
    if (!topicEquals(prev[k], next[k])) out.push(k)
  }
  return out
}

/** The coalescing reducer every swapped poller uses: refetch `topic` when a
 *  change event carries it, or on the initial/reconnect snapshot. Heartbeats
 *  carry the payload but signal NOTHING changed — a poller listening to them
 *  would be the old 30s interval wearing a new hat. */
export function shouldRefetch(ev: MistEvent, topic: MistEventTopic): boolean {
  if (ev.type === 'heartbeat') return false
  if (ev.type === 'snapshot') return topic in ev.topics
  return topic in ev.topics
}

/** Mounted-panels signal: the app's live surfaces → panel ids sent on
 *  connect (`?panels=chat,diagnostics`). Pure — derived from store state. */
export function panelsFromState(
  view: string,
  drawerOpen: boolean,
  browserOpen: boolean
): string[] {
  const panels: string[] = [view]
  if (drawerOpen) panels.push('diagnostics')
  if (browserOpen) panels.push('browser')
  return panels
}

/** Panel-scoped payload filter (the route applies this before emitting). */
export function filterTopics(
  topics: Partial<MistEventTopics>,
  panels: string[]
): Partial<MistEventTopics> {
  const scoped = panels.includes('diagnostics')
  const out: Partial<MistEventTopics> = {}
  // (the key-preserving copy needs one widening cast — TS cannot express
  //  "copy the value that belongs to THIS key" over a union of keys)
  const sink = out as Record<string, unknown>
  for (const key of Object.keys(topics) as MistEventTopic[]) {
    if (DIAGNOSTICS_SCOPED.has(key) && !scoped) continue
    sink[key] = topics[key]
  }
  return out
}

/** Parse the ?panels= query (tolerant: empty/whitespace entries dropped). */
export function parsePanels(raw: string | null): string[] {
  if (!raw) return []
  return raw
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p.length > 0 && p.length <= 32)
}
