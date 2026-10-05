// Echo guard — telling the creator's voice apart from M.I.S.T.'s own coming
// back through the speakers. Faithful TypeScript port of Mark-LV's
// core/echo.py (the teacher's clean-room algorithm, studied byte by byte):
//
//   1. CONTENT — echo is not merely loud, it is the SAME sound she just
//      played. Both streams are reduced to speech-band energies; as much of
//      her recent output as fits is SUBTRACTED (projected) from the mic
//      block. Pure echo cancels to almost nothing; a second voice cannot be
//      cancelled by hers — its formants sit in bands where hers were weak.
//      That distinction holds even when both arrive at the same loudness,
//      which is exactly where a level test gets wrong.
//
//   2. A LEARNED ECHO GAIN + learned residual floor/head — whenever the
//      content check says "definitely just echo", the observed residual is
//      folded into running percentiles, so the threshold calibrates itself
//      to the actual room within seconds and re-calibrates when the volume
//      changes or headphones get unplugged. No per-machine tuning constant.
//
//   3. HONESTY IN BAD ROOMS — when the room's echo floor is too high to
//      separate on content (loud speakers, reverberance), the guard demands
//      more consecutive blocks instead of guessing (BLOCKS_NOISY), and a
//      'voice' lasting impossibly long means the room changed — it
//      re-calibrates rather than interrupts.
//
// The mic side (BargeInProbe) opens its own getUserMedia with the browser's
// acoustic echo cancellation ON — the AEC removes most of her output before
// it even reaches this analysis; the guard's projection-subtraction catches
// what AEC lets through (AEC is imperfect by design on some devices).

'use client'

// Log-spaced edges across the range that carries speech. Coarse on purpose:
// fine bins would track pitch, and pitch is exactly what differs between two
// voices saying the same word — we want the timbre that echo preserves.
export const ECHO_BAND_EDGES = [200, 400, 700, 1100, 1700, 2600, 3800, 5200, 7000]

const HISTORY_S = 1.5 // how far back an echo could plausibly have been played
const MIN_LEVEL = 0.06 // below this the mic is room noise; nothing to decide
// The threshold is not a tuned constant. It is placed just above essentially
// ALL the echo a room has been seen to produce (measured residuals in the
// teacher's doc: headphones 0.09 · normal desk 0.13 · reverberant 0.23 ·
// loud+distorting 0.31 — vs a distinct voice at 0.28, a similar voice 0.16).
const MIN_USER = 0.15 // never call anything below this a voice
const HEAD_Q = 97 // percentile of observed echo the threshold must clear
const HEAD_MULT = 1.15 // …with this much headroom above it
// Above this echo floor, content separates the two poorly — loudness cannot
// rescue it; time can: echo wobbles around its median while a person talking
// holds above it, so hard rooms hold the evidence longer.
const UNRELIABLE_FLOOR = 0.22
const BLOCKS_NORMAL = 5 // ~320 ms of sustained evidence at 64ms blocks
const BLOCKS_NOISY = 12 // ~770 ms when the room is this hard
const FLOOR_WINDOW = 60 // blocks kept to characterise the room's echo
const FLOOR_Q = 35 // percentile taken as 'typical echo here'
const WARMUP = 16 // blocks (~1 s) of listening before judging anyone
const RELEARN_RUN = 28 // a 'voice' lasting this long means the room changed

interface HistEntry {
  t: number
  bands: Float32Array
  level: number
}

export class EchoGuard {
  private hist: HistEntry[] = []
  private gain = 0.6 // mic level per unit of output level; learned
  private seen = 0
  private residuals: number[] = [] // recent ECHO residuals only
  private floor = 0.1 // typical echo residual here; learned
  private head = 0.13 // near-worst echo residual here; learned
  private run = 0 // consecutive blocks called speech
  private lastSim = 0

  /** True once the estimate rests on enough real echo to be trusted. */
  get calibrated(): boolean {
    return this.seen >= 8
  }

  /** Residual left by this room's own echo. Higher = harder to separate. */
  get echoFloor(): number {
    return this.floor
  }

  /** False when the acoustics are too poor to judge on content alone. */
  get reliable(): boolean {
    return this.floor < UNRELIABLE_FLOOR
  }

  /** The residual a block must clear right now to count as a voice. */
  get threshold(): number {
    return Math.max(MIN_USER, this.head * HEAD_MULT)
  }

  /** Consecutive positive blocks before an interruption is believed. */
  get requiredBlocks(): number {
    return this.reliable ? BLOCKS_NORMAL : BLOCKS_NOISY
  }

  /** 1.0 = fully explained by her own output, 0.0 = nothing to do with it. */
  get lastSimilarity(): number {
    return this.lastSim
  }

