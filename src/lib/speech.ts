// M.I.S.T. shared speech pipeline (v6).
//
// One singleton player for the WHOLE app so a new utterance always interrupts
// the previous one — Mist never speaks two messages at once. Every spoken
// string is first passed through stripMarkdownForSpeech so listeners never
// hear "**", "##", hash symbols or code being read aloud.

'use client'

import { useMistStore } from './store'
import { mistApi } from './mist-api'
import { mistAudioResume, mistAudioAttachMedia } from './audio-bus'
import { resolveVoiceMode, type ResolvedVoiceMode } from './services/voice-local'
import { geminiStyledText, stripEmotionMarkers } from './voice-emotion'
import {
  chunkTextForGemini,
  googleTtsAvailable,
  googleTtsSynthesize,
  resolveGeminiVoice,
} from './google-direct'

// ---------------------------------------------------------------------------
// Markdown → natural speech
// ---------------------------------------------------------------------------

/**
 * Convert a markdown answer into text that sounds natural when spoken:
 * - fenced code blocks are REMOVED entirely (never read code aloud)
 * - inline code, bold/italic/strikethrough markers unwrapped
 * - headings unwrapped, links become their label, images dropped
 * - list bullets / blockquote markers / table pipes cleaned up
 * - citation markers like [1] and bare URLs dropped
 * - emoji stripped (TTS reads their names oddly)
 */
