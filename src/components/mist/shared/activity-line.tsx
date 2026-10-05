'use client'

// M.I.S.T. — ActivityLine (w3-activity): the quiet live status line that says
// what she is doing RIGHT NOW — "thinking", "reading package.json",
// "searching the web — mist console". One honest mono line, a pulsing teal
// dot, nothing else. Local state only (the label never enters the store, so
// label swaps re-render this component alone); it consumes the neural
// socket's 'activity' events while active and clears itself when the turn
// ends. `detail` is intentionally internal — the label is already specific.

import { useEffect, useRef, useState } from 'react'
import { getActivitySnapshot, useNeural, type ActivityMsg } from '@/hooks/use-neural'
import { cn } from '@/lib/utils'

export function ActivityLine({
  active,
  fallback = 'thinking',
  className,
  dotClassName,
}: {
  /** While true the line is shown and the activity stream is consumed. */
  active: boolean
  /** Label shown before the first activity event of the turn arrives. */
  fallback?: string
  className?: string
  dotClassName?: string
}) {
  const { onActivity } = useNeural()
  // Lazy initializer: a component mounted MID-TURN (e.g. the view switched
  // while she was already reading a file) starts on the current activity.
  const [label, setLabel] = useState<string | null>(() =>
    active ? getActivitySnapshot()?.label ?? null : null
  )
  // Turn boundary reset — render-phase state adjust (the React-endorsed
  // pattern, no effect needed): a deactivated line never resurrects a stale
  // label from the previous turn.
  const [wasActive, setWasActive] = useState(active)
  if (wasActive !== active) {
    setWasActive(active)
    setLabel(null)
  }
  // A late event racing the deactivate (activity emitted after the result
  // landed) must not resurrect the label.
  const activeRef = useRef(active)
  useEffect(() => {
    activeRef.current = active
  }, [active])

  useEffect(() => {
    if (!active) return
    // Subscribe only while the line is live — the unsub doubles as the
    // turn-end cleanup for parents that keep the component mounted.
    return onActivity((m: ActivityMsg) => {
      if (activeRef.current) setLabel(m.label)
    })
  }, [active, onActivity])

  if (!active) return null

  const text = label ?? fallback

  return (
    <span
      role="status"
      aria-live="polite"
      aria-label="Mist current activity"
      className={cn('inline-flex items-center gap-1.5 font-mono text-[10px] text-slate-400', className)}
    >
      <span aria-hidden className={cn('relative flex h-1.5 w-1.5 shrink-0', dotClassName)}>
        {/* soft halo — opacity-only pulses (no filters: Chrome glass flicker) */}
        <span className="absolute inset-0 animate-mist-pulse-glow rounded-full bg-teal-400/50" />
        <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-teal-400/90 shadow-[0_0_8px_rgba(45,212,191,0.55)]" />
      </span>
      {/* key={text} re-mounts the span per label so the swap keyframe replays */}
      <span key={text} className="mist-activity-swap truncate">
        {text}
      </span>
      <style>{`
        @keyframes mist-activity-in {
          from { opacity: 0; transform: translateY(3px); }
          to { opacity: 1; transform: translateY(0); }
        }
        .mist-activity-swap {
          animation: mist-activity-in 300ms ease-out both;
          will-change: opacity, transform;
        }
        @media (prefers-reduced-motion: reduce) {
          .mist-activity-swap { animation: none; will-change: auto; }
        }
      `}</style>
    </span>
  )
}
