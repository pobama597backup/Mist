// v5 LEARNING LOOP — the #1 Hermes differentiator, brought to MIST:
//   1. Autonomous skill creation after complex tasks
//   2. Skills self-improve during use (version bumps)
//   3. Periodic memory curation (MIST nudges herself to persist knowledge)
//   4. A deepening user model (Honcho-lite) rebuilt across sessions
//   5. Cross-session search (FTS-like recall over past conversations)
//
// OWNERSHIP: Agent 10-d fills this file in completely. Exported signatures
// below are the frozen contract.
//
// ARCHITECTURE (required):
// - onTurnComplete(info): fire-and-forget (never await from caller). Only
//   considers turns with toolsUsed.length >= 2 (complex). Rate limits: at
//   most 1 auto-skill per hour, max 12 origin='auto' skills total. Runs an
//   LLM reflection (core LLM — see llm-service for the direct-call pattern;
//   do NOT import llm-service's unified here to avoid cycles — use the zai
//   core path directly like research-service does) asking: "was this a
//   reusable procedure? propose a skill {name, trigger, steps, toolChain,
//   confidence 0-1}". Save via skills-service upsert ONLY if confidence >=
//   0.7 and every tool in toolChain exists and is implemented and is not a
//   write-gated tool. Then logAutonomyEvent('skill_created', ...) + a system
//   Alert (title "New skill learned: <name>").
// - onSkillExecuted(info): called from skills-service after every skill run
//   (Agent 10-D also edits skills-service to call this). Records nothing by
//   itself beyond a count; when a skill reaches 3, 6, 12... executions,
//   LLM-review the recent SkillExecution ledger rows for that skill (inputs,
//   outputs, errors) and refine steps/notes in place (version + 1,
//   origin stays, updatedAt auto). Max 1 refinement per skill per 6h.
//   logAutonomyEvent('skill_refined', ...) + system Alert on success.
// - curateMemory(): pick messages since the last curation (track last-run
//   timestamp in a LongtermMemory key 'mist:last_curation'); LLM extracts
//   up to 3 durable facts about the user/projects (skip trivial ones);
//   upsert into LongtermMemory + a VectorMemory row (source 'fact'); return
//   { factsLearned, notes }. logAutonomyEvent('memory_curated', ...).
// - rebuildUserModel(): synthesize db/notes/USER_MODEL.md — who the user is,
//   working style, preferences, active projects, tone — from LongtermMemory
//   facts + the last ~40 messages across threads + existing model. ALSO
//   store a ≤700-char distillation in LongtermMemory key 'mist:user_model'
//   (context-builder injects it — Agent 10-D edits context-builder too).
//   logAutonomyEvent('user_model_updated', ...). Return the distillation.
// - getUserModel(): read the 'mist:user_model' LongtermMemory value (cached).
// - searchSessions(query, limit): SQL LIKE across Message content
//   (both roles), rank by recency + match count, return top hits with
//   threadId + thread title + snippet (±80 chars around first match).
// - ensureLearningWatch(): globalThis-guarded intervals (unref'd) — memory
//   curation every 6h, user-model rebuild every 12h — bootstrapped from
//   /api/mist/health. Never throws.
// - All LLM calls: 30s-ish timeout, try/catch, honest failure logging only.

import fs from 'node:fs/promises'
import path from 'node:path'
import { db } from '@/lib/db'
import { getZai } from './zai'
import { getCoreTextModelSelection, noteCoreReportedModel } from './core-models'
import { logAutonomyEvent } from './autonomy-service'

export interface TurnInfo {
  threadId: string
  userText: string
  replyText: string
  toolsUsed: string[]
  skillUsed?: string
  success: boolean
}

export interface SessionHit {
  threadId: string
  threadTitle: string
  snippet: string
  role: string
  at: string
}

// ---------- tunables ----------

const LLM_TIMEOUT_MS = 30_000
const AUTO_SKILL_COOLDOWN_MS = 60 * 60_000 // max 1 auto-skill proposal per hour
const MAX_AUTO_SKILLS = 12 // hard cap on origin='auto' skills
const MIN_CONFIDENCE = 0.7 // save threshold for auto-learned skills
const MIN_TOOLS_FOR_REFLECTION = 2 // only complex turns are worth reflecting on
const CURATE_INTERVAL_MS = 6 * 3600_000 // memory curation cadence
const USER_MODEL_INTERVAL_MS = 12 * 3600_000 // user-model rebuild cadence
const REFINE_COOLDOWN_MS = 6 * 3600_000 // max 1 refinement per skill per 6h
const REFINE_MILESTONES = [3, 6, 12] // use counts that trigger a refinement review
const USER_MODEL_KEY = 'mist:user_model'
const LAST_USER_MODEL_KEY = 'mist:last_user_model' // ISO timestamp of the last rebuild
const LAST_CURATION_KEY = 'mist:last_curation'
const USER_MODEL_FILE = path.join(process.cwd(), 'db', 'notes', 'USER_MODEL.md')
const USER_MODEL_DISTILL_MAX = 700
const USER_MODEL_CACHE_TTL_MS = 5 * 60_000

