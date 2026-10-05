// M.I.S.T. keyless TTS engines — English neural voices, no API key, no signup.
//
// Why this exists (2026-09 creator request): the GLM cloud TTS intermittently
// degrades under load — the creator kept hearing babble ("nini ni na na")
// instead of the written text. These engines need zero authentication:
//
//   edge       — Microsoft Edge's public "read aloud" neural channel (the same
//                one msedge-tts / edge-tts use). High-quality neural voices,
//                many English accents, free, keyless. PRIMARY no-auth choice.
//   gtranslate — Google Translate's TTS endpoint. One voice, robotic-ish, but
//                bulletproof. LAST-RESORT rescue when Edge is blocked.
//
// English-only by the creator's instruction. Both engines return MP3; the
// client player accepts any audio blob (object URL → <audio>), so no WAV
// conversion is needed.
import { execFile } from 'node:child_process'
import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts'
import { recordActivity } from './activity-service'
import type { EdgeProsodyInput } from '@/lib/voice-emotion'

export type { EdgeProsodyInput }

export type FreeTtsEngine = 'edge' | 'gtranslate'

export interface FreeVoiceInfo {
  id: string
  label: string
  language: string
  accent: string
  gender: 'female' | 'male'
  engine: FreeTtsEngine
}

export type TtsEngine = 'glm' | FreeTtsEngine

/** Curated English-only neural voices for the Edge keyless channel. */
export const EDGE_VOICES: FreeVoiceInfo[] = [
  { id: 'en-US-AriaNeural', label: 'Aria', language: 'en', accent: 'US', gender: 'female', engine: 'edge' },
  { id: 'en-US-JennyNeural', label: 'Jenny', language: 'en', accent: 'US', gender: 'female', engine: 'edge' },
  { id: 'en-US-MichelleNeural', label: 'Michelle', language: 'en', accent: 'US', gender: 'female', engine: 'edge' },
  { id: 'en-US-GuyNeural', label: 'Guy', language: 'en', accent: 'US', gender: 'male', engine: 'edge' },
  { id: 'en-US-ChristopherNeural', label: 'Christopher', language: 'en', accent: 'US', gender: 'male', engine: 'edge' },
  { id: 'en-US-RogerNeural', label: 'Roger', language: 'en', accent: 'US', gender: 'male', engine: 'edge' },
  { id: 'en-GB-SoniaNeural', label: 'Sonia', language: 'en', accent: 'GB', gender: 'female', engine: 'edge' },
  { id: 'en-GB-LibbyNeural', label: 'Libby', language: 'en', accent: 'GB', gender: 'female', engine: 'edge' },
  { id: 'en-GB-RyanNeural', label: 'Ryan', language: 'en', accent: 'GB', gender: 'male', engine: 'edge' },
  { id: 'en-GB-ThomasNeural', label: 'Thomas', language: 'en', accent: 'GB', gender: 'male', engine: 'edge' },
  { id: 'en-AU-NatashaNeural', label: 'Natasha', language: 'en', accent: 'AU', gender: 'female', engine: 'edge' },
  { id: 'en-AU-WilliamNeural', label: 'William', language: 'en', accent: 'AU', gender: 'male', engine: 'edge' },
  { id: 'en-CA-ClaraNeural', label: 'Clara', language: 'en', accent: 'CA', gender: 'female', engine: 'edge' },
  { id: 'en-CA-LiamNeural', label: 'Liam', language: 'en', accent: 'CA', gender: 'male', engine: 'edge' },
  { id: 'en-IN-NeerjaNeural', label: 'Neerja', language: 'en', accent: 'IN', gender: 'female', engine: 'edge' },
  { id: 'en-IN-PrabhatNeural', label: 'Prabhat', language: 'en', accent: 'IN', gender: 'male', engine: 'edge' },
  { id: 'en-ZA-LeahNeural', label: 'Leah', language: 'en', accent: 'ZA', gender: 'female', engine: 'edge' },
  { id: 'en-ZA-LukeNeural', label: 'Luke', language: 'en', accent: 'ZA', gender: 'male', engine: 'edge' },
]

export const DEFAULT_EDGE_VOICE = 'en-US-AriaNeural'

/** One English voice for the gtranslate rescue channel (honest, single). */
export const GTRANSLATE_VOICE: FreeVoiceInfo = {
  id: 'gtranslate-en',
  label: 'Google (rescue)',
  language: 'en',
  accent: 'US',
  gender: 'female',
  engine: 'gtranslate',
}

export function isFreeEngine(v: unknown): v is FreeTtsEngine {
  return v === 'edge' || v === 'gtranslate'
}

export function isTtsEngine(v: unknown): v is TtsEngine {
  return v === 'glm' || isFreeEngine(v)
}

function sanitizeEdgeVoice(voice: unknown): string {
  if (typeof voice === 'string' && EDGE_VOICES.some((v) => v.id === voice)) return voice
  return DEFAULT_EDGE_VOICE
}

/** Combine the speed-derived rate with a tone's relative rate (both are
 *  relative percentages — they add). w8 voice emotion. */
function combineRate(speed: number, toneRate?: string): string {
  const base = Math.round((speed - 1) * 100)
  const m = /^([+-]?\d+)%$/.exec(toneRate ?? '')
  const add = m ? parseInt(m[1], 10) : 0
  const pct = Math.max(-80, Math.min(80, base + add))
  return `${pct >= 0 ? '+' : ''}${pct}%`
}

/** Minimal sanity floor for MP3 payloads: at ~48kbps mono, English speech is
 *  roughly 25–35 bytes per character. Below 8 bytes/char the audio cannot
 *  possibly contain the text — same spirit as the WAV degenerate guard. */
