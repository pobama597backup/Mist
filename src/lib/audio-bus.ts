// M.I.S.T. audio bus — a shared AudioContext + AnalyserNode singleton.
// TTS playback routes through this bus so the neural orb (and any other
// surface) can react to REAL audio amplitude/frequency in real time instead
// of fake envelopes. Client-only by design; every method is safe to call
// from anywhere (no-ops before init).
'use client'

/** Lazily-created singleton state (never instantiated during SSR). */
let ctx: AudioContext | null = null
let analyser: AnalyserNode | null = null
let freqData: Uint8Array<ArrayBuffer> | null = null

/** Media elements already routed through the graph (a node can only be created once per element). */
const routedElements = new WeakSet<HTMLMediaElement>()

function ensureGraph(): boolean {
  if (typeof window === 'undefined') return false
  if (ctx && analyser) return true
  try {
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!Ctor) return false
    ctx = new Ctor()
    analyser = ctx.createAnalyser()
    // 1024 (not 256): bin resolution 187.5Hz → ~47Hz at 48kHz, fine enough to
    // separate the formant bands the mouth tracker needs (150-450 / 450-1100 /
    // 600-1300 / 1700-3200 / 3800-8000 Hz). Verified resolution-agnostic
    // consumers: mistAudioEnergy averages over freqData.length, mistAudioSpectrum
    // log-bins from freqData.length dynamically, mistAudioWaveform re-sizes
    // timeData from analyser.fftSize on every call.
    analyser.fftSize = 1024
    analyser.smoothingTimeConstant = 0.55
    freqData = new Uint8Array(analyser.frequencyBinCount)
    return true
  } catch {
    return false
  }
}

/**
 * Try to unlock the AudioContext (must run inside a user gesture to satisfy
 * autoplay policy). Resolves true when the context is (or becomes) running.
 */
export async function mistAudioResume(): Promise<boolean> {
  if (!ensureGraph() || !ctx) return false
  try {
    if (ctx.state !== 'running') await ctx.resume()
  } catch {
    /* stay suspended — callers fall back to envelope playback */
  }
  return ctx.state === 'running'
}

/**
 * Route a media element (the TTS <audio>) through the shared analyser.
 * Idempotent per element. Only attaches when the context is running — a
 * suspended context would otherwise mute the element completely.
 */
export function mistAudioAttachMedia(el: HTMLMediaElement): void {
  if (!ensureGraph() || !ctx || !analyser) return
  if (ctx.state !== 'running') return
  if (routedElements.has(el)) return
  try {
    const source = ctx.createMediaElementSource(el)
    source.connect(analyser)
    analyser.connect(ctx.destination)
    routedElements.add(el)
  } catch {
    /* element may already be routed elsewhere — ignore */
  }
}

/** Current RMS-ish energy 0..1 from the analyser (0 when idle). */
export function mistAudioEnergy(): number {
  if (!analyser || !freqData) return 0
  try {
    analyser.getByteFrequencyData(freqData)
  } catch {
    return 0
  }
  let sum = 0
  const n = freqData.length
  for (let i = 0; i < n; i++) sum += freqData[i] * freqData[i]
  // perceptual-ish scaling: byte values are 0..255. Gain 2.2 keeps headroom —
  // typical TTS reads 0.4-0.9 and the orb's AGC expands it into full swing
  // (a hotter gain saturates at 1.0 and pins the bounce at one pose).
  return Math.min(1, Math.sqrt(sum / (n * 255 * 255)) * 2.2)
}

/**
 * Log-scaled spectrum binned to `bins` buckets, each 0..1.
 * Returns null when the bus is idle/unavailable (caller falls back).
 */
export function mistAudioSpectrum(bins: number): number[] | null {
  if (!analyser || !freqData) return null
  try {
    analyser.getByteFrequencyData(freqData)
  } catch {
    return null
  }
  const usable = Math.floor(freqData.length * 0.75) // drop the near-silent top end
  const out: number[] = new Array(bins).fill(0)
  for (let b = 0; b < bins; b++) {
    // logarithmic bin edges so voice fundamentals get resolution
    const lo = Math.floor(Math.pow(usable, b / bins))
    const hi = Math.max(lo + 1, Math.floor(Math.pow(usable, (b + 1) / bins)))
    let sum = 0
    for (let i = lo; i < hi && i < usable; i++) sum += freqData[i]
    out[b] = Math.min(1, sum / ((hi - lo) * 255) * 1.9)
  }
  return out
}

