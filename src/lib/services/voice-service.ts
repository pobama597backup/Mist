// M.I.S.T. voice service — SDK-backed TTS synthesis (WAV merge) + STT helpers
// TTS engines: 'glm' (7 rich cloud voices, keyless-free NOT) plus the no-auth
// English engines from tts-free.ts ('edge' neural, 'gtranslate' rescue).
//
// w3-speed SpokenCache: every synthesis first consults a persistent sha256
// cache (engine|voice|speed|text → audio bytes) at CHUNK level — the chunkers
// are deterministic, so the second time she says the same words the audio is
// served from SQLite in ~1ms instead of a fresh cloud synthesis. Cache I/O is
// fully guarded: a cache failure can never break or delay speech, and stores
// are fire-and-forget. After the first successful GLM/edge synthesis a
// one-shot background warm pre-synthesizes the top canned smalltalk lines, so
// after the first minute of use "hello" answers with INSTANT VOICE.
import { createHash } from 'node:crypto'
import { getZai } from './zai'
import { db } from '@/lib/db'
import { recordActivity } from './activity-service'
import { topCannedLinesForWarm } from './fast-path'
import {
  edgeSynthesize,
  edgeSilenceMp3,
  gtranslateSynthesize,
  isFreeEngine,
  type TtsEngine,
  type EdgeProsodyInput,
} from './tts-free'
import {
  EDGE_SOUND_PROSODY,
  EDGE_TONE_PROSODY,
  GLM_SOUND_SPEED,
  GLM_TONE_SPEED,
  SOUND_TEXT,
  hasEmotionMarkers,
  parseEmotionSegments,
  stripEmotionMarkers,
} from '@/lib/voice-emotion'

export const TTS_VOICES = ['tongtong', 'chuichui', 'xiaochen', 'jam', 'kazi', 'douji', 'luodo'] as const
export const DEFAULT_VOICE = 'tongtong'
const TTS_CHUNK_MAX = 1000 // SDK hard cap is 1024 chars per call

export type { TtsEngine }

/** What actually came back from synthesis — the route needs the real content
 *  type (GLM speaks WAV, keyless engines speak MP3) and the client/her tools
 *  deserve to know which engine spoke, especially on rescue fallback. */
export interface SynthesizedSpeech {
  buffer: Buffer
  contentType: 'audio/wav' | 'audio/mpeg'
  engineUsed: TtsEngine
  /** Set when the requested engine failed and a keyless engine rescued the utterance. */
  rescuedBy?: TtsEngine
}

export interface WavFormat {
  audioFormat: number // 1 = PCM
  channels: number
  sampleRate: number
  byteRate: number
  blockAlign: number
  bitsPerSample: number
}

export interface ParsedWav {
  format: WavFormat
  data: Buffer
}

function readAscii(buf: Buffer, start: number, len: number): string {
  return buf.toString('ascii', start, start + len)
}

/** Proper RIFF parser: iterates chunks to find 'fmt ' and 'data'. */
export function parseWav(buffer: Buffer): ParsedWav | null {
  try {
    if (buffer.length < 44) return null
    if (readAscii(buffer, 0, 4) !== 'RIFF' || readAscii(buffer, 8, 4) !== 'WAVE') return null
    let format: WavFormat | null = null
    let data: Buffer | null = null
    let offset = 12
    while (offset + 8 <= buffer.length) {
      const chunkId = readAscii(buffer, offset, 4)
      const chunkSize = buffer.readUInt32LE(offset + 4)
      const chunkStart = offset + 8
      if (chunkStart + chunkSize > buffer.length) break
      if (chunkId === 'fmt ' && !format) {
        format = {
          audioFormat: buffer.readUInt16LE(chunkStart),
          channels: buffer.readUInt16LE(chunkStart + 2),
          sampleRate: buffer.readUInt32LE(chunkStart + 4),
          byteRate: buffer.readUInt32LE(chunkStart + 8),
          blockAlign: buffer.readUInt16LE(chunkStart + 12),
          bitsPerSample: buffer.readUInt16LE(chunkStart + 14),
        }
      } else if (chunkId === 'data' && !data) {
        data = buffer.subarray(chunkStart, chunkStart + chunkSize)
      }
      // RIFF chunks are word-aligned
      offset = chunkStart + chunkSize + (chunkSize % 2)
    }
    if (!format || !data) return null
    return { format, data }
  } catch {
    return null
  }
}