  /** Playback stopped — drop the history, keep what was learned. */
  reset(): void {
    this.hist = []
    this.lastSim = 0
    this.run = 0
  }

  /** Record a slice of what she is playing, for later comparison. */
  noteOutput(bands: Float32Array, level: number, when?: number): void {
    try {
      const t = when ?? performance.now() / 1000
      this.hist.push({ t, bands: bands.slice(), level })
      const cutoff = t - HISTORY_S
      if (this.hist.length > 8) this.hist = this.hist.filter((h) => h.t >= cutoff)
    } catch {
      /* never let bookkeeping disturb playback */
    }
  }

  /** True if this mic block is a different voice, not her echo. */
  isUserSpeech(bands: Float32Array, level: number, when?: number): boolean {
    try {
      if (level < MIN_LEVEL) {
        // She is playing and the mic hears nothing back: this setup returns
        // no echo at all (headphones, or a mic far from the speaker). Record
        // that, or the window stays empty and the first person to speak gets
        // mistaken for the calibration sample.
        if (this.hist.length > 0 && Math.max(...this.hist.map((h) => h.level)) > 0.15) {
          this.residuals.push(0)
          if (this.residuals.length > FLOOR_WINDOW) this.residuals.splice(0, this.residuals.length - FLOOR_WINDOW)
          if (this.residuals.length >= WARMUP) {
            this.floor = percentile(this.residuals, FLOOR_Q)
            this.head = percentile(this.residuals, HEAD_Q)
          }
        }
        this.run = 0
        return false
      }
      if (this.hist.length === 0) {
        // Nothing playing that we know of — anything audible is theirs.
        this.run++
        return true
      }

      const t = when ?? performance.now() / 1000
      const total = bands.reduce((a, b) => a + b, 0)
      if (total <= 1e-9) return false

      // Find the recent output slice that best explains this block, and
      // subtract as much of it as fits. What is left over is whatever the
      // microphone heard that she did not play.
      let bestRes = 1
      let bestLevel = 0
      for (const h of this.hist) {
        if (h.t > t || t - h.t > HISTORY_S) continue
        const denom = dot(h.bands, h.bands)
        if (denom < 1e-12) continue
        const alpha = Math.max(0, dot(bands, h.bands) / denom)
        let residualSum = 0
        for (let i = 0; i < bands.length; i++) {
          residualSum += Math.max(0, bands[i]! - alpha * h.bands[i]!)
        }
        const ratio = residualSum / total
        if (ratio < bestRes) {
          bestRes = ratio
          bestLevel = h.level
        }
      }
      this.lastSim = 1 - bestRes

      // Nothing in the window explained it at all — that is not her sound.
      if (bestLevel <= 0) {
        this.run++
        return true
      }

      // Learning happens in two stages, and the order matters both times.
      // While warming up, learn from EVERY block (judging first is a trap:
      // in a poor room the first echo block already sits above any sensible
      // starting bar — it would be called a voice, never be learned from,
      // and the room would stay mis-characterised forever). Once warm, learn
      // only from blocks BELOW the bar (feeding the user's own blocks back
      // in lifts the threshold over themselves and the guard goes deaf to
      // the very thing it watches for).
      const warming = this.residuals.length < WARMUP
      const thr = this.threshold
      const speech = !warming && bestRes >= thr

      if (speech) {
        this.run++
        // A run this long is not someone interrupting — nobody talks over an
        // assistant for seconds on end. The room changed under us (volume,
        // headphones unplugged), so characterise it again.
        if (this.run > RELEARN_RUN) {
          this.residuals = []
          this.run = 0
          return false
        }
        return true
      }

      this.run = 0
      this.residuals.push(bestRes)
      if (this.residuals.length > FLOOR_WINDOW) this.residuals.splice(0, this.residuals.length - FLOOR_WINDOW)
      if (this.residuals.length >= WARMUP) {
        this.floor = percentile(this.residuals, FLOOR_Q)
        this.head = percentile(this.residuals, HEAD_Q)
      }
      if (warming) return false

      // Comfortably just her: also a safe moment to learn how loudly this
      // room returns her voice.
      if (bestRes <= this.floor * 1.15 && bestLevel > 0.05) {
        const obs = Math.min(level / Math.max(bestLevel, 1e-6), 3)
        this.gain += (obs - this.gain) * 0.08
        this.seen = Math.min(this.seen + 1, 999)
      }
      return false
    } catch {
      return false // any doubt: do not interrupt
    }
  }
}

function dot(a: Float32Array, b: Float32Array): number {
  let s = 0
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) s += a[i]! * b[i]!
  return s
}

/** Nearest-rank percentile (the teacher uses numpy's linear interpolation;
 * nearest-rank keeps this dependency-free and within a fraction of a dB). */
