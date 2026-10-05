// M.I.S.T. shared UI constants — design tokens as data
import type { ConsciousnessState, ProviderId } from './types'

export const PROVIDER_LABELS: Record<ProviderId, string> = {
  auto: 'Auto',
  omniroute: 'OmniRoute',
  hermes: 'Hermes / Nous',
  theoldapi: 'TheOldAPI',
  openai_compatible: 'OpenAI-compatible',
  nvidia: 'NVIDIA NIM',
  openrouter: 'OpenRouter',
  groq: 'Groq',
  github_models: 'GitHub Models',
  cerebras: 'Cerebras',
  together: 'Together AI',
  mistral: 'Mistral',
  huggingface: 'HuggingFace',
  anthropic: 'Anthropic',
  gemini: 'Gemini',
  kilo: 'Kilo Code',
  pollinations: 'Pollinations',
  llm7: 'LLM7.io',
  ovh: 'OVHcloud AI',
  qwen: 'Qwen',
  core: 'Mist Core',
  'offline-mind': 'Offline Mind',
  'mist-instant': 'Instant Recall',
}

export const STATE_COLORS: Record<ConsciousnessState, string> = {
  dormant: '#94a3b8', // slate-400
  awakening: '#fcd34d', // amber-300
  listening: '#34d399', // emerald-400
  processing: '#c084fc', // purple-400
  speaking: '#5eead4', // teal-300
  dreaming: '#e879f9', // fuchsia-400
}

export const STATE_LABELS: Record<ConsciousnessState, string> = {
  dormant: 'Dormant',
  awakening: 'Awakening',
  listening: 'Listening',
  processing: 'Processing',
  speaking: 'Speaking',
  dreaming: 'Dreaming',
}

export const NEURAL_SERVICE_PORT = 3003

export const TTS_VOICES = [
  { id: 'tongtong', label: 'Tongtong · warm' },
  { id: 'chuichui', label: 'Chuichui · playful' },
  { id: 'xiaochen', label: 'Xiaochen · steady' },
  { id: 'jam', label: 'Jam · english' },
  { id: 'kazi', label: 'Kazi · clear' },
  { id: 'douji', label: 'Douji · natural' },
  { id: 'luodo', label: 'Luodo · expressive' },
]

/** Cloud TTS engine options — 'glm' (rich cloud voices) plus the two NO-AUTH
 *  English engines (2026-09-28 creator request: "add an option for no auth
 *  voices too because glm is failing us"). GLM utterances that degrade are
 *  auto-rescued on the keyless Edge engine server-side — babble is gone.
 *  'gemini' (Mark-LV wave-2): 10 REAL distinct Google prebuilt voices driven
 *  browser-direct with the creator's own key — this instance's server egress
 *  is region-blocked by Google, the user's browser is not, so the client
 *  calls Google itself and falls back to the server chain when blocked. */
export const TTS_ENGINES = [
  { id: 'glm', label: 'GLM cloud · 7 voices (auto-rescued on Edge when it babbles)' },
  { id: 'edge', label: 'Edge neural · 18 English voices · no auth, no key' },
  { id: 'gtranslate', label: 'Google rescue · 1 English voice · no auth, bulletproof' },
  { id: 'gemini', label: 'Gemini direct · 10 real voices · your Google key, straight from this browser' },
] as const

/** Gemini prebuilt TTS voices (Mark-LV wave-2). SINGLE SOURCE OF TRUTH:
 *  google-direct.ts imports this list for validation/synthesis — keep the
 *  data here so server-safe consumers never import a browser module.
 *  Charon is Mark-LV's default voice. */
export const GEMINI_DIRECT_VOICES = [
  { id: 'Charon', label: 'Charon · informative · default' },
  { id: 'Puck', label: 'Puck · upbeat' },
  { id: 'Kore', label: 'Kore · firm' },
  { id: 'Fenrir', label: 'Fenrir · excitable' },
  { id: 'Aoede', label: 'Aoede · breezy' },
  { id: 'Zephyr', label: 'Zephyr · bright' },
  { id: 'Leda', label: 'Leda · youthful' },
  { id: 'Orus', label: 'Orus · firm' },
  { id: 'Sao', label: 'Sao · gravelly' },
  { id: 'Iapetus', label: 'Iapetus · clear' },
]

/** The Edge no-auth English catalog (must mirror EDGE_VOICES in tts-free.ts). */
export const FREE_TTS_VOICES = [
  { id: 'en-US-AriaNeural', label: 'Aria · US female' },
  { id: 'en-US-JennyNeural', label: 'Jenny · US female' },
  { id: 'en-US-MichelleNeural', label: 'Michelle · US female' },
  { id: 'en-US-GuyNeural', label: 'Guy · US male' },
  { id: 'en-US-ChristopherNeural', label: 'Christopher · US male' },
  { id: 'en-US-RogerNeural', label: 'Roger · US male' },
  { id: 'en-GB-SoniaNeural', label: 'Sonia · GB female' },
  { id: 'en-GB-LibbyNeural', label: 'Libby · GB female' },
  { id: 'en-GB-RyanNeural', label: 'Ryan · GB male' },
  { id: 'en-GB-ThomasNeural', label: 'Thomas · GB male' },
  { id: 'en-AU-NatashaNeural', label: 'Natasha · AU female' },
  { id: 'en-AU-WilliamNeural', label: 'William · AU male' },
  { id: 'en-CA-ClaraNeural', label: 'Clara · CA female' },
  { id: 'en-CA-LiamNeural', label: 'Liam · CA male' },
  { id: 'en-IN-NeerjaNeural', label: 'Neerja · IN female' },
  { id: 'en-IN-PrabhatNeural', label: 'Prabhat · IN male' },
  { id: 'en-ZA-LeahNeural', label: 'Leah · ZA female' },
  { id: 'en-ZA-LukeNeural', label: 'Luke · ZA male' },
]