/** Duration in seconds for a 16-bit PCM WAV upload, else null. */
export function wavDurationSeconds(buffer: Buffer): number | null {
  const parsed = parseWav(buffer)
  if (!parsed) return null
  const { format, data } = parsed
  if (format.audioFormat !== 1 || format.bitsPerSample !== 16 || format.byteRate <= 0) return null
  return data.length / format.byteRate
}

/** Write a fresh canonical 44-byte WAV header around raw PCM data. */
export function buildWav(format: WavFormat, data: Buffer): Buffer {
  const header = Buffer.alloc(44)
  header.write('RIFF', 0, 'ascii')
  header.writeUInt32LE(36 + data.length, 4)
  header.write('WAVE', 8, 'ascii')
  header.write('fmt ', 12, 'ascii')
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(format.audioFormat, 20)
  header.writeUInt16LE(format.channels, 22)
  header.writeUInt32LE(format.sampleRate, 24)
  header.writeUInt32LE(format.byteRate, 28)
  header.writeUInt16LE(format.blockAlign, 32)
  header.writeUInt16LE(format.bitsPerSample, 34)
  header.write('data', 36, 'ascii')
  header.writeUInt32LE(data.length, 40)
  return Buffer.concat([header, data])
}

/** Split text into ≤max-char chunks on sentence boundaries (fallback: whitespace / hard cut). */
export function chunkTextForTts(text: string, max = TTS_CHUNK_MAX): string[] {
  const trimmed = text.trim()
  if (trimmed.length <= max) return trimmed ? [trimmed] : []
  const chunks: string[] = []
  let rest = trimmed
  while (rest.length > max) {
    const window = rest.slice(0, max)
    let cut = -1
    const sentenceEnd = /[.!?。！？]["')\]]?\s/g
    let match: RegExpExecArray | null
    let lastEnd = -1
    while ((match = sentenceEnd.exec(window)) !== null) lastEnd = match.index + match[0].length
    if (lastEnd > 0) cut = lastEnd
    else {
      const space = window.lastIndexOf(' ')
      cut = space > 0 ? space + 1 : max
    }
    const chunk = rest.slice(0, cut).trim()
    if (chunk) chunks.push(chunk)
    rest = rest.slice(cut).trim()
  }
  if (rest) chunks.push(rest)
  return chunks
}

// ─── Mark-LV silence compression (ported 2026-09-30) ────────────────────────
// Mark-LV's Kokoro engine produced 1-2s punctuation pauses; the SDK voices do
// the same at sentence ends. Port of _compress_silence: ~10ms frames, RMS
// below threshold = silence, silent runs capped at maxSilenceMs (500ms) so
// natural prosody survives while extreme pauses vanish. Float math on 16-bit
// PCM, rebuilt under a fresh WAV header.
export function compressWavSilence(
  buffer: Buffer,
  opts: { maxSilenceMs?: number; threshold?: number } = {}
): { buffer: Buffer; trimmedMs: number } {
  const maxSilenceMs = opts.maxSilenceMs ?? 500
  const threshold = opts.threshold ?? 0.003 // RMS below this = silence
  const parsed = parseWav(buffer)
  if (!parsed || parsed.format.audioFormat !== 1 || parsed.format.bitsPerSample !== 16) {
    return { buffer, trimmedMs: 0 } // non-PCM16 — leave untouched
  }
  const { format, data } = parsed
  const frameSamples = Math.max(1, Math.round((format.sampleRate / 1000) * 10)) // ~10ms
  const frameBytes = frameSamples * 2 * format.channels
  const maxSilentFrames = Math.max(1, Math.round(maxSilenceMs / 10))

  const kept: Buffer[] = []
  let silentRun = 0
  let silentFramesKept = 0
  let silentFramesDropped = 0
  for (let off = 0; off < data.length; off += frameBytes) {
    const frame = data.subarray(off, Math.min(off + frameBytes, data.length))
    let sumSq = 0
    const samples = Math.floor(frame.length / 2)
    for (let i = 0; i + 1 < frame.length; i += 2) {
      const s = frame.readInt16LE(i) / 32768
      sumSq += s * s
    }
    const rms = Math.sqrt(sumSq / Math.max(1, samples))
    if (rms < threshold) {
      silentRun++
      if (silentRun <= maxSilentFrames) {
        kept.push(Buffer.from(frame))
        silentFramesKept++
      } else {
        silentFramesDropped++
      }
    } else {
      silentRun = 0
      kept.push(Buffer.from(frame))
    }
  }
  const trimmedMs = silentFramesDropped * 10
  if (silentFramesDropped === 0) return { buffer, trimmedMs: 0 }
  const merged = Buffer.concat(kept)
  return { buffer: buildWav(format, merged), trimmedMs }
}

function sanitizeVoice(voice: unknown): string {
  return typeof voice === 'string' && (TTS_VOICES as readonly string[]).includes(voice)
    ? voice
    : DEFAULT_VOICE
}

function sanitizeSpeed(speed: unknown): number {
  const n = typeof speed === 'number' ? speed : Number(speed)
  if (!Number.isFinite(n)) return 1.0
  return Math.min(2.0, Math.max(0.5, n))
}

async function ttsChunk(input: string, voice: string, speed: number): Promise<Buffer> {
  const zai = await getZai()
  const response = await zai.audio.tts.create({
    input,
    voice: voice as 'tongtong',
    speed,
    response_format: 'wav',
    stream: false,
  })
  const arrayBuffer = await response.arrayBuffer()
  return Buffer.from(new Uint8Array(arrayBuffer))
}

/** A degenerate-audio guard (2026-09-27 babble regression): the engine
 *  garbled text into babble ("nini ni na na") — detect, retry once, then fail
 *  honestly. 2026-09-28 silent-audio hole closed: a full-length but SILENT
 *  WAV (all-zero PCM) also passes the duration check — peak amplitude is
 *  sampled; <1% of full scale everywhere = degenerate.
 *  2026-09-30 FLOOR RECALIBRATED (Mark-LV port session, live probe): real
 *  GLM speech measures 13-17.6 chars/sec. The old floor (seconds * 4 < chars
 *  = max 4 chars/sec) rejected EVERY normal-rate utterance as "too short" —
 *  every GLM reply was silently rescued to the Edge voice. The floor is now
 *  the fastest natural speech (~20 chars/sec ≈ 240 wpm): audio shorter than
 *  chars/20 cannot possibly contain the text, while 13-17 chars/sec normal
 *  speech passes. Babble (40+ chars/sec of "nini ni na") still trips it. */
function ttsAudioLooksDegenerate(buffer: Buffer, text: string): boolean {
  const parsed = parseWav(buffer)
  if (!parsed) return true // non-RIFF payload — never expected from the SDK
  const { format, data } = parsed
  if (format.audioFormat !== 1 || format.channels < 1 || format.byteRate <= 0) return true
  if (data.length === 0) return true
  const seconds = data.length / format.byteRate
  const chars = text.trim().length
  // 20 chars/sec ≈ 240 wpm — no real speech is faster; shorter audio than
  // chars/20 seconds cannot contain the text (babble trips this hard)
  if (seconds * 20 < chars) return true
  if (format.bitsPerSample === 16 && data.length >= 2) {
    let peak = 0
    // sample ≤ ~10k frames (even stride keeps 2-byte sample alignment)
    const stride = Math.max(2, 2 * Math.floor(data.length / 2 / 10_000))
    for (let i = 0; i + 1 < data.length; i += stride) {
      const s = Math.abs(data.readInt16LE(i))
      if (s > peak) peak = s
      if (peak >= 328) break // ≥1% of full scale — audibly present, done
    }
    if (peak < 328) return true // silence across the whole clip
  }
  return false
}

/** One chunk with one degenerate/retry pass. Rate-limit (429) and other SDK
 *  errors surface with their true status so callers can back off honestly. */
async function ttsChunkGuarded(input: string, voice: string, speed: number): Promise<Buffer> {
  let last: unknown = null
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 1500)) // let the limiter breathe
    try {
      const buf = await ttsChunk(input, voice, speed)
      if (!ttsAudioLooksDegenerate(buf, input)) return buf
      last = new Error('engine returned degenerate audio for this text')
      continue
    } catch (err) {
      // 429s are transient — one retry is fair; anything else surfaces now
      const msg = err instanceof Error ? err.message : String(err)
      if (/429|too many requests/i.test(msg)) {
        last = err
        continue
      }
      throw err
    }
  }
  throw last instanceof Error ? last : new Error('text-to-speech failed after retry')
}