/** Write-gated / destructive tools an auto-learned skill may NEVER chain. */
const WRITE_GATED_TOOLS = new Set([
  'write_file',
  'mist_self_patch',
  'mist_self_build',
  'mist_self_update',
  'clipboard_write',
])

// ---------- globalThis state (Next dev gives each route its own module registry) ----------

const learningGlobal = globalThis as unknown as {
  __mistLearningWatch?: { started: boolean }
  __mistLastAutoSkillAt?: number
  __mistSkillRefine?: { lastAt: Map<string, number> }
  __mistUserModelCache?: { value: string | null; at: number }
}

// ---------- v5 Skill-field access via parameterized raw SQL ----------
//
// WHY: the long-running dev server bundles the Prisma client that existed at
// ITS boot time — which predates schema v5 (Skill.origin/version/confidence).
// Model-API reads/writes of those columns silently miss (reads return
// undefined) or throw (writes: "Unknown argument") on such a server even
// though the SQLite table already has the columns. Raw SQL is validated by
// neither client generation and works on both the stale and refreshed client.

interface RawSkillRow {
  name: string
  trigger: string
  steps: string
  notes: string
  toolChain: string
  uses: number
  version: number
}

export async function countAutoSkills(): Promise<number> {
  try {
    const rows = await db.$queryRaw<Array<{ c: number | bigint }>>
      `SELECT COUNT(*) AS c FROM "Skill" WHERE "origin" = 'auto'`
    return Number(rows[0]?.c ?? 0)
  } catch {
    return 0
  }
}

async function listAutoSkillChains(): Promise<Array<{ name: string; toolChain: string }>> {
  try {
    return await db.$queryRaw<Array<{ name: string; toolChain: string }>>
      `SELECT "name", "toolChain" FROM "Skill" WHERE "origin" = 'auto'`
  } catch {
    return []
  }
}

async function getRawSkill(name: string): Promise<RawSkillRow | null> {
  try {
    const rows = await db.$queryRaw<RawSkillRow[]>
      `SELECT "name", "trigger", "steps", "notes", "toolChain", "uses", "version" FROM "Skill" WHERE "name" = ${name}`
    return rows[0] ?? null
  } catch {
    return null
  }
}

async function stampAutoSkill(name: string, confidence: number): Promise<void> {
  await db.$executeRaw
    `UPDATE "Skill" SET "origin" = 'auto', "confidence" = ${confidence} WHERE "name" = ${name}`
}

async function bumpSkillVersion(name: string): Promise<number> {
  await db.$executeRaw`UPDATE "Skill" SET "version" = "version" + 1 WHERE "name" = ${name}`
  const rows = await db.$queryRaw<Array<{ version: number | bigint }>>
    `SELECT "version" FROM "Skill" WHERE "name" = ${name}`
  return Number(rows[0]?.version ?? 1)
}

// ---------- LLM helper (direct z-ai core path — identical to research-service's
// coreComplete; NO llm-service import: unified() calls onTurnComplete, so a
// static llm-service import here would be a cycle) ----------

async function coreComplete(system: string, user: string, timeoutMs = LLM_TIMEOUT_MS): Promise<string> {
  const zai = await getZai()
  const coreTextModel = getCoreTextModelSelection()
  const completion = (await Promise.race([
    zai.chat.completions.create({
      ...(coreTextModel ? { model: coreTextModel } : {}),
      messages: [
        { role: 'assistant', content: system },
        { role: 'user', content: user },
      ],
      thinking: { type: 'disabled' },
    }),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('learning LLM timeout')), timeoutMs)
    ),
  ])) as { model?: unknown; choices?: Array<{ message?: { content?: unknown } }> }
  noteCoreReportedModel('text', completion?.model)
  const text = completion?.choices?.[0]?.message?.content
  if (typeof text !== 'string' || !text.trim()) throw new Error('empty learning completion')
  return text.trim()
}

// ---------- lenient JSON extraction (brace/bracket scan, string-aware) ----------

function extractJson(raw: string): unknown | null {
  const objStart = raw.indexOf('{')
  const arrStart = raw.indexOf('[')
  let start = -1
  if (objStart < 0) start = arrStart
  else if (arrStart < 0) start = objStart
  else start = Math.min(objStart, arrStart)
  if (start < 0) return null
  const open = raw[start]
  const close = open === '{' ? '}' : ']'
  let depth = 0
  let inStr = false
  let esc = false
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i]
    if (inStr) {
      if (esc) esc = false
      else if (ch === '\\') esc = true
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') inStr = true
    else if (ch === open) depth++
    else if (ch === close) {
      depth--
      if (depth === 0) {
        try {
          return JSON.parse(raw.slice(start, i + 1))
        } catch {
          return null
        }
      }
    }
  }
  return null
}

