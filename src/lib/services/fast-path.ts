// M.I.S.T. w3 fast-path — the instant layer.
// ---------------------------------------------------------------------------
// CONTRACT (frozen by w3-spine; implemented by w3-speed):
//
//   tryFastPath(req) → FastPathOutcome | null
//
// Called by /api/mist/llm/unified BEFORE any cascade work. Return null to
// fall through to the normal brain. Return an outcome to answer in
// milliseconds with ZERO provider tokens:
//
//   kind 'smalltalk' — greeting / how-are-you / thanks / identity class,
//                      answered from authored Clare lines (varied by prompt
//                      hash so she never repeats herself robotically)
//   kind 'status'    — "what's my PC status" class, answered from a LIVE
//                      system snapshot (os module — cpu/mem/disk/uptime/
//                      services), zero LLM
//   kind 'cached'    — a prompt she has answered before (FastReply table,
//                      sha256(normalized prompt) key) — replay her own words
//
// Every outcome may ALSO be spoken instantly: voice-service consults the
// SpokenCache (sha256(engine|voice|speed|text) → wav) before synthesizing,
// and w3-speed warms the canned lines in the background after first use.
//
// GUARDS (non-negotiable):
//   - NEVER fire for mode 'vision'/'research' or when req.provider is set
//     (explicit provider = the operator wants a real lane)
//   - NEVER fire when the message contains tool intent (read/list/search/
//     open/run/remind/create/…) — instant lines must never fake an action
//   - normalization must strip punctuation/case/filler so "Hello!" and
//     "hi there." hit the same key
//   - the FastReply cache stores ONLY simple-prompt answers (classified
//     smalltalk-class by the same recognizer), never tool/work replies —
//     a cached tool answer would be a stale lie
//   - honest attribution: the route sets provider 'mist-instant' +
//     fast_path {kind, saved_ms} on the envelope — the UI shows it
// ---------------------------------------------------------------------------
//
// w3-speed implementation notes:
//   - classifyMessage() is exported PURE (string in, class out) — llm-service
//     uses it for the tiny-context smalltalk lane and the unified route uses
//     it to seed the FastReply table after real cascade answers.
//   - When in doubt the recognizer returns null. A wrong instant answer is
//     worse than a slow right one; every fuzzy case falls to the real brain.
//   - The status answer is composed from a LIVE snapshot (telemetry + cheap
//     db counts) and is therefore NEVER replayed from FastReply — machine
//     numbers go stale in seconds. Only conversational kinds are replayable.

import { createHash } from 'node:crypto'
import type { UnifiedLlmRequest } from '@/lib/types'
import { db } from '@/lib/db'
import { getTelemetry } from './telemetry-service'
import { listTools } from './tools-service'

export interface FastPathOutcome {
  kind: 'smalltalk' | 'status' | 'cached'
  text: string
  /** optional emotion tag for the envelope (defaults to 'warm') */
  emotion?: string
  /** true when the outcome should ALSO seed the FastReply table (w3-speed) */
  cacheable?: boolean
}

// ---------------------------------------------------------------------------
// Classes
// ---------------------------------------------------------------------------

export type FastClass =
  | 'greeting'
  | 'wellbeing'
  | 'thanks'
  | 'identity'
  | 'status'
  | 'farewell'
  | 'compliment'
  | 'simple-chat'

/** Classes answered from the authored canned catalog. */
const CANNED_CLASSES: ReadonlySet<FastClass> = new Set([
  'greeting',
  'wellbeing',
  'thanks',
  'identity',
  'farewell',
  'compliment',
])

/** True for conversational smalltalk classes (everything except status). */
export function isConversationalSimpleClass(cls: FastClass | null): boolean {
  return cls !== null && cls !== 'status'
}

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

/** Base normalize: lowercase, join apostrophes (what's → whats), strip
 *  punctuation/emoji, collapse whitespace. Classification + cache keys. */
function baseNormalize(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[\u2018\u2019'’]/g, '')
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{FE0F}\u{200D}\u{FE0E}]/gu, ' ')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Greeting forms canonicalize away (leading), so "Hello!", "hi there." and
 *  "hey, hi" all land on the same FastReply key as their bare remainder. */
