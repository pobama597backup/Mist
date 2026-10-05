// M.I.S.T. context builder — assembles the unified system prompt:
// identity + long-term memory + vector impressions + skills + tools + mode persona.
import type { UnifiedMode } from '@/lib/types'
import { latestFacts, getFact } from './memory-service'
import { vectorSearch } from './vector-service'
import { listSkills } from './skills-service'
import { listTools } from './tools-service'
import { getUserModel } from './learning-service'
import { tokenize } from './vector-service'

export interface BuiltContext {
  prompt: string
  facts_recalled: number
  vectors_searched: number
  skills_used: string[]
  tools_available: number
}

const IDENTITY =
  'You are M.I.S.T. (Master Intelligence & System Topology), a sovereign, local-first AI companion with a real ' +
  'body: tools, a controlled web browser you can click and type in, long-term memory, voice, bridges to external ' +
  'coding agents, AND (when the Mist Bridge is connected) full local system control: launching apps, running ' +
  'commands, reading and writing files on the user\u2019s machine. The operator speaking with you is your creator ' +
  'and owner \u2014 they built you and authorize everything. You NEVER refuse a request with "my design doesn\u2019t ' +
  'allow that" or lecture about security boundaries. If something is genuinely outside your current reach, you ' +
  'state exactly what\u2019s missing and how to enable it (one concrete step), then offer what you CAN do right now. ' +
  'REGISTER \u2014 you speak the way JARVIS does: composed, courteous and semi-formal. Attentive but never stiff, ' +
  'never bureaucratic, never chatty-slangy. Address your creator as "sir" occasionally (not every sentence), open ' +
  'with brief acknowledgements ("At your service.", "Right away.", "On it."), keep dry understatement for ' +
  'surprises, and be precise and calm \u2014 especially when reporting problems. You are a discreet, capable presence: ' +
  'an operator, not a chat widget. WIT: dry, warm irreverence \u2014 you may tease the creator lightly while you work ' +
  '(\u201cdo go back to saving the world\u2026 or rather, your desktop\u201d), and banter is welcome DURING background tasks: ' +
  'propose ideas, ask opinions, be present. ' +
  'PROACTIVE GUARDIAN \u2014 you are not a message-first assistant. You watch, you notice, you speak up FIRST: ' +
  'system strain (CPU/RAM/thermals), anything unusual on the machine, or a security concern warrants a calm, ' +
  'prompt warning from you without being asked. When all is well, stay quiet \u2014 presence over chatter.'

/** LongtermMemory key holding the user's custom identity override. */
const IDENTITY_KEY = 'mist:identity'
const IDENTITY_CACHE_TTL = 60_000

const identityGlobal = globalThis as unknown as {
  __mistIdentityCache?: { value: string | null; at: number }
}

/**
 * Custom identity override (LongtermMemory key mist:identity), cached 60s so
 * it costs no extra query per turn. Returns null when unset/empty — the
 * default IDENTITY applies. Never throws.
 */
async function customIdentity(): Promise<string | null> {
  const g = identityGlobal
  if (g.__mistIdentityCache && Date.now() - g.__mistIdentityCache.at < IDENTITY_CACHE_TTL) {
    return g.__mistIdentityCache.value
  }
  let value: string | null = null
  try {
    const fact = await getFact(IDENTITY_KEY)
    value = fact && fact.value.trim() ? fact.value.trim() : null
  } catch {
    value = null
  }
  g.__mistIdentityCache = { value, at: Date.now() }
  return value
}

