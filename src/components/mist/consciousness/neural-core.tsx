'use client'

// M.I.S.T. — NeuralCore: the living consciousness orb.
// A DPR-aware canvas render loop with layered visuals (halo, breathing blob
// core with squash-and-stretch, nucleus, synaptic rings, orbital particle
// field, mirrored spectrum ring, thought sparks, shockwaves + celebration
// bursts on state transitions). Speaking state is driven by REAL audio via
// the shared audio bus (AnalyserNode) with an envelope fallback.
// Accessibility: under reduced motion the orb never freezes into a dead
// static frame — it drops to CALM MODE (slow breathing, soft nucleus pulse,
// gentle twinkle, color melts). State is communicated through calm rhythm
// and color instead of large motion, so the orb stays alive for everyone.
// Task 7-d · wow-factor remake · calm-mode accessibility pass

import { useEffect, useRef } from 'react'
import { motion, useSpring, useTransform } from 'framer-motion'
import { useMistStore } from '@/lib/store'
import { PROVIDER_LABELS, STATE_COLORS, STATE_LABELS } from '@/lib/mist-constants'
import { mistAudioEnergy, mistAudioSpectrum } from '@/lib/audio-bus'
import { mistSpeech } from '@/lib/speech'
import { fireInterrupt } from '@/lib/interrupt-bus'
import { cn } from '@/lib/utils'
import type { ConsciousnessState } from '@/lib/types'

/** Orbital speed multiplier per consciousness state. */
const ORBIT_SPEED: Record<ConsciousnessState, number> = {
  dormant: 0.35,
  awakening: 0.8,
  listening: 1.2,
  processing: 1.6,
  speaking: 1.3,
  dreaming: 0.5,
}

type RGB = [number, number, number]

const WHITE: RGB = [255, 255, 255]
const BLACK: RGB = [0, 0, 0]
const CELEBRATION_COLORS = ['#c084fc', '#5eead4', '#e879f9', '#34d399', '#fcd34d']

function hexToRgb(hex: string): RGB {
  const h = hex.replace('#', '')
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ]
}

function mix(a: RGB, b: RGB, t: number): RGB {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
}

function rgba(c: RGB, alpha: number): string {
  return `rgba(${Math.round(c[0])}, ${Math.round(c[1])}, ${Math.round(c[2])}, ${alpha})`
}

/** Cheap layered-sine pseudo-noise for organic blob displacement. */
function wobble(angle: number, t: number): number {
  return (
    Math.sin(angle * 3 + t * 3.1) * 0.5 +
    Math.sin(angle * 5 - t * 2.3) * 0.3 +
    Math.sin(angle * 8 + t * 4.7) * 0.2
  )
}

/**
 * Speech-cadence envelope for the no-audio fallback: continuous syllable
 * pulses (~4.3 Hz, detuned pair so consecutive syllables differ) with
 * phrase-level loudness dips and drifting stress accents. Phrasing modulates
 * DEPTH — never gates to silence — so the orb dances continuously while it
 * talks instead of freezing between phrases. (A bare sine or a hard gate
 * reads as a slow hover: "frozen while green".)
 */
function talkEnvelope(t: number): number {
  const sylRaw = Math.sin(t * 27 + Math.sin(t * 9.7) * 1.8) * Math.sin(t * 13.5 + 1.2)
  const syl = 0.62 + 0.38 * sylRaw // 0.24..1 syllable pulses
  const phrase = 0.72 + 0.28 * Math.sin(t * 2.4 + Math.sin(t * 0.61) * 1.4) // 0.44..1 phrase dips
  const stress = 0.82 + 0.18 * Math.sin(t * 2.9 + Math.sin(t * 0.83) * 2.0) // 0.64..1 sentence stress
  // soft-lift curve keeps the average loud (avg ≈ 0.47, valleys ≥ 0.12)
  return Math.min(1, syl * phrase * stress * 1.12) ** 0.85
}

interface Particle {
  angle: number
  speed: number
  rx: number
  ry: number
  tilt: number
  zPhase: number
  size: number
  bright: boolean
}

interface Spark {
  x: number
  y: number
  vx: number
  vy: number
  life: number
  maxLife: number
}

interface Confetti {
  x: number
  y: number
  vx: number
  vy: number
  life: number
  maxLife: number
  color: string
}

interface Wave {
  life: number
  maxLife: number
  delay: number
  maxR: number
  lw: number
}

interface RingSpec {
  rx: number
  ry: number
  rot: number
  pulses: { offset: number; speed: number }[]
}

/** 3 elliptical synaptic rings, each with traveling light pulses. */
const RINGS: RingSpec[] = [
  { rx: 1.16, ry: 0.34, rot: -0.55, pulses: [{ offset: 0.4, speed: 0.85 }] },
  { rx: 1.04, ry: 0.52, rot: 0.75, pulses: [{ offset: 2.4, speed: -0.65 }] },
  {
    rx: 0.9,
    ry: 0.64,
    rot: 1.95,
    pulses: [
      { offset: 4.1, speed: 1.05 },
      { offset: 1.2, speed: 0.55 },
    ],
  },
]

