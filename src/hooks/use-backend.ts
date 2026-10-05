// Backend health poller — measures /api/mist/health round-trip latency.
'use client'

import { useEffect } from 'react'
import { useMistStore } from '@/lib/store'

export function useBackendStatus(intervalMs = 10000) {
  const backend = useMistStore((s) => s.backend)
  const setBackend = useMistStore((s) => s.setBackend)

  useEffect(() => {
    let alive = true

    const check = async () => {
      const t0 = performance.now()
      try {
        const res = await fetch('/api/mist/health', { cache: 'no-store' })
        if (!alive) return
        setBackend({ online: res.ok, latency: Math.round(performance.now() - t0) })
      } catch {
        if (alive) setBackend({ online: false, latency: null })
      }
    }

    check()
    const id = setInterval(check, intervalMs)
    window.addEventListener('focus', check)
    return () => {
      alive = false
      clearInterval(id)
      window.removeEventListener('focus', check)
    }
  }, [intervalMs, setBackend])

  return backend
}
