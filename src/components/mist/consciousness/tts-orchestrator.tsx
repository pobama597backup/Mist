'use client'

// M.I.S.T. — tts-orchestrator: the chat's voice-replies wiring.
//
// Phase 4-a · chat-panel split: the speak-on-reply orchestration extracted
// from the god-file one-to-one. Every reply flow (socket response, research
// report) and the per-message read-aloud button share this ONE home so two
// utterances can never speak at once — the shared mistSpeech singleton
// already interrupts in-flight playback; this hook tracks WHICH message is
// audible so the message list can light the right icon.
//
// The hook is intentionally tiny: state stays where it was (a single
// speakingId in the chat shell), just extracted so the panel body stops
// carrying the wiring.

import { useCallback, useState } from 'react'
import { mistSpeech } from '@/lib/speech'

export interface TtsOrchestrator {
  /** The assistant message currently being read (null = silent). */
  speakingId: string | null
  /** Auto-speak a fresh reply — routes through the shared singleton (always
   *  interrupts the previous utterance, markdown/code stripped inside). */
  speakReply: (id: string, content: string) => void
  /** Explicit per-message read-aloud (the button) — `force: true`, ignoring
   *  the auto-speak preference exactly like the pre-split behavior. */
  speakMessage: (id: string, content: string) => void
  /** Silence everything NOW (the interrupt sequence entry point). */
  stopSpeaking: () => void
}

export function useTtsOrchestrator(): TtsOrchestrator {
  const [speakingId, setSpeakingId] = useState<string | null>(null)

  const speakReply = useCallback((id: string, content: string) => {
    setSpeakingId(id)
    void mistSpeech.speak(content, {
      onEnd: () => setSpeakingId((cur) => (cur === id ? null : cur)),
    })
  }, [])

  const speakMessage = useCallback((id: string, content: string) => {
    setSpeakingId(id)
    void mistSpeech.speak(content, {
      // explicit action — ignores the auto-speak pref
      force: true,
      onEnd: () => setSpeakingId((cur) => (cur === id ? null : cur)),
    })
  }, [])

  const stopSpeaking = useCallback(() => {
    mistSpeech.stop()
    setSpeakingId(null)
  }, [])

  return { speakingId, speakReply, speakMessage, stopSpeaking }
}
