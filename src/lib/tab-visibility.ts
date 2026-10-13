// M.I.S.T. tab-visibility store (Phase 3-b · TabBoundary).
//
// The shared door for page visibility: ONE document listener for the whole
// app instead of a private listener per surface. The boundary consumers
// (chat-panel, neural-core, browser-window, settings-view) pause their rAF
// loops and polling intervals while document.hidden and resume on return —
// a hidden tab burns no timers.
//
// The store is a factory so the test suite can drive it with an injected
// document (no jsdom): createVisibilityStore(null) is the SSR/no-DOM shape
// and always reports visible (never pause what you cannot observe).
'use client'

export interface VisibilityDocumentLike {
  hidden: boolean
  addEventListener(type: 'visibilitychange', fn: () => void): void
  removeEventListener(type: 'visibilitychange', fn: () => void): void
}

export interface VisibilityStore {
  /** Subscribe to visibility flips. Returns the unsubscribe fn. */
  subscribe(fn: () => void): () => void
  /** True when the tab is (or is assumed to be) visible. */
  getSnapshot(): boolean
}

export function createVisibilityStore(doc: VisibilityDocumentLike | null): VisibilityStore {
  let visible = doc ? !doc.hidden : true
  const subs = new Set<() => void>()
  let listening = false

  const onVisibility = () => {
    const next = doc ? !doc.hidden : true
    if (next === visible) return
    visible = next
    for (const fn of subs) fn()
  }

  return {
    subscribe(fn) {
      subs.add(fn)
      if (doc && !listening) {
        doc.addEventListener('visibilitychange', onVisibility)
        listening = true
      }
      return () => {
        subs.delete(fn)
        // The document listener lives exactly as long as the last subscriber
        // (subscribe/unsubscribe pairs balance — strict-mode safe).
        if (doc && listening && subs.size === 0) {
          doc.removeEventListener('visibilitychange', onVisibility)
          listening = false
        }
      }
    },
    getSnapshot: () => visible,
  }
}

let singleton: VisibilityStore | null = null

/** The app-wide store, bound to the real document (SSR-safe: no document →
 *  a store that always reports visible and never subscribes). */
export function tabVisibility(): VisibilityStore {
  if (!singleton) {
    singleton = createVisibilityStore(
      typeof document !== 'undefined' ? document : null
    )
  }
  return singleton
}