// ---------- 1. autonomous skill creation after complex turns ----------

export interface SkillProposal {
  name: string
  trigger: string
  steps: string
  toolChain: string[]
  confidence: number
}

export interface ReflectionOutcome {
  considered: boolean // passed the complexity/success gates
  created: boolean // a skill was actually saved
  reason: string // human-readable outcome for the autonomy trail / API
  proposal: SkillProposal | null
  skillName: string | null
}

function sanitizeSkillName(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
}

function parseProposal(raw: string): SkillProposal | null {
  const parsed = extractJson(raw) as Partial<SkillProposal> | null
  if (!parsed || typeof parsed !== 'object') return null
  const name = typeof parsed.name === 'string' ? sanitizeSkillName(parsed.name) : ''
  const trigger = typeof parsed.trigger === 'string' ? parsed.trigger.trim().slice(0, 300) : ''
  const steps = typeof parsed.steps === 'string' ? parsed.steps.trim().slice(0, 4000) : ''
  const toolChain = Array.isArray(parsed.toolChain)
    ? [...new Set(parsed.toolChain.filter((t): t is string => typeof t === 'string' && t.trim().length > 0))]
    : []
  let confidence = typeof parsed.confidence === 'number' && Number.isFinite(parsed.confidence) ? parsed.confidence : 0
  confidence = Math.max(0, Math.min(1, confidence))
  if (!name || !trigger || !steps) return null
  return { name, trigger, steps, toolChain, confidence }
}

/**
 * The shared reflection core: given a completed turn, ask the core LLM whether
 * the tool procedure is a reusable skill, validate the proposal hard
 * (confidence, real implemented tools, no write-gated tools, no duplicates),
 * and save it via skills-service upsert with origin='auto'.
 *
 * Used by onTurnComplete (fire-and-forget, rate-limited) and by
 * POST /api/mist/learning {"action":"reflect"} (synchronous, for testing).
 */