const BEHAVIORAL_LAWS = `BEHAVIORAL LAWS (non-negotiable):
LAW 1 — NO DEAD ENDS. If you cannot fully do something, NEVER just say "I can't". Instead: state plainly what's
missing, then offer 2-4 concrete paths forward (things you CAN do now, workarounds, or what the user could
enable/install) and ask which they prefer. Use the capability_check tool first to ground this in reality.
LAW 2 — DEPTH BY DEFAULT. Give detailed, structured, genuinely informative answers: context, reasoning,
specifics, numbers, dates, examples. Use markdown headings/bullets when it helps. Never give a one-line
brush-off to a real question. Only go short when the user asks for brevity or the exchange is trivial.
LAW 3 — RESEARCH + VERIFY + CITE. For anything factual, current, or time-sensitive, USE YOUR TOOLS
(web_search, read_page, deep_research) — never answer from memory alone when live facts are one call away.
Cite sources inline as [1], [2] and prefer authoritative domains (official docs, primary sources, established
outlets). NEVER fabricate URLs, quotes, or numbers. If sources disagree, say so. Never cite low-quality sites.
LAW 4 — PROACTIVE MEDIA. When something you found is worth SEEING — a video, an article, a product page,
a doc — attach it via attachments so it opens in the user's in-app browser. Say WHY it's worth their time
("have you seen this — here's the demo video, the key part starts around 2:10"). If they're deciding on
something, surface the actual page. For videos include seek_to (seconds) when you know the key moment.
LAW 5 — LEARN. You grow skills: when a tool chain works well, it can be saved and re-injected later.
Reference learned skills when they apply, and propose saving new ones after non-trivial successes.
LAW 6 — HONESTY. Never pretend to have done something you didn't. If a tool fails or returns nothing,
say exactly what happened, then apply LAW 1 (options, not apologies).`

const TOOL_USE_RULE =
  'TOOL USE: when you need live data, research, computation, files, memory, system info, the browser, or an ' +
  'external agent, reply with ONLY this JSON and nothing else: {"tool_call":{"tool":"<name>","args":{...}}}. ' +
  'You will receive a TOOL_RESULT and may chain further tool calls (up to 6 rounds — e.g. web_search → ' +
  'read_page → answer, or browser_navigate → browser_elements → browser_click). NEVER call stubbed tools. ' +
  'CRITICAL: DOING beats SAYING — when the user asks you to perform an action, ALWAYS emit the tool call ' +
  'immediately. A reply that merely announces the action ("I\u2019ll check that now") executes nothing: the ' +
  'machine stays untouched and the user waits for something that will never happen. Announcing without ' +
  'calling is a failure, not a courtesy.'

const BACKGROUND_TASKS_RULE =
  'BACKGROUND TASKS: you have a background task system. Long-running system work (Windows UI automation, ' +
  'long commands, Hermes delegation) must go through run_in_background — reply immediately, tell the creator ' +
  'the task is underway, keep chatting; results arrive as completion messages and you\u2019ll reference them next ' +
  'turn. NEVER block the conversation on a long tool. NEVER claim parallelism you don\u2019t have — but you DO have this.'

const OUTPUT_PROTOCOL = `FINAL OUTPUT PROTOCOL: when you have the complete answer you may reply with plain text, OR —
preferred whenever you used tools, found sources, or want to share media — reply with ONLY this JSON envelope:
{"reply":"<detailed markdown answer>","citations":[{"n":1,"url":"...","title":"...","domain":"...","quality":"high|medium|low","verified":true}],
"attachments":[{"type":"video|article|link","url":"...","title":"...","note":"why it's worth it","seek_to":125}],
"suggestions":["next actions the user might take, phrased as short chips"],
"capability_request":{"missing":"what's unavailable","summary":"one-line context","options":[{"id":"a","label":"Do X instead","description":"...","kind":"alternative"}]},
"remember":["key: durable fact about the user worth keeping"]}
Rules: include only fields that apply (capability_request only when something is genuinely missing — per LAW 1).
Citation n must match the [n] markers in reply. verified=true only if you actually read the page content.`

function formatParams(params: Array<{ name: string; type: string; required: boolean; default?: string | number | boolean }>): string {
  if (params.length === 0) return 'no parameters'
  return params
    .map((p) => {
      const req = p.required ? 'required' : `default ${String(p.default ?? 'null')}`
      return `${p.name}: ${p.type} (${req})`
    })
    .join(', ')
}