// ─── w3-speed SpokenCache ────────────────────────────────────────────────────

/** Cache key for a spoken utterance: sha256(engine|voice|speed|text). */
export function spokenCacheHash(engine: string, voice: string, speed: number, text: string): string {
  return createHash('sha256').update(`${engine}|${voice}|${speed.toFixed(2)}|${text}`).digest('hex')
}

/** O(1) cache read. Any failure → null (synthesize normally). */
async function lookupSpoken(hash: string): Promise<Buffer | null> {
  try {
    const hit = await db.spokenCache.findUnique({ where: { hash } })
    if (hit && hit.bytes && hit.bytes.length > 44) return Buffer.from(hit.bytes)
    return null
  } catch {
    return null
  }
}

/** Best-effort store + trim guard (>400 entries → drop the oldest ~100).
 *  Never awaited on the speech path — failures are swallowed. */
async function storeSpoken(hash: string, buffer: Buffer): Promise<void> {
  try {
    // Prisma's Bytes field wants Uint8Array<ArrayBuffer>; Buffer is
    // ArrayBufferLike — a copy into a fresh Uint8Array satisfies both.
    const bytes = new Uint8Array(buffer)
    await db.spokenCache.upsert({
      where: { hash },
      update: { bytes, size: bytes.length },
      create: { hash, bytes, size: bytes.length },
    })
    const count = await db.spokenCache.count()
    if (count > 400) {
      const oldest = await db.spokenCache.findMany({
        orderBy: { createdAt: 'asc' },
        take: 100,
        select: { id: true },
      })
      if (oldest.length > 0) {
        await db.spokenCache.deleteMany({ where: { id: { in: oldest.map((o) => o.id) } } })
      }
    }
  } catch {
    /* a cache failure must never break or delay speech */
  }
}

