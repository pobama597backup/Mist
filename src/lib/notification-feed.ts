// Notification feed — a tiny module store shared between the alert delivery
// loop (use-alerts, which polls every 30s) and the notification bell.
//
// Same pattern as interrupt-bus: dependency-free, browser-safe, no store.ts
// ownership (that file belongs to the settings lane). The delivery loop
// WRITES the latest snapshot; the bell READS it via useSyncExternalStore —
// one poller, many surfaces.
//
// ui-5+6b · per-item dismissal: a dismissed id is EXCLUDED from the feed —
// dismissed = gone from the panel. This is UI-level only: the underlying
// Alert rows in the DB (pending/delivered status, conversation binding) are
// NEVER touched, so a dismissal never falsely "resolves" a machine-health
// error — it only hides the card from this surface. Unread/read semantics
// stay time-based via lastSeenAt exactly as before. The persisted key is
// `mist:dismissedFeedIds` — deliberately separate from the in-chat heartbeat
// cards' `mist-dismissedAlertIds` (different surface, different system; a
// swipe in the chat must not wipe the bell's panel and vice versa).

import type { AlertInfo } from '@/lib/types'

export interface NotificationFeedSnapshot {
  /** Newest-first merged view: pending + recently delivered (dismissed excluded). */
  items: AlertInfo[]
  /** ISO timestamp of the newest item the user has actually SEEN (panel open). */
  lastSeenAt: string | null
  /** Bumped on every write — cheap change signal. */
  revision: number
}

const LS_KEY = 'mist:notifLastSeen'
const DISMISS_LS_KEY = 'mist:dismissedFeedIds'
/** Cap the persisted id list — years of swipes must not grow localStorage unbounded. */
const DISMISS_CAP = 200

let snapshot: NotificationFeedSnapshot = {
  items: [],
  lastSeenAt: null,
  revision: 0,
}

/** Dismissed ids — insertion-ordered (oldest first) so the cap drops the oldest. */
let dismissedIds = new Set<string>()

const listeners = new Set<() => void>()

function loadLastSeen(): string | null {
  if (typeof window === 'undefined') return null
  try {
    return window.localStorage.getItem(LS_KEY)
  } catch {
    return null
  }
}

function loadDismissed(): Set<string> {
  if (typeof window === 'undefined') return new Set()
  try {
    const raw = window.localStorage.getItem(DISMISS_LS_KEY)
    if (!raw) return new Set()
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return new Set()
    return new Set(parsed.filter((v): v is string => typeof v === 'string'))
  } catch {
    // corrupted payload — start fresh rather than lose the feed
    return new Set()
  }
}

function persistDismissed(): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(DISMISS_LS_KEY, JSON.stringify([...dismissedIds]))
  } catch {
    /* storage unavailable — session-only dismissal */
  }
}

if (typeof window !== 'undefined') {
  snapshot = { ...snapshot, lastSeenAt: loadLastSeen() }
  dismissedIds = loadDismissed()
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
  // dedup by id, newest-first — dismissed ids never re-enter the panel
  const byId = new Map<string, AlertInfo>()
  for (const a of merged) byId.set(a.id, a)
  const items = [...byId.values()]
    .filter((a) => (a.status === 'pending' || a.delivered_at) && !dismissedIds.has(a.id))
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
    .slice(0, 40)
  snapshot = { ...snapshot, items }
  emit()
}

/** A locally-surfaced notification (welcome briefing) joins the same feed. */
export function pushLocalNotification(alert: AlertInfo): void {
  if (dismissedIds.has(alert.id)) return // a re-pushed local item stays dismissed
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

/**
 * Dismiss ONE feed item — UI-level only. Persists the id (capped), removes
 * the item from the live snapshot and notifies subscribers. The DB Alert row
 * and the in-chat heartbeat card are deliberately untouched.
 */
export function dismissFeedItem(id: string): void {
  if (!dismissedIds.has(id)) {
    dismissedIds.add(id)
    // insertion order = dismissal order; drop the OLDEST past the cap so the
    // in-memory set and the persisted list always agree
    while (dismissedIds.size > DISMISS_CAP) {
      const oldest = dismissedIds.values().next().value
      if (oldest === undefined) break
      dismissedIds.delete(oldest)
    }
    persistDismissed()
  }
  const items = snapshot.items.filter((a) => a.id !== id)
  if (items.length === snapshot.items.length) return // already gone — nothing to emit
  snapshot = { ...snapshot, items }
  emit()
}

/** Count of items newer than lastSeenAt (bell badge) — dismissed excluded. */
export function unreadNotificationCount(): number {
  const seen = snapshot.lastSeenAt ? Date.parse(snapshot.lastSeenAt) : 0
  if (!Number.isFinite(seen) || seen === 0) {
    return Math.min(snapshot.items.filter((a) => !dismissedIds.has(a.id)).length, 9)
  }
  return snapshot.items.filter((a) => !dismissedIds.has(a.id) && Date.parse(a.created_at) > seen).length
}

/** Total items currently in the feed (dismissed excluded) — panel sizing + honest badges. */
export function feedUndismissedCount(): number {
  return snapshot.items.filter((a) => !dismissedIds.has(a.id)).length
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
