'use client'

// Browser-direct Gemini TTS (Mark-LV wave-2, task mlv-voice-1).
//
// THE ARCHITECTURE (frozen by the lead after live-probing the key):
// this instance's SERVER egress is region-blocked by Google — every live
// Gemini model answers "User location is not supported for the API use" from
// the server. The CREATOR'S BROWSER is (typically) in a supported region, so
// Gemini TTS is called browser-direct: the client fetches the key ONCE from
// the same-origin route /api/mist/google (it never enters the JS bundle) and
// POSTs to generativelanguage.googleapis.com itself — Google serves
// permissive CORS headers for API-key requests, so no proxy is needed.
//
// When the browser is ALSO blocked (e.g. this sandbox's preview browser), the
// one-shot probe records 'blocked' and every caller falls back to the normal
// GLM→Edge server chain — never a dead end.
//
// Everything here is browser-only; guards keep a stray server import inert.

import { GEMINI_DIRECT_VOICES } from './mist-constants'

/** The TTS model verified by the lead to exist on v1beta (it returned a
 *  LOCATION error from this sandbox, not a 404 — from a supported browser
 *  region it serves). */
export const GEMINI_TTS_MODEL = 'gemini-2.5-flash-preview-tts'

/** Validate a stored voice id against the real prebuilt catalog — anything
 *  unknown (e.g. a stale GLM id) resolves to Mark-LV's default, Charon. */
export function resolveGeminiVoice(voice: string | undefined): string {
  return voice && GEMINI_DIRECT_VOICES.some((v) => v.id === voice) ? voice : 'Charon'
}

// ---------------------------------------------------------------------------
// Key — fetched same-origin once per session
// ---------------------------------------------------------------------------

let keyPromise: Promise<string | null> | null = null

async function fetchGoogleKey(): Promise<string | null> {
  if (typeof window === 'undefined') return null
  try {
    const res = await fetch('/api/mist/google')
    if (!res.ok) return null
    const json = (await res.json()) as { configured?: boolean; key?: string | null }
    return json.configured && typeof json.key === 'string' && json.key ? json.key : null
  } catch {
    return null // key route unreachable — Gemini direct simply doesn't offer
  }
}

/** The creator's Google key, fetched same-origin ONCE per session (cached
 *  promise). Null when the instance has no key configured. */
export function getGoogleKey(): Promise<string | null> {
  if (!keyPromise) keyPromise = fetchGoogleKey()
  return keyPromise
}

// ---------------------------------------------------------------------------
// Synthesis — browser → Google, raw PCM wrapped as WAV
// ---------------------------------------------------------------------------

/** base64 → raw PCM bytes → 44-byte RIFF/WAV header (mono, rate from
 *  Google's reported mimeType, 16-bit). Gemini TTS returns raw signed 16-bit
 *  LE PCM (audio/L16;codec=pcm;rate=24000) — <audio> needs a WAV container. */
function pcmToWavBlob(b64: string, mimeType: string | undefined): Blob {
  const rate = Number(/rate=(\d+)/.exec(mimeType ?? '')?.[1] ?? 24000) || 24000
  const bin = atob(b64)
  const pcm = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) pcm[i] = bin.charCodeAt(i)

  const header = new ArrayBuffer(44)
  const dv = new DataView(header)
  const writeStr = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) dv.setUint8(off + i, s.charCodeAt(i))
  }
  writeStr(0, 'RIFF')
  dv.setUint32(4, 36 + pcm.length, true) // rest of file
  writeStr(8, 'WAVE')
  writeStr(12, 'fmt ')
  dv.setUint32(16, 16, true) // fmt chunk size
  dv.setUint16(20, 1, true) // PCM
  dv.setUint16(22, 1, true) // mono
  dv.setUint32(24, rate, true) // sample rate
  dv.setUint32(28, rate * 2, true) // byte rate (1ch × 16-bit)
  dv.setUint16(32, 2, true) // block align
  dv.setUint16(34, 16, true) // bits per sample
  writeStr(36, 'data')
  dv.setUint32(40, pcm.length, true)

  const out = new Uint8Array(44 + pcm.length)
  out.set(new Uint8Array(header), 0)
  out.set(pcm, 44)
  return new Blob([out], { type: 'audio/wav' })
}

/**
 * Synthesize `text` with a Gemini prebuilt voice, browser-direct. Throws with
 * the HONEST message on any failure — Google's own words verbatim when it
 * speaks (e.g. 'User location is not supported for the API use').
 */