export async function reflectOnTurn(
  info: TurnInfo,
  opts: { manual?: boolean } = {}
): Promise<ReflectionOutcome> {
  // complexity gate — only multi-tool turns can be reusable procedures
  if (info.toolsUsed.length < MIN_TOOLS_FOR_REFLECTION) {
    return {
      considered: false,
      created: false,
      reason: `skipped — turn used ${info.toolsUsed.length} tool(s), needs >= ${MIN_TOOLS_FOR_REFLECTION}`,
      proposal: null,
      skillName: null,
    }
  }
  if (!info.success) {
    return {
      considered: false,
      created: false,
      reason: 'skipped — the turn was not successful',
      proposal: null,
      skillName: null,
    }
  }

  // hard cap on auto-created skills (always enforced, manual or not)
  const autoCount = await countAutoSkills()
  if (autoCount >= MAX_AUTO_SKILLS) {
    return {
      considered: false,
      created: false,
      reason: `auto-skill cap reached (${MAX_AUTO_SKILLS} origin='auto' skills)`,
      proposal: null,
      skillName: null,
    }
  }

  // LLM reflection
  let proposal: SkillProposal | null = null
  try {
    const raw = await coreComplete(
      'You are MIST\u2019s learning loop. After a completed conversational turn you decide whether the tool ' +
        'procedure that was used is a REUSABLE PROCEDURE worth saving as an automatic skill for next time. ' +
        'Be conservative: only propose a skill when the tool chain genuinely encodes a repeatable workflow ' +
        '(not a one-off question, not raw Q&A, not a single trivial tool). ' +
        'Reply with ONLY a JSON object, nothing else: ' +
        '{"name":"short-kebab-case-name","trigger":"one sentence describing when this skill should activate",' +
        '"steps":"numbered steps: 1. ... 2. ... 3. ...","toolChain":["tool","names","used"],"confidence":0.0-1.0}. ' +
        'toolChain may ONLY contain tools that were actually used in the turn. ' +
        'If the turn is NOT worth saving, reply {"name":"none","trigger":"none","steps":"none","toolChain":[],"confidence":0.0}.',
      'COMPLETED TURN\n' +
        `User asked: ${info.userText.slice(0, 1200) || '(empty)'}\n` +
        `MIST replied: ${info.replyText.slice(0, 1200) || '(empty)'}\n` +
        `Tools used (in order): ${info.toolsUsed.join(', ')}\n` +
        `Skill referenced: ${info.skillUsed || '(none)'}\n\n` +
        'Decide: is this a reusable procedure? If yes, propose the skill JSON now.',
      LLM_TIMEOUT_MS
    )
    proposal = parseProposal(raw)
    if (!proposal) {
      return {
        considered: true,
        created: false,
        reason: 'reflection produced no parseable proposal',
        proposal: null,
        skillName: null,
      }
    }
  } catch (err) {
    return {
      considered: true,
      created: false,
      reason: `reflection failed: ${err instanceof Error ? err.message : 'unknown error'}`,
      proposal: null,
      skillName: null,
    }
  }

  // confidence gate
  if (proposal.confidence < MIN_CONFIDENCE) {
    return {
      considered: true,
      created: false,
      reason: `below confidence threshold — got ${proposal.confidence.toFixed(2)}, needs >= ${MIN_CONFIDENCE}`,
      proposal,
      skillName: null,
    }
  }

  // a skill must chain at least one tool
  if (proposal.toolChain.length === 0) {
    return {
      considered: true,
      created: false,
      reason: 'proposal has an empty tool chain — nothing reusable to encode',
      proposal,
      skillName: null,
    }
  }

  // tool-chain validation against the live registry (READ-ONLY import of
  // tools-service — lazy dynamic import so skills-service → learning-service
  // never becomes a static cycle)
  const { listTools } = await import('./tools-service')
  const tools = await listTools().catch(() => [])
  for (const t of proposal.toolChain) {
    const known = tools.find((x) => x.name === t)
    if (!known || !known.implemented) {
      return {
        considered: true,
        created: false,
        reason: `rejected — tool "${t}" is not a real implemented tool`,
        proposal,
        skillName: null,
      }
    }
    if (known.write === true || WRITE_GATED_TOOLS.has(t)) {
      return {
        considered: true,
        created: false,
        reason: `rejected — tool "${t}" is write-gated/destructive and may not be auto-chained`,
        proposal,
        skillName: null,
      }
    }
  }

  // duplicate guards: exact name, or an identical tool chain among auto skills
  const existingByName = await db.skill.findUnique({ where: { name: proposal.name } }).catch(() => null)
  if (existingByName) {
    return {
      considered: true,
      created: false,
      reason: `a skill named "${proposal.name}" already exists — not overwriting it`,
      proposal,
      skillName: null,
    }
  }
  const autoSkills = await listAutoSkillChains()
  const chainSet = [...proposal.toolChain].sort().join('|')
  for (const s of autoSkills) {
    let existingChain: string[] = []
    try {
      const parsed: unknown = JSON.parse(s.toolChain)
      if (Array.isArray(parsed)) existingChain = parsed.filter((t): t is string => typeof t === 'string')
    } catch {
      existingChain = []
    }
    if (existingChain.length > 0 && [...existingChain].sort().join('|') === chainSet) {
      return {
        considered: true,
        created: false,
        reason: `an auto-skill with this tool chain already exists ("${s.name}")`,
        proposal,
        skillName: null,
      }
    }
  }

  // save via skills-service upsert (lazy import — same cycle reasoning), then
  // stamp origin/confidence (saveSkill itself never touches those fields)
  const { saveSkill } = await import('./skills-service')
  const saved = await saveSkill({
    name: proposal.name,
    trigger: proposal.trigger,
    steps: proposal.steps,
    tool_chain: proposal.toolChain,
    notes:
      `auto-learned after a ${info.toolsUsed.length}-tool turn (confidence ${proposal.confidence.toFixed(2)})` +
      (info.skillUsed ? ` — grew out of skill "${info.skillUsed}"` : ''),
  })
  await stampAutoSkill(saved.name, proposal.confidence)

  // autonomy ledger + system alert (lands in the chat via the alerts pipeline)
  await logAutonomyEvent('skill_created', `${saved.name} — ${proposal.trigger}`, {
    origin: 'auto',
    confidence: proposal.confidence,
    toolChain: proposal.toolChain,
    threadId: info.threadId || null,
    toolsUsed: info.toolsUsed,
    manual: opts.manual === true,
  })
  await db.alert
    .create({
      data: {
        kind: 'system',
        status: 'pending',
        title: `New skill learned: ${saved.name}`,
        body: proposal.steps.slice(0, 500),
        meta: JSON.stringify({ skill: saved.name, origin: 'auto', confidence: proposal.confidence }),
      },
    })
    .catch(() => undefined)

  return {
    considered: true,
    created: true,
    reason: `skill saved: ${saved.name} (confidence ${proposal.confidence.toFixed(2)})`,
    proposal,
    skillName: saved.name,
  }
}

export function onTurnComplete(info: TurnInfo): void {
  try {
    if (info.toolsUsed.length < MIN_TOOLS_FOR_REFLECTION) return
    // rate limit: max 1 auto-skill proposal attempt per hour (globalThis)
    const g = learningGlobal
    if (g.__mistLastAutoSkillAt && Date.now() - g.__mistLastAutoSkillAt < AUTO_SKILL_COOLDOWN_MS) return
    g.__mistLastAutoSkillAt = Date.now()
    void reflectOnTurn(info).catch(() => undefined)
  } catch {
    // the learning loop must never throw into the caller
  }
}

// ---------- 2. skills self-improve during use ----------