/** GLM chunk synthesis through the SpokenCache. Cache hit → the exact bytes
 *  she spoke last time (no re-synthesis, no increment — O(1)); miss →
 *  synthesize, store fire-and-forget, and arm the background warm. */
async function cachedGlmChunk(text: string, voice: string, speed: number): Promise<Buffer> {
  const hash = spokenCacheHash('glm', voice, speed, text)
  const hit = await lookupSpoken(hash)
  if (hit) return hit
  const buffer = await ttsChunkGuarded(text, voice, speed)
  void storeSpoken(hash, buffer)
  maybeWarmSpokenCache()
  return buffer
}

/** Keyless-engine synthesis through the SpokenCache (whole utterance —
 *  those engines have no chunk merging). w8: an optional prosody override
 *  (the emotion layer) becomes part of the cache key so a whispered line
 *  never replays as its normal-voice twin. */
async function cachedFreeSynthesis(
  engine: 'edge' | 'gtranslate',
  text: string,
  voice: string | undefined,
  speed: number,
  prosody?: EdgeProsodyInput
): Promise<Buffer> {
  const key = prosody
    ? `${text}|px:${prosody.rate ?? ''};${prosody.pitch ?? ''};${prosody.volume ?? ''}`
    : text
  const hash = spokenCacheHash(engine, voice ?? '', speed, key)
  const hit = await lookupSpoken(hash)
  if (hit) return hit
  const buffer = engine === 'edge' ? await edgeSynthesize(text, voice, speed, prosody) : await gtranslateSynthesize(text)
  void storeSpoken(hash, buffer)
  if (engine === 'edge') maybeWarmSpokenCache()
  return buffer
}

// ─── w3-speed background warm ──────────────────────────────────────────────────
// After ANY successful GLM/edge synthesis (once per process — the globalThis
// flag survives dev hot-reload module swaps), pre-synthesize the TOP canned
// smalltalk lines (shortest variants of the most frequent classes, default
// voice/engine/speed the client actually sends: glm / tongtong / 1.0) one at
// a time with 2s gaps. After the first minute of use, "hello" answers with
// instant VOICE, not just instant text.

const spokenWarmGlobal = globalThis as unknown as { __mistSpokenWarmDone?: boolean }

function maybeWarmSpokenCache(): void {
  const g = spokenWarmGlobal
  if (g.__mistSpokenWarmDone) return
  g.__mistSpokenWarmDone = true
  void (async () => {
    try {
      const lines = topCannedLinesForWarm(10)
      let stored = 0
      for (const line of lines) {
        await new Promise((r) => setTimeout(r, 2000)) // 2s gaps — kind to the rate limiter
        try {
          const hash = spokenCacheHash('glm', 'tongtong', 1.0, line)
          if (await db.spokenCache.findUnique({ where: { hash } })) continue
          // hard per-line timeout — an un-timed SDK call could hang the warm
          // forever on a bad day; a skipped line costs nothing
          const buffer = await Promise.race([
            ttsChunkGuarded(line, 'tongtong', 1.0),
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error('warm line timed out')), 45_000)
            ),
          ])
          await storeSpoken(hash, buffer)
          stored++
        } catch {
          break // engine is limiting/failing — stop quietly, some warmth banked
        }
      }
      console.log(
        `[mist:warm] spoken cache warmed: ${stored}/${lines.length} canned lines pre-synthesized (glm/tongtong) — instant voice ready`
      )
    } catch {
      /* warm is best-effort, never spoken of */
    }
  })()
}