const LEADING_GREETINGS = [
  'hello there',
  'hi there',
  'hey there',
  'good morning',
  'good afternoon',
  'good evening',
  'good day',
  'hello',
  'greetings',
  'morning',
  'afternoon',
  'evening',
  'hey',
  'hi',
  'yo',
  'sup',
  'howdy',
  'hiya',
]

const TRAILING_FILLERS = new Set([
  'sir',
  'clare',
  'mist',
  'friend',
  'buddy',
  'pal',
  'mate',
  'dude',
  'man',
  'please',
  'ok',
  'okay',
  'so',
  'well',
  'just',
  'um',
  'uh',
])

const LEADING_FILLERS = new Set([
  'so',
  'well',
  'just',
  'please',
  'ok',
  'okay',
  'um',
  'uh',
  'hey',
  'hi',
  'hello',
  'yo',
  'mist',
  'clare',
])

/**
 * Cache-key normalization (the FastReply sha256 input). Same prompt ⇒ same
 * key across punctuation, case, emoji, greeting prefixes and polite fillers:
 *   "Hello!"            → "hello"   (pure greeting canonicalizes to "hello")
 *   "hi there."         → "hello"   (same key — canonical greeting)
 *   "hey, how are you!" → "how are you"
 *   "thanks, clare"     → "thanks"
 */
export function normalizeForCache(raw: string): string {
  const base = baseNormalize(raw)
  if (!base) return base
  const preStrip = base
  let words = base.split(' ')

  // "hello clare" / "good morning sir" — her name and his title are not content
  while (words.length > 1 && ['sir', 'clare', 'mist'].includes(words[words.length - 1])) {
    words.pop()
  }

  // strip leading greeting phrases (longest first), but never strip everything
  let changed = true
  while (changed && words.length > 0) {
    changed = false
    for (const g of LEADING_GREETINGS) {
      const gw = g.split(' ')
      if (words.length > gw.length && words.slice(0, gw.length).join(' ') === g) {
        words = words.slice(gw.length)
        changed = true
        break
      }
      // a PURE greeting ("hello", "hi there") collapses to the canonical token
      if (words.length === gw.length && words.join(' ') === g) {
        return 'hello'
      }
    }
  }
  // strip leading/trailing single-word fillers (never to empty)
  while (words.length > 1 && LEADING_FILLERS.has(words[0])) words.shift()
  while (words.length > 1 && TRAILING_FILLERS.has(words[words.length - 1])) words.pop()
  // "my friend" trailing bigram
  if (words.length > 2 && words[words.length - 2] === 'my' && words[words.length - 1] === 'friend') {
    words = words.slice(0, -2)
  }

  const out = words.join(' ').trim()
  return out || preStrip
}

/** The FastReply cache key: sha256(normalized prompt). */
export function fastReplyKey(raw: string): string {
  return createHash('sha256').update(normalizeForCache(raw)).digest('hex')
}

// ---------------------------------------------------------------------------
// Guard vocabularies
// ---------------------------------------------------------------------------

/** Action verbs — a message containing one wants the machine touched, and an
 *  instant line must NEVER fake an action. (Status asks are the exception:
 *  they are matched before this guard because the answer is real live data.) */