export async function googleTtsSynthesize(text: string, voice: string): Promise<Blob> {
  if (typeof window === 'undefined') throw new Error('gemini direct: browser-only path')
  const key = await getGoogleKey()
  if (!key) throw new Error('gemini direct: no Google API key configured on this instance')

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_TTS_MODEL}:generateContent?key=${encodeURIComponent(key)}`
  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text }] }],
        generationConfig: {
          responseModalities: ['AUDIO'],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
        },
      }),
    })
  } catch (err) {
    // TypeError network failure — browser offline, DNS, or a hard block.
    // Belt-and-suspenders: Google serves CORS headers for API-key requests,
    // so this is genuinely a network condition, not a CORS wall.
    throw new Error(
      `gemini direct: Google unreachable from this browser (${err instanceof Error ? err.message : 'network error'})`
    )
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    // pull Google's own message out of the JSON error envelope, verbatim
    const gmsg = /"message"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(body)?.[1] ?? body.slice(0, 300)
    throw new Error(`gemini direct: HTTP ${res.status}${gmsg ? ` — ${gmsg}` : ''}`)
  }

  const json = (await res.json()) as {
    candidates?: Array<{
      content?: { parts?: Array<{ inlineData?: { mimeType?: string; data?: string } }> }
    }>
  }
  const inline = json.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data)?.inlineData
  if (!inline?.data) throw new Error('gemini direct: response carried no audio')
  return pcmToWavBlob(inline.data, inline.mimeType)
}

// ---------------------------------------------------------------------------
// One-shot availability probe
// ---------------------------------------------------------------------------

export type GoogleTtsProbe = 'unknown' | 'available' | 'blocked' | 'error'

let probeState: GoogleTtsProbe = 'unknown'
let probePromise: Promise<GoogleTtsProbe> | null = null

/** Current cached probe state (no network). */
export function googleTtsProbeState(): GoogleTtsProbe {
  return probeState
}

/**
 * One-shot probe, module-cached for the page session: synthesize 'OK.' with
 * the default voice. 'available' on success; 'blocked' when Google says the
 * browser's region is unsupported; 'error' for anything else. Never throws.
 */
export function googleTtsAvailable(): Promise<GoogleTtsProbe> {
  if (probeState !== 'unknown') return Promise.resolve(probeState)
  if (!probePromise) {
    probePromise = googleTtsSynthesize('OK.', 'Charon')
      .then(() => {
        probeState = 'available'
        return probeState
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err)
        probeState = /location is not supported|User location/i.test(msg) ? 'blocked' : 'error'
        return probeState
      })
      .finally(() => {
        probePromise = null
      })
  }
  return probePromise
}

// ---------------------------------------------------------------------------
// LM relay — browser-direct text generation (w8: one free key, mind + voice)
// ---------------------------------------------------------------------------

export interface GeminiRelayMessage {
  role: 'user' | 'assistant'
  content: string
}

/**
 * Generate TEXT browser-direct with the same free AI Studio key that powers
 * the voice engine — her mind lane's lifeboat when the server's Gemini
 * egress is region-blocked (the same asymmetry the voice engine solves
 * browser-direct): the neural service relays the request here, the browser
 * POSTs to Google (permissive CORS for API-key requests), and the lane
 * answers as if the server had reached Google itself. Throws the HONEST
 * message on any failure — Google's own words verbatim when it speaks.
 */
export async function googleLmGenerate(opts: {
  model: string
  systemPrompt: string
  messages: GeminiRelayMessage[]
}): Promise<string> {
  if (typeof window === 'undefined') throw new Error('gemini direct: browser-only path')
  const key = await getGoogleKey()
  if (!key) throw new Error('gemini direct: no Google API key configured on this instance')

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(opts.model)}:generateContent?key=${encodeURIComponent(key)}`
  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: opts.systemPrompt }] },
        contents: opts.messages.map((m) => ({
          role: m.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: m.content }],
        })),
      }),
    })
  } catch (err) {
    throw new Error(
      `gemini direct: Google unreachable from this browser (${err instanceof Error ? err.message : 'network error'})`
    )
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    const gmsg = /"message"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(body)?.[1] ?? body.slice(0, 300)
    throw new Error(`gemini direct: HTTP ${res.status}${gmsg ? ` — ${gmsg}` : ''}`)
  }
  const json = (await res.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>
  }
  const text = (json.candidates?.[0]?.content?.parts ?? [])
    .map((p) => (typeof p.text === 'string' ? p.text : ''))
    .join('')
    .trim()
  if (!text) throw new Error('gemini direct: response carried no text')
  return text
}

// ---------------------------------------------------------------------------
// Chunker — the client-side mirror of the server's lead/follow strategy
// ---------------------------------------------------------------------------

/**
 * Sentence-boundary chunker for the direct path (the server's
 * chunkTextForTts lives behind server-only SDK imports, so this is a small
 * local mirror): the FIRST chunk stays ≤220 chars so speech starts after one
 * small synthesis; follow-ups carry ≤400 chars each — fetched while the
 * previous chunk plays (producer/consumer, Mark-LV's insight).
 */
export function chunkTextForGemini(text: string): string[] {
  const cleaned = text.replace(/\s+/g, ' ').trim()
  if (!cleaned) return []
  const sentences = cleaned.match(/[^.!?…]+[.!?…]+(?:\s|$)|[^.!?…]+$/g) ?? [cleaned]
  const chunks: string[] = []
  let buf = ''
  let limit = 220 // lead chunk — speech starts as soon as possible
  for (const raw of sentences) {
    const piece = raw.trim()
    if (!piece) continue
    if (buf && buf.length + piece.length + 1 > limit) {
      chunks.push(buf)
      buf = piece
      limit = 400 // follow-ups — throughput chunks
    } else {
      buf = buf ? `${buf} ${piece}` : piece
    }
    // a single monster sentence longer than the limit is hard-split
    while (buf.length > limit) {
      chunks.push(buf.slice(0, limit))
      buf = buf.slice(limit)
    }
  }
  if (buf) chunks.push(buf)
  return chunks
}
