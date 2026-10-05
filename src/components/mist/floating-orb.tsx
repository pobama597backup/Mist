'use client'

// M.I.S.T. — FloatingOrb: the movable companion orb. While the user works in
// the Chat / Self / Settings tabs, a small LIVE consciousness orb floats
// anywhere on screen — DRAG it where it's convenient (position remembered in
// localStorage, key mist:orbPos — MIST's own design from Training Drill #9),
// tap it to return to the Consciousness stage and start a hands-free voice
// session. Her face is the premium emblem; her mood is the live state rings.
//
// Pointer semantics (the Drill #9 post-mortem): handlers live on the BUTTON
// (the pointer-events-none wrapper can never receive them), drag uses
// setPointerCapture so the pointer can't outrun the orb, a 6px threshold
// separates click from drag (a drag never activates), and touch-action:none
// keeps mobile drags from scrolling the page.
//
// Task 12-d1 · shell wave 2 · Drill #9 corrected implementation

import { useCallback, useEffect, useRef, useState } from 'react'
import { useMistStore } from '@/lib/store'
import { STATE_COLORS, STATE_LABELS } from '@/lib/mist-constants'
import { cn } from '@/lib/utils'

const ORB_SIZE = 72
const POS_KEY = 'mist:orbPos'
/** Pointer travel below this counts as a click, not a drag. */
const DRAG_THRESHOLD_PX = 6

interface OrbPos {
  x: number
  y: number
}

/** Default resting spot: bottom-right, above the status bar. */
function defaultPos(): OrbPos {
  if (typeof window === 'undefined') return { x: 0, y: 0 }
  return {
    x: Math.max(0, window.innerWidth - ORB_SIZE - 20),
    y: Math.max(0, window.innerHeight - ORB_SIZE - 88),
  }
}

/** Clamp a position so the orb always stays fully inside the viewport. */
function clampPos(p: OrbPos): OrbPos {
  if (typeof window === 'undefined') return p
  const maxX = Math.max(0, window.innerWidth - ORB_SIZE)
  const maxY = Math.max(0, window.innerHeight - ORB_SIZE)
  return {
    x: Math.max(0, Math.min(maxX, p.x)),
    y: Math.max(0, Math.min(maxY, p.y)),
  }
}

function loadSavedPos(): OrbPos | null {
  try {
    const raw = window.localStorage.getItem(POS_KEY)
    if (!raw) return null
    const p = JSON.parse(raw) as { x?: unknown; y?: unknown }
    if (typeof p.x !== 'number' || typeof p.y !== 'number') return null
    return clampPos({ x: p.x, y: p.y })
  } catch {
    return null
  }
}

