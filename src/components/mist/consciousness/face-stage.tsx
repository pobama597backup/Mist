'use client'

// M.I.S.T. FaceStage (v8) — the consciousness stage as one of the
// adapted ai-visualizer canvas faces, served from /av/faces/* and fed LIVE
// by the postMessage face bus (src/lib/face-bus.ts): the face hears, thinks
// and speaks with Mist's real voice state and real waveform.
//
// Phase 6-b: the frames now carry the FULL SANDBOX — allow-scripts ONLY,
// no same-origin grant. Each face is an opaque-origin document that cannot
// touch this window's DOM, cookies or storage even if a face's canvas code
// were ever compromised; the bus rides window.parent.postMessage (strict
// origin target) answered on a private MessagePort, so nothing the faces
// need was lost. F/S/C key handling (fullscreen / cinematic camera) works
// inside the iframe once it has focus. While the in-app browser window is
// open the face docks top-right exactly like the orb does.

import { useEffect, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import type { ConsciousnessFace } from '@/lib/types'
import { attachFaceFrame, detachFaceFrame } from '@/lib/face-bus'
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

  // Phase 6-b: register this frame's contentWindow with the postMessage
  // face bus BEFORE its document can boot (the transport's hello arrives
  // when the face's core.js evals). The window proxy is stable across the
  // frame's navigations, so attaching this early is safe and covers face
  // swaps without remounts; the effect cleanup closes the frame's bus port.
  useEffect(() => {
    const win = frameRef.current?.contentWindow
    if (!win) return
    attachFaceFrame(win)
    return () => detachFaceFrame(win)
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
        // Phase 6-b · TRUE SANDBOX (resolves the Phase 1 S12 backlog note:
        // "postMessage bus migration unlocks a true sandbox"). allow-scripts
        // ONLY — deliberately WITHOUT a same-origin grant: the faces ride
        // the postMessage bus now (face-bus.ts), so they need no
        // same-origin access to this window. Each frame is an
        // opaque-origin document — it cannot touch the parent DOM, cookies
        // or storage, and a compromised face stays inside its own box. CSP
        // frame-src 'self' still governs which URLs may load here; referrer
        // stays sealed. (The literal token the test bans never appears in
        // this file — keep it that way.)
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        className={cn(
          'h-full w-full border-0 bg-black transition-opacity duration-700',
          loaded ? 'opacity-100' : 'opacity-0'
        )}
      />
    </motion.div>
  )
}