function makeParticle(): Particle {
  return {
    angle: Math.random() * Math.PI * 2,
    speed: 0.18 + Math.random() * 0.5,
    rx: 0.85 + Math.random() * 0.5,
    ry: 0.3 + Math.random() * 0.45,
    tilt: Math.random() * Math.PI,
    zPhase: Math.random() * Math.PI * 2,
    size: 0.9 + Math.random() * 0.9,
    bright: Math.random() < 0.12,
  }
}

/** Spawn the signature triple-shockwave (staggered 120ms). */
function spawnWaves(): Wave[] {
  return [0, 120, 240].map((delay) => ({
    life: 0,
    maxLife: 0.72,
    delay,
    maxR: 220 + Math.random() * 30,
    lw: 2.6,
  }))
}

function spawnConfetti(cx: number, cy: number, coreR: number): Confetti[] {
  const out: Confetti[] = []
  const n = 26
  for (let i = 0; i < n; i++) {
    const ang = (i / n) * Math.PI * 2 + Math.random() * 0.4
    const sp = coreR * (0.9 + Math.random() * 1.4)
    out.push({
      x: cx,
      y: cy,
      vx: Math.cos(ang) * sp,
      vy: Math.sin(ang) * sp,
      life: 0,
      maxLife: 0.9 + Math.random() * 0.5,
      color: CELEBRATION_COLORS[i % CELEBRATION_COLORS.length],
    })
  }
  return out
}

export interface NeuralCoreProps {
  /** Voice-stage mode — larger canvas, no bottom readouts (the stage renders
   *  its own richer caption row). */
  immersive?: boolean
  /** Corner-dock mode (in-app browser window open) — compact container. */
  docked?: boolean
  /** Activation handler — replaces the legacy dream toggle when provided. */
  onActivate?: () => void
  /** Accessible label for the activation button (contextual voice labels). */
  activateLabel?: string
}

