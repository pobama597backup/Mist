'use client'

// M.I.S.T. starfield — the ambient data-mote layer behind everything.
// ~90 depth-layered motes drift downward; drift speed scales with the
// consciousness state (the whole room accelerates with the mind), and the
// field parallaxes a few px toward the cursor. Pauses when hidden; collapses
// to a single static frame under reduced motion.

import { useEffect, useRef } from 'react'
import { useMistStore } from '@/lib/store'
import type { ConsciousnessState } from '@/lib/types'

const DRIFT: Record<ConsciousnessState, number> = {
  dormant: 0.25,
  awakening: 0.6,
  listening: 0.8,
  processing: 1.25,
  speaking: 1.0,
  dreaming: 0.35,
}

interface Mote {
  x: number // 0..1
  y: number // 0..1
  z: number // 0.2..1 depth
  size: number
  phase: number
  accent: string | null // null = neutral slate
}

export function Starfield() {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const reduced =
      useMistStore.getState().reducedMotion ||
      (typeof window !== 'undefined' &&
        window.matchMedia('(prefers-reduced-motion: reduce)').matches)

    let w = 1
    let h = 1
    let dpr = 1
    let raf = 0
    let running = true

    const motes: Mote[] = []
    const ACCENTS = ['#c084fc', '#5eead4', '#e879f9']
    const count = 90
    for (let i = 0; i < count; i++) {
      motes.push({
        x: Math.random(),
        y: Math.random(),
        z: 0.2 + Math.random() * 0.8,
        size: 0.6 + Math.random() * 1.4,
        phase: Math.random() * Math.PI * 2,
        accent: Math.random() < 0.1 ? ACCENTS[i % ACCENTS.length] : null,
      })
    }

    let px = 0
    let py = 0
    let ptx = 0
    let pty = 0
    const onPointerMove = (e: PointerEvent) => {
      ptx = (e.clientX / window.innerWidth - 0.5) * 2
      pty = (e.clientY / window.innerHeight - 0.5) * 2
    }
    window.addEventListener('pointermove', onPointerMove, { passive: true })

    const resize = () => {
      const rect = canvas.getBoundingClientRect()
      w = Math.max(1, rect.width)
      h = Math.max(1, rect.height)
      dpr = Math.min(window.devicePixelRatio || 1, 2)
      canvas.width = Math.round(w * dpr)
      canvas.height = Math.round(h * dpr)
    }
    const observer = new ResizeObserver(resize)
    observer.observe(canvas)
    resize()

    const draw = (nowMs: number, dt: number, animate: boolean) => {
      const store = useMistStore.getState()
      const speed = DRIFT[store.neural.state]

      if (animate) {
        px += (ptx - px) * 0.04
        py += (pty - py) * 0.04
      }
      const t = nowMs / 1000

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, w, h)

      for (const m of motes) {
        if (animate) {
          m.y += (0.008 + m.z * 0.014) * speed * dt
          if (m.y > 1.02) {
            m.y = -0.02
            m.x = Math.random()
          }
        }
        const wob = Math.sin(t * 0.4 + m.phase) * (6 + m.z * 10)
        const x = m.x * w + wob + px * (5 + m.z * 9)
        const y = m.y * h + py * (4 + m.z * 7)
        const alpha = (0.12 + m.z * 0.4) * (animate ? 0.75 + 0.25 * Math.sin(t * 1.8 + m.phase * 5) : 0.9)
        if (m.accent) {
          ctx.fillStyle = m.accent
          ctx.globalAlpha = alpha * 0.8
          ctx.beginPath()
          ctx.arc(x, y, m.size * (0.6 + m.z * 0.6), 0, Math.PI * 2)
          ctx.fill()
          ctx.globalAlpha = alpha * 0.25
          ctx.beginPath()
          ctx.arc(x, y, m.size * (2 + m.z * 2), 0, Math.PI * 2)
          ctx.fill()
        } else {
          ctx.fillStyle = `rgba(226, 232, 240, ${alpha})`
          ctx.beginPath()
          ctx.arc(x, y, m.size * (0.5 + m.z * 0.5), 0, Math.PI * 2)
          ctx.fill()
        }
      }
      ctx.globalAlpha = 1
    }

    const onVisibility = () => {
      if (document.hidden) {
        running = false
        cancelAnimationFrame(raf)
      } else if (!reduced) {
        running = true
        last = performance.now()
        raf = requestAnimationFrame(loop)
      }
    }
    document.addEventListener('visibilitychange', onVisibility)

    if (reduced) {
      draw(performance.now(), 0, false)
      return () => {
        observer.disconnect()
        window.removeEventListener('pointermove', onPointerMove)
        document.removeEventListener('visibilitychange', onVisibility)
      }
    }

    let last = performance.now()
    const loop = (now: number) => {
      if (!running) return
      const dt = Math.min(0.05, (now - last) / 1000)
      last = now
      draw(now, dt, true)
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)

    return () => {
      running = false
      cancelAnimationFrame(raf)
      observer.disconnect()
      window.removeEventListener('pointermove', onPointerMove)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [])

  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      className="pointer-events-none absolute inset-0 h-full w-full"
    />
  )
}