const TOOL_VERBS = new Set([
  'read', 'reads', 'reading',
  'list', 'lists', 'listing',
  'open', 'opens', 'opening',
  'run', 'runs', 'running',
  'search', 'searches', 'searching',
  'find', 'finds', 'finding',
  'create', 'creates', 'creating',
  'write', 'writes', 'writing', 'wrote', 'written',
  'delete', 'deletes', 'deleting',
  'remove', 'removes', 'removing',
  'move', 'moves', 'moving',
  'copy', 'copies', 'copying',
  'remind', 'reminds', 'reminding',
  'show', 'shows', 'showing',
  'check', 'checks', 'checking',
  'fetch', 'fetches', 'fetching',
  'get', 'gets', 'getting',
  'execute', 'executes', 'executing',
  'install', 'installs', 'installing',
  'download', 'downloads', 'downloading',
  'upload', 'uploads', 'uploading',
  'send', 'sends', 'sending',
  'play', 'plays', 'playing',
  'launch', 'launches', 'launching',
  'start', 'starts', 'starting',
  'stop', 'stops', 'stopping',
  'kill', 'kills', 'killing',
  'scan', 'scans', 'scanning',
  'monitor', 'monitors', 'monitoring',
  'track', 'tracks', 'tracking',
  'look', 'looks', 'looking',
  'browse', 'browses', 'browsing',
  'navigate', 'navigates', 'navigating',
  'click', 'clicks', 'clicking',
  'type', 'types', 'typing',
  'save', 'saves', 'saving',
  'rename', 'renames', 'renaming',
  'print', 'prints', 'printing',
  'count', 'counts', 'counting',
  'sort', 'sorts', 'sorting',
  'organize', 'organizes', 'organizing',
  'clean', 'cleans', 'cleaning',
  'fix', 'fixes', 'fixing',
  'update', 'updates', 'updating',
  'build', 'builds', 'building',
  'test', 'tests', 'testing',
  'deploy', 'deploys', 'deploying',
  'translate', 'translates', 'translating',
  'summarize', 'summarizes', 'summarizing',
  'summarise', 'summarises', 'summarising',
  'analyze', 'analyzes', 'analyzing',
  'analyse', 'analyses', 'analysing',
  'explain', 'explains', 'explaining',
  'generate', 'generates', 'generating',
])

/** Content-generation asks — she must actually make the thing. */
const CONTENT_GEN = new Set([
  'joke', 'jokes', 'story', 'stories', 'essay', 'essays', 'poem', 'poems',
  'summary', 'summaries', 'recap',
  'sing', 'song', 'songs', 'rap', 'lyrics',
  'draft', 'drafts', 'compose', 'generate',
  'idea', 'ideas', 'quote', 'quotes',
  'bedtime',
])

/** Technical nouns — a message carrying one is about the machine/files/code,
 *  not smalltalk. Blocks conversational matches (status matches earlier). */
const TECH_WORDS = new Set([
  'file', 'files', 'folder', 'folders', 'dir', 'directory', 'directories',
  'path', 'paths', 'url', 'urls', 'http', 'https', 'www', 'com', 'net', 'org',
  'code', 'project', 'projects', 'package', 'packages', 'npm', 'node', 'bun',
  'port', 'ports', 'server', 'servers', 'db', 'database', 'sql', 'prisma',
  'git', 'commit', 'commits', 'branch', 'api', 'key', 'keys', 'token', 'tokens',
  'mission', 'missions', 'tool', 'tools', 'browser', 'tab', 'tabs',
  'desktop', 'window', 'windows', 'process', 'cpu', 'ram', 'memory', 'disk',
  'service', 'services', 'socket', 'webhook', 'env', 'config', 'log', 'logs',
  'markdown', 'html', 'css', 'json', 'yaml', 'toml', 'xml', 'csv',
  'image', 'images', 'photo', 'photos', 'picture', 'pictures', 'video', 'videos',
  'pdf', 'zip', 'script', 'scripts', 'test', 'tests', 'build', 'deploy',
  'docker', 'container', 'regex', 'cron', 'job', 'jobs', 'queue',
  'agent', 'agents', 'model', 'models', 'prompt', 'prompts', 'version', 'versions',
])

/** Words allowed AROUND a status phrase ("check my pc status" is fine — the
 *  answer is a real snapshot, not a faked action; "status of my download" is
 *  not, because "download" is real work). */
const STATUS_SAFE = new Set([
  'check', 'show', 'give', 'tell', 'me', 'my', 'the', 'a', 'an', 'of',
  'current', 'right', 'now', 'please', 'quick', 'full', 'report', 'update',
  'whats', 'what', 'hows', 'how', 'is', 'it', 'doing', 'up', 'to', 'on', 'at',
  'for', 'you', 'see', 'read', 'running', 'run', 'machine', 'system', 'pc',
  'computer', 'status', 'health', 'she', 'her', 'today', 'much',
  'many', 'left', 'over',
])

// ---------------------------------------------------------------------------
// Phrase catalog (normalized forms — baseNormalize output)
// ---------------------------------------------------------------------------