// ─── w8 voice emotion — marker rendering per engine ─────────────────────────
// The LLM may inline markers ([sigh] [laugh] [whisper] …) in her replies.
// GLM (SDK: voice + speed only) renders tones as per-segment speed
// modulations, sounds as prosody-tuned vocalizations, pauses as raw PCM
// zeros — all merged under one WAV header. Edge renders tones as real
// prosody (rate/pitch/volume), pauses as ffmpeg-spliced silent MP3 frames.
// Both go through the SpokenCache; every existing guard (degenerate audio,
// rescue chains) keeps running.

const clampSpeed = (s: number) => Math.min(2.0, Math.max(0.5, s))

/** GLM: marker text → one WAV buffer (per-segment synth + PCM assembly). */
async function emotionalGlm(text: string, voice: string, speed: number): Promise<Buffer> {
  const segments = parseEmotionSegments(text)
  const pieces: Array<{ pcm: Buffer } | { pauseMs: number }> = []
  for (const seg of segments) {
    if (seg.kind === 'pause') {
      pieces.push({ pauseMs: seg.ms })
      continue
    }
    if (seg.kind === 'sound') {
      const buf = await cachedGlmChunk(SOUND_TEXT[seg.sound], voice, clampSpeed(GLM_SOUND_SPEED[seg.sound]))
      pieces.push({ pcm: buf })
      continue
    }
    const trimmed = seg.text.trim()
    if (!trimmed) continue
    for (const chunk of chunkTextForTts(trimmed)) {
      const buf = await cachedGlmChunk(chunk, voice, clampSpeed(speed * GLM_TONE_SPEED[seg.tone]))
      pieces.push({ pcm: buf })
    }
  }
  // resolve formats + build the pause zeros now that a real format exists
  const parsed: Buffer[] = []
  let format: WavFormat | null = null
  for (const piece of pieces) {
    if ('pauseMs' in piece) {
      if (format) parsed.push(Buffer.alloc(Math.round((format.byteRate * piece.pauseMs) / 1000)))
      continue // no format yet (pause before any speech) — skipped honestly
    }
    const p = parseWav(piece.pcm)
    if (!p) throw new Error('unexpected TTS audio format (non-RIFF payload)')
    format ??= p.format
    parsed.push(p.data)
  }
  if (!format || parsed.length === 0) throw new Error('nothing to synthesize')
  return buildWav(format, Buffer.concat(parsed))
}

/** Edge: marker text → one MP3 buffer (per-segment prosody + silence). */
async function emotionalEdge(text: string, voice: unknown, speed: number): Promise<Buffer> {
  const segments = parseEmotionSegments(text)
  const parts: Buffer[] = []
  for (const seg of segments) {
    if (seg.kind === 'pause') {
      const silence = await edgeSilenceMp3(seg.ms)
      if (silence.length) parts.push(silence)
      continue
    }
    if (seg.kind === 'sound') {
      parts.push(await cachedFreeSynthesis('edge', SOUND_TEXT[seg.sound], voice as string | undefined, 1.0, EDGE_SOUND_PROSODY[seg.sound]))
      continue
    }
    const trimmed = seg.text.trim()
    if (!trimmed) continue
    const tone = EDGE_TONE_PROSODY[seg.tone]
    const hasProsody = seg.tone !== 'normal' && (tone.rate || tone.pitch || tone.volume)
    parts.push(
      await cachedFreeSynthesis(
        'edge',
        trimmed,
        voice as string | undefined,
        speed,
        hasProsody ? tone : undefined
      )
    )
  }
  const real = parts.filter((p) => p.length > 0)
  if (real.length === 0) throw new Error('nothing to synthesize')
  return Buffer.concat(parts)
}

/**
 * Synthesize speech through the selected engine.
 *  - glm: rich cloud voices, WAV, degenerate-audio guarded (retry), and when
 *    the guard exhausts (babble/429) the utterance is RESCUED on the keyless
 *    Edge engine — the creator never hears babble again, GLM or not.
 *  - edge / gtranslate: keyless English voices (MP3), no rescue needed.
 *  - w8 voice emotion: marker-laden text renders per engine (see above);
 *    engines with no emotion support (gtranslate) and every RESCUE path
 *    speak the marker-stripped text — a rescue never reads "[sigh]" aloud.
 * Single chunk → its buffer returned untouched; multiple GLM chunks → PCM
 * concatenated under one fresh 44-byte WAV header.
 */