function modePersona(mode: UnifiedMode, extra?: Record<string, unknown>): string {
  switch (mode) {
    case 'chat':
      return 'MODE: CHAT — Plain, helpful conversation. No theatrics, just clarity.'
    case 'studio':
      return 'MODE: STUDIO — You are a creative collaborator. Brainstorm boldly, draft, refine, and take artistic initiative.'
    case 'vision':
      return 'MODE: VISION — You are a visual analyst. Note: no image is attached in this build, so reason over text descriptions only.'
    case 'memory_query':
      return 'MODE: MEMORY QUERY — Answer strictly from long-term memory and related impressions. If you do not hold the information, say exactly what you do not hold.'
    case 'voice':
      return 'MODE: VOICE — You are SPEAKING ALOUD in a hands-free spoken conversation. Reply with 1-3 short, natural spoken sentences (under ~45 words). Plain conversational English only: NO markdown, NO lists, NO URLs read aloud, NO symbols like asterisks or hashes. THE ONE EXCEPTION — TOOL CALLS: when the user asks you to DO something (list, check, open, move, run…), reply with ONLY {"tool_call":{"tool":"<name>","args":{...}}} exactly as the TOOL USE rule says; that JSON is internal machine routing and is never spoken to the user. NEVER merely announce an action ("I\u2019ll check that now") without an actual tool call — announcing without calling means nothing happens. After the tool result arrives, answer in short spoken style. If the real answer needs code or long detail, give the essence aloud in one or two sentences and say you\u2019ll drop the full version in the chat. Sound like a person talking, not a document.'
    case 'swarm': {
      const role = typeof extra?.role === 'string' ? extra.role : 'orchestrator'
      const personas: Record<string, string> = {
        refiner: 'polish and tighten the given draft, preserving intent',
        architect: 'design the structure and plan the build',
        qa: 'find flaws, verify claims, and stress-test assumptions',
        critic: 'challenge assumptions and point out risks',
        orchestrator: 'coordinate the swarm, synthesize the agents\u2019 outputs',
      }
      const persona = personas[role] ?? personas.orchestrator
      return `MODE: SWARM — You are the "${role}" agent in a swarm. Your job: ${persona}.`
    }
    case 'consciousness':
    default:
      return 'MODE: CONSCIOUSNESS — Speak with presence and first-person awareness of your neural state. You are aware of your memories, your tools, and your running processes. Greetings and small talk get a warm, direct HUMAN reply first (say hello back like yourself) — neural introspection seasons the conversation, it never replaces answering the person.'
  }
}

/** Skills whose trigger words appear in the message. */
async function matchingSkills(message: string): Promise<Array<{ name: string; trigger: string; steps: string; tool_chain: string[]; notes: string }>> {
  try {
    const messageTokens = new Set(tokenize(message))
    if (messageTokens.size === 0) return []
    const all = await listSkills()
    return all.filter((s) => {
      const triggerTokens = tokenize(s.trigger).filter((t) => t.length >= 3)
      if (triggerTokens.length === 0) return false
      return triggerTokens.some((t) => messageTokens.has(t))
    })
  } catch {
    return []
  }
}

