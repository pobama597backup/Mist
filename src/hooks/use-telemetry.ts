// Telemetry poller with rolling history for sparklines.
'use client'

import { useEffect, useRef, useState } from 'react'
import { mistApi } from '@/lib/mist-api'
import type { TelemetryResponse } from '@/lib/types'

const MAX_HISTORY = 60

export function useTelemetry(enabled = true, intervalMs = 2000) {
  const [data, setData] = useState<TelemetryResponse | null>(null)
  const [history, setHistory] = useState<TelemetryResponse[]>([])
  const [error, setError] = useState<string | null>(null)
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    if (!enabled) return

    const poll = async () => {
      try {
        const t = await mistApi.telemetry()
        if (!alive.current) return
        setData(t)
        setError(null)
        setHistory((h) => [...h.slice(-(MAX_HISTORY - 1)), t])
      } catch (e) {
        if (alive.current) setError(e instanceof Error ? e.message : 'telemetry unavailable')
      }
    }

    poll()
    const id = setInterval(poll, intervalMs)
    return () => {
      alive.current = false
      clearInterval(id)
    }
  }, [enabled, intervalMs])

  return { data, history, error }
}