export async function synthesizeSpeech(
  text: string,
  voiceInput: unknown,
  speedInput: unknown,
  engineInput: unknown = 'glm'
): Promise<SynthesizedSpeech> {
  const voice = sanitizeVoice(voiceInput)
  const speed = sanitizeSpeed(speedInput)
  const engine: TtsEngine = engineInput === 'edge' || engineInput === 'gtranslate' ? engineInput : 'glm'

  // Keyless engines — one shot, honest errors (through the SpokenCache).
  // w8: edge performs the markers; gtranslate speaks the stripped text.
  if (isFreeEngine(engine)) {
    try {
      if (engine === 'edge' && hasEmotionMarkers(text)) {
        const buffer = await emotionalEdge(text, voice, speed)
        recordActivity('voice', `tts emotional edge (${voice || 'aria'}, ${parseEmotionSegments(text).length} segments)`)
        return { buffer, contentType: 'audio/mpeg', engineUsed: 'edge' }
      }
      const plain = hasEmotionMarkers(text) ? stripEmotionMarkers(text) : text
      const buffer = await cachedFreeSynthesis(engine, plain, voice, speed)
      return { buffer, contentType: 'audio/mpeg', engineUsed: engine }
    } catch (err) {
      // Edge blocked/slow → gtranslate is the final keyless rescue (markers
      // stripped — the robotic rescue voice never reads "[sigh]" aloud)
      if (engine === 'edge') {
        const buffer = await cachedFreeSynthesis('gtranslate', stripEmotionMarkers(text), undefined, speed)
        return { buffer, contentType: 'audio/mpeg', engineUsed: 'edge', rescuedBy: 'gtranslate' }
      }
      throw err
    }
  }

  // GLM with markers — the emotional path, with the SAME rescue chain on
  // failure (stripped text — a rescue is a rescue, not a performance)
  if (hasEmotionMarkers(text)) {
    const plain = stripEmotionMarkers(text)
    try {
      const buffer = await emotionalGlm(text, voice, speed)
      recordActivity('voice', `tts emotional glm (${voice}, ${parseEmotionSegments(text).length} segments)`)
      return { buffer, contentType: 'audio/wav', engineUsed: 'glm' }
    } catch (glmErr) {
      try {
        const buffer = await cachedFreeSynthesis('edge', plain, undefined, speed)
        recordActivity('voice', `tts emotional glm failed (${glmErr instanceof Error ? glmErr.message.slice(0, 80) : 'error'}) — rescued on keyless edge`)
        return { buffer, contentType: 'audio/mpeg', engineUsed: 'glm', rescuedBy: 'edge' }
      } catch {
        try {
          const buffer = await cachedFreeSynthesis('gtranslate', plain, undefined, speed)
          recordActivity('voice', 'tts emotional glm failed and edge unreachable — rescued on keyless gtranslate')
          return { buffer, contentType: 'audio/mpeg', engineUsed: 'glm', rescuedBy: 'gtranslate' }
        } catch {
          throw glmErr
        }
      }
    }
  }

  const chunks = chunkTextForTts(text)
  if (chunks.length === 0) throw new Error('nothing to synthesize')

  const buffers: Buffer[] = []
  try {
    for (const chunk of chunks) {
      // sequential — preserves ordering and avoids burst-limiting
      // (w3-speed: each chunk consults the SpokenCache first)
      buffers.push(await cachedGlmChunk(chunk, voice, speed))
    }
  } catch (glmErr) {
    // GLM babbled/limited twice — the creator's hard requirement: NEVER babble.
    // Rescue the whole utterance on the keyless engines. 2026-09-28 chain
    // completion: the rescue used to be edge-only, and when edge's websocket
    // was ALSO unreachable (sandbox/firewall egress) the utterance died with a
    // 500 — the orb danced through 'speaking' while NO voice came out (live
    // case). The chain now runs edge (nicer neural voice) → gtranslate (works
    // on any network that can reach the web) → honest original error.
    try {
      const buffer = await cachedFreeSynthesis('edge', text, undefined, speed)
      recordActivity('voice', `tts glm failed (${glmErr instanceof Error ? glmErr.message.slice(0, 80) : 'error'}) — rescued on keyless edge`)
      return { buffer, contentType: 'audio/mpeg', engineUsed: 'glm', rescuedBy: 'edge' }
    } catch {
      try {
        const buffer = await cachedFreeSynthesis('gtranslate', text, undefined, speed)
        recordActivity('voice', `tts glm failed and edge unreachable — rescued on keyless gtranslate`)
        return { buffer, contentType: 'audio/mpeg', engineUsed: 'glm', rescuedBy: 'gtranslate' }
      } catch {
        throw glmErr // every engine failed — surface the original honest error
      }
    }
  }

  if (buffers.length === 1) return { buffer: buffers[0], contentType: 'audio/wav', engineUsed: 'glm' }

  const parsedParts: ParsedWav[] = []
  for (const buf of buffers) {
    const parsed = parseWav(buf)
    if (!parsed) throw new Error('unexpected TTS audio format (non-RIFF payload)')
    parsedParts.push(parsed)
  }
  const format = parsedParts[0].format // all chunks share the SDK voice format
  const merged = Buffer.concat(parsedParts.map((p) => p.data))
  recordActivity('voice', `tts synthesized ${chunks.length} chunks (${voice})`)
  return { buffer: buildWav(format, merged), contentType: 'audio/wav', engineUsed: 'glm' }
}