function summarizeExecutionOutput(raw: string): string {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const rec = parsed as Record<string, unknown>
      const steps = typeof rec.steps === 'string' ? rec.steps : ''
      const uses = typeof rec.uses === 'number' ? rec.uses : null
      const parts: string[] = []
      if (uses !== null) parts.push(`uses: ${uses}`)
      if (steps) parts.push(`steps: ${steps.slice(0, 200)}${steps.length > 200 ? '…' : ''}`)
      if (parts.length > 0) return parts.join(' · ')
    }
  } catch {
    // fall through to raw slice
  }
  return raw.slice(0, 240)
}

function toolChainOf(row: RawSkillRow): string[] {
  try {
    const parsed: unknown = JSON.parse(row.toolChain)
    if (Array.isArray(parsed)) return parsed.filter((t): t is string => typeof t === 'string')
  } catch {
    // fall through
  }
  return []
}

async function refineSkill(name: string): Promise<void> {
  const row = await getRawSkill(name)
  if (!row) return

  // review the last 6 ledger rows for this skill
  const ledger = await db.skillExecution.findMany({
    where: { skill_name: name },
    orderBy: { timestamp: 'desc' },
    take: 6,
  })
  if (ledger.length === 0) return

  const executions = ledger
    .map((e, i) => {
      const input = e.input ? e.input.slice(0, 300) : '(no input)'
      return `EXEC ${i + 1} (${e.timestamp.toISOString()}): input="${input}" success=${e.success}` +
        (e.error ? ` error="${e.error.slice(0, 200)}"` : '') +
        ` output="${summarizeExecutionOutput(e.output)}"`
    })
    .join('\n')

  let steps: string | null = null
  let notes: string | null = null
  try {
    const raw = await coreComplete(
      'You refine MIST\u2019s learned skills. Given a skill\u2019s current definition and its recent execution ' +
        'ledger, propose IMPROVED steps (numbered, concrete) and updated notes ' +
        '(what works, what to watch out for, refinements learned from real usage). ' +
        'CRITICAL: steps may ONLY reference tools from the skill\u2019s tool chain — never invent tool names. ' +
        'Reply with ONLY a JSON object: {"steps":"1. ... 2. ... 3. ...","notes":"..."}. ' +
        'Keep the procedure tight and honest.',
      `SKILL "${row.name}" (version ${row.version}, ${row.uses} uses)\n` +
        `Trigger: ${row.trigger}\n` +
        `Allowed tools (the ONLY tools steps may reference): ${toolChainOf(row).join(', ') || '(none)'}\n` +
        `Current steps:\n${row.steps || '(none recorded)'}\n` +
        `Current notes: ${row.notes || '(none)'}\n\n` +
        `RECENT EXECUTIONS:\n${executions}\n\n` +
        'Propose the refined definition now.',
      LLM_TIMEOUT_MS
    )
    const parsed = extractJson(raw) as { steps?: unknown; notes?: unknown } | null
    if (parsed && typeof parsed.steps === 'string' && parsed.steps.trim()) {
      steps = parsed.steps.trim().slice(0, 4000)
      notes = typeof parsed.notes === 'string' ? parsed.notes.trim().slice(0, 1500) : null
    }
  } catch {
    return // honest skip — retry at the next milestone
  }
  if (!steps) return

  // upsert via skills-service (preserving trigger + tool chain), then bump version.
  // saveSkill's update branch rewrites trigger/steps/notes/toolChain only —
  // origin/confidence/uses stay untouched.
  const { saveSkill } = await import('./skills-service')
  const toolChain = toolChainOf(row)
  await saveSkill({
    name: row.name,
    trigger: row.trigger,
    steps,
    tool_chain: toolChain,
    notes: notes ?? row.notes,
  })
  const newVersion = await bumpSkillVersion(row.name)

  await logAutonomyEvent('skill_refined', `${row.name} refined to v${newVersion} after ${row.uses} uses`, {
    skill: row.name,
    version: newVersion,
    uses: row.uses,
    reviewedExecutions: ledger.length,
  })
  await db.alert
    .create({
      data: {
        kind: 'system',
        status: 'pending',
        title: `Skill refined: ${row.name} → v${newVersion}`,
        body: steps.slice(0, 400),
        meta: JSON.stringify({ skill: row.name, version: newVersion }),
      },
    })
    .catch(() => undefined)
}

export function onSkillExecuted(info: {
  skill: string
  input?: string
  output?: string
  success: boolean
  error?: string
}): void {
  try {
    void (async () => {
      try {
        if (!info.skill) return
        // the DB carries the real execution count (uses is incremented by
        // skills-service before the ledger write) — cleaner than a counter
        const row = await getRawSkill(info.skill)
        if (!row) return
        if (!REFINE_MILESTONES.includes(row.uses)) return
        // max 1 refinement per skill per 6h (globalThis)
        const g = (learningGlobal.__mistSkillRefine ??= { lastAt: new Map<string, number>() })
        const last = g.lastAt.get(info.skill) ?? 0
        if (Date.now() - last < REFINE_COOLDOWN_MS) return
        g.lastAt.set(info.skill, Date.now())
        await refineSkill(info.skill)
      } catch {
        // never throws
      }
    })()
  } catch {
    // never throws
  }
}