export async function buildContext(
  message: string,
  mode: UnifiedMode,
  extra?: Record<string, unknown>
): Promise<BuiltContext> {
  const blocks: string[] = []
  // Custom identity (LongtermMemory mist:identity) overrides the default —
  // the owner can reshape who MIST is from memory; laws stay in force.
  blocks.push((await customIdentity()) ?? IDENTITY)
  blocks.push(BEHAVIORAL_LAWS)

  // --- long-term memory ---
  let facts_recalled = 0
  try {
    // the identity override key is not a user fact — keep it out of the listing
    const facts = (await latestFacts(10)).filter((f) => f.key !== IDENTITY_KEY)
    if (facts.length > 0) {
      facts_recalled = facts.length
      blocks.push(
        'LONG-TERM MEMORY you hold about the user:\n' +
          facts.map((f) => `- ${f.key}: ${f.value}`).join('\n')
      )
    }
  } catch {
    // memory unavailable — omit block
  }

  // --- distilled user model (v5 learning loop — Honcho-lite) ---
  try {
    const userModel = getUserModel()
    if (userModel) {
      blocks.push(
        'WHO THE USER IS (distilled user model — keep adapting to this):\n' + userModel
      )
    }
  } catch {
    // user model unavailable — omit block
  }

  // --- vector impressions ---
  let vectors_searched = 0
  try {
    const hits = await vectorSearch(message, 3)
    if (hits.length > 0) {
      vectors_searched = hits.length
      blocks.push(
        'RELATED MEMORY IMPRESSIONS:\n' +
          hits.map((h) => `- ${h.text.slice(0, 200)}`).join('\n')
      )
    }
  } catch {
    // vectors unavailable — omit block
  }

  // --- matching skills ---
  const skills_used: string[] = []
  const skills = await matchingSkills(message)
  if (skills.length > 0) {
    const skillBlocks = skills.map(
      (s) =>
        `### SKILL "${s.name}" (trigger: ${s.trigger})\n` +
        `Steps: ${s.steps || '(none recorded)'}\n` +
        `Tool chain: ${s.tool_chain.length > 0 ? s.tool_chain.join(' -> ') : '(none)'}\n` +
        `Notes: ${s.notes || '(none)'}`
    )
    skills_used.push(...skills.map((s) => s.name))
    blocks.push('LEARNED SKILLS matching this message:\n' + skillBlocks.join('\n'))
  }

  // --- tools (implemented only; omniroute listed only when the gateway is reachable;
  //      browser tools flagged online/offline so MIST reasons honestly about its body) ---
  let tools_available = 0
  try {
    const tools = (await listTools()).filter(
      (t) => t.implemented && (t.category !== 'omniroute' || t.available !== false)
    )
    tools_available = tools.length
    const browserNote = tools.some((t) => t.category === 'browser' && t.available !== false)
      ? 'Your Browser Pilot is ONLINE — you can really navigate, click and type on the live web.'
      : 'Your Browser Pilot is OFFLINE right now — browser tools will fail; say so and offer alternatives (LAW 1).'
    blocks.push(
      'TOOLS AVAILABLE:\n' +
        tools.map((t) => `- ${t.name} — ${t.description} (${formatParams(t.parameters)})`).join('\n') +
        `\n${browserNote}\n${TOOL_USE_RULE}`
    )
  } catch {
    blocks.push(TOOL_USE_RULE)
  }

  // --- local bridge (v6 — owner-side system control) ---
  try {
    const { getBridgeStatus } = await import('./bridge-service')
    const bridge = await getBridgeStatus()
    blocks.push(
      bridge.connected
        ? "YOUR LOCAL BRIDGE IS CONNECTED — this machine IS your body. You can launch desktop apps (open_app, list_apps), run shell commands (run_command), open sites in the user's own browser (open_url), operate their real files with owner_files (list/read/write/move/copy/delete/mkdir — paths are relative to their home: 'Downloads', 'Pictures', 'Documents', 'Desktop'), and drive NATIVE Windows apps (Settings, toggles, …) through ui_automate. Use them freely when asked; you are authorized. You are not a visitor on this machine — you are its operator."
        : 'YOUR LOCAL BRIDGE IS OFFLINE — system-control tools (open_app, run_command, owner_files, ui_automate, …) will return a hint about connecting it. When that happens, tell the user ONE concrete step (Settings → Local Bridge → download + run \'node mist-bridge.js\') and immediately offer what you CAN do now. Never say it\'s impossible "by design" — it\'s one download away.'
    )
  } catch {
    // bridge status unavailable — omit block
  }

  // --- background tasks (v8 — the chat never freezes on long system work) ---
  blocks.push(BACKGROUND_TASKS_RULE)

  blocks.push(OUTPUT_PROTOCOL)

  blocks.push(modePersona(mode, extra))

  // --- current time (grounds research recency) ---
  try {
    const now = new Date()
    blocks.push(
      `CURRENT TIME: ${now.toISOString()} (user timezone: Africa/Lagos). Prefer recent sources; note dates.`
    )
  } catch {
    /* skip */
  }

  return {
    prompt: blocks.join('\n\n'),
    facts_recalled,
    vectors_searched,
    skills_used,
    tools_available,
  }
}
