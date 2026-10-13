// Backend health — Phase 4-a · R11: the events channel edition.
//
// The old 10s /api/mist/health interval is gone (it ran TWICE — the shell
// and the status bar each mounted a poller). The channel's lifecycle now
// carries the truth: onopen measures the SSE connect round-trip (the honest
// live-backend latency the CORE chip displays, refreshed on every
// reconnect), onerror marks the backend down (EventSource retries
// natively), and a paused channel (hidden tab) RETAINS the last known
// state instead of flapping the chip red while nobody is looking.
//
// Public API unchanged: returns the backend slice, works with or without
// args (the old interval parameter is accepted and ignored — callers keep
// compiling, the channel owns the cadence).
'use client'

import { useEffect } from 'react'
import { useMistStore } from '@/lib/store'
import { subscribeMistEventStatus } from '@/hooks/use-events'

export function useBackendStatus(_intervalMs = 10_000) {
  const backend = useMistStore((s) => s.backend)
  const setBackend = useMistStore((s) => s.setBackend)
  void _intervalMs // retained for API compatibility — the channel owns cadence

  useEffect(() => {
    const unsub = subscribeMistEventStatus((s) => {
      if (s.state === 'open') {
        setBackend({ online: true, latency: s.rttMs })
      } else if (s.state === 'error') {
        setBackend({ online: false, latency: null })
      }
      // 'connecting' / 'paused' (hidden tab) / 'idle' — retain the last
      // known state; no flap, no phantom offline.
    })
    return unsub
  }, [setBackend])

  return backend
}