function percentile(xs: number[], q: number): number {
  if (xs.length === 0) return 0
  const sorted = [...xs].sort((a, b) => a - b)
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round((q / 100) * (sorted.length - 1))))
  return sorted[idx]!
}

// ---------------------------------------------------------------------------
// BargeInProbe — the mic side: one getUserMedia stream with AEC on, analysed
// every ~64ms while she speaks. The browser's echo cancellation strips most
// of her output before it reaches us; the EchoGuard catches the rest.
// ---------------------------------------------------------------------------

export interface BargeInProbe {
  /** Armed and sampling (mic stream open). */
  readonly active: boolean
  /** True when the room's acoustics have been characterized enough to trust. */
  readonly calibrated: boolean
  /** Diagnostics: last residual similarity (1 = pure echo). */
  readonly lastSimilarity: number
  stop: () => void
}

export interface BargeInOptions {
  /** Fired ONCE per speaking turn when the creator's voice is believed. */
  onBargeIn: () => void
  /** Fired when the probe cannot start (no mic / permission denied). */
  onUnavailable?: (reason: string) => void
  /** Sampling cadence — 64ms mirrors the teacher's block size. */
  intervalMs?: number
}

export async function startBargeInProbe(opts: BargeInOptions): Promise<BargeInProbe | null> {
  if (typeof window === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
    opts.onUnavailable?.('microphone unavailable')
    return null
  }
  let stream: MediaStream
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true, // the first line of defense: her output
        noiseSuppression: true, // leaves the mic signal before analysis
        autoGainControl: true,
      },
    })
  } catch {
    opts.onUnavailable?.('microphone blocked')
    return null
  }

  const Ctor =
    window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!Ctor) {
    stream.getTracks().forEach((t) => t.stop())
    opts.onUnavailable?.('audio engine unavailable')
    return null
  }
  const ctx = new Ctor()
  const source = ctx.createMediaStreamSource(stream)
  const analyser = ctx.createAnalyser()
  analyser.fftSize = 1024
  analyser.smoothingTimeConstant = 0.2 // per-block honesty — no smoothing
  source.connect(analyser)

  const freqBuf = new Float32Array(analyser.frequencyBinCount)
  const timeBuf = new Float32Array(analyser.fftSize)
  const guard = new EchoGuard()
  let fired = false
  let stopped = false
  let consecutive = 0

  const { mistAudioBandEnergies, mistAudioEnergy } = await import('@/lib/audio-bus')

  const sample = () => {
    if (stopped) return
    // her side — the reference she just played
    const outBands = mistAudioBandEnergies(ECHO_BAND_EDGES)
    const outLevel = mistAudioEnergy()
    if (outBands) guard.noteOutput(outBands, outLevel)
    // mic side
    analyser.getFloatFrequencyData(freqBuf)
    analyser.getFloatTimeDomainData(timeBuf)
    let sq = 0
    for (let i = 0; i < timeBuf.length; i++) sq += timeBuf[i]! * timeBuf[i]!
    const level = Math.sqrt(sq / timeBuf.length)
    const micBands = bandsFromDb(freqBuf, ctx.sampleRate)
    const isUser = guard.isUserSpeech(micBands, level)
    consecutive = isUser ? consecutive + 1 : 0
    if (!fired && consecutive >= guard.requiredBlocks) {
      fired = true // once per speaking turn — the caller re-arms
      try {
        opts.onBargeIn()
      } catch {
        /* listener errors never break the probe */
      }
    }
  }

  const timer = window.setInterval(sample, opts.intervalMs ?? 64)
  // first sample immediately so the guard starts warming up
  sample()

  return {
    get active() {
      return !stopped
    },
    get calibrated() {
      return guard.calibrated
    },
    get lastSimilarity() {
      return guard.lastSimilarity
    },
    stop() {
      if (stopped) return
      stopped = true
      window.clearInterval(timer)
      guard.reset()
      try {
        stream.getTracks().forEach((t) => t.stop())
      } catch {
        /* already stopped */
      }
      void ctx.close().catch(() => undefined)
    },
  }
}

/** Mic band energies from a float-dB spectrum (dB → linear magnitudes). */
function bandsFromDb(db: Float32Array, sampleRate: number): Float32Array {
  const binHz = sampleRate / 1024
  const out = new Float32Array(ECHO_BAND_EDGES.length - 1)
  for (let b = 0; b < out.length; b++) {
    const lo = Math.max(0, Math.round(ECHO_BAND_EDGES[b]! / binHz))
    const hi = Math.max(lo + 1, Math.round(ECHO_BAND_EDGES[b + 1]! / binHz))
    let sum = 0
    for (let i = lo; i < hi && i < db.length; i++) {
      const v = db[i]!
      if (Number.isFinite(v)) sum += 10 ** (v / 20)
    }
    out[b] = sum
  }
  return out
}
