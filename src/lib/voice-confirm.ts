// M.I.S.T. voice confirm phrase — Phase 2-d · S14.
//
// The mandate: "voice is trusted for chat + read-only. exec/destructive/
// persist/egress need on-screen tap or owner-set spoken confirm (not the wake
// word)." This module owns the PURE half of the spoken confirm: the phrase
// (v1 is env/const — Settings-free; MIST_VOICE_CONFIRM_PHRASE overrides), the
// whole-utterance matcher, and the 60s window measured from the approval's
// creation. The WIRING half lives in use-voice.ts handleUtterance — the
// single place every voice transcript lands (SpeechRecognition onresult,
// hold-to-talk, local whisper and server STT all funnel through submit() →
// handleUtterance) — plus the on-screen chip (voice-approval-chip.tsx) that
// covers the 1-tap path.

/** The owner's spoken confirm phrase. NOT the wake word — a deliberate
 *  decision phrase. Default "confirm and run it"; env override honored. */
export const MIST_VOICE_CONFIRM_PHRASE =
  (process.env.MIST_VOICE_CONFIRM_PHRASE ?? '').trim() || 'confirm and run it'

/** A confirm phrase is only valid if the NEXT voice transcript arrives within
 *  this window of the pending approval's creation (mandate: 60s). */
export const VOICE_CONFIRM_WINDOW_MS = 60_000

/** Small backward clock-skew grace (server createdAt vs client clock). */
const CLOCK_SKEW_GRACE_MS = 5_000

/**
 * Whole-utterance, case-insensitive, whitespace-trimmed match against the
 * confirm phrase. Deliberately NOT a substring match: "hey mist" (the wake
 * word) and wake-prefixed chatter never confirm anything — only the bare
 * phrase, spoken alone, does.
 */
export function matchVoiceConfirm(transcript: string, phrase: string = MIST_VOICE_CONFIRM_PHRASE): boolean {
  const t = (transcript ?? '').trim().toLowerCase()
  const p = (phrase ?? '').trim().toLowerCase()
  return p.length > 0 && t === p
}

/** True when `createdAt` is within the confirm window of `now`. */
export function confirmWindowActive(
  createdAt: string | Date,
  now: number = Date.now(),
  windowMs: number = VOICE_CONFIRM_WINDOW_MS,
): boolean {
  const created = createdAt instanceof Date ? createdAt.getTime() : Date.parse(String(createdAt))
  if (!Number.isFinite(created)) return false
  return now - created <= windowMs && created - now <= CLOCK_SKEW_GRACE_MS
}

/** The combined decision: a pending voice approval may be approved by voice
 *  only when the window is live AND the transcript is the bare confirm phrase. */
export function shouldApproveByVoice(
  transcript: string,
  approval: { createdAt: string | Date },
  now: number = Date.now(),
): boolean {
  return matchVoiceConfirm(transcript) && confirmWindowActive(approval.createdAt, now)
}