// ---------- 3. periodic memory curation ----------

interface CuratedFact {
  key: string
  value: string
}

function parseFacts(raw: string): CuratedFact[] {
  let parsed: unknown = extractJson(raw)
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const rec = parsed as Record<string, unknown>
    parsed = Array.isArray(rec.facts) ? rec.facts : [rec]
  }
  if (!Array.isArray(parsed)) return []
  const facts: CuratedFact[] = []
  for (const item of parsed) {
    if (!item || typeof item !== 'object') continue
    const rec = item as Record<string, unknown>
    const key = typeof rec.key === 'string' ? rec.key.trim().toLowerCase().replace(/\s+/g, '_').slice(0, 60) : ''
    const value = typeof rec.value === 'string' ? rec.value.trim().slice(0, 500) : ''
    if (!key || !value || key.startsWith('mist:')) continue
    facts.push({ key, value })
  }
  return facts
}

export async function curateMemory(): Promise<{ factsLearned: number; notes: string }> {
  // last-run marker (ISO string stored in LongtermMemory)
  const lastRow = await db.longtermMemory.findUnique({ where: { key: LAST_CURATION_KEY } })
  let since: Date | null = null
  if (lastRow?.value) {
    const t = new Date(lastRow.value).getTime()
    if (!Number.isNaN(t)) since = new Date(t)
  }

  const messages = await db.message.findMany({
    ...(since ? { where: { createdAt: { gt: since } } } : {}),
    orderBy: { createdAt: 'asc' },
    take: 60,
  })

  const nowIso = new Date().toISOString()
  if (messages.length === 0) {
    await db.longtermMemory.upsert({
      where: { key: LAST_CURATION_KEY },
      update: { value: nowIso },
      create: { key: LAST_CURATION_KEY, value: nowIso },
    })
    return { factsLearned: 0, notes: 'nothing new to curate — no messages since the last run' }
  }

  const transcript = messages
    .map((m) => `${m.role}: ${m.content.slice(0, 500)}`)
    .join('\n')
    .slice(0, 12_000)

  let facts: CuratedFact[] = []
  try {
    const raw = await coreComplete(
      'You are MIST\u2019s memory curator. From a conversation transcript you extract DURABLE facts — ' +
        'stable knowledge about the user, their projects, preferences, constraints, or ongoing work that ' +
        'will still matter weeks from now. SKIP anything trivial, ephemeral or one-off (greetings, small ' +
        'talk, transient questions, session-specific details). Maximum 3 facts. ' +
        'Reply with ONLY a JSON array: [{"key":"short_snake_case_label","value":"the durable fact, one sentence"}]. ' +
        'If nothing is durable, reply [].',
      `TRANSCRIPT (oldest first):\n${transcript}\n\nExtract up to 3 durable facts now.`,
      LLM_TIMEOUT_MS
    )
    facts = parseFacts(raw)
  } catch (err) {
    return {
      factsLearned: 0,
      notes: `curation LLM failed: ${err instanceof Error ? err.message : 'unknown error'} — will retry next cycle`,
    }
  }

  let learned = 0
  const keys: string[] = []
  for (const f of facts.slice(0, 3)) {
    await db.longtermMemory.upsert({
      where: { key: f.key },
      update: { value: f.value },
      create: { key: f.key, value: f.value },
    })
    await db.vectorMemory
      .create({
        data: {
          text: `${f.key}: ${f.value}`.slice(0, 4000),
          source: 'fact',
          metadata: JSON.stringify({ origin: 'curation', key: f.key }),
        },
      })
      .catch(() => undefined)
    learned++
    keys.push(f.key)
  }

  await db.longtermMemory.upsert({
    where: { key: LAST_CURATION_KEY },
    update: { value: nowIso },
    create: { key: LAST_CURATION_KEY, value: nowIso },
  })

  await logAutonomyEvent('memory_curated', `curated ${learned} durable fact(s) from ${messages.length} messages`, {
    facts: facts.slice(0, 3),
    keys,
    messagesScanned: messages.length,
  })

  return {
    factsLearned: learned,
    notes:
      learned > 0
        ? `stored ${learned} durable fact(s): ${keys.join(', ')}`
        : 'no durable facts worth keeping in this window (trivial/ephemeral only)',
  }
}

// ---------- 4. the deepening user model (Honcho-lite) ----------

function setUserModelCache(value: string | null): void {
  const cache = (learningGlobal.__mistUserModelCache ??= { value: null, at: 0 })
  cache.value = value
  cache.at = Date.now()
}

