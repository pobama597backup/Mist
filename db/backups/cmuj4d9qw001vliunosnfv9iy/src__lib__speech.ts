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

// ---------------------------------------------------------------------------
// Singleton player — interrupt-aware
// ---------------------------------------------------------------------------

export interface SpeakOptions {
  /** TTS voice id; defaults to the store preference. */
  voice?: string
  /** Called when playback finishes, fails, or is interrupted. */
  onEnd?: () => void
  /** Speak even when the auto-speak preference is off (explicit user action). */
  force?: boolean
  /** Max characters sent to the TTS service (default 900 ≈ 40s). */
  maxLength?: number
}

let currentAudio: HTMLAudioElement | null = null
let currentUrl: string | null = null
let speakSeq = 0

function cleanupAudio() {
  if (currentAudio) {
    currentAudio.onended = null
    currentAudio.onerror = null
    try {
      currentAudio.pause()
    } catch {
      /* already gone */
    }
    currentAudio = null
  }
  if (currentUrl) {
    URL.revokeObjectURL(currentUrl)
    currentUrl = null
  }
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

  /** Stop the current utterance (if any). Safe to call repeatedly. */
  stop() {
    if (!currentAudio) return
    cleanupAudio()
    const st = useMistStore.getState()
    if (st.neural.state === 'speaking') st.setNeuralState('dormant')
  },

  /**
   * Speak `text` aloud. ALWAYS interrupts whatever is currently playing so the
   * newest message wins (the user never hears two replies at once). Honors the
   * ttsEnabled preference unless `force` is set (explicit per-message button).
   */
  async speak(text: string, opts: SpeakOptions = {}): Promise<void> {
    const store = useMistStore.getState()
    if (!opts.force && !store.ttsEnabled) {
      opts.onEnd?.()
      return
    }
    const clean = stripMarkdownForSpeech(text)
    if (!clean) {
      opts.onEnd?.()
      return
    }

    const mySeq = ++speakSeq
    // interrupt any in-flight utterance immediately
    this.stop()

    try {
      const busReady = await mistAudioResume()
      // Branch ONLY the fetch: local mode synthesizes the chunk offline on the
      // user's machine (piper via the bridge), everything else uses the cloud
      // route. The player (object URL → <audio> → audio bus) is shared.
      const chunk = clean.slice(0, opts.maxLength ?? 900)
      const mode = await getVoiceMode()
      let blob: Blob
      if (mode === 'local') {
        try {
          blob = await mistApi.voice.localTts(chunk)
        } catch (err) {
          console.warn(
            '[mist-voice] local TTS failed — falling back to the cloud voice for this utterance',
            err
          )
          blob = await mistApi.voice.tts(chunk, opts.voice ?? store.voice, 1.0)
        }
      } else {
        blob = await mistApi.voice.tts(chunk, opts.voice ?? store.voice, 1.0)
      }
      // a newer speak() may have raced us while the TTS fetch was in flight
      if (mySeq !== speakSeq) return
      this.stop()

      const url = URL.createObjectURL(blob)
      const audio = new Audio(url)
      currentAudio = audio
      currentUrl = url
      if (busReady) mistAudioAttachMedia(audio)
      store.setNeuralState('speaking')

      const finish = () => {
        if (mySeq !== speakSeq) return // superseded — let the newer one own state
        cleanupAudio()
        const st = useMistStore.getState()
        if (st.neural.state === 'speaking') st.setNeuralState('dormant')
        opts.onEnd?.()
      }
      audio.onended = finish
      audio.onerror = finish
      await audio.play()
    } catch (err) {
      if (mySeq !== speakSeq) return
      cleanupAudio()
      const st = useMistStore.getState()
      if (st.neural.state === 'speaking') st.setNeuralState('dormant')
      // Autoplay policy blocks unmuted audio without a gesture — skip silently.
      if (err instanceof DOMException && (err.name === 'NotAllowedError' || err.name === 'AbortError')) {
        opts.onEnd?.()
        return
      }
      opts.onEnd?.()
    }
  },
}
