// M.I.S.T. TabBoundary hook (Phase 3-b) — the ergonomic surface over the
// shared visibility store (lib/tab-visibility.ts). `const { visible,
// visibleRef } = useTabBoundary('chat-panel')` gates rAF loops, polling
// intervals and other per-tick work while the tab is hidden; the ref mirror
// serves callbacks that outlive renders (the chat energy interval).
//
// Double-invocation-safe (reactStrictMode is ON): the hook only subscribes
// through useSyncExternalStore — subscribe/unsubscribe pairs balance inside
// React, and the underlying document listener is armed once per subscriber
// generation and disarmed with the last one.
'use client'

import { useEffect, useRef, useSyncExternalStore } from 'react'
import { tabVisibility } from '@/lib/tab-visibility'

export interface TabBoundary {
  /** False while document.hidden — gate render-visible work on this. */
  visible: boolean
  /** Ref mirror of `visible` for interval/timer callbacks (never read during render). */
  visibleRef: { current: boolean }
}

const serverVisible = () => true

export function useTabBoundary(name?: string): TabBoundary {
  const store = tabVisibility()
  const visible = useSyncExternalStore(store.subscribe, store.getSnapshot, serverVisible)
  const visibleRef = useRef(visible)
  useEffect(() => {
    visibleRef.current = visible
    // Dev-only manual-proof surface: window.__tabBoundary carries the live
    // flip count + the registered boundaries so a browser pass can watch the
    // pause/resume counter tick. Compiled out of production.
    if (process.env.NODE_ENV === 'development' && typeof window !== 'undefined') {
      const w = window as typeof window & {
        __tabBoundary?: { visible: boolean; names: string[] }
      }
      const names = w.__tabBoundary?.names ?? []
      if (name && !names.includes(name)) names.push(name)
      w.__tabBoundary = { visible, names }
    }
  }, [visible, name])
  return { visible, visibleRef }
}