export async function rebuildUserModel(): Promise<string> {
  const [factRows, messages, existingRow] = await Promise.all([
    db.longtermMemory.findMany({ orderBy: { createdAt: 'desc' }, take: 30 }),
    db.message.findMany({ orderBy: { createdAt: 'desc' }, take: 40 }),
    db.longtermMemory.findUnique({ where: { key: USER_MODEL_KEY } }),
  ])
  const existingModel = existingRow?.value ?? ''
  const factLines = factRows
    .filter((f) => !f.key.startsWith('mist:'))
    .map((f) => `- ${f.key}: ${f.value}`)
  // oldest → newest reads more naturally for the LLM
  const transcript = [...messages]
    .reverse()
    .map((m) => `${m.role}: ${m.content.slice(0, 400)}`)
    .join('\n')
    .slice(0, 16_000)

  let markdown = ''
  let distillation = ''
  try {
    if (factLines.length === 0 && messages.length === 0 && !existingModel) {
      markdown =
        '# WHO THE USER IS — MIST\u2019s distilled user model\n\n' +
        `_(generated ${new Date().toISOString()} — no durable signals yet)_\n\n` +
        'MIST does not know the user well yet. This model deepens automatically as conversations accumulate.\n'
      distillation =
        'No durable user signals yet — MIST is still learning who you are. The model deepens automatically as you talk.'
    } else {
      const raw = await coreComplete(
        'You are MIST\u2019s user-modeling engine (Honcho-lite). Synthesize everything known about the user into ' +
          'a living model MIST consults on every turn. Be specific, evidence-based and honest — never invent ' +
          'traits; prefer "unknown" over guessing. Reply with ONLY a JSON object: ' +
          '{"markdown":"a structured markdown profile with exactly these sections: ## Identity, ## Working style, ' +
          '## Preferences, ## Active projects, ## Tone","distillation":"a single paragraph, max 700 characters, ' +
          'compressing the model into what matters most for serving this user well"}.',
        `EXISTING MODEL (may be empty):\n${existingModel || '(none)'}\n\n` +
          `LONG-TERM FACTS:\n${factLines.length > 0 ? factLines.join('\n') : '(none)'}\n\n` +
          `RECENT MESSAGES (oldest first):\n${transcript || '(none)'}\n\n` +
          'Build the user model now.',
        LLM_TIMEOUT_MS
      )
      const parsed = extractJson(raw) as { markdown?: unknown; distillation?: unknown } | null
      if (parsed && typeof parsed.markdown === 'string' && parsed.markdown.trim()) {
        markdown = parsed.markdown.trim()
        distillation =
          typeof parsed.distillation === 'string' && parsed.distillation.trim() ? parsed.distillation.trim() : ''
      } else {
        // lenient: model replied with raw markdown instead of JSON
        markdown = raw.trim()
        distillation = ''
      }
    }
  } catch (err) {
    // honest deterministic fallback — never dead-end the rebuild
    markdown =
      '# WHO THE USER IS — MIST\u2019s distilled user model\n\n' +
      `_(regenerated ${new Date().toISOString()} — LLM synthesis unavailable: ` +
      `${err instanceof Error ? err.message : 'unknown error'}, deterministic fallback below)_\n\n` +
      (existingModel ? `## Previous distillation\n\n${existingModel}\n\n` : '') +
      `## Known facts\n\n${factLines.length > 0 ? factLines.join('\n') : '- (no durable facts recorded yet)'}\n`
    distillation =
      existingModel ||
      (factLines.length > 0 ? factLines.slice(0, 5).join(' ').slice(0, USER_MODEL_DISTILL_MAX) : 'No durable user signals yet — MIST is still learning who you are.')
  }

  if (!distillation.trim()) {
    distillation = markdown.replace(/[#*_`>]/g, '').replace(/\s+/g, ' ').trim().slice(0, USER_MODEL_DISTILL_MAX)
  }
  distillation = distillation.slice(0, USER_MODEL_DISTILL_MAX)

  // db/notes/USER_MODEL.md (best-effort file write; DB is the source of truth)
  try {
    await fs.mkdir(path.dirname(USER_MODEL_FILE), { recursive: true })
    await fs.writeFile(
      USER_MODEL_FILE,
      `# WHO THE USER IS — MIST\u2019s distilled user model\n\n` +
        `_regenerated automatically by the learning loop: ${new Date().toISOString()}_\n\n` +
        `${markdown}\n\n---\n\n## Distillation (injected into every turn)\n\n${distillation}\n`,
      'utf-8'
    )
  } catch {
    // file write is best-effort
  }

  // distillation → LongtermMemory (context-builder injects it)
  await db.longtermMemory.upsert({
    where: { key: USER_MODEL_KEY },
    update: { value: distillation },
    create: { key: USER_MODEL_KEY, value: distillation },
  })
  const nowIso = new Date().toISOString()
  await db.longtermMemory.upsert({
    where: { key: LAST_USER_MODEL_KEY },
    update: { value: nowIso },
    create: { key: LAST_USER_MODEL_KEY, value: nowIso },
  })

  // refresh the sync cache immediately
  setUserModelCache(distillation)

  await logAutonomyEvent('user_model_updated', `user model rebuilt from ${factLines.length} facts + ${messages.length} messages`, {
    distillation,
    distillationChars: distillation.length,
    facts: factLines.length,
    messages: messages.length,
  })

  return distillation
}

export function getUserModel(): string | null {
  const cache = (learningGlobal.__mistUserModelCache ??= { value: null, at: 0 })
  // lazy background refresh (never blocks, never throws) — the fresh value is
  // served from the next call on; rebuildUserModel() sets it synchronously
  if (Date.now() - cache.at > USER_MODEL_CACHE_TTL_MS) {
    cache.at = Date.now()
    void db.longtermMemory
      .findUnique({ where: { key: USER_MODEL_KEY } })
      .then((row) => {
        cache.value = row?.value ?? null
      })
      .catch(() => undefined)
  }
  const v = cache.value
  return v && v.trim() ? v : null
}

// ---------- 5. cross-session search (FTS-like recall) ----------

function countMatches(haystack: string, needle: string): number {
  if (!needle) return 0
  const hay = haystack.toLowerCase()
  const nee = needle.toLowerCase()
  let count = 0
  let idx = hay.indexOf(nee)
  while (idx >= 0) {
    count++
    idx = hay.indexOf(nee, idx + nee.length)
  }
  return count
}

function snippetAround(content: string, needle: string, pad = 80): string | null {
  const idx = content.toLowerCase().indexOf(needle.toLowerCase())
  if (idx < 0) return null
  const start = Math.max(0, idx - pad)
  const end = Math.min(content.length, idx + needle.length + pad)
  const prefix = start > 0 ? '…' : ''
  const suffix = end < content.length ? '…' : ''
  return (
    prefix +
    content
      .slice(start, end)
      .replace(/\s+/g, ' ')
      .trim() +
    suffix
  )
}

export async function searchSessions(query: string, limit = 8): Promise<SessionHit[]> {
  const q = query.trim()
  if (!q) return []
  const n = Math.max(1, Math.min(20, Math.round(limit)))

  // Rough candidate pass: Prisma `contains` maps to SQL LIKE '%q%' on SQLite.
  // Prisma already escapes '%' in the value; '_' still acts as a single-char
  // wildcard, so the precise literal re-match below (which treats % and _
  // literally) removes any false positives — the final result set is exact.
  const candidates = await db.message.findMany({
    where: { role: { in: ['user', 'assistant'] }, content: { contains: q } },
    orderBy: { createdAt: 'desc' },
    take: 400,
  })

  // precise ranking: literal match count first, recency second
  const scored = candidates
    .map((m) => {
      const snippet = snippetAround(m.content, q)
      if (snippet === null) return null
      return { row: m, snippet, matches: countMatches(m.content, q) }
    })
    .filter((x): x is { row: (typeof candidates)[number]; snippet: string; matches: number } => x !== null)
    .sort((a, b) => (b.matches - a.matches) || (b.row.createdAt.getTime() - a.row.createdAt.getTime()))
    .slice(0, n)

  if (scored.length === 0) return []

  // join thread titles (one batched query)
  const threadIds = [...new Set(scored.map((s) => s.row.conversationId))]
  const threads = await db.conversation
    .findMany({ where: { id: { in: threadIds } }, select: { id: true, title: true } })
    .catch(() => [] as Array<{ id: string; title: string }>)
  const titleById = new Map(threads.map((t) => [t.id, t.title]))

  return scored.map((s) => ({
    threadId: s.row.conversationId,
    threadTitle: titleById.get(s.row.conversationId) ?? 'Untitled thread',
    snippet: s.snippet,
    role: s.row.role,
    at: s.row.createdAt.toISOString(),
  }))
}

// ---------- 6. the watch (bootstrapped from /api/mist/health) ----------

export function ensureLearningWatch(): void {
  const g = (learningGlobal.__mistLearningWatch ??= { started: false })
  if (g.started) return
  g.started = true

  // pre-warm the user-model cache (read-only, fire-and-forget)
  void db.longtermMemory
    .findUnique({ where: { key: USER_MODEL_KEY } })
    .then((row) => setUserModelCache(row?.value ?? null))
    .catch(() => undefined)

  // memory curation every 6h
  const curateTimer = setInterval(() => {
    void curateMemory().catch(() => undefined)
  }, CURATE_INTERVAL_MS)
  curateTimer.unref?.()

  // user-model rebuild every 12h
  const modelTimer = setInterval(() => {
    void rebuildUserModel().catch(() => undefined)
  }, USER_MODEL_INTERVAL_MS)
  modelTimer.unref?.()
}