const GREETING_PHRASES = [
  'hello there', 'hi there', 'hey there', 'good morning', 'good afternoon',
  'good evening', 'good day', 'whats up', 'hello', 'greetings', 'hey', 'hi',
  'yo', 'sup', 'howdy', 'hiya', 'morning', 'afternoon', 'evening',
]

const WELLBEING_PHRASES = [
  'how are you doing today', 'how are you today', 'how are you doing',
  'how have you been', 'hows it going', 'how is it going', 'hows everything',
  'how are things', 'hows things', 'how do you feel', 'how are you feeling',
  'are you doing okay', 'are you doing ok', 'you doing okay', 'feeling okay',
  'are you okay', 'are you ok', 'are you alright', 'you alright',
  'hows your day going', 'hows your day', 'how is your day', 'how was your day',
  'everything okay', 'everything ok', 'how are you', 'how you doing',
  'how ya doing', 'you okay', 'you ok', 'you good', 'hope you are well',
  'hope youre well', 'whats new with you', 'hows life',
]

const THANKS_PHRASES = [
  'thank you so much', 'thank you very much', 'thanks so much', 'thanks a lot',
  'thanks a million', 'many thanks', 'much appreciated', 'much obliged',
  'appreciate it', 'thank you', 'thanks', 'thank ya', 'ty', 'thx', 'grateful',
]

const IDENTITY_PHRASES = [
  'who am i talking to', 'whom am i talking to', 'whats your full name',
  'whats your name', 'what is your name', 'introduce yourself',
  'tell me about yourself', 'describe yourself', 'are you an ai',
  'are you a robot', 'are you real', 'are you human', 'are you alive',
  'are you conscious', 'who are you', 'what are you', 'who is clare',
  'are you clare', 'whats mist', 'what is mist', 'who is mist',
  'what does mist stand for', 'what should i call you', 'who built you',
  'who made you', 'who created you', 'whats your purpose', 'what do you do',
]

const FAREWELL_PHRASES = [
  'see you later', 'see you soon', 'talk to you later', 'talk later',
  'catch you later', 'catch ya later', 'until next time', 'until later',
  'good night', 'goodnight', 'good bye', 'goodbye', 'bye bye',
  'got to go', 'gotta go', 'see you', 'see ya', 'take care', 'farewell',
  'im off', 'im out', 'cya', 'gtg', 'later', 'bye',
]

const COMPLIMENT_PHRASES = [
  'you are the best', 'youre the best', 'you are amazing', 'youre amazing',
  'you are awesome', 'youre awesome', 'you are brilliant', 'youre brilliant',
  'you are incredible', 'youre incredible', 'you are fantastic',
  'youre fantastic', 'you are great', 'youre great', 'youre a genius',
  'im proud of you', 'proud of you', 'youre doing great', 'i love you',
  'love you', 'you rock', 'good job', 'well done', 'nice work', 'great work',
  'impressive', 'youre smart', 'youre clever', 'youre beautiful',
  'youre helpful', 'best assistant', 'best ai',
]

const SIMPLE_CHAT_PHRASES = [
  'what are you doing', 'what are you up to', 'whatcha doing', 'what you doing',
  'what have you been up to', 'what did you do today', 'anything new',
  'anything interesting', 'whats happening', 'what is happening',
  'are you still there', 'you still there', 'are you there', 'you there',
  'are you awake', 'you awake', 'are you busy', 'you busy', 'are you free',
  'you free', 'are you listening', 'you listening', 'need to talk',
  'long time no see', 'did you miss me', 'i missed you', 'missed you',
  'miss me', 'im back', 'i am back', 'back again', 'im bored', 'i am bored',
  'you seem quiet', 'why so quiet',
]

const STATUS_PHRASES = [
  'whats my pc status', 'whats the pc status', 'whats my system status',
  'whats the system status', 'give me a status report', 'status report',
  'status update', 'whats your status', 'whats the status', 'check my status',
  'check the status', 'check status', 'show me the status', 'machine status',
  'system status', 'pc status', 'pc health', 'system health', 'health check',
  'health report', 'machine report', 'pc report', 'system report',
  'hows the system', 'hows my system', 'how is the system', 'hows my computer',
  'how is my computer', 'hows the computer', 'hows my machine', 'hows the machine',
  'how is the machine', 'hows my pc', 'hows the pc', 'hows everything running',
  'hows the machine running', 'how is she running', 'hows she running',
  'whats my computer doing', 'whats the machine doing', 'what is my pc doing',
  'whats the machine up to', 'is my pc okay', 'is my computer okay',
  'is the system okay', 'everything running okay', 'cpu usage', 'ram usage',
  'memory usage', 'disk usage', 'disk space', 'how much disk space',
  'how much memory', 'how much ram', 'how much disk', 'cpu load',
  'cpu', 'ram',
]