/** Transcribe an audio buffer via SDK ASR. Returns text + WAV duration when derivable. */
export async function transcribeAudio(buffer: Buffer): Promise<{ text: string; duration: number | null }> {
  const zai = await getZai()
  const base64 = buffer.toString('base64')
  const response = await zai.audio.asr.create({ file_base64: base64 })
  const text: unknown = (response as { text?: unknown })?.text
  const duration = wavDurationSeconds(buffer)
  recordActivity('voice', `stt transcribed ${duration ? duration.toFixed(1) + 's' : 'audio'}`)
  return { text: typeof text === 'string' ? text : '', duration }
}

// ─── Mark-LV streaming synthesis (ported 2026-09-30) ────────────────────────
// Mark-LV's producer/consumer insight: "chunk N+1 synthesises WHILE chunk N
// plays, cutting perceived latency by the playback duration of all but the
// last chunk." The old path synthesized EVERY chunk, merged them into one
// WAV, and only then returned — the creator waited for the full text before
// hearing the first word. The streaming path hands each chunk to onChunk the
// moment it is synthesized: the route flushes it, the client starts playing
// chunk 0 while the server is still synthesizing chunk 1.
//
// THE LEAD CHUNK (measured 2026-09-30): GLM synthesizes ~1s of speech per
// ~0.31s of wall time, so an 887-char single chunk = 20.4s of silence before
// the first word. The stream chunker therefore cuts a SMALL lead chunk
// (≤220 chars ≈ 2 sentences → speech starts in ~5s) and uses bigger follow-up
// chunks (≤400 chars) to keep SDK call count and rate limits friendly. The
// blob path keeps the old 1000-char max — merging is fine there.
//
// Ordering is sequential (never parallel — burst-limiting is real on this
// SDK), the degenerate-audio guard still runs per chunk, and the silence
// compressor tightens every chunk before it ships. If the GLM engine fails
// mid-stream, the REMAINING text (including the failed chunk) is rescued on
// the keyless engines — what already played is never repeated.

const STREAM_LEAD_MAX = 220 // first chunk — speech starts fast
const STREAM_FOLLOW_MAX = 400 // follow-ups — fewer SDK calls, rate-limit friendly

/** Stream chunker: a small lead chunk, then medium follow-ups. */
export function chunkTextForStream(text: string): string[] {
  const trimmed = text.trim()
  if (!trimmed) return []
  if (trimmed.length <= STREAM_LEAD_MAX) return [trimmed]
  const leadPieces = chunkTextForTts(trimmed, STREAM_LEAD_MAX)
  const lead = leadPieces[0]
  const rest = trimmed.slice(lead.length).trim()
  if (!rest) return leadPieces
  return [lead, ...chunkTextForTts(rest, STREAM_FOLLOW_MAX)]
}

export interface StreamChunk {
  seq: number
  text: string
  buffer: Buffer
  contentType: 'audio/wav' | 'audio/mpeg'
  engineUsed: TtsEngine
  rescuedBy?: TtsEngine
  trimmedSilenceMs: number
}

export interface StreamResult {
  chunks: number
  engineUsed: TtsEngine
  rescuedBy?: TtsEngine
  error?: string
}