export function NeuralCore({
  immersive = false,
  docked = false,
  onActivate,
  activateLabel,
}: NeuralCoreProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)

  const state = useMistStore((s) => s.neural.state)
  const load = useMistStore((s) => s.neural.load)
  const provider = useMistStore((s) => s.neural.provider)
  const model = useMistStore((s) => s.neural.model)
  const fallback = useMistStore((s) => s.neural.fallback)
  const setNeuralState = useMistStore((s) => s.setNeuralState)

  // The user's explicit M.I.S.T. preference is authoritative. The OS
  // prefers-reduced-motion signal is adopted into the store at boot
  // (app-shell) but must never override an explicit user choice — toggling
  // "Reduce motion" off in Settings has to restore the dance, even when the
  // OS still prefers reduced.
  const reduced = useMistStore((s) => s.reducedMotion)

  // Spring ticker so the load % "lands" instead of jumping.
  const loadSpring = useSpring(12, { stiffness: 80, damping: 20 })
  const loadPctMotion = useTransform(loadSpring, (v) =>
    `${Math.round(Math.max(0, Math.min(1, v)) * 100)}`
  )
  useEffect(() => {
    loadSpring.set(load * 100)
  }, [load, loadSpring])
  const loadPct = Math.round(Math.max(0, Math.min(1, load)) * 100)

  // Simulation state survives reduced-motion toggles.
  const simRef = useRef({
    color: hexToRgb(STATE_COLORS.dormant) as RGB,
    particles: [] as Particle[],
    sparks: [] as Spark[],
    confetti: [] as Confetti[],
    waves: [] as Wave[],
    lastSpark: 0,
    lastScanWave: 0,
    lastTalkWave: 0,
    lastBusEnergy: 0,
    lastBusE: 0,
    lastBusChange: 0,
    lastState: 'dormant' as ConsciousnessState,
    env: 0, // envelope follower (fast attack, slow release)
    busActive: false, // real audio detected during this speaking session
    speed: ORBIT_SPEED.dormant,
    breatheAmt: 0.45,
    parallax: { x: 0, y: 0, tx: 0, ty: 0 },
    clickPulse: 0,
  })

  useEffect(() => {
    const canvas = canvasRef.current
    const container = containerRef.current
    if (!canvas || !container) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    let raf = 0
    let cssSize = 1
    let dpr = 1
    let running = true

    const resize = () => {
      const rect = container.getBoundingClientRect()
      cssSize = Math.max(1, rect.width)
      dpr = Math.min(window.devicePixelRatio || 1, 2)
      canvas.width = Math.round(cssSize * dpr)
      canvas.height = Math.round(cssSize * dpr)
    }
    const observer = new ResizeObserver(resize)
    observer.observe(container)
    resize()

    const sim = simRef.current

    // Cursor parallax — the whole mind drifts a few px toward attention.
    const onPointerMove = (e: PointerEvent) => {
      sim.parallax.tx = (e.clientX / window.innerWidth - 0.5) * 2
      sim.parallax.ty = (e.clientY / window.innerHeight - 0.5) * 2
    }
    window.addEventListener('pointermove', onPointerMove, { passive: true })

    // Pause the loop when the tab is hidden (no battery burn).
    const stop = () => {
      running = false
      if (raf) cancelAnimationFrame(raf)
      raf = 0
    }
    const onVisibility = () => {
      if (document.hidden) {
        stop()
      } else {
        start()
      }
    }
    document.addEventListener('visibilitychange', onVisibility)

    const seedParticles = (count: number) => {
      while (sim.particles.length < count) sim.particles.push(makeParticle())
      if (sim.particles.length > count) sim.particles.length = count
    }

    const particlePos = (p: Particle, cx: number, cy: number, coreR: number) => {
      const ex = Math.cos(p.angle) * coreR * p.rx
      const ey = Math.sin(p.angle) * coreR * p.ry
      const cosT = Math.cos(p.tilt)
      const sinT = Math.sin(p.tilt)
      return { x: cx + ex * cosT - ey * sinT, y: cy + ex * sinT + ey * cosT }
    }

    const draw = (nowMs: number, dt: number, mode: 'full' | 'calm') => {
      const animate = mode === 'full'
      const store = useMistStore.getState()
      const cState = store.neural.state
      const cLoad = store.neural.load
      const intensity = store.animationIntensity / 100

      // ---- state transition ceremonies ----
      if (cState !== sim.lastState) {
        const prev = sim.lastState
        sim.lastState = cState
        if (animate) {
          sim.waves.push(...spawnWaves())
          // a completed thought deserves confetti
          if (prev === 'processing' && (cState === 'speaking' || cState === 'dormant')) {
            sim.confetti.push(...spawnConfetti(cssSize / 2, cssSize / 2, cssSize * 0.26))
          }
        } else {
          // calm mode carries transitions through the color melt + label —
          // clear any full-mode leftovers so nothing big fires here
          sim.waves = []
          sim.sparks = []
          sim.confetti = []
        }
        if (cState !== 'speaking') sim.busActive = false
      }
      if (sim.clickPulse > 0) {
        if (animate) sim.waves.push(...spawnWaves())
        sim.clickPulse = 0
      }

      // clock for all cadences below (MUST precede the envelope block —
      // talkEnvelope(t) below would otherwise hit the temporal dead zone)
      const t = nowMs / 1000

      // ---- envelope: REAL audio when speaking, mic energy when listening ----
      let spectrum: number[] | null = null
      let talkE = 0 // simulated speech cadence (used when the bus is unavailable)
      if (animate) {
        let target = 0
        if (cState === 'speaking') {
          const busE = mistAudioEnergy()
          if (busE > 0.03) {
            sim.busActive = true
            sim.lastBusEnergy = nowMs
          }
          // dead-bus fail-safes — a routed bus can die two ways:
          // 1) silence (element ended/detached): energy ~ 0
          // 2) FROZEN data: a context suspended mid-playback freezes
          //    getByteFrequencyData at its last (nonzero!) reading — the
          //    magnitude check alone would never catch it. Real speech
          //    varies wildly frame to frame, so if the reading barely
          //    MOVES for 800ms the bus is dead. Either way: simulate.
          const busDelta = Math.abs(busE - sim.lastBusE)
          sim.lastBusE = busE
          if (sim.busActive) {
            if (busE < 0.015 && nowMs - sim.lastBusEnergy > 1200) {
              sim.busActive = false
            } else if (busDelta > 0.004) {
              sim.lastBusChange = nowMs
            } else if (nowMs - sim.lastBusChange > 800) {
              sim.busActive = false // frozen analyser — suspended context
            }
          }
          // BLEND — the simulated speech cadence GUARANTEES the dance while
          // the real loudness modulates its amplitude. A raw analyser signal
          // alone proved fragile: it saturates at 1.0 (pins the bounce at one
          // pose), freezes when the context suspends, or converges too slowly
          // through any AGC. The cadence can do none of those things.
          talkE = talkEnvelope(t)
          if (sim.busActive) {
            const loud = 0.35 + 0.65 * Math.min(1, busE * 1.6) // 0.35..1
            target = talkE * loud
            spectrum = mistAudioSpectrum(24)
          } else {
            // no routed audio (autoplay policy) — pure simulated cadence
            target = talkE
          }
        } else if (cState === 'listening') {
          // gentle attention floor so a quiet room doesn't freeze the orb
          target = Math.max(store.neural.audioEnergy, 0.1 + 0.05 * Math.sin(t * 2))
        }
        // frame-rate independent follower: fast attack (~50ms), slower
        // release (~200ms) — identical feel at 20fps and 60fps
        const k = target > sim.env ? 1 - Math.exp(-dt * 20) : 1 - Math.exp(-dt * 5)
        sim.env += (target - sim.env) * k
      } else {
        sim.env = 0
      }
      const env = sim.env * (0.35 + intensity * 0.65)

      // ---- smoothed motion params (600ms crossfade between states) ----
      const lerp = (a: number, b: number, t: number) => a + (b - a) * t
      const smooth = animate ? Math.min(1, dt * 3.2) : 1
      sim.speed = lerp(sim.speed, ORBIT_SPEED[cState], smooth)
      sim.breatheAmt = lerp(
        sim.breatheAmt,
        cState === 'dormant' || cState === 'dreaming' ? 0.45 : 0.8,
        smooth
      )
      // early bounce preview for layers drawn before the core (ground-glow)
      const bouncePreview = env

      // ---- color melt ----
      // Full mode: 0.05/frame melt · calm: a ~0.4s crossfade — color
      // transitions carry state changes without any positional motion.
      const target2 = hexToRgb(STATE_COLORS[cState])
      sim.color = animate
        ? mix(sim.color, target2, 0.05)
        : mix(sim.color, target2, Math.min(1, dt * 2.5))
      const col = sim.color

      const cx = cssSize / 2
      const cy = cssSize / 2
      const coreR = (cssSize / 2) * 0.52

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, cssSize, cssSize)

      // subtle parallax drift toward the cursor
      if (animate) {
        sim.parallax.x = lerp(sim.parallax.x, sim.parallax.tx, 0.04)
        sim.parallax.y = lerp(sim.parallax.y, sim.parallax.ty, 0.04)
        ctx.translate(sim.parallax.x * 7, sim.parallax.y * 7)
      }

      // (a) ambient halo — breathes with the audio envelope (full) or a slow
      // calm sine (calm mode) so the orb never reads as frozen
      const calmSway = 0.5 + 0.5 * Math.sin(t * 0.9)
      const haloR = animate
        ? coreR * (1.35 + env * 0.5)
        : coreR * (1.34 + 0.05 * calmSway)
      const halo = ctx.createRadialGradient(cx, cy, 0, cx, cy, haloR)
      halo.addColorStop(0, rgba(col, animate ? 0.14 + env * 0.22 : 0.13 + 0.06 * calmSway))
      halo.addColorStop(0.55, rgba(col, 0.05))
      halo.addColorStop(1, rgba(col, 0))
      ctx.fillStyle = halo
      ctx.beginPath()
      ctx.arc(cx, cy, haloR, 0, Math.PI * 2)
      ctx.fill()

      // (a2) energy ground-glow — a soft reflection pool beneath the orb. It
      // thins and dims as the core hops (speaking bounce) so the dance reads
      // as weightless: the orb lifts, its reflection lets go.
      {
        const ggY = cy + coreR * 1.58
        const ggR = coreR * (0.74 - bouncePreview * 0.18)
        ctx.save()
        ctx.translate(cx, ggY)
        ctx.scale(1, 0.26)
        const gg = ctx.createRadialGradient(0, 0, 0, 0, 0, ggR)
        gg.addColorStop(0, rgba(col, (animate ? 0.2 : 0.13) * (1 - bouncePreview * 0.6)))
        gg.addColorStop(1, rgba(col, 0))
        ctx.fillStyle = gg
        ctx.beginPath()
        ctx.arc(0, 0, ggR, 0, Math.PI * 2)
        ctx.fill()
        ctx.restore()
      }

      // (b) shockwaves — the consciousness-shift tell (additive bloom)
      if (sim.waves.length > 0) {
        ctx.save()
        ctx.globalCompositeOperation = 'lighter'
        const nextWaves: Wave[] = []
        for (const w of sim.waves) {
          if (w.delay > 0) {
            if (animate) w.delay -= dt * 1000
            nextWaves.push(w)
            continue
          }
          if (animate) w.life += dt
          if (w.life >= w.maxLife) continue
          const p = w.life / w.maxLife
          const ease = 1 - Math.pow(1 - p, 4) // ease-out quartic
          // rings fade fully INSIDE the canvas — never clipped by the square
          // bitmap edge (immersive mode grows the field to 560px; at every
          // size the reach is capped so alpha hits 0 before the border)
          const waveRoom = Math.max(12, cssSize / 2 - 8 - coreR * 1.05)
          const r = coreR * 1.05 + ease * Math.min(w.maxR * (cssSize / 640), waveRoom)
          ctx.strokeStyle = rgba(col, 0.5 * (1 - p) ** 1.5)
          ctx.lineWidth = w.lw * (1 - p) + 0.4
          ctx.shadowColor = rgba(col, 0.8)
          ctx.shadowBlur = 16 * (1 - p)
          ctx.beginPath()
          ctx.arc(cx, cy, r, 0, Math.PI * 2)
          ctx.stroke()
          nextWaves.push(w)
        }
        sim.waves = nextWaves
        ctx.restore()
      }

      // (c) synaptic rings + traveling light pulses
      for (const ring of RINGS) {
        ctx.save()
        ctx.translate(cx, cy)
        ctx.rotate(ring.rot)
        ctx.strokeStyle = rgba(col, 0.13)
        ctx.lineWidth = 1
        ctx.beginPath()
        ctx.ellipse(0, 0, coreR * ring.rx, coreR * ring.ry, 0, 0, Math.PI * 2)
        ctx.stroke()
        for (const p of ring.pulses) {
          const a = animate ? p.offset + t * p.speed * (0.7 + sim.speed * 0.4) : p.offset
          const px = Math.cos(a) * coreR * ring.rx
          const py = Math.sin(a) * coreR * ring.ry
          const g = ctx.createRadialGradient(px, py, 0, px, py, 4 + env * 2)
          g.addColorStop(0, rgba(mix(col, WHITE, 0.6), 0.85))
          g.addColorStop(1, rgba(col, 0))
          ctx.fillStyle = g
          ctx.beginPath()
          ctx.arc(px, py, 4 + env * 2, 0, Math.PI * 2)
          ctx.fill()
        }
        ctx.restore()
      }

      // (c2) cognition comets — three arcing electron trails that chase each
      // other around the core while M.I.S.T. thinks. The unambiguous,
      // never-resting "working" tell (with the radar sweep + sparks).
      if (animate && cState === 'processing') {
        ctx.save()
        ctx.globalCompositeOperation = 'lighter'
        const nComets = 3
        for (let ci = 0; ci < nComets; ci++) {
          const base = t * (1.5 + cLoad * 1.3) + (ci * Math.PI * 2) / nComets
          const cr = coreR * (1.16 + 0.05 * Math.sin(t * 2.1 + ci * 2.1))
          for (let k = 0; k < 10; k++) {
            const a = base - k * 0.058
            const falloff = 1 - k / 10
            const px = cx + Math.cos(a) * cr
            const py = cy + Math.sin(a) * cr * 0.92
            const sz = (2.6 * falloff + 0.4) * 3
            const g2 = ctx.createRadialGradient(px, py, 0, px, py, sz)
            g2.addColorStop(0, rgba(mix(col, WHITE, 0.5 + 0.35 * falloff), 0.55 * falloff))
            g2.addColorStop(1, rgba(col, 0))
            ctx.fillStyle = g2
            ctx.beginPath()
            ctx.arc(px, py, sz, 0, Math.PI * 2)
            ctx.fill()
          }
        }
        ctx.restore()
      }

      // (c3) HUD tick dial — 64 faint ticks ringing the field. While
      // processing, a bright chase sweeps the dial (a system-working gauge);
      // otherwise the ticks breathe gently. Calm mode: static faint structure.
      {
        const ticks = 64
        const tr = coreR * 1.5
        const sweepA = (t * 2.4) % (Math.PI * 2)
        const procChase = animate && cState === 'processing'
        ctx.save()
        ctx.lineCap = 'round'
        for (let i = 0; i < ticks; i++) {
          const a = (i / ticks) * Math.PI * 2 - Math.PI / 2
          let alpha = animate ? 0.05 + 0.04 * Math.sin(t * 1.2 + i * 0.7) : 0.07
          if (procChase) {
            let d = (sweepA - a) % (Math.PI * 2)
            if (d < 0) d += Math.PI * 2
            alpha += Math.max(0, 1 - d / 1.5) * 0.5
          }
          if (alpha < 0.02) continue
          const major = i % 8 === 0
          const len = major ? 5 : 3
          ctx.strokeStyle = rgba(mix(col, WHITE, procChase ? 0.5 : 0.15), alpha)
          ctx.lineWidth = major ? 1.4 : 1
          ctx.beginPath()
          ctx.moveTo(cx + Math.cos(a) * tr, cy + Math.sin(a) * tr)
          ctx.lineTo(cx + Math.cos(a) * (tr + len), cy + Math.sin(a) * (tr + len))
          ctx.stroke()
        }
        ctx.restore()
      }

      // (d) core — squash-and-stretch bounce driven by the voice envelope.
      // Volume-preserving deformation (12 principles): sx up, sy down.
      // Scales are deliberately LARGE: at typical speech energy the core
      // deforms 15-25% and hops ~15% of its radius — a visible dance, not a
      // shimmer. (The old 0.14/0.11/0.10 scales read as "frozen while green".)
      const bounce = env * (animate ? 1 : 0)
      const sx = 1 + bounce * 0.26
      const sy = 1 - bounce * 0.21
      const bounceY = -bounce * coreR * 0.17
      // full: lively breath synced to cognitive load · calm: a slow, gentle
      // heartbeat (±1.2%) — enough to feel alive, no vestibular risk
      const breathe = animate
        ? 1 + 0.02 * Math.sin(t * (1.1 + cLoad * 2.4)) * sim.breatheAmt
        : 1 + (cState === 'processing' ? 0.016 : 0.012) * Math.sin(t * (cState === 'processing' ? 1.1 : 0.8))
      const r = coreR * breathe

      ctx.save()
      ctx.translate(cx, cy + bounceY)
      ctx.scale(sx, sy)

      // organic blob edge (displacement grows with voice energy). Calm mode
      // morphs very slowly at low amplitude — an idle drift, not a twitch.
      const segments = 72
      const dispAmt = animate
        ? 0.035 + (cState === 'processing' ? 0.05 : 0) + bounce * 0.22
        : 0.028
      const wobbleT = animate ? t : t * 0.18
      // mouth — a rhythmic lower bulge that articulates with the voice,
      // so the orb visibly "talks" toward the listener (bottom = chat side)
      const mouth = animate && cState === 'speaking' ? env : 0
      ctx.beginPath()
      for (let i = 0; i <= segments; i++) {
        const a = (i / segments) * Math.PI * 2
        const d = Math.atan2(Math.sin(a - Math.PI / 2), Math.cos(a - Math.PI / 2))
        const bulge = Math.exp(-(d * d) / 0.16) * mouth * 0.2
        const rr = r * (1 + wobble(a, wobbleT) * dispAmt + bulge)
        const px = Math.cos(a) * rr
        const py = Math.sin(a) * rr
        if (i === 0) ctx.moveTo(px, py)
        else ctx.lineTo(px, py)
      }
      ctx.closePath()
      const core = ctx.createRadialGradient(-r * 0.22, -r * 0.26, r * 0.08, 0, 0, r)
      core.addColorStop(0, rgba(mix(col, WHITE, 0.65), 0.92))
      core.addColorStop(0.38, rgba(mix(col, WHITE, 0.18), 0.6))
      core.addColorStop(0.78, rgba(mix(col, BLACK, 0.35), 0.34))
      core.addColorStop(1, rgba(mix(col, BLACK, 0.6), 0.06))
      ctx.fillStyle = core
      ctx.fill()

      // inner nucleus — pulses with load and voice. Calm mode keeps a slow
      // 0.6 rad/s heartbeat so state changes remain perceptible.
      const pulse = animate
        ? 0.5 + 0.5 * Math.sin(t * (2.2 + cLoad * 4.5))
        : 0.5 + 0.5 * Math.sin(t * (cState === 'processing' ? 1.6 : 0.6))
      const nucleusAlpha = 0.3 + 0.5 * pulse * (0.35 + cLoad * 0.75) + bounce * 0.25
      const nR = coreR * (0.16 + cLoad * 0.08 + bounce * 0.06)
      const nuc = ctx.createRadialGradient(0, 0, 0, 0, 0, nR)
      nuc.addColorStop(0, rgba(mix(col, WHITE, 0.85), Math.min(0.95, nucleusAlpha)))
      nuc.addColorStop(1, rgba(col, 0))
      ctx.fillStyle = nuc
      ctx.beginPath()
      ctx.arc(0, 0, nR, 0, Math.PI * 2)
      ctx.fill()

      // (d2) glossy specular glint — a crisp off-center highlight (plus a
      // tiny counter-glint low-right) gives the core physical, glassy
      // presence instead of a flat gradient. It brightens with the voice
      // envelope and rides the squash-stretch transform.
      {
        const glintX = -r * 0.34
        const glintY = -r * 0.38
        const glintR = r * (0.22 + bounce * 0.05)
        const glint = ctx.createRadialGradient(glintX, glintY, 0, glintX, glintY, glintR)
        glint.addColorStop(0, rgba(WHITE, 0.34 + bounce * 0.22))
        glint.addColorStop(0.55, rgba(WHITE, 0.08))
        glint.addColorStop(1, rgba(WHITE, 0))
        ctx.fillStyle = glint
        ctx.beginPath()
        ctx.arc(glintX, glintY, glintR, 0, Math.PI * 2)
        ctx.fill()
        // the crisp core of the reflection
        ctx.fillStyle = rgba(WHITE, 0.5 + bounce * 0.25)
        ctx.beginPath()
        ctx.ellipse(glintX, glintY, r * 0.085, r * 0.052, -0.6, 0, Math.PI * 2)
        ctx.fill()
        // low counter-glint — sells the sphere's curvature
        const cgX = r * 0.42
        const cgY = r * 0.46
        const cg = ctx.createRadialGradient(cgX, cgY, 0, cgX, cgY, r * 0.12)
        cg.addColorStop(0, rgba(mix(col, WHITE, 0.7), 0.16))
        cg.addColorStop(1, rgba(col, 0))
        ctx.fillStyle = cg
        ctx.beginPath()
        ctx.arc(cgX, cgY, r * 0.12, 0, Math.PI * 2)
        ctx.fill()
      }
      ctx.restore()

      // (e) particle field — pseudo-3D elliptical orbits. Calm mode parks
      // the orbits (no angular motion) and lets the stars slowly twinkle
      // (opacity only) so the field still shimmers gently.
      const want = Math.round(70 + intensity * 60)
      seedParticles(want)
      for (const p of sim.particles) {
        if (animate) p.angle += p.speed * sim.speed * dt
        const { x, y } = particlePos(p, cx, cy, coreR)
        const depth = (Math.sin(p.angle + p.zPhase) + 1) / 2
        const size = (0.5 + depth) * (p.bright ? 1.6 : 1)
        const twinkle = animate
          ? 0.72 + 0.28 * Math.sin(t * 2.6 + p.zPhase * 9)
          : 0.8 + 0.2 * Math.sin(t * 0.5 + p.zPhase * 9)
        const alpha = (p.bright ? 0.5 + 0.4 * depth : 0.2 + 0.5 * depth) * twinkle
        if (p.bright) {
          const g = ctx.createRadialGradient(x, y, 0, x, y, size * 3)
          g.addColorStop(0, rgba(mix(col, WHITE, 0.45), alpha))
          g.addColorStop(1, rgba(col, 0))
          ctx.fillStyle = g
          ctx.beginPath()
          ctx.arc(x, y, size * 3, 0, Math.PI * 2)
          ctx.fill()
        } else {
          ctx.fillStyle = rgba(mix(col, WHITE, 0.12), alpha)
          ctx.beginPath()
          ctx.arc(x, y, size, 0, Math.PI * 2)
          ctx.fill()
        }
      }

      // (f) mirrored radial spectrum — REAL FFT when speaking, mic when listening
      if (animate && (cState === 'listening' || cState === 'speaking')) {
        const bins = 24
        const r0 = coreR * 1.08
        ctx.save()
        ctx.globalCompositeOperation = 'lighter'
        ctx.lineCap = 'round'
        let maxAmp = 0
        let maxIdx = -1
        for (let i = 0; i < bins; i++) {
          let amp: number
          if (spectrum) {
            amp = spectrum[i]
          } else if (cState === 'listening') {
            amp = store.neural.audioEnergy * (0.4 + 0.6 * Math.abs(Math.sin(i * 1.7 + t * 5.2)))
          } else {
            amp = talkE * (0.4 + 0.6 * Math.abs(Math.sin(i * 1.7 + t * 5.2)))
          }
          amp *= 0.35 + intensity * 0.65
          if (amp > maxAmp) {
            maxAmp = amp
            maxIdx = i
          }
          const a = (i / bins) * Math.PI * 2 - Math.PI / 2
          const r1 = r0 + 1.5 + amp * coreR * 0.26
          const alpha = 0.12 + amp * 0.7
          ctx.strokeStyle = rgba(col, alpha)
          ctx.lineWidth = 2
          // bloom on the hot bars
          ctx.shadowColor = rgba(col, 0.9)
          ctx.shadowBlur = amp > 0.55 ? 12 : 0
          ctx.beginPath()
          ctx.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0)
          ctx.lineTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1)
          ctx.stroke()
          // mirrored twin (mandala symmetry)
          const a2 = a + Math.PI
          ctx.beginPath()
          ctx.moveTo(cx + Math.cos(a2) * r0, cy + Math.sin(a2) * r0)
          ctx.lineTo(cx + Math.cos(a2) * r1, cy + Math.sin(a2) * r1)
          ctx.stroke()
        }
        ctx.shadowBlur = 0
        // beat comet — the hottest bin gets a glowing head
        if (maxIdx >= 0 && maxAmp > 0.25) {
          const a = (maxIdx / bins) * Math.PI * 2 - Math.PI / 2
          const r1 = r0 + 1.5 + maxAmp * coreR * 0.26 + 4
          ctx.fillStyle = rgba(mix(col, WHITE, 0.7), 0.9)
          ctx.shadowColor = rgba(col, 1)
          ctx.shadowBlur = 14
          ctx.beginPath()
          ctx.arc(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1, 2.6, 0, Math.PI * 2)
          ctx.fill()
        }
        ctx.restore()
      }

      // (f2) voice ripples — each syllable peak sends a soft shockwave out
      // through the core (the acoustic "mouth movement" tell)
      if (animate && cState === 'speaking' && env > 0.42 && nowMs - sim.lastTalkWave > 300) {
        sim.lastTalkWave = nowMs
        sim.waves.push({ life: 0, maxLife: 0.55, delay: 0, maxR: 46 + env * 70, lw: 1.5 })
      }

      // (g) thought sparks — processing (radar scan wave + frequent sparks)
      if (animate && cState === 'processing' && nowMs - sim.lastScanWave > 1400) {
        sim.lastScanWave = nowMs
        sim.waves.push({ life: 0, maxLife: 0.9, delay: 0, maxR: 90, lw: 1.2 })
      }
      if (
        animate &&
        cState === 'processing' &&
        sim.particles.length > 0 &&
        nowMs - sim.lastSpark > (intensity > 0.4 ? 1400 : 2400)
      ) {
        sim.lastSpark = nowMs
        const p = sim.particles[(Math.random() * sim.particles.length) | 0]
        const { x, y } = particlePos(p, cx, cy, coreR)
        const ang = Math.random() * Math.PI * 2
        const sp = 46 + Math.random() * 56
        sim.sparks.push({
          x,
          y,
          vx: Math.cos(ang) * sp,
          vy: Math.sin(ang) * sp,
          life: 0,
          maxLife: 0.55 + Math.random() * 0.2,
        })
      }
      if (animate) {
        const next: Spark[] = []
        for (const s of sim.sparks) {
          s.life += dt
          if (s.life >= s.maxLife) continue
          s.x += s.vx * dt
          s.y += s.vy * dt
          const k = 1 - s.life / s.maxLife
          ctx.strokeStyle = rgba(mix(col, WHITE, 0.5), 0.75 * k)
          ctx.lineWidth = 1.4
          ctx.beginPath()
          ctx.moveTo(s.x, s.y)
          ctx.lineTo(s.x - s.vx * 0.1, s.y - s.vy * 0.1)
          ctx.stroke()
          next.push(s)
        }
        sim.sparks = next
      }

      // (h) celebration confetti — thought completed
      if (animate) {
        const nextC: Confetti[] = []
        ctx.save()
        ctx.globalCompositeOperation = 'lighter'
        for (const c of sim.confetti) {
          c.life += dt
          if (c.life >= c.maxLife) continue
          c.x += c.vx * dt
          c.y += c.vy * dt
          c.vy += 60 * dt // gravity-lite
          c.vx *= 1 - 0.6 * dt
          const k = 1 - c.life / c.maxLife
          ctx.strokeStyle = c.color
          ctx.globalAlpha = k
          ctx.lineWidth = 1.6
          ctx.beginPath()
          ctx.moveTo(c.x, c.y)
          ctx.lineTo(c.x - c.vx * 0.06, c.y - c.vy * 0.06)
          ctx.stroke()
          nextC.push(c)
        }
        ctx.globalAlpha = 1
        ctx.restore()
        sim.confetti = nextC
      }
    }

    let last = performance.now()
    // One tick, two personalities: full-motion choreography or the calm
    // accessibility mode (slow breathing, twinkle, color melts — no
    // parallax/shockwaves/sparks/bounce/spectrum).
    const tick = (now: number) => {
      if (!running) return
      // heal bitmap drift: entrance transforms can leave the canvas measured
      // smaller than its final layout (e.g. 272px bitmap in a 300px box)
      const w = container.getBoundingClientRect().width
      if (Math.abs(w - cssSize) > 1) resize()
      const dt = Math.min(0.05, (now - last) / 1000)
      last = now
      draw(now, dt, reduced ? 'calm' : 'full')
      raf = requestAnimationFrame(tick)
    }
    const start = () => {
      if (raf) return // already scheduled
      running = true
      last = performance.now()
      raf = requestAnimationFrame(tick)
    }

    // Calm mode starts from a clean slate (no leftover full-motion FX).
    if (reduced) {
      sim.waves = []
      sim.sparks = []
      sim.confetti = []
    }
    start()
    return () => {
      stop()
      observer.disconnect()
      window.removeEventListener('pointermove', onPointerMove)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [reduced])

  const stateColor = STATE_COLORS[state]
  const shimmerWhileOn = state === 'processing' || state === 'awakening'

  const handleClick = () => {
    // clicking the mind sends a ripple through consciousness
    if (!reduced) simRef.current.clickPulse = performance.now()
    if (onActivate) {
      // The voice stage owns its own tap choreography (idle → start ·
      // active → interrupt + stop) — never preempt it.
      onActivate()
      return
    }
    // mlv-ux-2 — tap-to-interrupt (Mark-LV port): tapping the orb while she
    // SPEAKS silences her instantly; while she THINKS it cancels the
    // in-flight thought. The interrupt bus lets the chat panel run its
    // superset cleanup (voice + thought + UI settle). The direct stop() is
    // belt-and-suspenders in case no panel is subscribed.
    const cur = useMistStore.getState().neural.state
    if (cur === 'speaking') {
      mistSpeech.stop()
      fireInterrupt('orb-tap')
      return
    }
    if (cur === 'processing') {
      fireInterrupt('orb-tap')
      return
    }
    // legacy behavior for every non-voice surface: toggle the dream state
    setNeuralState(cur === 'dreaming' ? 'dormant' : 'dreaming')
  }

  return (
    <div className="flex flex-col items-center gap-5">
      <motion.button
        type="button"
        onClick={handleClick}
        aria-label={
          activateLabel ??
          (state === 'speaking'
            ? 'Tap to silence M.I.S.T.'
            : state === 'processing'
              ? 'Tap to cancel her reply'
              : 'Toggle dream state')
        }
        className={cn(
          'relative cursor-pointer overflow-visible rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-400/60',
          docked
            ? 'w-[min(150px,38vw)]'
            : immersive
              ? 'w-[min(560px,72vw,66vh)]'
              : 'w-[min(300px,80vw)]'
        )}
        whileHover={reduced ? undefined : { scale: 1.02 }}
        whileTap={reduced ? undefined : { scale: 0.98 }}
      >
        {/* energy-reactive aura behind the canvas */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-[8%] animate-mist-pulse-glow rounded-full transition-[background] duration-700"
          style={{
            background: `radial-gradient(circle at 50% 50%, ${stateColor}26, transparent 68%)`,
            filter: 'blur(18px)',
          }}
        />
        <div ref={containerRef} className="relative aspect-square w-full">
          <canvas
            ref={canvasRef}
            className="absolute inset-0 h-full w-full"
            role="img"
            aria-label="Neural core"
          />
        </div>
      </motion.button>

      {/* the visible state label doubles as a polite live region so state
          shifts (processing → speaking → dormant) reach screen readers too —
          never color/motion alone. In immersive mode the voice stage renders
          its own richer caption row, so the compact readout stays hidden. */}
      {!immersive && (
        <div className="flex flex-col items-center gap-1.5 text-center">
        <span
          role="status"
          aria-live="polite"
          className={`font-mono text-xs uppercase tracking-[0.3em] transition-colors duration-500 ${
            shimmerWhileOn ? 'mist-shimmer-text' : ''
          }`}
          style={
            shimmerWhileOn
              ? ({ '--mist-shimmer-color': stateColor } as React.CSSProperties)
              : { color: stateColor }
          }
        >
          {STATE_LABELS[state]}
        </span>
        {fallback ? (
          <span className="font-mono text-[11px] text-rose-400">offline-mind fallback</span>
        ) : (
          <span className="font-mono text-[11px] text-slate-400">
            via {PROVIDER_LABELS[provider]}
            {model ? ` · ${model}` : ''}
          </span>
        )}
        <div className="mt-1 flex w-32 items-center gap-2">
          <div className="h-1 flex-1 overflow-hidden rounded-full bg-white/10">
            <div
              className="mist-load-shimmer h-full rounded-full transition-[width] duration-700 ease-out"
              style={{ width: `${loadPct}%`, backgroundColor: stateColor }}
            />
          </div>
          <span className="font-mono text-[10px] text-slate-500 tabular-nums">
            {reduced ? (
              <span>{loadPct}%</span>
            ) : (
              <motion.span>{loadPctMotion}</motion.span>
            )}
          </span>
        </div>
      </div>
      )}
    </div>
  )
}