/** Reusable time-domain buffer for mistAudioWaveform (sized on first use). */
let timeData: Uint8Array<ArrayBuffer> | null = null

// ---------------- echo guard (Mark-LV echo.py port) ----------------

/** Reusable float-dB buffer for band energies (sized on first use). */
let floatDb: Float32Array<ArrayBuffer> | null = null

/**
 * RAW linear band energies of what she is playing RIGHT NOW — the echo
 * guard's reference signal (Mark-LV's band_energies: unnormalized magnitudes,
 * because the projection-subtraction needs real amplitudes, not 0..1 gain).
 * Returns null when the bus is idle. `edges` are Hz (e.g. the guard's
 * 200..7000 speech bands).
 */
export function mistAudioBandEnergies(edges: number[]): Float32Array | null {
  if (!ensureGraph() || !analyser) return null
  if (!floatDb || floatDb.length !== analyser.frequencyBinCount) {
    floatDb = new Float32Array(analyser.frequencyBinCount)
  }
  try {
    analyser.getFloatFrequencyData(floatDb)
  } catch {
    return null
  }
  const sr = ctx?.sampleRate ?? 48000
  const binHz = sr / analyser.fftSize
  const out = new Float32Array(edges.length - 1)
  for (let b = 0; b < out.length; b++) {
    const lo = Math.max(0, Math.round(edges[b]! / binHz))
    const hi = Math.max(lo + 1, Math.round(edges[b + 1]! / binHz))
    let sum = 0
    for (let i = lo; i < hi && i < floatDb.length; i++) {
      const db = floatDb[i]!
      if (Number.isFinite(db)) sum += 10 ** (db / 20) // dB → linear magnitude
    }
    out[b] = sum
  }
  return out
}

// ---------------- mouth formant analysis (Mark-LV port) ----------------

/** One mouth-tracking frame derived from the LIVE spectrum (teacher's
 *  _pcm_visemes physics, ported to the Web Audio analyser). */
export interface MouthFrame {
  /** Jaw target 0..1 — the F1 formant shape already fused with the level
   *  envelope (drive = q^0.85 · shape^0.75, exactly the teacher's fusion). */
  openness: number
  /** Lip spread (-1 purse) .. (+1 spread) from the F2 front/back contrast. */
  width: number
  /** Raw voice-band level normalized against this voice's running peak 0..1. */
  level: number
  /** True when the level dropped below 10% of the running peak — a stop
  *  consonant / bilabial; the lips must press fully. */
  closure: boolean
}

/** byte(0..255 dB-mapped) → linear magnitude. The analyser's byte spectrum is
 *  a 70dB dB-scale; summing raw bytes would make the -100dB noise floor
 *  contribute like speech. One decade per 20dB, the default range spans 70dB
 *  → 3.5 decades of magnitude. Precomputed once. */
const BYTE_TO_LIN = new Float32Array(256)
for (let b = 0; b < 256; b++) BYTE_TO_LIN[b] = Math.pow(10, (b / 255 - 1) * 3.5)

/** Running peak estimate of THIS voice (teacher's _v_peak: rise instantly on
 *  a louder frame, decay slowly so quiet syllables still read against it).
 *  Time-based decay (0.35/s) so the rate is poll-frequency independent. */
let mouthVPeak = 0
let mouthLastAt = 0

/** Sum of linear magnitudes for a frequency band (teacher's raw band sums —
 *  band widths intentionally NOT normalized, matching the reference). */
function bandSum(loHz: number, hiHz: number): number {
  if (!analyser || !freqData || !ctx) return 0
  const binHz = ctx.sampleRate / analyser.fftSize
  const lo = Math.max(0, Math.round(loHz / binHz))
  const hi = Math.min(freqData.length - 1, Math.round(hiHz / binHz))
  let sum = 0
  for (let i = lo; i <= hi; i++) sum += BYTE_TO_LIN[freqData[i]]
  return sum
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v)