function mp3LooksDegenerate(buffer: Buffer, text: string): boolean {
  if (buffer.length < 64) return true
  return buffer.length < text.trim().length * 8
}

/** Synthesize one utterance through the Edge keyless neural channel.
 *  The whole text goes in one request (Edge handles minutes of audio; the
 *  client caps utterances at ~900 chars anyway). w8: an optional prosody
 *  override carries the emotion layer (rate/pitch/volume — the ONLY tags
 *  this channel honors; no express-as styles, no <break>). Never throws a
 *  raw crash — honest Error with a speakable message. */
export async function edgeSynthesize(
  text: string,
  voice: unknown,
  speed = 1.0,
  prosody?: EdgeProsodyInput
): Promise<Buffer> {
  const v = sanitizeEdgeVoice(voice)
  const s = Math.min(2.0, Math.max(0.5, Number.isFinite(speed) ? speed : 1.0))
  let timedOut = false
  const timeout = new Promise<never>((_, reject) => {
    setTimeout(() => {
      timedOut = true
      reject(new Error('edge voice timed out (no key needed, but the channel was slow)'))
    }, 30_000)
  })
  const work = async (): Promise<Buffer> => {
    const tts = new MsEdgeTTS()
    await tts.setMetadata(v, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3)
    const opts = {
      rate: combineRate(s, prosody?.rate),
      ...(prosody?.pitch ? { pitch: prosody.pitch } : {}),
      ...(prosody?.volume ? { volume: prosody.volume } : {}),
    }
    const { audioStream } = tts.toStream(text, opts)
    const parts: Buffer[] = []
    for await (const chunk of audioStream) {
      parts.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as ArrayBufferLike))
      if (timedOut) throw new Error('edge voice timed out')
    }
    const buf = Buffer.concat(parts)
    if (mp3LooksDegenerate(buf, text)) {
      throw new Error('edge voice returned degenerate audio for this text')
    }
    recordActivity('voice', `tts keyless edge ${v} (${buf.length}B mp3)`)
    return buf
  }
  return Promise.race([work(), timeout])
}

/** Google Translate TTS: 200-char chunks, sequential, MP3 parts concatenated
 *  (frame-based format — browsers play concatenations fine). Single voice. */
export async function gtranslateSynthesize(text: string): Promise<Buffer> {
  const trimmed = text.trim()
  if (!trimmed) throw new Error('nothing to synthesize')
  const chunks: string[] = []
  let rest = trimmed
  while (rest.length > 200) {
    const window = rest.slice(0, 200)
    const cut = Math.max(window.lastIndexOf(' '), window.lastIndexOf(','), 100)
    chunks.push(rest.slice(0, cut).trim())
    rest = rest.slice(cut).trim()
  }
  if (rest) chunks.push(rest)

  const parts: Buffer[] = []
  for (let i = 0; i < chunks.length; i++) {
    const url =
      'https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl=en&q=' +
      encodeURIComponent(chunks[i])
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
    })
    if (!res.ok) {
      throw new Error(`google rescue voice failed (http ${res.status})`)
    }
    const arr = Buffer.from(await res.arrayBuffer())
    if (mp3LooksDegenerate(arr, chunks[i])) {
      throw new Error('google rescue voice returned degenerate audio')
    }
    parts.push(arr)
    if (i < chunks.length - 1) await new Promise((r) => setTimeout(r, 120)) // be polite
  }
  const buf = Buffer.concat(parts)
  recordActivity('voice', `tts keyless gtranslate (${chunks.length} chunks, ${buf.length}B)`)
  return buf
}

/** Full catalog for the settings UI / her tools: every English keyless voice. */
export function freeTtsCatalog(): { engines: TtsEngine[]; voices: FreeVoiceInfo[] } {
  return { engines: ['glm', 'edge', 'gtranslate'], voices: [...EDGE_VOICES, GTRANSLATE_VOICE] }
}

// ─── w8 voice emotion: silence for the Edge lane ─────────────────────────────
// The channel accepts no <break> SSML, so a [pause] marker is spliced in as
// real silent MP3 frames, generated once by ffmpeg (the machine has
// /usr/bin/ffmpeg) and cached per duration bucket. Any failure → an empty
// buffer and the pause is simply skipped (honest degradation, never a crash).

const silenceGlobal = globalThis as unknown as {
  __mistEdgeSilence?: Map<number, Buffer>
}

/** Silent MP3 (24kHz mono 48kbps — same format the channel emits). */
export async function edgeSilenceMp3(ms: number): Promise<Buffer> {
  const bucket = Math.max(200, Math.min(2000, Math.round(ms / 250) * 250))
  silenceGlobal.__mistEdgeSilence ??= new Map<number, Buffer>()
  const cached = silenceGlobal.__mistEdgeSilence.get(bucket)
  if (cached) return cached
  const secs = (bucket / 1000).toFixed(3)
  try {
    const { stdout } = await new Promise<{ stdout: Buffer }>((resolve, reject) => {
      const child = execFile(
        'ffmpeg',
        ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `anullsrc=r=24000:cl=mono`, '-t', secs, '-b:a', '48k', '-f', 'mp3', 'pipe:1'],
        { encoding: 'buffer', timeout: 8000, maxBuffer: 4 * 1024 * 1024 },
        (err, stdout) => (err ? reject(err) : resolve({ stdout: stdout as unknown as Buffer }))
      )
      // guard against a child that never exits
      child.on('error', reject)
    })
    if (stdout.length < 64) throw new Error('ffmpeg produced no silence')
    silenceGlobal.__mistEdgeSilence.set(bucket, stdout)
    return stdout
  } catch {
    silenceGlobal.__mistEdgeSilence.set(bucket, Buffer.alloc(0))
    return Buffer.alloc(0) // ffmpeg missing/failed — pauses are skipped
  }
}
