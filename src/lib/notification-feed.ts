// Notification feed — a tiny module store shared between the alert delivery
// loop (use-alerts, which polls every 30s) and the notification bell.
//
// Same pattern as interrupt-bus: dependency-free, browser-safe, no store.ts
// ownership (that file belongs to the settings lane). The delivery loop
// WRITES the latest snapshot; the bell READS it via useSyncExternalStore —
// one poller, many surfaces.

import type { AlertInfo } from '@/lib/types'

export interface NotificationFeedSnapshot {
  /** Newest-first merged view: pending + recently delivered. */
  items: AlertInfo[]
  /** ISO timestamp of the newest item the user has actually SEEN (panel open). */
  lastSeenAt: string | null
  /** Bumped on every write — cheap change signal. */
  revision: number
}

const LS_KEY = 'mist:notifLastSeen'

let snapshot: NotificationFeedSnapshot = {
  items: [],
  lastSeenAt: null,
  revision: 0,
}

const listeners = new Set<() => void>()

function loadLastSeen(): string | null {
  if (typeof window === 'undefined') return null
  try {
    return window.localStorage.getItem(LS_KEY)
  } catch {
    return null
  }
}

if (typeof window !== 'undefined') {
  snapshot = { ...snapshot, lastSeenAt: loadLastSeen() }
}

function emit(): void {
  snapshot = { ...snapshot, revision: snapshot.revision + 1 }
  for (const cb of listeners) {
    try {
      cb()
    } catch {
      /* one bad subscriber never breaks the rest */
    }
  }
}

/** The delivery loop publishes each poll's pending + recent-delivered rows. */
export function publishNotificationFeed(pending: AlertInfo[], recent: AlertInfo[]): void {
  const merged = [...pending, ...recent]
  // dedup by id, newest-first
  const byId = new Map<string, AlertInfo>()
  for (const a of merged) byId.set(a.id, a)
  const items = [...byId.values()]
    .filter((a) => a.status === 'pending' || a.delivered_at)
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
    .slice(0, 40)
  snapshot = { ...snapshot, items }
  emit()
}

/** A locally-surfaced notification (welcome briefing) joins the same feed. */
export function pushLocalNotification(alert: AlertInfo): void {
  snapshot = { ...snapshot, items: [alert, ...snapshot.items].slice(0, 40) }
  emit()
}

/** The panel opened / mark-all-read — everything up to now counts as seen. */
export function markNotificationsSeen(): void {
  const now = new Date().toISOString()
  try {
    window.localStorage.setItem(LS_KEY, now)
  } catch {
    /* best-effort */
  }
  snapshot = { ...snapshot, lastSeenAt: now }
  emit()
}

/** Count of items newer than lastSeenAt (bell badge). */
export function unreadNotificationCount(): number {
  const seen = snapshot.lastSeenAt ? Date.parse(snapshot.lastSeenAt) : 0
  if (!Number.isFinite(seen) || seen === 0) return Math.min(snapshot.items.length, 9)
  return snapshot.items.filter((a) => Date.parse(a.created_at) > seen).length
}

export function subscribeNotificationFeed(cb: () => void): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

export function getNotificationFeed(): NotificationFeedSnapshot {
  return snapshot
}