/**
 * Formant-based mouth frame from the LIVE audio spectrum — the teacher's
 *  secret sauce, ported from Mark-LV main.py _pcm_visemes:
 *   F1-low 150-450Hz   (closed vowels)   F1-high 450-1100Hz (open vowels)
 *   F2-back 600-1300Hz (rounded)         F2-front 1700-3200Hz (spread)
 *   hiss 3800-8000Hz   (fricatives close the mouth)
 *   openness = F1hi/(F1lo+F1hi), damped by hiss ×(1 − 0.65·min(1,h·2.5))
 *   width = (F2f−F2b)/(F2f+F2b), damped by (1−openness)^0.8
 *   level is normalized against a running peak of this voice; closure when
 *   the level falls below 10% of it (a stop consonant drops ≥20dB).
 * Returns null when the analyser is unavailable (faces animate to rest).
 */
export function mistAudioFormants(): MouthFrame | null {
  if (!analyser || !freqData || !ctx) return null
  try {
    analyser.getByteFrequencyData(freqData)
  } catch {
    return null
  }

  const now = typeof performance !== 'undefined' ? performance.now() / 1000 : Date.now() / 1000
  const dt = mouthLastAt > 0 ? Math.min(0.5, Math.max(0.001, now - mouthLastAt)) : 0.016
  mouthLastAt = now

  // teacher's band masks (raw sums, no width normalization)
  const f1lo = bandSum(150, 450)
  const f1hi = bandSum(450, 1100)
  const f2bk = bandSum(600, 1300)
  const f2fr = bandSum(1700, 3200)
  const hiss = bandSum(3800, 8000)
  const voice = f1lo + f1hi + f2bk + f2fr

  // running peak of this voice (rise fast, decay ~0.35/s — scale-free at any
  // speaker volume, exactly why the teacher normalizes instead of fixing)
  const levelRaw = voice / 68 // voice-band mean magnitude (68 ≈ bins in 150-3200Hz at 48k/1024)
  mouthVPeak = Math.max(levelRaw, mouthVPeak - dt * 0.35)
  const ref = Math.max(mouthVPeak, 1e-6)

  // closure floor: 10% of this voice's own loud level (stop consonants drop
  // ≥20dB below the vowels around them — this ratio is that, expressed so it
  // holds at any volume)
  const closure = levelRaw < 0.1 * ref
  const q = clamp01((levelRaw - 0.1 * ref) / (ref * 0.9))

  // F1 shape, hiss-damped (fricatives are formed with a nearly closed mouth)
  const shapeOpen = clamp01(f1hi / (f1lo + f1hi + 1e-9))
  const h = hiss / (voice + hiss + 1e-9)
  const openness = shapeOpen * (1 - 0.65 * Math.min(1, h * 2.5))

  // F2 shape — a wide-open jaw physically cannot purse, so openness damps width
  const rawWidth = (f2fr - f2bk) / (f2fr + f2bk + 1e-9)
  const width = Math.max(-1, Math.min(1, rawWidth * Math.pow(1 - openness, 0.8)))

  // the teacher's fusion: level envelope × viseme shape → one jaw target
  const drive = Math.pow(q, 0.85) * Math.pow(openness, 0.75)
  return {
    openness: clamp01(drive),
    width,
    level: clamp01(levelRaw / ref),
    closure,
  }
}

/**
 * REAL time-domain waveform, downsampled to exactly `count` samples at
 * int16 scale (±32767) — the format the backtalk/ai-visualizer signal bus
 * expects. Returns null when the audio bus is unavailable; zeros when idle.
 */
export function mistAudioWaveform(count = 64): number[] | null {
  if (!analyser) return null
  try {
    if (!timeData || timeData.length !== analyser.fftSize) {
      timeData = new Uint8Array(analyser.fftSize)
    }
    analyser.getByteTimeDomainData(timeData)
  } catch {
    return null
  }
  const n = timeData.length
  const out: number[] = []
  for (let i = 0; i < count; i++) {
    // nearest-neighbor downsampling; byte 0..255 → int16 -32768..32767
    const idx = Math.min(n - 1, Math.round((i / Math.max(1, count - 1)) * (n - 1)))
    out.push(Math.round((timeData[idx] - 128) * 257))
  }
  return out
}
