// OS notifications — M.I.S.T. in the PC's notification panel.
//
// The Web Notifications API puts a real desktop toast in the OS notification
// center (Windows action center / macOS notification center / Linux), where
// it survives even when the browser tab is in the background. Permission is
// requested once from the bell panel; clicks focus the app back.
//
// Every entry point is defensive: unsupported (mobile Safari quirks, denied
// permission, notification constructor throw) degrades to silent — the
// in-app toast still fired, so nothing is ever lost.

export type OsPermissionState = 'unsupported' | 'default' | 'granted' | 'denied'

interface NotificationCtor {
  new (title: string, options?: NotificationOptions): Notification
  permission?: NotificationPermission
  requestPermission?: (callback?: (p: NotificationPermission) => void) => Promise<NotificationPermission>
  maxActions?: number
}

function ctor(): NotificationCtor | null {
  if (typeof window === 'undefined') return null
  const w = window as unknown as { Notification?: NotificationCtor }
  return w.Notification ?? null
}

export function osNotificationsSupported(): boolean {
  return ctor() !== null && typeof ctor()?.requestPermission === 'function'
}

export function osNotificationPermission(): OsPermissionState {
  const N = ctor()
  if (!N || typeof N.requestPermission !== 'function') return 'unsupported'
  const p = N.permission
  if (p === 'granted' || p === 'denied') return p
  return 'default'
}

/** Ask the browser for permission (must run from a user gesture). */
export async function requestOsNotifications(): Promise<OsPermissionState> {
  const N = ctor()
  if (!N || typeof N.requestPermission !== 'function') return 'unsupported'
  try {
    const p = await N.requestPermission()
    return p === 'granted' || p === 'denied' ? p : 'default'
  } catch {
    return osNotificationPermission()
  }
}

/** Dedup guard — the same tag replaces (not stacks) repeat notifications. */
const shownTags = new Set<string>()

/**
 * Fire a desktop notification. Returns true when one actually went out.
 * Clicking it focuses this tab and switches to the chat view so the creator
 * lands right on the conversation the alert belongs to.
 */
export function showOsNotification(title: string, body: string, tag?: string): boolean {
  const N = ctor()
  if (!N) return false
  if (osNotificationPermission() !== 'granted') return false
  if (tag && shownTags.has(tag)) return false // identical alert never double-fires
  try {
    const n = new N(title, {
      body: body.slice(0, 220),
      tag,
      icon: '/mist-mark.png',
      badge: '/mist-mark.png',
      // silent: true — her own voice (spoken warnings) is the sound; the OS
      // chime on top of her talking would be noise
      silent: true,
    })
    n.onclick = () => {
      try {
        window.focus()
        n.close()
      } catch {
        /* already closed */
      }
    }
    if (tag) {
      shownTags.add(tag)
      // keep the dedup set small
      if (shownTags.size > 60) {
        const first = shownTags.values().next().value
        if (first !== undefined) shownTags.delete(first)
      }
    }
    return true
  } catch {
    // constructor threw (rare browser policies) — the in-app toast carries it
    return false
  }
}