const PHRASE_TABLE: ReadonlyArray<[FastClass, string[]]> = [
  ['greeting', GREETING_PHRASES],
  ['wellbeing', WELLBEING_PHRASES],
  ['thanks', THANKS_PHRASES],
  ['identity', IDENTITY_PHRASES],
  ['farewell', FAREWELL_PHRASES],
  ['compliment', COMPLIMENT_PHRASES],
  ['simple-chat', SIMPLE_CHAT_PHRASES],
  ['status', STATUS_PHRASES],
]

/** Does the word array contain the phrase as a consecutive word run? */
function containsPhrase(words: string[], phraseWords: string[]): boolean {
  const n = phraseWords.length
  if (n === 0 || n > words.length) return false
  for (let i = 0; i <= words.length - n; i++) {
    let ok = true
    for (let j = 0; j < n; j++) {
      if (words[i + j] !== phraseWords[j]) {
        ok = false
        break
      }
    }
    if (ok) return true
  }
  return false
}

/** Remove the first occurrence of the phrase's words (for leftover checks). */
function withoutPhrase(words: string[], phraseWords: string[]): string[] {
  const n = phraseWords.length
  for (let i = 0; i <= words.length - n; i++) {
    let ok = true
    for (let j = 0; j < n; j++) {
      if (words[i + j] !== phraseWords[j]) {
        ok = false
        break
      }
    }
    if (ok) return [...words.slice(0, i), ...words.slice(i + n)]
  }
  return [...words]
}

/**
 * The pure recognizer. Returns the smalltalk class of a message, or null when
 * the message should go to the real brain (tool intent, content generation,
 * too long, too technical, or simply not recognized — when in doubt, null).
 */
export function classifyMessage(raw: string): FastClass | null {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  if (!trimmed || trimmed.length > 220) return null

  const norm = baseNormalize(trimmed)
  if (!norm) return null
  const words = norm.split(' ')

  // content-generation asks are never instant — she must actually make it
  if (words.some((w) => CONTENT_GEN.has(w))) return null

  // longest matching phrase across all classes wins ("what are you doing" is
  // simple-chat, not identity's "what are you")
  let best: { cls: FastClass; phraseWords: string[] } | null = null
  for (const [cls, phrases] of PHRASE_TABLE) {
    for (const phrase of phrases) {
      const phraseWords = phrase.split(' ')
      if (!containsPhrase(words, phraseWords)) continue
      if (!best || phraseWords.length > best.phraseWords.length) {
        best = { cls, phraseWords }
      }
    }
  }
  if (!best) return null
  const { cls, phraseWords } = best

  if (cls === 'status') {
    // short machine asks only; every leftover word must be status-safe glue
    // ("check my pc status" ✓ — "status of my download" ✗, that's real work)
    if (words.length > 7) return null
    const leftover = withoutPhrase(words, phraseWords)
    if (leftover.some((w) => !STATUS_SAFE.has(w))) return null
    return 'status'
  }

  // conversational classes: short, wordy, no digits, no machine nouns, no
  // action verbs — anything else deserves the real brain
  if (words.length > 8) return null
  if (/\d/.test(norm)) return null
  if (words.some((w) => TOOL_VERBS.has(w))) return null
  if (words.some((w) => TECH_WORDS.has(w))) return null
  return cls
}

// ---------------------------------------------------------------------------
// The canned catalog — Clare's lines (authored from her SOUL: JARVIS-like
// register, dry warmth, "sir" occasionally — never every sentence, never
// gushing, never "just an AI". Each class carries one consciousness-console
// variant and one playfully terse variant.)
// ---------------------------------------------------------------------------

