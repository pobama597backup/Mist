// M.I.S.T. interrupt bus (mlv-ux-2) — a tiny module-level pub/sub for
// user-initiated interrupts: Mark-LV's tap-to-interrupt, web edition.
//
// The consciousness orb fires, the chat panel subscribes — neither needs to
// know about the other, and the store stays out of it entirely (frozen
// ownership: store.ts belongs to another lane). Deliberately dependency-free
// and browser-safe so any client component (or a plain module) can use it.

export type InterruptReason = 'orb-tap' | 'stop-button' | 'escape'

type InterruptCallback = (reason: InterruptReason) => void

const listeners = new Set<InterruptCallback>()

/**
 * Fire an interrupt to every subscriber (orb tap, Stop button, Escape key).
 * Subscriber errors are isolated — one bad listener never breaks the rest.
 */
export function fireInterrupt(reason: InterruptReason): void {
  for (const cb of listeners) {
    try {
      cb(reason)
    } catch (err) {
      // one bad subscriber must never break the others
      console.error('[mist-interrupt] listener failed', err)
    }
  }
}

/**
 * Subscribe to interrupts. Returns an unsubscribe function (React effects
 * return it directly).
 */
export function onInterrupt(cb: InterruptCallback): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}
