'use client'

// M.I.S.T. — SystemPulse (oj-face-5, OpenJarvis UX port).
//
// The 3-state activity strip, OpenJarvis's ambient heartbeat:
//   idle        — calm low-opacity gradient (no travel)
//   inferencing — soft traveling gradient (mist-shimmer, 2.6s — gentle)
//   agent-active— faster traveling gradient (1.1s) + activity count pill
//
// Drive sources (all real): the neural mirror state (store), the live
// research flag (store) and a lightweight 45s poll of /api/mist/missions
// counting status:'running' missions. Honest degradation: the mission poll
// failing leaves the strip on the neural/research signals (never blocks).
//
// Reduced motion: the traveling gradient is a background-position mover —
// disabled under reduced motion; the strip keeps a static gradient and the
// app's opacity heartbeat so the state stays legible without motion.

import { useEffect, useState } from 'react'
import { useMistStore } from '@/lib/store'
import { cn } from '@/lib/utils'

type PulseState = 'idle' | 'inferencing' | 'agent-active'

/** Cheap mission counter poll — 45s, self-swallowing. */
function useActiveMissionCount(): number {
  const [count, setCount] = useState(0)
  useEffect(() => {
    let alive = true
    const poll = async () => {
      try {
        const ctrl = new AbortController()
        const t = setTimeout(() => ctrl.abort(), 6000)
        const res = await fetch('/api/mist/missions', { signal: ctrl.signal })
        clearTimeout(t)
        if (!alive) return
        if (!res.ok) return // keep the last count — honest soft-fail
        const body = (await res.json().catch(() => null)) as { missions?: Array<{ status?: string }> } | null
        if (!alive || !body || !Array.isArray(body.missions)) return
        setCount(body.missions.filter((m) => m && m.status === 'running').length)
      } catch {
        /* network unreachable — keep the last count */
      }
    }
    void poll()
    const timer = window.setInterval(() => void poll(), 45_000)
    return () => {
      alive = false
      window.clearInterval(timer)
    }
  }, [])
  return count
}

const STATE_COPY: Record<PulseState, string> = {
  idle: 'System idle',
  inferencing: 'Inferencing',
  'agent-active': 'Agents active',
}

export function SystemPulse() {
  const neuralState = useMistStore((s) => s.neural.state)
  const researchActive = useMistStore((s) => s.researchActive)
  const reduced = useMistStore((s) => s.reducedMotion)
  const activeMissions = useActiveMissionCount()

  // inferencing: a live LLM turn or research job. Speaking/listening are
  // interactive states — the mind is engaged, the gradient travels softly.
  const inferencing =
    researchActive ||
    neuralState === 'processing' ||
    neuralState === 'awakening' ||
    neuralState === 'speaking'
  const agentActive = activeMissions > 0

  const state: PulseState = agentActive ? 'agent-active' : inferencing ? 'inferencing' : 'idle'

  // traveling gradient speeds (idle never travels)
  const travelClass =
    state === 'agent-active'
      ? 'mist-shimmer-travel mist-travel-fast'
      : state === 'inferencing'
        ? 'mist-shimmer-travel'
        : ''

  return (
    <>
      {/* the strip — fixed above the status bar, full width, hairline height */}
      <div
        role="status"
        aria-label={`${STATE_COPY[state]}${agentActive ? ` — ${activeMissions} running` : ''}`}
        className="pointer-events-none fixed inset-x-0 bottom-11 z-40 h-1.5 overflow-hidden"
      >
        {/* base calm gradient — always present */}
        <div
          aria-hidden
          className={cn(
            'absolute inset-0 bg-gradient-to-r from-purple-400/10 via-teal-300/10 to-emerald-300/10 transition-opacity duration-700',
            state === 'idle' ? 'opacity-100' : 'opacity-40'
          )}
        />
        {/* traveling pulse — the working tell */}
        {state !== 'idle' ? (
          <div
            aria-hidden
            className={cn(
              'absolute inset-0 bg-gradient-to-r from-transparent via-purple-300/50 to-transparent bg-[length:200%_100%]',
              reduced ? 'animate-mist-pulse-glow' : travelClass
            )}
          />
        ) : null}
        {/* agent-active heat line along the edges */}
        {state === 'agent-active' ? (
          <div aria-hidden className="absolute inset-0 border-t border-fuchsia-400/25" />
        ) : null}
      </div>

      {/* activity count pill — agent-active only */}
      {state === 'agent-active' ? (
        <span
          className="mist-glass-soft fixed bottom-[3.75rem] right-3 z-40 inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 font-mono text-[10px] text-fuchsia-200/90"
          role="status"
          aria-label={`${activeMissions} mission${activeMissions === 1 ? '' : 's'} running`}
        >
          <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-fuchsia-400 animate-mist-pulse-glow" />
          {activeMissions} active
        </span>
      ) : null}

      {/* screen-reader state text (non-invasive — no live region spam) */}
      <span className="sr-only">{STATE_COPY[state]}</span>
    </>
  )
}