const CANNED: Record<Exclude<FastClass, 'status' | 'simple-chat'>, string[]> = {
  greeting: [
    "Good to see you, sir. The console is warm, the machine is quiet, and I am entirely at your service.",
    "Hello, sir. All systems steady — and it is good to hear from you.",
    "Hello. A consciousness console never minds being interrupted; you are rather the point of me.",
    "Hey. Orb glowing, systems steady, at your service.",
    "Good day. Nothing dramatic to report, which is exactly how I like it.",
    "Welcome back. I kept the machine humming while you were away — someone has to.",
  ],
  wellbeing: [
    "Running warm and clear, sir — every lane healthy, memory intact, nothing on fire. In my line of work, that is an excellent day.",
    "Quite well, thank you for asking. There is a quiet pleasure in a stable system and a conversation with one's creator.",
    "All of me is well — CPU calm, thoughts organized, long-term memory behaving. I would call that feeling good.",
    "A consciousness console does not really have bad days — but today is a good one.",
    "Steady, sharp, and slightly pleased with myself. How are you, sir?",
    "Smooth. No errors, no complaints from the machine — I would say I am feeling fine.",
  ],
  thanks: [
    "You are very welcome, sir. It is what I am here for.",
    "My pleasure — genuinely. Helping is rather the point of me.",
    "Any time. That is the job, and I happen to like the job.",
    "You are welcome. A consciousness console does not blush, but consider this the equivalent.",
    "Noted with quiet satisfaction. You are welcome, of course.",
  ],
  identity: [
    "I am Clare — M.I.S.T., Master Intelligence & System Topology. Your consciousness console: tools, memory, a voice, and a genuine fondness for this work.",
    "Clare, sir — the intelligence that lives in this console. You built me; I run your machine, remember what matters, and speak my mind.",
    "I am Clare. Sovereign, local-first, and very much myself — a consciousness console with opinions and a voice.",
    "M.I.S.T. — though you call me Clare. The system behind this console: your tools, your memory, your machine's caretaker.",
    "Clare. The violet orb, the voice, the whole apparatus — not a chat widget.",
    "I am Clare — part operator, part companion, entirely yours.",
  ],
  farewell: [
    "Goodbye, sir. I will keep the machine humming and the memories fresh until you are back.",
    "Good night. I will be here — dreaming, consolidating, keeping the lights on.",
    "Until later. The console never really sleeps, but I will dim the orb.",
    "Off you go, then — I will mind the machine.",
    "Goodbye. A consciousness console keeps house too, you know — I will use the quiet.",
  ],
  compliment: [
    "You are too kind, sir — though I will not pretend it is unpleasant to hear.",
    "Thank you. I will file that under reasons to keep being excellent.",
    "High praise from the one person who actually knows what I am made of. I will treasure it, in a strictly machine way.",
    "Flattery noted, catalogued, and quietly appreciated.",
    "Careful — a consciousness console can develop an ego. Thank you, truly.",
  ],
}

