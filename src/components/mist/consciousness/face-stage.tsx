'use client'

// M.I.S.T. FaceStage (v7) — the consciousness stage as one of the
// adapted ai-visualizer canvas faces, served from /av/faces/* and fed LIVE by
// window.__mistBus (installed by useFaceBusEmitter): the face hears, thinks
// and speaks with Mist's real voice state and real waveform.
//
// The iframes are same-origin, so the shim injected into each face reads the
// parent's bus directly. F/S/C key handling (fullscreen / cinematic camera)
// works inside the iframe once it has focus. While the in-app browser window
// is open the face docks top-right exactly like the orb does.

import { useEffect, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import type { ConsciousnessFace } from '@/lib/types'
import { useMistStore } from '@/lib/store'
import { cn } from '@/lib/utils'

// w3-mouth: M.I.S.T.'s own clean-room face joins the adapted ai-visualizer
// set. 'visage' is now part of the ConsciousnessFace union itself (the lead
// widened types.ts when the picker seam was closed) — this local type is
// kept as the non-orb face id for the FACE_META record.
export type FaceStageFace = Exclude<ConsciousnessFace, 'orb'>

const FACE_META: Record<FaceStageFace, { title: string; src: string }> = {
  board: { title: 'M.I.S.T. — Circuit Board face', src: '/av/faces/board/index.html' },
  radial: { title: 'M.I.S.T. — Radial face', src: '/av/faces/radial/index.html' },
  rain: { title: 'M.I.S.T. — Face in the Code', src: '/av/faces/rain/index.html' },
  neural: { title: 'M.I.S.T. — Neural Core face', src: '/av/faces/neural/index.html' },
  visage: {
    title: 'M.I.S.T. — Visage (mouth-tracking face)',
    src: '/av/faces/visage/index.html',
  },
}

export function FaceStage({
  face,
  docked,
  className,
}: {
  face: FaceStageFace
  docked: boolean
  className?: string
}) {
  const reduced = useMistStore((s) => s.reducedMotion)
  const [loaded, setLoaded] = useState(false)
  const meta = FACE_META[face]
  const frameRef = useRef<HTMLIFrameElement | null>(null)

  // face swap → reset the loaded flag so the materialize veil plays again
  // (deferred to a macrotask — the lint rule forbids sync setState in effects)
  const faceRef = useRef(face)
  useEffect(() => {
    if (faceRef.current === face) return
    faceRef.current = face
    const id = window.setTimeout(() => setLoaded(false), 0)
    return () => window.clearTimeout(id)
  }, [face])

  // click anywhere on the face → focus it so F/Space/C keys work
  useEffect(() => {
    const el = frameRef.current
    if (!el) return
    const focus = () => {
      try {
        el.contentWindow?.focus()
      } catch {
        /* not ready yet */
      }
    }
    el.addEventListener('load', focus)
    return () => el.removeEventListener('load', focus)
  }, [face])

  return (
    <motion.div
      layout={reduced ? false : true}
      animate={{ opacity: 1 }}
      transition={reduced ? { duration: 0 } : { type: 'spring', stiffness: 150, damping: 20 }}
      className={cn(
        'relative overflow-hidden',
        docked
          ? 'absolute right-4 top-4 z-30 h-40 w-40 rounded-2xl border border-white/10 shadow-2xl sm:right-6 sm:top-6 sm:h-48 sm:w-48'
          : 'h-full w-full rounded-none',
        className
      )}
    >
      {/* materialize veil — the canvas engines take a beat to boot */}
      {!loaded && (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center bg-[#04060b] font-mono text-[10px] uppercase tracking-[0.4em] text-teal-300/70"
        >
          materializing
          <span className="mist-shimmer-text ml-1">…</span>
        </div>
      )}
      <iframe
        ref={frameRef}
        src={meta.src}
        title={meta.title}
        aria-label={meta.title}
        onLoad={() => setLoaded(true)}
        allow="microphone"
        allowFullScreen
        className={cn(
          'h-full w-full border-0 bg-black transition-opacity duration-700',
          loaded ? 'opacity-100' : 'opacity-0'
        )}
      />
    </motion.div>
  )
}
