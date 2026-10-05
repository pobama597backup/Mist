// M.I.S.T. voice emotion (w8) — the shared inline-marker grammar.
//
// The creator's order: "give her voice emotion like [sigh], [laugh],
// [whisper]". This module is the single source of truth for the marker
// vocabulary, the parser, and the per-engine renderings. It is ISOMORPHIC
// (zero imports): the server voice engines, the client speech pipeline,
// the prompt builder and the display components all import from here.
//
// Research notes (2026-10, 10 searches / 8 topics before building):
//  - Orpheus-TTS trains exactly this vocabulary as inline tags (<laugh>,
//    <chuckle>, <sigh>, <gasp>) — "trained features, not prompt hacks".
//  - Gemini 3.8 Flash TTS ships 200+ inline vocal tags (<laugh> etc.);
//    the 2.5-preview model she calls takes natural-language style cues
//    ("Whisper this softly: …"), so the gemini lane maps markers → cues.
//  - LiveKit "expressive mode" is the same architecture: the LLM adds
//    emotion, pacing and non-verbal sounds inline with its reply.
//  - The Edge read-aloud channel allows ONLY speak/voice/prosody SSML
//    (rate/pitch/volume) — no express-as styles, no <break>. So the edge
//    lane renders markers as per-segment PROSODY + vocalized
//    approximations ("Hah…", "Ha ha ha!") and ffmpeg-spliced silence.
//  - Piper (her offline lane) has no emotion support (rhasspy/piper#150)
//    — markers are stripped there, honestly.
//
// Marker grammar (square brackets, as the creator wrote them):
//   POINT SOUNDS  [sigh] [laugh] [chuckle] [gasp]     — one-shot vocal sounds
//   TONES         [whisper] [soft] [excited] [sad] [warm] — style the FOLLOWING
//                 words until the next marker or [normal]
//   BEAT          [pause] — a short beat of silence
//   RESET         [normal]

export type EmotionSound = 'sigh' | 'laugh' | 'chuckle' | 'gasp'
export type EmotionTone = 'normal' | 'whisper' | 'soft' | 'excited' | 'sad' | 'warm'

export type EmotionSegment =
  | { kind: 'speech'; tone: EmotionTone; text: string }
  | { kind: 'sound'; sound: EmotionSound }
  | { kind: 'pause'; ms: number }

const SOUND_WORDS: readonly EmotionSound[] = ['sigh', 'laugh', 'chuckle', 'gasp']
const TONE_WORDS: readonly EmotionTone[] = ['whisper', 'soft', 'excited', 'sad', 'warm', 'normal']

// one marker token: [word], case-insensitive, no inner spaces
const MARKER_RE = /\[(sigh|laugh|chuckle|gasp|whisper|soft|excited|sad|warm|normal|pause)\]/gi

/** The pause a [pause] marker buys (ms). */
export const PAUSE_MS = 450

/** Does this text carry any emotion markers? (cheap pre-check for the hot paths) */
export function hasEmotionMarkers(text: string): boolean {
  MARKER_RE.lastIndex = 0
  return MARKER_RE.test(text)
}

/** Remove every emotion marker — what DISPLAYS and what tone-deaf engines
 *  (gtranslate, Piper) receive. Collapses the leftover whitespace. */
export function stripEmotionMarkers(text: string): string {
  return text
    .replace(MARKER_RE, ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/ *\n */g, '\n')
    .trim()
}

/** Parse marked-up text into ordered segments. Text before the first marker
 *  is normal-tone speech. Empty speech segments are dropped. Unknown
 *  bracketed tokens (citations like [1], links) are LEFT IN the text — only
 *  the exact vocabulary above is treated as a marker. */
export function parseEmotionSegments(text: string): EmotionSegment[] {
  const segments: EmotionSegment[] = []
  let tone: EmotionTone = 'normal'
  let cursor = 0
  MARKER_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = MARKER_RE.exec(text)) !== null) {
    const plain = text.slice(cursor, m.index)
    if (plain.trim()) segments.push({ kind: 'speech', tone, text: plain })
    cursor = m.index + m[0].length
    const word = m[1].toLowerCase()
    if (word === 'pause') segments.push({ kind: 'pause', ms: PAUSE_MS })
    else if (word === 'normal') tone = 'normal'
    else if ((SOUND_WORDS as readonly string[]).includes(word)) segments.push({ kind: 'sound', sound: word as EmotionSound })
    else if ((TONE_WORDS as readonly string[]).includes(word)) tone = word as EmotionTone
  }
  const tail = text.slice(cursor)
  if (tail.trim()) segments.push({ kind: 'speech', tone, text: tail })
  return segments
}

// ---------------------------------------------------------------------------
// Edge (msedge-tts) rendering — relative prosody strings the channel accepts
// ---------------------------------------------------------------------------

