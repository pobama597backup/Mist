// M.I.S.T. use-events — Phase 4-a · R11: the ONE shared events channel.
//
// Replaces the UI's per-mount pollers (use-alerts' 30s interval, the approval
// bell's 30s interval, use-backend's 10s×2 health polls) with a single
// EventSource on GET /api/mist/events. The channel is a module singleton
// (like the audio session / interrupt bus); hooks subscribe through it.
//
// Semantics (mandate R11):
//   · PAUSE ON HIDDEN — the EventSource CLOSES while document.hidden (the
//     shared tab-visibility store drives it) and reopens with fresh panels
//     on return; the post-reconnect snapshot carries catch-up state.
//   · PANELS SIGNAL — the client tells the server which panels are mounted
//     (?panels=chat,diagnostics); view switches re-open the channel so the
//     signal stays honest (cheap: one reconnect per view change).
//   · COALESCED — change events only; heartbeats keep the connection alive.
//
// The channel factory takes an injected visibility store + EventSource
// factory (the tabboundary test pattern) so the pause/reconnect semantics
// are unit-testable without a DOM.
'use client'

import { useEffect, useSyncExternalStore } from 'react'
import { useMistStore } from '@/lib/store'
import { tabVisibility, type VisibilityStore } from '@/lib/tab-visibility'
import { panelsFromState, type MistEvent } from '@/lib/events-protocol'

/** The EventSource surface the channel uses (injectable for tests; optional
 *  METHOD syntax keeps the DOM EventSource structurally assignable while
 *  staying assignable FROM our zero-arg callbacks). */
export interface EventSourceLike {
  onopen?(ev?: unknown): void
  onerror?(ev?: unknown): void
  onmessage?(ev: { data: string }): void
  readonly readyState: number
  close(): void
}

export type ChannelState = 'idle' | 'connecting' | 'open' | 'paused' | 'error'

export interface ChannelStatus {
  state: ChannelState
  /** SSE connect round-trip (ms) — measured on every (re)connect; it is the
   *  honest live-backend latency the status bar's CORE chip displays. */
  rttMs: number | null
}

export type EventsListener = (e: MistEvent) => void
export type StatusListener = (s: ChannelStatus) => void

export interface EventsChannel {
  /** Open (or keep open) with the given panels — reconnects when the panels
   *  signal changes. Idempotent: same panels → no-op. */
  open: (panels: string[]) => void
  /** Close because the tab is hidden (retain last-known status). */
  pause: () => void
  subscribeEvents: (cb: EventsListener) => () => void
  subscribeStatus: (cb: StatusListener) => () => void
  getStatus: () => ChannelStatus
}