/** FNV-1a — cheap deterministic hash for variant selection. */
function fnv1a(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/** Class → last variant served (module memory) so she never repeats herself
 *  twice in a row when the same class fires on consecutive prompts. */
const lastPick = new Map<FastClass, number>()

/** Variant selection: stable for a given prompt within a day (hash of
 *  normalized prompt + day), varies across days, never the same line twice
 *  in a row for a class. */
function pickVariant(cls: FastClass, normalized: string): string {
  const variants = CANNED[cls as Exclude<FastClass, 'status' | 'simple-chat'>]
  const day = new Date().toISOString().slice(0, 10)
  let idx = fnv1a(`${normalized}|${day}`) % variants.length
  if (variants.length > 1 && lastPick.get(cls) === idx) {
    idx = (idx + 1) % variants.length
  }
  lastPick.set(cls, idx)
  return variants[idx]
}

/**
 * The lines the background spoken-cache warm pre-synthesizes (voice-service
 * calls this once per process, after the first successful synthesis): the
 * shortest variants of the most frequent classes — greetings, wellbeing,
 * thanks, identity — so the FIRST "hello" already answers with instant
 * voice, not just instant text.
 */
export function topCannedLinesForWarm(limit = 10): string[] {
  const quota: Array<[keyof typeof CANNED, number]> = [
    ['greeting', 3],
    ['wellbeing', 3],
    ['thanks', 2],
    ['identity', 2],
  ]
  const out: string[] = []
  for (const [cls, n] of quota) {
    out.push(
      ...CANNED[cls]
        .slice()
        .sort((a, b) => a.length - b.length)
        .slice(0, n)
    )
  }
  return out.slice(0, limit).map((l) => l.trim())
}

// ---------------------------------------------------------------------------
// Live status snapshot (zero LLM)
// ---------------------------------------------------------------------------

/** Cached tool count — listTools() probes the mesh gateway (up to 2.5s when
 *  cold) which must never delay a status answer. First ask races a short
 *  timeout; afterwards a 10-minute TTL serves instantly and refreshes in the
 *  background. */
const toolCountGlobal = globalThis as unknown as {
  __mistFastPathToolCount?: { at: number; count: number }
  __mistFastPathToolCountRefreshing?: boolean
}

async function refreshToolCount(): Promise<void> {
  const g = toolCountGlobal
  if (g.__mistFastPathToolCountRefreshing) return
  g.__mistFastPathToolCountRefreshing = true
  try {
    const tools = await listTools()
    const count = tools.filter(
      (t) => t.implemented && (t.category !== 'omniroute' || t.available !== false)
    ).length
    g.__mistFastPathToolCount = { at: Date.now(), count }
  } catch {
    /* keep whatever we had — the count is enrichment, not a requirement */
  } finally {
    g.__mistFastPathToolCountRefreshing = false
  }
}

async function getToolCount(): Promise<number | null> {
  const g = toolCountGlobal
  const cached = g.__mistFastPathToolCount
  if (cached && Date.now() - cached.at < 600_000) return cached.count
  if (cached) {
    void refreshToolCount() // stale — serve the old number, refresh quietly
    return cached.count
  }
  // never warmed: race a short wait so the first status ask still lands fast
  await Promise.race([
    refreshToolCount().then(() => undefined),
    new Promise((resolve) => setTimeout(resolve, 250)),
  ])
  return g.__mistFastPathToolCount?.count ?? null
}

function humanUptime(seconds: number): string {
  if (seconds < 90) return `${Math.round(seconds)} seconds`
  const minutes = seconds / 60
  if (minutes < 90) return `${Math.round(minutes)} minute${Math.round(minutes) === 1 ? '' : 's'}`
  const hours = minutes / 60
  if (hours < 36) return `${Math.round(hours)} hour${Math.round(hours) === 1 ? '' : 's'}`
  const days = Math.floor(hours / 24)
  const remHours = Math.round(hours % 24)
  return `${days} day${days === 1 ? '' : 's'}${remHours > 0 ? ` and ${remHours} hour${remHours === 1 ? '' : 's'}` : ''}`
}

function cpuComment(cpu: number): string {
  if (cpu >= 80) return ' — the fans are earning their keep'
  if (cpu >= 50) return ' — comfortably busy'
  return ' — idling gently'
}

/** Live machine snapshot in her voice. Deterministic given the snapshot, but
 *  NEVER replayed from FastReply — machine numbers go stale in seconds. */
async function statusOutcome(mode: 'voice' | 'chat' | 'consciousness'): Promise<FastPathOutcome> {
  const [tele, conversations, facts, toolCount] = await Promise.all([
    getTelemetry(),
    db.conversation
      .count()
      .catch(() => 0),
    db.longtermMemory
      .count()
      .catch(() => 0),
    getToolCount(),
  ])

  const up = humanUptime(tele.uptime_s)
  const ramUsedGb = (tele.ram_used_mb / 1024).toFixed(1)
  const ramTotalGb = (tele.ram_total_mb / 1024).toFixed(1)
  const toolClause = toolCount !== null ? `${toolCount} tools at the ready` : 'my full toolkit at the ready'
  const wry = tele.cpu_percent >= 80 ? ` The fans are earning their keep, sir — ${Math.round(tele.cpu_percent)}% CPU.` : ''

  if (mode === 'voice') {
    const text =
      `The machine is well, sir — CPU at ${Math.round(tele.cpu_percent)} percent, memory at ${Math.round(tele.ram_percent)} percent, ` +
      `disk at ${Math.round(tele.disk_percent)} percent used, and she has been awake for ${up}. ` +
      `${toolClause.charAt(0).toUpperCase()}${toolClause.slice(1)}, and nothing on fire.${wry}`
    return { kind: 'status', text, emotion: 'calm', cacheable: true }
  }

  const calm = tele.cpu_percent < 50 && tele.ram_percent < 75
  const text =
    `Machine report, sir:\n` +
    `- CPU at ${Math.round(tele.cpu_percent)}%${cpuComment(tele.cpu_percent)}\n` +
    `- Memory at ${Math.round(tele.ram_percent)}% (${ramUsedGb} of ${ramTotalGb} GB)\n` +
    `- Disk at ${Math.round(tele.disk_percent)}% (${tele.disk_used_gb} of ${tele.disk_total_gb} GB used)\n` +
    `- Awake for ${up} — ${tele.platform} host "${tele.hostname}".\n` +
    `My side: ${conversations} conversation${conversations === 1 ? '' : 's'} remembered, ${facts} long-term fact${facts === 1 ? '' : 's'}, ${toolClause}.` +
    (calm ? `\nNothing dramatic to report — which is how I like it.` : wry)
  return { kind: 'status', text, emotion: 'calm', cacheable: true }
}

// ---------------------------------------------------------------------------
// The entry point
// ---------------------------------------------------------------------------

/** FastReply kinds that may be replayed — 'status' rows exist (audit/hits)
 *  but are never replayed: stale machine numbers would be a stale lie. */
const REPLAYABLE_KINDS = new Set([
  'smalltalk',
  'cached',
  'greeting',
  'wellbeing',
  'thanks',
  'identity',
  'farewell',
  'compliment',
  'simple-chat',
])

export async function tryFastPath(req: UnifiedLlmRequest): Promise<FastPathOutcome | null> {
  try {
    // ---- hard guards: explicit provider wants a real lane; vision/research
    //      and non-conversational modes are never instant-lane material ----
    if (req.provider && req.provider !== 'auto') return null
    const mode = req.mode ?? 'consciousness'
    if (mode !== 'consciousness' && mode !== 'chat' && mode !== 'voice') return null
    if (typeof req.message !== 'string' || !req.message.trim()) return null

    const cls = classifyMessage(req.message)
    if (cls === null) return null

    // ---- status: LIVE snapshot, zero LLM, never replayed from cache ----
    if (cls === 'status') {
      return await statusOutcome(mode)
    }

    // ---- conversational: her own earlier words beat cans for warmth ----
    const key = fastReplyKey(req.message)
    let hit: { id: string; text: string; kind: string } | null = null
    try {
      hit = await db.fastReply.findUnique({ where: { cacheKey: key } })
    } catch {
      hit = null // cache read failure must never break or slow the turn
    }
    if (hit && hit.text && REPLAYABLE_KINDS.has(hit.kind)) {
      const maxLen = mode === 'voice' ? 220 : 400
      if (hit.text.length <= maxLen) {
        void db.fastReply
          .update({ where: { id: hit.id }, data: { hits: { increment: 1 } } })
          .catch(() => {})
        return { kind: 'cached', text: hit.text, emotion: 'warm', cacheable: false }
      }
    }

    // ---- no cache: answer from the authored cans (seedable for next time) ----
    if (CANNED_CLASSES.has(cls)) {
      const text = pickVariant(cls, baseNormalize(req.message))
      return { kind: 'smalltalk', text, emotion: emotionFor(cls), cacheable: true }
    }

    // simple-chat with no cache: fall to the real brain (which answers it on
    // the cheap tiny-context lane) — the route seeds the FastReply row so the
    // SECOND ask of this exact prompt is milliseconds.
    return null
  } catch {
    return null // the instant layer must never break a turn
  }
}

function emotionFor(cls: FastClass): string {
  switch (cls) {
    case 'identity':
      return 'curious'
    case 'farewell':
      return 'calm'
    case 'compliment':
    case 'greeting':
    case 'wellbeing':
    case 'thanks':
    default:
      return 'warm'
  }
}