export function stripMarkdownForSpeech(text: string): string {
  let out = text ?? ''

  // 1. fenced code blocks (``` or ~~~, with optional language tag) → gone
  out = out.replace(/```[\s\S]*?```/g, ' ')
  out = out.replace(/~~~[\s\S]*?~~~/g, ' ')

  // 2. images ![alt](url) → dropped; links [label](url) → label
  out = out.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
  out = out.replace(/\[([^\]]+)\]\((?:https?:\/\/|\/)[^)]*\)/g, '$1')

  // 3. bare urls → dropped
  out = out.replace(/(?:https?:\/\/)\S+/g, ' ')

  // 4. inline code `x` (incl. multi-backtick) → x
  out = out.replace(/``([^`]+)``/g, '$1')
  out = out.replace(/`([^`]+)`/g, '$1')

  // 5. headings: leading #'s → gone
  out = out.replace(/^\s{0,3}#{1,6}\s*/gm, '')

  // 6. bold / italic / strikethrough markers
  out = out.replace(/(\*\*\*|___)(?=\S)([\s\S]*?\S)\1/g, '$2')
  out = out.replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, '$2')
  out = out.replace(/(\*|_)(?=\S)([\s\S]*?\S)\1/g, '$2')
  out = out.replace(/~~(?=\S)([\s\S]*?\S)~~/g, '$1')

  // 7. blockquote markers + horizontal rules
  out = out.replace(/^\s{0,3}>\s?/gm, '')
  out = out.replace(/^\s{0,3}(?:[-*_]\s*){3,}$/gm, ' ')

  // 8. list bullets ("-", "*", "+", "•") and numbered markers ("1.", "2)")
  out = out.replace(/^\s{0,3}[-*+•]\s+/gm, '')
  out = out.replace(/^\s{0,3}\d+[.)]\s+/gm, '')

  // 9. citation markers [1] / [n] and footnote refs
  out = out.replace(/\[\d+\]/g, ' ')

  // 10. table pipes → comma pauses; drop separator rows
  out = out.replace(/^\s{0,3}\|?[\s:|-]+\|[\s:|-]*$/gm, ' ')
  out = out.replace(/\|/g, ', ')

  // 11. emoji & pictographs (spoken as odd names by TTS) → strip
  out = out.replace(
    /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{200D}]/gu,
    ' '
  )

  // 12. collapse whitespace
  out = out.replace(/[ \t]+/g, ' ')
  out = out.replace(/\n{2,}/g, '. ').replace(/\n/g, ' ')
  out = out.replace(/\s+([.,!?;:])/g, '$1')
  out = out.replace(/\.{2,}/g, '.')
  return out.trim()
}

/**
 * Determines if text is suitable for speech synthesis.
 * Guards against: unexpected scripts, single syllable-word dominance, and excessive repetition.
 */
export function isSpeakableText(s: string): boolean {
  if (!s || !s.trim()) return false

  const text = s.trim()

  // (a) Unexpected-script ratio: Hangul/Cyrillic > 20% of letters when text is otherwise Latin
  const letterMatches = text.match(/[\p{L}]/gu)
  if (letterMatches && letterMatches.length > 0) {
    const totalLetters = letterMatches.length
    const hangulCyrillic = letterMatches.filter((ch) => /[\u1100-\u11FF\u3130-\u318F\uAC00-\uD7AF\u0400-\u04FF]/.test(ch)).length
    const latin = letterMatches.filter((ch) => /[A-Za-z]/.test(ch)).length
    // Only flag if there's a meaningful Latin presence but high non-Latin ratio
    if (latin > 0 && hangulCyrillic / totalLetters > 0.2) {
      return false
    }
  }

  // (b) Single short syllable-word dominating > 50% of word tokens
  const words = text.split(/\s+/).filter((w) => w.length > 0)
  if (words.length > 0) {
    const freq = new Map<string, number>()
    for (const w of words) {
      const key = w.toLowerCase()
      freq.set(key, (freq.get(key) ?? 0) + 1)
    }
    for (const [word, count] of freq) {
      // Short word: 1-3 chars, single syllable heuristic
      if (word.length <= 3 && count / words.length > 0.5) {
        return false
      }
    }
  }

  // (c) Same word repeated 4+ times consecutively
  let consecutive = 1
  let prev = ''
  for (const w of words) {
    const key = w.toLowerCase()
    if (key === prev) {
      consecutive++
      if (consecutive >= 4) return false
    } else {
      consecutive = 1
      prev = key
    }
  }

  return true
}

// ---------------------------------------------------------------------------
// w5 voice-speed — the subtitle bus + the incremental speaker
// ---------------------------------------------------------------------------

/** The live subtitle state: the sentence chunks of the utterance being
 *  spoken, and which one is audible RIGHT NOW. The voice stage renders
 *  this (past dim · active bold); any future consumer (faces, the chat
 *  preview) may subscribe the same way. */
export interface SubtitleState {
  chunks: string[]
  /** Index of the chunk currently being spoken; -1 = none yet. */
  activeIndex: number
}

const subtitleListeners = new Set<() => void>()
let subtitleSnapshot: SubtitleState = { chunks: [], activeIndex: -1 }

function subtitleMutate(next: SubtitleState) {
  subtitleSnapshot = { chunks: [...next.chunks], activeIndex: next.activeIndex }
  subtitleListeners.forEach((fn) => fn())
}

export const subtitleBus = {
  subscribe(fn: () => void): () => void {
    subtitleListeners.add(fn)
    return () => {
      subtitleListeners.delete(fn)
    }
  },
  getSnapshot(): SubtitleState {
    return subtitleSnapshot
  },
  getServerSnapshot(): SubtitleState {
    return subtitleSnapshot
  },
  /** A new utterance begins — chunks reset. */
  begin() {
    subtitleMutate({ chunks: [], activeIndex: -1 })
  },
  addChunk(text: string) {
    if (!text) return
    subtitleMutate({ chunks: [...subtitleSnapshot.chunks, text], activeIndex: subtitleSnapshot.activeIndex })
  },
  setActive(index: number) {
    if (subtitleSnapshot.activeIndex === index) return
    subtitleMutate({ chunks: subtitleSnapshot.chunks, activeIndex: index })
  },
  clear() {
    if (subtitleSnapshot.chunks.length === 0 && subtitleSnapshot.activeIndex === -1) return
    subtitleMutate({ chunks: [], activeIndex: -1 })
  },
}

// Observability (mirrors the __mistBus precedent — read-only, idempotent)
declare global {
  interface Window {
    __mistSubs?: { state: () => SubtitleState }
  }
}
if (typeof window !== 'undefined' && !window.__mistSubs) {
  window.__mistSubs = { state: () => subtitleBus.getSnapshot() }
}

/** Sentence-aware chunking for the incremental speaker: one chunk ≈ one
 *  sentence (the natural subtitle unit — the active sentence is what goes
 *  bold). Very short openers ("Yes.") merge with the next sentence so the
 *  lead chunk never sounds clipped; a sentence that runs long splits at the
 *  last natural pause instead of mid-word. */
const CHUNK_MIN = 12
const CHUNK_HARD_MAX = 300
function extractChunk(pending: string, force: boolean): { chunk: string; rest: string } | null {
  if (!pending.trim()) return null
  // a sentence boundary at a speakable length → cut there
  const m = pending.match(/^([\s\S]*?[.!?…])(?:\s|$)/)
  if (m && m[1].trim().length >= CHUNK_MIN) {
    return { chunk: m[1].trim(), rest: pending.slice(m[1].length) }
  }
  if (pending.length >= CHUNK_HARD_MAX) {
    // no boundary and over budget → last natural pause before the cap
    const head = pending.slice(0, CHUNK_HARD_MAX)
    let cut = -1
    for (const re of [/[,;: —–-]\s/, /\s/]) {
      const matches = [...head.matchAll(re)]
      if (matches.length > 0) {
        const last = matches[matches.length - 1]
        const at = (last.index ?? 0) + last[0].length
        if (at >= 40) {
          cut = at
          break
        }
      }
    }
    if (cut > 0) return { chunk: pending.slice(0, cut).trim(), rest: pending.slice(cut) }
    return { chunk: head.trim(), rest: pending.slice(CHUNK_HARD_MAX) }
  }
  if (force && pending.trim()) return { chunk: pending.trim(), rest: '' }
  return null
}

/** The result of ending an incremental utterance. */
export type IncrementalEnd =
  | 'streamed' // the final text was spoken by the stream (fully or as a prefix)
  | 'replaced' // nothing of it was spoken — the caller should speak the final text itself

/** w5 voice-speed — an utterance that grows while the model still generates.
 *  See mistSpeech.speakIncremental for the full contract. */
export interface IncrementalSpeech {
  /** Feed one clean prose delta (server-side envelope-filtered). */
  feed(text: string): void
  /** Finalize: flush the tail, reconcile with the canonical reply, resolve
   *  when playback completes. Safe to call once. */
  end(finalText?: string): Promise<IncrementalEnd>
  /** Hard stop — the utterance is dead (superseded / session ended). */
  abort(): void
}


export interface SpeakOptions {
  /** TTS voice id; defaults to the store preference. */
  voice?: string
  /** Called when playback finishes, fails, or is interrupted. */
  onEnd?: () => void
  /** Called when the utterance could not be voiced at all (engine down,
   *  network blocked, autoplay refused) — the caller can surface an honest
   *  caption instead of a silent "speaking" dance. onEnd still fires after. */
  onError?: (reason: string) => void
  /** Called when playback actually begins (the utterance is audible). */
  onStart?: () => void
  /** Speak even when the auto-speak preference is off (explicit user action). */
  force?: boolean
  /** Max characters sent to the TTS service (default 4000 ≈ 3min — the
   *  Mark-LV streaming path speaks chunk-by-chunk, so long text no longer
   *  waits for a full synthesis; the old 900 cap was a blob-path compromise). */
  maxLength?: number
  /** Skip the Mark-LV streaming path and use the single-blob route (used by
   *  the ack path so a quick acknowledgment never queues a second stream). */
  noStream?: boolean
}

let currentAudio: HTMLAudioElement | null = null
let currentUrl: string | null = null
let speakSeq = 0

/** w9 interruption polish: ramp a mid-playback element down over ~120ms
 *  before pausing — the creator hears her stop cleanly instead of a harsh
 *  clip when they cut in. Fire-and-forget: ownership state (currentAudio /
 *  currentUrl) is already cleared by then, the element pauses itself, and a
 *  superseding utterance's synthesis always takes longer than the fade, so
 *  the tail can never overlap the next reply. Natural endings (paused /
 *  ended elements) skip the ramp entirely. */
function fadeOutAndPause(audio: HTMLAudioElement) {
  try {
    if (audio.paused || audio.ended) return
    const steps = 8 // ~120ms total — under the ~200ms turn-gap perceptual floor
    const stepMs = 15
    const vol0 = audio.volume
    let i = 0
    const timer = window.setInterval(() => {
      i += 1
      if (i >= steps) {
        window.clearInterval(timer)
        try {
          audio.pause()
        } catch {
          /* already gone */
        }
        return
      }
      try {
        audio.volume = Math.max(0, vol0 * (1 - i / steps))
      } catch {
        window.clearInterval(timer) // element torn down mid-fade — let it go
      }
    }, stepMs)
  } catch {
    try {
      audio.pause()
    } catch {
      /* already gone */
    }
  }
}

function cleanupAudio() {
  if (currentAudio) {
    currentAudio.onended = null
    currentAudio.onerror = null
    currentAudio.onpause = null
    // w9: smooth cancellation — fade the audible tail out instead of the
    // instant pause (no-op for elements that already ended on their own)
    fadeOutAndPause(currentAudio)
    currentAudio = null
  }
  if (currentUrl) {
    URL.revokeObjectURL(currentUrl)
    currentUrl = null
  }
}

/** mlv-lead-4: audio-only teardown (no speakSeq bump) — internal callers
 *  (per-chunk cleanup, speak's own interrupt) must NOT invalidate the
 *  utterance that currently owns the playback queue. */
function stopAudioOnly() {
  if (!currentAudio) return
  cleanupAudio()
  const st = useMistStore.getState()
  if (st.neural.state === 'speaking') st.setNeuralState('dormant')
}

/** base64 → Blob (for the NDJSON stream chunks). */
function b64ToBlob(b64: string, contentType: string): Blob {
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return new Blob([bytes], { type: contentType || 'audio/wav' })
}

/**
 * Resolve the effective voice mode for the current utterance (SSR-safe —
 * 'cloud' on the server). Used by the voice session hook, the stage and
 * speak() itself.
 */
export async function getVoiceMode(): Promise<ResolvedVoiceMode> {
  try {
    return await resolveVoiceMode(useMistStore.getState().voiceMode)
  } catch {
    return 'cloud'
  }
}

export const mistSpeech = {
  /** True while an utterance is loaded/playing. */
  get speaking() {
    return currentAudio !== null
  },

  /** Stop the current utterance (if any). Safe to call repeatedly.
   *  mlv-lead-4: bumps speakSeq so in-flight TTS chunks (server NDJSON stream
   *  or Gemini-direct) still synthesizing when the user interrupts are
   *  DISCARDED on arrival instead of starting playback after the stop — the
   *  zombie-chunk gap Mark-LV closes by draining the audio queue. Internal
   *  callers (per-chunk cleanup, speak's own interrupt) use stopAudioOnly()
   *  so they never invalidate the utterance that owns the queue. */
  stop() {
    stopAudioOnly()
    speakSeq++
  },

  /**
   * Speak `text` aloud. ALWAYS interrupts whatever is currently playing so the
   * newest message wins (the user never hears two replies at once). Honors the
   * ttsEnabled preference unless `force` is set (explicit per-message button).
   *
   * Mark-LV port (2026-09-30): the cloud path streams chunk-by-chunk (NDJSON
   * from /voice/tts/stream) — the first words play while the rest is still
   * synthesizing, instead of waiting for the whole utterance. Falls back to
   * the single-blob route if the stream is unavailable. onStart fires only
   * when the FIRST chunk is actually audible (never during loading).
   */
  async speak(text: string, opts: SpeakOptions = {}): Promise<void> {
    const store = useMistStore.getState()
    if (!opts.force && !store.ttsEnabled) {
      opts.onEnd?.()
      return
    }
    let clean = stripMarkdownForSpeech(text)
    // w8 voice emotion: with the preference off the markers are inert text —
    // strip them so no engine ever reads "[sigh]" aloud
    if (!store.voiceEmotion) clean = stripEmotionMarkers(clean)
    if (!clean) {
      opts.onEnd?.()
      return
    }
    if (!isSpeakableText(clean)) {
      const fallback = "I got lost in thought there — give me a moment and try again."
      console.warn('[mistSpeech] Rejected non-speakable text:', clean.slice(0, 200))
      await this.speak(fallback, opts)
      return
    }

    const mySeq = ++speakSeq
    // interrupt any in-flight utterance's AUDIO immediately; the seq bump
    // above already discards its in-flight synthesis chunks
    stopAudioOnly()

    try {
      const busReady = await mistAudioResume()
      const full = clean.slice(0, opts.maxLength ?? 4000)
      const mode = await getVoiceMode()
      // engine pref: 'glm' (rich cloud voices), a no-auth English engine
      // ('edge' neural / 'gtranslate' rescue), or 'gemini' (Mark-LV wave-2:
      // REAL distinct Google prebuilt voices, synthesized browser-direct —
      // this server's egress is region-blocked by Google, the user's browser
      // is not). GLM is auto-rescued on edge server-side when it babbles.
      const rawEngine = store.voiceEngine
      const cloudVoice =
        rawEngine === 'gemini'
          ? resolveGeminiVoice(opts.voice ?? store.voice)
          : rawEngine === 'edge' || rawEngine === 'gtranslate'
            ? store.voiceFree
            : (opts.voice ?? store.voice)
      // the server never hears about the browser-direct engine — every server
      // call (stream, blob, local-mode rescue) maps gemini onto the glm chain
      const serverEngine: 'glm' | 'edge' | 'gtranslate' | undefined =
        rawEngine === 'edge' || rawEngine === 'gtranslate'
          ? rawEngine
          : rawEngine === 'gemini'
            ? 'glm'
            : undefined

      // ── Gemini-direct path (Mark-LV wave-2): browser → Google with the
      // creator's key. Only when the one-shot probe says THIS browser can
      // reach Google — blocked/unreachable falls straight through to the
      // normal server chain (never a dead end). A failure before the first
      // chunk is audible also falls through, mirroring the
      // "stream unavailable → blob" pattern below. ──
      if (rawEngine === 'gemini') {
        const probe = await googleTtsAvailable() // one-shot, module-cached
        if (mySeq !== speakSeq) return // superseded while probing
        if (probe === 'available') {
          try {
            await this.speakGeminiDirect(full, cloudVoice, { mySeq, busReady, opts })
            return
          } catch (gemErr) {
            if (mySeq !== speakSeq) return // superseded — the newer utterance owns playback
            console.warn(
              '[mistSpeech] gemini direct failed before first audio — falling back to the server voice chain',
              gemErr
            )
          }
        }
      }

      if (mode === 'local') {
        // Local mode synthesizes offline on the user's machine (piper via the
        // bridge) — single blob, shared player below. Piper has no emotion
        // support (rhasspy/piper#150) — markers are stripped for it.
        let blob: Blob
        try {
          blob = await mistApi.voice.localTts(stripEmotionMarkers(full))
        } catch (err) {
          console.warn(
            '[mist-voice] local TTS failed — falling back to the cloud voice for this utterance',
            err
          )
          blob = await mistApi.voice.tts(full, cloudVoice, 1.0, serverEngine)
        }
        if (mySeq !== speakSeq) return
        stopAudioOnly()
        await this.playBlob(blob, { mySeq, busReady, opts })
        return
      }

      // ── Mark-LV streaming path: first words out in one chunk's synth time ──
      if (!opts.noStream) {
        try {
          await this.speakStreamed(full, cloudVoice, serverEngine, { mySeq, busReady, opts })
          return
        } catch (streamErr) {
          if (mySeq !== speakSeq) return // superseded — the newer utterance owns playback
          console.warn('[mistSpeech] stream unavailable — falling back to single-blob TTS', streamErr)
        }
      }

      // ── Single-blob path (fallback / noStream acks) ──
      const blob = await mistApi.voice.tts(full, cloudVoice, 1.0, serverEngine)
      if (mySeq !== speakSeq) return
      stopAudioOnly()
      await this.playBlob(blob, { mySeq, busReady, opts })
    } catch (err) {
      if (mySeq !== speakSeq) return
      cleanupAudio()
      const st = useMistStore.getState()
      if (st.neural.state === 'speaking') st.setNeuralState('dormant')
      // honest failure report — the caller decides how to surface it
      if (err instanceof DOMException && (err.name === 'NotAllowedError' || err.name === 'AbortError')) {
        // Autoplay policy blocks unmuted audio without a gesture — skip silently
        // but still tell the caller why nothing was heard (click-to-unlock hint)
        opts.onError?.('browser blocked audio — click anywhere in the page, then try again')
      } else {
        opts.onError?.(err instanceof Error ? err.message : 'voice engine unavailable')
      }
      opts.onEnd?.()
    }
  },

  /** Play one synthesized blob on the shared player. */
  async playBlob(
    blob: Blob,
    ctx: { mySeq: number; busReady: boolean; opts: SpeakOptions }
  ): Promise<void> {
    const url = URL.createObjectURL(blob)
    const audio = new Audio(url)
    currentAudio = audio
    currentUrl = url
    if (ctx.busReady) mistAudioAttachMedia(audio)

    const finish = () => {
      if (ctx.mySeq !== speakSeq) return // superseded — let the newer one own state
      cleanupAudio()
      const st = useMistStore.getState()
      if (st.neural.state === 'speaking') st.setNeuralState('dormant')
      ctx.opts.onEnd?.()
    }
    audio.onended = finish
    audio.onerror = finish
    await audio.play()

    // Playback has actually begun — fire onStart and set neural state
    // Guard with seq check so a superseded utterance doesn't fire it.
    if (ctx.mySeq === speakSeq) {
      useMistStore.getState().setNeuralState('speaking')
      ctx.opts.onStart?.()
    }
  },

  /**
   * Gemini-direct player (Mark-LV wave-2): chunk the text with the same
   * lead/follow strategy as the server (lead ≤220 chars so speech starts
   * after one small synthesis, follow-ups ≤400), then run a sequential
   * producer/consumer — fetch chunk N+1's audio while chunk N plays, exactly
   * like the server streaming path but with the synthesis happening in THIS
   * browser. onStart fires only when the first chunk's audio.play() resolves.
   *
   * Throws ONLY when nothing played (failure before the first chunk) so the
   * caller can fall back to the server chain; a mid-utterance failure keeps
   * what played and ends honestly via onEnd. Uses the SAME shared
   * currentAudio/currentUrl as every other path, so stop() kills this too.
   */
  async speakGeminiDirect(
    text: string,
    voice: string,
    ctx: { mySeq: number; busReady: boolean; opts: SpeakOptions }
  ): Promise<void> {
    const chunks = chunkTextForGemini(text)
    if (chunks.length === 0) throw new Error('nothing to speak')

    let started = false

    // play one chunk on the shared player — mirrors speakStreamed's playChunk
    // (resolve only when the chunk finishes/interrupts, never at play-start)
    const playChunk = (blob: Blob): Promise<boolean> =>
      new Promise((resolveChunk) => {
        if (ctx.mySeq !== speakSeq) {
          resolveChunk(false)
          return
        }
        stopAudioOnly() // clear any previous chunk's audio (seq untouched — this utterance owns the queue)
        const url = URL.createObjectURL(blob)
        const audio = new Audio(url)
        currentAudio = audio
        currentUrl = url
        if (ctx.busReady) mistAudioAttachMedia(audio)
        let settled = false
        const done = (ok: boolean) => {
          if (settled) return
          settled = true
          if (currentAudio === audio) cleanupAudio()
          resolveChunk(ok)
        }
        audio.onended = () => done(true)
        audio.onerror = () => done(false)
        audio.onpause = () => done(false) // stop() pauses — unblock the loop
        audio
          .play()
          .then(() => {
            if (ctx.mySeq === speakSeq && !started) {
              started = true
              useMistStore.getState().setNeuralState('speaking')
              ctx.opts.onStart?.()
            }
          })
          .catch((err: unknown) => {
            if (ctx.mySeq === speakSeq) {
              // autoplay policy or engine refusal — honest report, stop here
              const reason =
                err instanceof DOMException && (err.name === 'NotAllowedError' || err.name === 'AbortError')
                  ? 'browser blocked audio — click anywhere in the page, then try again'
                  : err instanceof Error
                    ? err.message
                    : 'voice engine unavailable'
              ctx.opts.onError?.(reason)
            }
            done(false)
          })
      })

    // prime the producer: chunk 0's synthesis starts now; every later chunk
    // is fetched while the previous one plays. w8: each chunk's markers map
    // to a Gemini style cue ("Whisper this softly: …") — the documented
    // 2.5-preview style-prompt pattern.
    let nextAudio: Promise<Blob> = googleTtsSynthesize(geminiStyledText(chunks[0]), voice)
    nextAudio.catch(() => undefined) // silence the prefetch — failure surfaces at its await

    for (let i = 0; i < chunks.length; i++) {
      let blob: Blob
      try {
        blob = await nextAudio
      } catch (err) {
        if (!started) throw err // nothing played yet — caller falls back to the server chain
        if (ctx.mySeq !== speakSeq) return
        // partial delivery — keep what played, end honestly
        console.warn('[mistSpeech] gemini direct failed mid-utterance — keeping what played', err)
        break
      }
      if (ctx.mySeq !== speakSeq) return // superseded — stop consuming
      if (i + 1 < chunks.length) {
        nextAudio = googleTtsSynthesize(geminiStyledText(chunks[i + 1]), voice)
        nextAudio.catch(() => undefined) // silence the prefetch — failure surfaces at its await
      }
      const ok = await playChunk(blob)
      if (!ok) break // interrupt / autoplay refusal / decode failure — done
    }

    if (ctx.mySeq !== speakSeq) return
    const st = useMistStore.getState()
    if (st.neural.state === 'speaking') st.setNeuralState('dormant')
    ctx.opts.onEnd?.()
  },

  /**
   * Mark-LV streaming player: POST /voice/tts/stream, consume NDJSON lines as
   * they arrive, play chunks in arrival order. The server synthesizes chunk
   * N+1 while chunk N plays here — perceived latency collapses to the first
   * chunk's synthesis time. Throws ONLY when nothing played (total failure
   * before the first chunk) so the caller can fall back to the blob path; a
   * mid-stream failure after partial delivery keeps what played and ends
   * honestly via onEnd.
   */
  async speakStreamed(
    text: string,
    voice: string | undefined,
    engine: string | undefined,
    ctx: { mySeq: number; busReady: boolean; opts: SpeakOptions }
  ): Promise<void> {
    const res = await fetch('/api/mist/voice/tts/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, voice, speed: 1.0, engine }),
    })
    if (!res.ok || !res.body) throw new Error(`stream route unavailable (${res.status})`)

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let lineBuf = ''
    let started = false
    let playedAny = false
    let queue: Promise<void> = Promise.resolve()

    const playChunk = (blob: Blob): Promise<void> =>
      new Promise((resolveChunk) => {
        if (ctx.mySeq !== speakSeq) {
          resolveChunk()
          return
        }
        stopAudioOnly() // clear any previous chunk's audio (seq untouched — this utterance owns the queue)
        const url = URL.createObjectURL(blob)
        const audio = new Audio(url)
        currentAudio = audio
        currentUrl = url
        if (ctx.busReady) mistAudioAttachMedia(audio)
        const done = () => {
          if (currentAudio === audio) cleanupAudio()
          resolveChunk()
        }
        audio.onended = done
        audio.onerror = done
        audio.onpause = done // stop() pauses — unblock the queue
        audio
          .play()
          .then(() => {
            playedAny = true
            if (ctx.mySeq === speakSeq && !started) {
              started = true
              useMistStore.getState().setNeuralState('speaking')
              ctx.opts.onStart?.()
            }
          })
          .catch((err: unknown) => {
            done()
            if (ctx.mySeq === speakSeq) {
              // autoplay policy or engine refusal on this chunk — honest report
              const reason =
                err instanceof DOMException && (err.name === 'NotAllowedError' || err.name === 'AbortError')
                  ? 'browser blocked audio — click anywhere in the page, then try again'
                  : err instanceof Error
                    ? err.message
                    : 'voice engine unavailable'
              ctx.opts.onError?.(reason)
            }
          })
      })

    try {
      for (;;) {
        const { value, done: readerDone } = await reader.read()
        if (value) {
          lineBuf += decoder.decode(value, { stream: true })
          let nl: number
          while ((nl = lineBuf.indexOf('\n')) >= 0) {
            const line = lineBuf.slice(0, nl).trim()
            lineBuf = lineBuf.slice(nl + 1)
            if (!line) continue
            let msg: {
              seq?: number
              contentType?: string
              audioB64?: string
              engineUsed?: string
              done?: boolean
              chunks?: number
              error?: string
            }
            try {
              msg = JSON.parse(line)
            } catch {
              continue // skip malformed line — never crash the player
            }
            if (msg.audioB64) {
              if (ctx.mySeq !== speakSeq) {
                // superseded mid-stream — stop consuming
                reader.cancel().catch(() => undefined)
                break
              }
              const blob = b64ToBlob(msg.audioB64, msg.contentType ?? 'audio/wav')
              queue = queue.then(() => playChunk(blob))
            } else if (msg.error) {
              if (!playedAny && !started) {
                // total failure before anything played — caller falls back
                throw new Error(msg.error)
              }
              // partial delivery — the client keeps what played
              console.warn('[mistSpeech] stream ended early:', msg.error)
            }
          }
        }
        if (readerDone) break
      }
    } finally {
      reader.cancel().catch(() => undefined)
    }

    await queue
    if (ctx.mySeq !== speakSeq) return
    const st = useMistStore.getState()
    if (st.neural.state === 'speaking') st.setNeuralState('dormant')
    ctx.opts.onEnd?.()
  },

  /**
   * w5 voice-speed — the INCREMENTAL speaker: `feed()` clean prose deltas as
   * they stream from the model; sentence chunks are synthesized the moment
   * they complete (per-chunk synth starts at feed time, so chunk N+1's audio
   * is already downloading while chunk N plays) and played in order on the
   * shared player. First words are audible after roughly: first-token +
   * first-sentence + one short-sentence synth — milliseconds of voice on a
   * complex reply that previously waited for the FULL completion.
   *
   * The subtitle bus tracks every chunk (subtitleBus.addChunk) and the one
   * currently audible (setActive) — the stage renders them as live captions.
   *
   * end(finalText?) flushes the tail, reconciles with the canonical reply
   * (feeds its unfed remainder when it extends what was streamed) and
   * resolves when playback completes. Returns 'streamed' when the stream
   * spoke the text, 'replaced' when NOTHING of it was spoken (caller should
   * speak the final text itself — e.g. the stream never started because the
   * lane doesn't stream). stop()/any other speak() invalidates it (seq).
   */
  speakIncremental(opts: SpeakOptions = {}): IncrementalSpeech {
    const mySeq = ++speakSeq
    stopAudioOnly() // a new utterance owns playback immediately

    let ended = false
    let pending = '' // raw fed text not yet chunked
    let fedRaw = '' // everything ever fed (for reconciliation)
    let totalChars = 0
    let playedAny = false
    let started = false
    let failed = false
    let voiceOff = false
    let firstSniffDone = false
    let playQueue: Promise<void> = Promise.resolve()
    const synthPromises: Promise<Blob>[] = []

    const resolveSynth = async (): Promise<((text: string) => Promise<Blob>) | null> => {
      const store = useMistStore.getState()
      if (!opts.force && !store.ttsEnabled) return null // captions still run; no audio
      busReady = await mistAudioResume()
      const mode = await getVoiceMode()
      const rawEngine = store.voiceEngine
      const cloudVoice =
        rawEngine === 'gemini'
          ? resolveGeminiVoice(opts.voice ?? store.voice)
          : rawEngine === 'edge' || rawEngine === 'gtranslate'
            ? store.voiceFree
            : (opts.voice ?? store.voice)
      const serverEngine: 'glm' | 'edge' | 'gtranslate' | undefined =
        rawEngine === 'edge' || rawEngine === 'gtranslate'
          ? rawEngine
          : rawEngine === 'gemini'
            ? 'glm'
            : undefined
      if (rawEngine === 'gemini') {
        const probe = await googleTtsAvailable()
        if (mySeq !== speakSeq) return null
        // w8: markers → per-chunk natural-language style cues for Gemini
        if (probe === 'available') return (t) => googleTtsSynthesize(geminiStyledText(t), cloudVoice)
        // blocked → the server chain below (never a dead end)
      }
      if (mode === 'local') {
        return async (t) => {
          try {
            // piper: no emotion support — markers stripped (the cloud fallback keeps them)
            return await mistApi.voice.localTts(stripEmotionMarkers(t))
          } catch {
            return await mistApi.voice.tts(t, cloudVoice, 1.0, serverEngine)
          }
        }
      }
      return (t) => mistApi.voice.tts(t, cloudVoice, 1.0, serverEngine)
    }
    let synthFnPromise: Promise<((text: string) => Promise<Blob>) | null> | null = null
    let busReady = false

    subtitleBus.begin()

    const playChunk = (blob: Blob, index: number): Promise<void> =>
      new Promise((resolveChunk) => {
        if (mySeq !== speakSeq || voiceOff) {
          resolveChunk()
          return
        }
        stopAudioOnly()
        const url = URL.createObjectURL(blob)
        const audio = new Audio(url)
        currentAudio = audio
        currentUrl = url
        if (busReady) mistAudioAttachMedia(audio)
        const done = () => {
          if (currentAudio === audio) cleanupAudio()
          resolveChunk()
        }
        audio.onended = done
        audio.onerror = done
        audio.onpause = done
        audio
          .play()
          .then(() => {
            playedAny = true
            subtitleBus.setActive(index)
            if (mySeq === speakSeq && !started) {
              started = true
              useMistStore.getState().setNeuralState('speaking')
              opts.onStart?.()
            }
          })
          .catch((err: unknown) => {
            done()
            if (mySeq === speakSeq) {
              const reason =
                err instanceof DOMException && (err.name === 'NotAllowedError' || err.name === 'AbortError')
                  ? 'browser blocked audio — click anywhere in the page, then try again'
                  : err instanceof Error
                    ? err.message
                    : 'voice engine unavailable'
              opts.onError?.(reason)
            }
          })
      })

    const enqueueChunk = (rawChunk: string) => {
      const clean = stripMarkdownForSpeech(rawChunk)
      if (!clean) return
      // degenerate-babble sniff on the first chunk (the same honesty as speak())
      if (!firstSniffDone) {
        firstSniffDone = true
        if (!isSpeakableText(clean)) {
          failed = true
          ended = true
          opts.onError?.('reply was not speakable')
          return
        }
      }
      // w8: the caption never shows the raw markers — they are for the
      // engine, not the reader (a sound-only chunk captions as a beat "…")
      subtitleBus.addChunk(stripEmotionMarkers(clean) || '…')
      const index = synthPromises.length
      if (voiceOff || !synthFnPromise) {
        // captions-only mode (tts off): no synth, no playback, no onStart —
        // the 'speaking' phase never lies about audio that cannot play
        synthPromises.push(Promise.resolve(new Blob()))
        playQueue = playQueue.then(() => undefined)
        return
      }
      const synth = synthFnPromise
      synthPromises.push(
        synth.then((fn) => {
          if (!fn || mySeq !== speakSeq) return new Blob()
          return fn(clean)
        })
      )
      playQueue = playQueue
        .then(async () => {
          if (mySeq !== speakSeq) return
          try {
            const blob = await synthPromises[index]
            if (mySeq !== speakSeq) return
            await playChunk(blob, index)
          } catch {
            if (!playedAny) {
              // total failure before anything played — honest report + stop
              failed = true
              ended = true
              opts.onError?.('voice engine unavailable')
            }
            // partial delivery — skip the failed chunk, keep what plays
          }
        })
        .catch(() => undefined)
    }

    const drain = (force: boolean) => {
      for (;;) {
        const cut = extractChunk(pending, force)
        if (!cut) return
        pending = cut.rest
        enqueueChunk(cut.chunk)
      }
    }

    return {
      feed(text: string) {
        if (ended || failed || !text) return
        if (totalChars >= (opts.maxLength ?? 4000)) return
        if (!synthFnPromise && !voiceOff) {
          const store = useMistStore.getState()
          if (!opts.force && !store.ttsEnabled) {
            voiceOff = true // captions still flow; audio stays off
          } else {
            synthFnPromise = resolveSynth()
            synthFnPromise.catch(() => undefined)
          }
        }
        // w8 voice emotion: pref off → strip the markers at the gate so the
        // whole pipeline (chunker, captions, synthesis) is marker-free
        const piece = useMistStore.getState().voiceEmotion === false ? stripEmotionMarkers(text) : text
        if (!piece.trim()) return
        totalChars += piece.length
        fedRaw += piece
        pending += piece
        drain(false)
      },
      async end(finalText?: string): Promise<IncrementalEnd> {
        if (failed) return playedAny ? 'streamed' : 'replaced'
        if (!ended) {
          ended = true
          // reconcile with the canonical final text: feed its unfed remainder
          // when it extends what was streamed (e.g. an appended honesty clause)
          if (typeof finalText === 'string' && finalText.trim()) {
            const ft = (
              useMistStore.getState().voiceEmotion === false ? stripEmotionMarkers(finalText) : finalText
            ).trim()
            const fed = fedRaw.trim()
            if (ft.startsWith(fed) && ft.length > fed.length) {
              const remainder = ft.slice(fed.length)
              if (remainder.trim() && totalChars < (opts.maxLength ?? 4000)) {
                pending += remainder
                drain(true)
              }
            } else if (!ft.includes(fed) && !fed.includes(ft) && fed) {
              // completely divergent (shouldn't happen — committed rounds only)
              if (!playedAny && !started) {
                subtitleBus.clear()
                return 'replaced'
              }
              // something already played — what was said was said; the full
              // canonical text still lands in the thread/history
            }
          }
          drain(true) // flush the final partial sentence
        }
        await playQueue.catch(() => undefined)
        if (mySeq !== speakSeq) return 'streamed' // superseded — no state work
        const st = useMistStore.getState()
        if (st.neural.state === 'speaking') st.setNeuralState('dormant')
        opts.onEnd?.()
        return playedAny || voiceOff ? 'streamed' : 'replaced'
      },
      abort() {
        ended = true
        stopAudioOnly()
        speakSeq++ // invalidate — in-flight synth results are discarded on arrival
      },
    }
  },
}