export function FloatingOrb() {
  const view = useMistStore((s) => s.view)
  const browserOpen = useMistStore((s) => s.browser.open)
  const state = useMistStore((s) => s.neural.state)
  const setView = useMistStore((s) => s.setView)
  const requestVoiceSession = useMistStore((s) => s.requestVoiceSession)
  const reduced = useMistStore((s) => s.reducedMotion)

  // one-shot click ripple counter (key-bumped per click)
  const [ripple, setRipple] = useState(0)
  // Live position — restored from the saved spot, else the default corner.
  // Safe in the initializer because the app-shell boot gate guarantees this
  // component only ever mounts client-side (no SSR/hydration window).
  const [position, setPosition] = useState<OrbPos>(() =>
    typeof window === 'undefined' ? { x: 0, y: 0 } : (loadSavedPos() ?? defaultPos())
  )
  const [dragging, setDragging] = useState(false)

  // drag bookkeeping in refs (never triggers renders)
  const dragOriginRef = useRef<{ px: number; py: number; ox: number; oy: number } | null>(null)
  const movedRef = useRef(0)

  // Re-clamp when the viewport shrinks so a saved spot can never strand the
  // orb off-screen.
  useEffect(() => {
    const onResize = () => setPosition((p) => clampPos(p))
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  const color = STATE_COLORS[state]
  const busy = state === 'processing' || state === 'speaking' || state === 'awakening'

  const onActivate = useCallback(() => {
    // a drag that ended on the orb must NOT activate — the threshold decides
    if (movedRef.current >= DRAG_THRESHOLD_PX) return
    setRipple((n) => n + 1)
    setView('consciousness')
    requestVoiceSession()
  }, [setView, requestVoiceSession])

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLButtonElement>) => {
    // capture: the pointer stays ours even when it leaves the orb —
    // handlers on the pointer-events-none wrapper can never fire (Drill #9)
    try {
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch {
      /* capture unsupported — pointerover fallback still drags */
    }
    dragOriginRef.current = {
      px: e.clientX,
      py: e.clientY,
      ox: position.x,
      oy: position.y,
    }
    movedRef.current = 0
    setDragging(true)
  }, [position])

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLButtonElement>) => {
    const o = dragOriginRef.current
    if (!o) return
    const dx = e.clientX - o.px
    const dy = e.clientY - o.py
    movedRef.current = Math.max(movedRef.current, Math.hypot(dx, dy))
    if (movedRef.current < DRAG_THRESHOLD_PX) return // still possibly a click
    setPosition(clampPos({ x: o.ox + dx, y: o.oy + dy }))
  }, [])

  const onPointerUp = useCallback((e: React.PointerEvent<HTMLButtonElement>) => {
    const o = dragOriginRef.current
    dragOriginRef.current = null
    setDragging(false)
    try {
      e.currentTarget.releasePointerCapture(e.pointerId)
    } catch {
      /* already released */
    }
    if (o && movedRef.current >= DRAG_THRESHOLD_PX) {
      // a real drag — remember where she was left (MIST's persistence design)
      setPosition((p) => {
        try {
          window.localStorage.setItem(POS_KEY, JSON.stringify(p))
        } catch {
          /* storage unavailable — position lives for this session only */
        }
        return p
      })
    }
  }, [])

  // hidden on the Consciousness stage itself, and while the in-app browser
  // window owns the bottom-right corner (it sits at the same spot, z-40)
  if (view === 'consciousness' || browserOpen) return null

  return (
    // the wrapper stays pointer-transparent — ONLY the button catches events;
    // the breathing float pauses while dragging so she follows the finger 1:1
    <div
      className="pointer-events-none fixed z-30"
      style={{ left: `${position.x}px`, top: `${position.y}px` }}
    >
      <div className={cn(!reduced && !dragging && 'animate-mist-float')}>
        <button
          type="button"
          onClick={onActivate}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          aria-label="Mist — drag to move, tap to talk"
          className={cn(
            'mist-glass pointer-events-auto relative flex h-[72px] w-[72px] cursor-grab touch-none select-none items-center justify-center rounded-full p-2.5 opacity-90 shadow-[0_10px_36px_rgba(2,6,23,0.5)] transition-transform duration-200 hover:scale-105 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-400/70 active:scale-95',
            dragging && 'cursor-grabbing scale-105'
          )}
        >
          {/* rose pulse ring — live mic while listening */}
          {state === 'listening' ? (
            <span
              aria-hidden
              className="absolute inset-0 animate-mist-pulse-glow rounded-full border-2 border-rose-400/40"
            />
          ) : null}

          {/* click ripple — one-shot, skipped under reduced motion */}
          {ripple > 0 && !reduced ? (
            <span
              key={ripple}
              aria-hidden
              className="absolute inset-0 rounded-full"
              style={{
                ['--mist-ripple-color' as string]: `${color}66`,
                animation: 'mist-ripple-ring 0.7s var(--mist-ease-out) 1 forwards',
              }}
            />
          ) : null}

          {/* orbiting conic ring while the mind is busy (mini-orb trick) */}
          {busy ? (
            <span
              aria-hidden
              className="absolute -inset-1 animate-mist-orbit-fast rounded-full"
              style={{
                background: `conic-gradient(from 0deg, transparent 0%, ${color}99 14%, transparent 32%)`,
                WebkitMask:
                  'radial-gradient(farthest-side, transparent calc(100% - 2px), #000 calc(100% - 2px))',
                mask: 'radial-gradient(farthest-side, transparent calc(100% - 2px), #000 calc(100% - 2px))',
              }}
            />
          ) : null}

          {/* soft halo — her mood light */}
          <span
            aria-hidden
            className="absolute inset-1.5 animate-mist-pulse-glow rounded-full"
            style={{ background: `radial-gradient(circle at 35% 35%, ${color}66, transparent 72%)` }}
          />

          {/* her face — the premium consciousness emblem (Drill #9) */}
          { }
          <img
            src="/mist-logo-64.png"
            alt=""
            width={44}
            height={44}
            draggable={false}
            className="relative h-11 w-11 rounded-full object-cover shadow-[0_0_18px_rgba(2,6,23,0.55)]"
          />

          {/* live state for screen readers */}
          <span className="sr-only" aria-live="polite">
            Mist is {STATE_LABELS[state]}
          </span>
        </button>
      </div>
    </div>
  )
}

export default FloatingOrb