export function createEventsChannel(opts: {
  visibility: VisibilityStore
  createSource?: (url: string) => EventSourceLike
  /** Hook the visibility store into open/pause (default: wired by the
   *  factory — the store's flips drive the channel). */
  autoVisibility?: boolean
}): EventsChannel {
  const { visibility, createSource } = opts
  const autoVisibility = opts.autoVisibility ?? true

  let status: ChannelStatus = { state: 'idle', rttMs: null }
  let source: EventSourceLike | null = null
  let panelsKey = ''
  let openedAt = 0
  /** Neutralizes the previous source's handlers after close/reconnect. */
  let generation = 0

  const eventSubs = new Set<EventsListener>()
  const statusSubs = new Set<StatusListener>()

  const setStatus = (next: ChannelStatus) => {
    status = next
    for (const cb of statusSubs) {
      try {
        cb(status)
      } catch {
        /* one bad subscriber never breaks the rest */
      }
    }
  }

  const closeSource = () => {
    if (!source) return
    const s = source
    source = null
    try {
      s.close()
    } catch {
      /* already closed */
    }
    // no handler nulling needed: a closed source fires nothing, and the
    // generation guard below neutralizes any late callback regardless
  }

  const open = (panels: string[]) => {
    const key = panels.join(',')
    if (source && panelsKey === key && status.state !== 'error') return // already live
    closeSource()
    panelsKey = key
    generation += 1
    const myGen = generation
    openedAt = Date.now()
    setStatus({ state: 'connecting', rttMs: null })
    const url = `/api/mist/events?panels=${encodeURIComponent(key)}`
    let es: EventSourceLike
    try {
      es = createSource
        ? createSource(url)
        : // (the DOM EventSource's nullable handler properties don't fit the
          //  non-nullable method surface above — the structural mismatch is
          //  ONLY that null; the runtime contract is identical)
          (new EventSource(url) as unknown as EventSourceLike)
    } catch {
      setStatus({ state: 'error', rttMs: null })
      return
    }
    source = es
    es.onopen = () => {
      if (myGen !== generation) return // stale source (replaced mid-flight)
      setStatus({ state: 'open', rttMs: Math.max(0, Date.now() - openedAt) })
    }
    es.onerror = () => {
      if (myGen !== generation || !source) return
      // native EventSource retries automatically — report the drop honestly;
      // a successful retry fires onopen again.
      setStatus({ state: 'error', rttMs: null })
    }
    es.onmessage = (ev) => {
      if (myGen !== generation) return
      try {
        const parsed = JSON.parse(ev.data) as MistEvent
        if (!parsed || typeof parsed.type !== 'string') return
        for (const cb of eventSubs) {
          try {
            cb(parsed)
          } catch {
            /* one bad subscriber never breaks the rest */
          }
        }
      } catch {
        /* malformed frame — ignore */
      }
    }
  }

  const pause = () => {
    closeSource()
    panelsKey = ''
    if (status.state !== 'idle') setStatus({ state: 'paused', rttMs: status.rttMs })
  }

  if (autoVisibility) {
    // Hidden → pause; visible again → reopen (the caller's hook re-issues
    // open() with fresh panels right after; this wiring guarantees the pause
    // even if the hook effect is somehow missed).
    visibility.subscribe(() => {
      if (visibility.getSnapshot()) {
        // reopen with the last-known panels — the hook's open() refreshes
        // them if they changed while hidden
        if (panelsKey) open(panelsKey.split(','))
      } else {
        pause()
      }
    })
  }

  return {
    open,
    pause,
    subscribeEvents: (cb) => {
      eventSubs.add(cb)
      return () => {
        eventSubs.delete(cb)
      }
    },
    subscribeStatus: (cb) => {
      statusSubs.add(cb)
      return () => {
        statusSubs.delete(cb)
      }
    },
    getStatus: () => status,
  }
}

// ---------------------------------------------------------------- singleton

let singleton: EventsChannel | null = null

/** The app-wide channel (bound to the real document + EventSource). */
export function mistEvents(): EventsChannel {
  if (!singleton) {
    singleton = createEventsChannel({
      visibility: tabVisibility(),
      // (same null-only structural mismatch as open() — see the note there)
      createSource: (url) => new EventSource(url) as unknown as EventSourceLike,
    })
  }
  return singleton
}

/** Subscribe to every parsed channel event (no React state — poller hooks
 *  call this inside their effects). Returns the unsubscribe fn. */
export function subscribeMistEvents(cb: EventsListener): () => void {
  return mistEvents().subscribeEvents(cb)
}

/** Subscribe to channel status flips (open/error/paused + the connect RTT).
 *  Returns the unsubscribe fn. */
export function subscribeMistEventStatus(cb: StatusListener): () => void {
  return mistEvents().subscribeStatus(cb)
}

/** Latest channel status (pull side). */
export function mistEventStatus(): ChannelStatus {
  return mistEvents().getStatus()
}

// ---------------------------------------------------------------- the hook

const serverVisible = () => true

/**
 * Mount ONCE (the app shell). Owns the channel lifecycle: opens with the
 * live panels signal, pauses while the tab is hidden, reopens on return.
 * Strict-mode safe — open() is idempotent for identical panels.
 */
export function useMistEventsChannel(): void {
  const view = useMistStore((s) => s.view)
  const drawerOpen = useMistStore((s) => s.drawerOpen)
  const browserOpen = useMistStore((s) => s.browser.open)
  const store = tabVisibility()
  const visible = useSyncExternalStore(store.subscribe, store.getSnapshot, serverVisible)
  const panels = panelsFromState(view, drawerOpen, browserOpen)

  useEffect(() => {
    const channel = mistEvents()
    if (!visible) {
      channel.pause()
      return
    }
    channel.open(panels)
  }, [visible, panels])
}