export async function synthesizeSpeechStream(
  text: string,
  voiceInput: unknown,
  speedInput: unknown,
  engineInput: unknown = 'glm',
  onChunk: (chunk: StreamChunk) => void
): Promise<StreamResult> {
  const voice = sanitizeVoice(voiceInput)
  const speed = sanitizeSpeed(speedInput)
  const engine: TtsEngine = engineInput === 'edge' || engineInput === 'gtranslate' ? engineInput : 'glm'

  // Keyless engines — one whole-utterance shot (they have no chunk merging;
  // w3-speed: through the SpokenCache; w8: edge performs the markers)
  if (isFreeEngine(engine)) {
    try {
      if (engine === 'edge' && hasEmotionMarkers(text)) {
        const buffer = await emotionalEdge(text, voice, speed)
        onChunk({ seq: 0, text: stripEmotionMarkers(text), buffer, contentType: 'audio/mpeg', engineUsed: 'edge', trimmedSilenceMs: 0 })
        return { chunks: 1, engineUsed: 'edge' }
      }
      const plain = hasEmotionMarkers(text) ? stripEmotionMarkers(text) : text
      const buffer = await cachedFreeSynthesis(engine, plain, voice, speed)
      onChunk({ seq: 0, text: plain, buffer, contentType: 'audio/mpeg', engineUsed: engine, trimmedSilenceMs: 0 })
      return { chunks: 1, engineUsed: engine }
    } catch (err) {
      if (engine === 'edge') {
        const buffer = await cachedFreeSynthesis('gtranslate', stripEmotionMarkers(text), undefined, speed)
        onChunk({ seq: 0, text: stripEmotionMarkers(text), buffer, contentType: 'audio/mpeg', engineUsed: 'edge', rescuedBy: 'gtranslate', trimmedSilenceMs: 0 })
        return { chunks: 1, engineUsed: 'edge', rescuedBy: 'gtranslate' }
      }
      throw err
    }
  }

  const chunks = chunkTextForStream(text)
  if (chunks.length === 0) throw new Error('nothing to synthesize')

  let seq = 0
  let delivered = 0
  let rescuedBy: TtsEngine | undefined
  let failReason: string | undefined

  for (let i = 0; i < chunks.length; i++) {
    const chunkText = chunks[i]
    try {
      // w3-speed: chunk-level SpokenCache consult — repeated lines (canned
      // smalltalk, common phrases) come back in ~1ms with the exact audio.
      // w8: a marker-carrying chunk renders through the emotional path.
      const raw = hasEmotionMarkers(chunkText)
        ? await emotionalGlm(chunkText, voice, speed)
        : await cachedGlmChunk(chunkText, voice, speed)
      // silence-compress each chunk before it ships (Mark-LV: cap pauses)
      const { buffer, trimmedMs } = compressWavSilence(raw)
      onChunk({ seq: seq++, text: stripEmotionMarkers(chunkText), buffer, contentType: 'audio/wav', engineUsed: 'glm', trimmedSilenceMs: trimmedMs })
      delivered++
    } catch (glmErr) {
      // GLM babbled/limited on this chunk — rescue the REMAINING text on the
      // keyless chain (edge → gtranslate), exactly once, in ONE piece so the
      // fallback voice doesn't re-speak what already played.
      failReason = glmErr instanceof Error ? glmErr.message : String(glmErr)
      const remaining = stripEmotionMarkers(chunks.slice(i).join(' '))
      try {
        const buffer = await cachedFreeSynthesis('edge', remaining, undefined, speed)
        rescuedBy = 'edge'
        onChunk({ seq: seq++, text: remaining, buffer, contentType: 'audio/mpeg', engineUsed: 'glm', rescuedBy: 'edge', trimmedSilenceMs: 0 })
        delivered++
      } catch {
        try {
          const buffer = await cachedFreeSynthesis('gtranslate', remaining, undefined, speed)
          rescuedBy = 'gtranslate'
          onChunk({ seq: seq++, text: remaining, buffer, contentType: 'audio/mpeg', engineUsed: 'glm', rescuedBy: 'gtranslate', trimmedSilenceMs: 0 })
          delivered++
        } catch {
          if (delivered > 0) {
            // partial delivery + total failure — the client keeps what played
            recordActivity('voice', `tts stream failed after ${delivered} chunk(s): ${failReason.slice(0, 80)}`)
            return { chunks: delivered, engineUsed: 'glm', error: failReason }
          }
          throw glmErr
        }
      }
      break // rescued in one piece — done
    }
  }

  recordActivity(
    'voice',
    `tts streamed ${delivered} chunk(s) (${voice}${rescuedBy ? `, rescued on ${rescuedBy}` : ''})`
  )
  return { chunks: delivered, engineUsed: 'glm', rescuedBy }
}