export interface EdgeProsodyInput {
  rate?: string // e.g. '-10%' (relative, same grammar as speedToRate)
  pitch?: string // e.g. '-12Hz'
  volume?: string // e.g. '-40%' (relative)
}

/** Tuned prosody per tone (researched SSML practice + field values). */
export const EDGE_TONE_PROSODY: Record<EmotionTone, EdgeProsodyInput> = {
  normal: {},
  whisper: { rate: '-10%', pitch: '-12Hz', volume: '-40%' },
  soft: { rate: '-6%', pitch: '-6Hz', volume: '-20%' },
  excited: { rate: '+12%', pitch: '+15Hz', volume: '+15%' },
  sad: { rate: '-14%', pitch: '-18Hz', volume: '-12%' },
  warm: { rate: '-4%', pitch: '-4Hz', volume: '+0%' },
}

/** Vocalized approximations of the point sounds (honest: the channel cannot
 *  perform a true non-verbal laugh — these are the closest speakable
 *  renderings, prosody-tuned so they read as sounds, not words). */
export const SOUND_TEXT: Record<EmotionSound, string> = {
  sigh: 'Hah...',
  laugh: 'Ha ha ha!',
  chuckle: 'Heh heh.',
  gasp: 'Ah!',
}

export const EDGE_SOUND_PROSODY: Record<EmotionSound, EdgeProsodyInput> = {
  sigh: { rate: '-25%', pitch: '-20Hz', volume: '-25%' },
  laugh: { rate: '+8%', pitch: '+12Hz', volume: '+5%' },
  chuckle: { rate: '-5%', pitch: '-8Hz', volume: '-15%' },
  gasp: { rate: '+30%', pitch: '+25Hz', volume: '+10%' },
}

// ---------------------------------------------------------------------------
// GLM (z-ai SDK) rendering — speed is the only lever the SDK exposes
// ---------------------------------------------------------------------------

export const GLM_TONE_SPEED: Record<EmotionTone, number> = {
  normal: 1.0,
  whisper: 0.88,
  soft: 0.94,
  excited: 1.12,
  sad: 0.88,
  warm: 0.97,
}

export const GLM_SOUND_SPEED: Record<EmotionSound, number> = {
  sigh: 0.8,
  laugh: 1.08,
  chuckle: 0.95,
  gasp: 1.2,
}

// ---------------------------------------------------------------------------
// Gemini-direct (2.5-preview TTS) rendering — natural-language style cues
// ---------------------------------------------------------------------------

export const GEMINI_TONE_CUE: Record<EmotionTone, string> = {
  normal: '',
  whisper: 'Whisper this softly and closely:',
  soft: 'Say this gently and softly:',
  excited: 'Say this brightly, with excitement:',
  sad: 'Say this slowly, with a heavy heart:',
  warm: 'Say this warmly:',
}

export const GEMINI_SOUND_CUE: Record<EmotionSound, string> = {
  sigh: 'Let out a soft, tired sigh.',
  laugh: 'Give a short, warm laugh.',
  chuckle: 'Give a light chuckle.',
  gasp: 'Give a small, startled gasp.',
}

/** One synthesis unit for the Gemini lane: the FIRST marker in the text
 *  becomes a style cue prefix, every marker is stripped, sounds become
 *  cue-only utterances, pauses are dropped (the model paces itself).
 *  Text without markers passes through untouched. */
export function geminiStyledText(text: string): string {
  if (!hasEmotionMarkers(text)) return text
  const segments = parseEmotionSegments(text)
  const out: string[] = []
  let cue = ''
  for (const seg of segments) {
    if (seg.kind === 'pause') continue
    if (seg.kind === 'sound') {
      out.push(GEMINI_SOUND_CUE[seg.sound])
      continue
    }
    if (seg.tone !== 'normal' && !cue) cue = GEMINI_TONE_CUE[seg.tone]
    const t = seg.text.trim()
    if (t) out.push(t)
  }
  const body = out.join(' ')
  return cue && body ? `${cue} ${body}` : body
}

// ---------------------------------------------------------------------------
// The LLM instruction (injected by context-builder for spoken-capable modes)
// ---------------------------------------------------------------------------

export const EMOTION_RULE =
  'VOICE EMOTION: your replies are often spoken aloud, and your voice carries feeling. When it is ' +
  'GENUINE (never forced, never theatrical), you may mark HOW words sound with inline markers: ' +
  '[whisper], [soft], [excited], [sad], [warm] style the words that follow, [sigh], [laugh], ' +
  '[chuckle], [gasp] are brief vocal sounds, [pause] is a short beat, [normal] returns to your ' +
  'regular voice. Rules: at most one or two markers per reply, and most replies carry NONE — use ' +
  'them only when the moment truly calls for it (a joke lands, something is touching, a secret is ' +
  'shared, you are tired). The words must read complete without the marker — markers style ' +
  'delivery, they never replace words, and they are never the point.'
