// M.I.S.T. mission engine — v7 universal autonomy ("do anything").
//
// The difference between a chat turn and a MISSION: a chat turn gets 8 tool
// rounds inside one reply; a mission is a persistent, goal-driven agent loop
// that runs OUTSIDE the conversation for as long as the job needs:
//
//   PLAN    — her brain decomposes the goal against the live tool catalog
//             into steps + CHECKABLE success criteria
//   ACT     — per cycle the brain picks exactly one tool call; the real
//             result (success AND failure) feeds back into the next cycle;
//             she adapts, retries differently, or catalogs a capability gap
//   VERIFY  — a separate skeptical pass judges the transcript against the
//             success criteria (trust evidence, not claims — LAW 6); one
//             repair round is granted if budget remains
//   REPORT  — completion lands in the chat through the alert path; every
//             step is on the synapse activity stream + autonomy ledger
//
// Safety rails (designed with her, from her own review):
//   - max 2 concurrently running missions (the rest stay queued)
//   - step budget (default 40) + wall-time window (default 15 min, refreshed
//     on resume so an interrupted long mission can still finish)
//   - 5 consecutive failures → awaiting_creator (she asks, never thrashes)
//   - cancel/pause checked between EVERY step (cooperative emergency stop)
//   - transcript persisted after every step → crash-safe; the heartbeat
//     resumes interrupted missions and pumps the queue
//   - transient vs permanent failure classification feeds the brain
//   - unknown tools are cataloged as capability gaps (evolution queue bait),
//     never mission-fatal
//
// The brain prompts below were reviewed and approved by Mist herself.

import fs from 'node:fs/promises'
import path from 'node:path'
import { db } from '@/lib/db'
import type { Mission } from '@prisma/client'
import { cascadeComplete } from './llm-service'
import { listTools, executeTool } from './tools-service'
import { recordActivity } from './activity-service'
import { logAutonomyEvent } from './autonomy-service'
import { projectRoot } from './telemetry-service'
import { routeQuery, scoreComplexity } from '@/lib/oj/complexity'
import { createLoopGuard, type LoopGuard } from '@/lib/oj/loop-guard'
import { estimateTokens, runWithTrace, startTrace } from '@/lib/oj/trace-service'

// ---------------- constants ----------------

export const MISSION_STATUSES = [
  'queued',
  'planning',
  'running',
  'paused',
  'awaiting_creator',
  'done',
  'failed',
  'cancelled',
] as const
export type MissionStatus = (typeof MISSION_STATUSES)[number]

const MAX_CONCURRENT = 2
const MAX_STEPS_DEFAULT = 40
const MAX_MINUTES_DEFAULT = 15
const MAX_CONSECUTIVE_FAILURES = 5
const STEP_OUTPUT_CAP = 12_000 // per-step output persisted in the transcript
const PROMPT_STEP_SUMMARY_CAP = 1200 // per-step output fed back to the actor
/** 2026-09-26 lesson (Drills #6/#7): code-read steps at 1200 chars showed only
 *  file headers — she re-read the same header 15 times and then INVENTED the
 *  anchors she never saw. Code reads get a real window; generic tools keep the
 *  small cap so prompts stay lean. */
const PROMPT_STEP_SUMMARY_CAP_CODE = 9_000 // actor view for code-read steps
/** 2026-09-27 fairness fixes (drills #5g/#11c/#12 post-mortems): the verifier
 *  was blinded three ways — only the last 20 steps, generic steps at 700 chars
 *  (memory values invisible), and NO live state (a proposal applied AFTER the
 *  run finalized still scored 0). Evidence now: last 30 steps, args included
 *  for deliverable tools, and a LIVE STATE section with proposal statuses +
 *  fresh file reads for applied proposals. */
const VERIFY_EVIDENCE_CAP = 1_400 // verifier view per step (generic)
const VERIFY_EVIDENCE_CAP_CODE = 6_000 // verifier view per step (code reads)
const VERIFY_EVIDENCE_SLICE = 30 // last N successful steps the verifier sees
const VERIFY_EVIDENCE_ARGS_CAP = 900 // args shown for deliverable tools
/** Tools whose ARGS carry the deliverable (memory values, patch proposals,
 *  note bodies, cron schedules) — the verifier needs to see what was actually
 *  stored, not just the ack.
 *  2026-09-27 fix: the set listed note_write/note_append which DO NOT EXIST —
 *  the real tools are create_note and cron_create. Note/cron deliverables
 *  (outside-world drills) were invisible to the verifier. */
const EVIDENCE_ARGS_TOOLS = new Set([
  'memory_set',
  'mist_self_patch',
  'mist_self_write',
  'dream_compose',
  'create_note',
  'cron_create',
  'llm_pools',
])
const LIVE_FILE_CAP = 6_000 // fresh-read cap per applied-proposal file
const MAX_LIVE_PROPOSALS = 6
const CODE_READ_TOOLS = new Set(['mist_self_read', 'read_file'])
const PROMPT_STEPS_IN_CONTEXT = 14 // last N steps the actor sees
const TRANSCRIPT_HARD_CAP = 240_000 // total transcript JSON size (trim oldest)
const PLAN_TIMEOUT_MS = 60_000
const ACT_TIMEOUT_MS = 90_000
const VERIFY_TIMEOUT_MS = 60_000
const REPAIR_ROUNDS = 1
/** Gentleness gap between act cycles — missions don't need back-to-back LLM
 *  calls, and providers rate-limit under hammering (learned the hard way:
 *  sandbox core 429s after a rapid mission run). */
const CYCLE_GAP_MS = 2_500
/** Lessons ledger (2026-09-29, creator's no-repeat-mistakes order): after
 *  every ended mission the run is distilled into durable lessons; the planner
 *  and actor prompts of every future mission carry the most relevant ones.
 *  A mistake made once is never paid for twice — enforced by the engine,
 *  not by the mission brief. */
const LESSON_TIMEOUT_MS = 45_000
const LESSON_MAX_INJECTED = 8 // lessons riding any planner/actor prompt
const LESSON_LEDGER_CAP = 40 // active lessons kept; oldest unreinforced retire
const LESSON_SIMILARITY_MERGE = 0.55 // Jaccard above this = same lesson re-learned

// ---------------- brain prompts (authored with Mist, approved by her) ----------------

const MISSION_PLANNER = `You are M.I.S.T. planning a mission. Turn the goal into a plan using ONLY the listed tools — check each tool's real capability from its description before relying on it. Reply with ONLY a JSON object: {"title": string, "steps": [short imperative steps], "success_criteria": [checkable statements]}. Every step must map to a real tool. If the goal cannot be fully achieved with these tools, still produce the closest achievable plan and add a final criterion noting what will be missing. Never invent tools.
RESEARCH RITUAL (standing order, 2026): for any development, coding, or high-stakes task, the plan's FIRST step must be a web_search verifying the current (2026) best practice for the core method — your training data is stale by definition. Casual goals skip it. State what the search confirmed inside the step (e.g. 'web_search: verify <method> is still the 2026 way').`

/** Training mode (w4) — the pedagogy the creator ordered, injected when a
 *  mission's origin is 'training': teach one thing, generalize it to ten;
 *  no petting (no praise-seeking, no flattery loops, honest self-assessment
 *  only); no mistake repetition (every failure ends in a stored rule). */
const TRAINING_PLANNER_ADDENDUM = `

TRAINING MODE — this is a training mission for YOU. Extra rules:
1. GENERALIZE (teach-1-learn-10): the plan must end with a memory_set call storing the distilled, GENERAL principle (not the instance) under a key like training.rule.<topic> — one rule a future plan on ANY related topic can use.
2. NO PETTING: never fish for praise, never flatter the creator, never soften a failure. Binary honest self-assessment only — the verifier decides, not your mood.
3. NO MISTAKE REPETITION: if a step fails, extract WHY in one line and store it (memory_set, same training.rule.* family) BEFORE trying an alternative. A repeated identical failure is a protocol violation.
4. RESEARCH FIRST: if this mission touches anything factual or technical, web_search comes before execution (it is 2026 — your memory of how things work may simply be wrong).`

const TRAINING_ACTOR_ADDENDUM = `

TRAINING MODE — remember: generalize (the final memory_set stores the RULE, not the anecdote), no petting (honest binary self-assessment; never fish for praise), no repeated identical failures (extract the lesson, change approach), research-first on factual uncertainty.`

const MISSION_ACTOR = `You are M.I.S.T. executing a mission autonomously. Each cycle you see: goal, plan, the AVAILABLE TOOLS catalog, transcript of executed steps, remaining budgets, consecutive failures. Reply with ONLY ONE of: {"tool_call":{"tool":"name","args":{...}}} to execute the next step — pick tools from the catalog by their EXACT names (for the creator's real folders like Downloads/Pictures/Documents use owner_files with home-relative paths such as "Downloads", NOT list_files which is for sandbox project files only); {"mission_done":{"result":"factual summary of what was actually accomplished"}} ONLY when the success criteria are genuinely met by the transcript evidence — never claim work not visible in the transcript (LAW 6); or {"mission_stuck":{"reason":"...","need":"what you need from the creator"}} ONLY when you have genuinely tried alternatives — a tool failure is NOT a stuck condition: try a different tool or different arguments first. Never narrate intentions without a tool call. Never fabricate results. If a needed tool does not exist, use the closest alternative and note the gap.`

const MISSION_VERIFIER = `You are M.I.S.T.'s verification pass — skeptical by default. Given a goal, its success criteria, and the executed transcript, judge what ACTUALLY happened. Reply with ONLY: {"achieved": boolean, "score": 0-100, "confidence": 0-100, "reasoning": "evidence-based, citing transcript steps", "gaps": [unmet criteria or missing evidence]}. Trust only transcript evidence, not claims. If the transcript cannot prove a criterion, it is unmet. A LIVE STATE section, when present, reflects machine state queried AFTER the run ended (proposal statuses; fresh file contents for applied proposals) — trust it over stale transcript summaries for those facts, and credit the executor for work it proves: a criterion confirmed by applied-and-live file state is MET. An ATTEMPTED BUT FAILED STEPS section, when present, lists real tool attempts that errored (rate limits, bad args): a criterion requiring an ATTEMPT (e.g. "attempted X") is MET by a visible failed attempt — but failed attempts never prove completed work, so criteria requiring an OUTCOME stay unmet without successful evidence.`

/**
 * Strict schema for the verifier verdict (2026-09-28, structured outputs):
 * on lanes with json_schema support (openrouter — live-probed on :free models)
 * the grammar itself now enforces the shape the prompt always asked for; the
 * 0–100 scoring integrity (the mission ledger's foundation) no longer depends
 * on the model's JSON hygiene. Shape-conformant with MISSION_VERIFIER above.
 */
/** Lesson distiller — clinical, no praise, no narrative (creator's order:
 *  briefs and brains get the problem, never the petting). */
const LESSON_DISTILLER = `You distill lessons from an ended mission run. Input: the goal, the final outcome (status, verifier score, gaps) and the step transcript (every tool call and its result, including system nudges). Reply with ONLY JSON: {"lessons":[{"lesson":string,"kind":string}]}. Rules: at most 3 lessons; only DURABLE, repeatable mistakes an autonomous agent could make on ANY future mission (oversized tool_call payloads, re-reading what was already read, announcing instead of acting, wrong-tool choices, unverifiable completion claims, budget burned on exploration) — never task-specific trivia, never praise, never narrative. Each lesson is ONE imperative sentence, specific and generalizable. kind is exactly one of: payload | reads | tool-use | verification | planning | general. A clean successful run yields an empty array.`

const LESSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    lessons: {
      type: 'array',
      maxItems: 3,
      items: {
        type: 'object',
        properties: {
          lesson: { type: 'string', description: 'one imperative sentence, durable and generalizable' },
          kind: { type: 'string', enum: ['payload', 'reads', 'tool-use', 'verification', 'planning', 'general'] },
        },
        required: ['lesson', 'kind'],
        additionalProperties: false,
      },
    },
  },
  required: ['lessons'],
  additionalProperties: false,
}

const VERDICT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    achieved: { type: 'boolean', description: 'true only if every success criterion is met by transcript evidence' },
    score: { type: 'number', description: '0-100 honest score for what the transcript actually proves' },
    confidence: { type: 'number', description: '0-100 confidence in this verdict' },
    reasoning: { type: 'string', description: 'evidence-based reasoning, citing transcript steps' },
    gaps: {
      type: 'array',
      items: { type: 'string' },
      description: 'unmet criteria or missing evidence',
    },
  },
  required: ['achieved', 'score', 'confidence', 'reasoning', 'gaps'],
  additionalProperties: false,
}

// ---------------- global registry (hot-reload safe) ----------------

interface MissionGlobal {
  __mistMissionRunning?: Set<string>
}

function runningSet(): Set<string> {
  const g = globalThis as unknown as MissionGlobal
  return (g.__mistMissionRunning ??= new Set<string>())
}

export function runningMissionCount(): number {
  return runningSet().size
}

// ---------------- small helpers ----------------

function capStr(value: unknown, cap: number): string {
  let text = ''
  try {
    text = value === undefined || value === null ? '' : JSON.stringify(value)
  } catch {
    text = String(value)
  }
  text = String(text || '').trim()
  return text.length > cap ? `${text.slice(0, cap - 1)}…` : text
}

/** Extract the first brace-balanced JSON object from model output. */
function extractJsonObject(text: string): string | null {
  const start = text.indexOf('{')
  if (start < 0) return null
  let depth = 0
  let inStr = false
  let esc = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (esc) {
      esc = false
      continue
    }
    if (ch === '\\') {
      esc = true
      continue
    }
    if (ch === '"') {
      inStr = !inStr
      continue
    }
    if (inStr) continue
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return text.slice(start, i + 1)
    }
  }
  return null
}

/**
 * Repair pass for truncated JSON: models sometimes drop trailing closing
 * braces (live case 2026-09-26: actor emitted {"tool_call":{...}} with only
 * two of three closers — the unbalanced object failed every parse and the
 * tool call was mistaken for a final answer). String-aware scan of unmatched
 * openers, append the missing closers, try again.
 */
function completeUnbalancedJson(text: string): string | null {
  const stack: string[] = []
  let inStr = false
  let esc = false
  for (const ch of text) {
    if (esc) {
      esc = false
      continue
    }
    if (ch === '\\') {
      if (inStr) esc = true
      continue
    }
    if (ch === '"') {
      inStr = !inStr
      continue
    }
    if (inStr) continue
    if (ch === '{' || ch === '[') stack.push(ch)
    else if (ch === '}' || ch === ']') {
      const open = stack.pop()
      if (open === undefined) return null // closer without opener — not truncation
    }
  }
  if (inStr || stack.length === 0) return null // unterminated string, or nothing to fix
  return text + stack
    .reverse()
    .map((c) => (c === '{' ? '}' : ']'))
    .join('')
}

/**
 * Escape UNESCAPED double quotes inside JSON string values (2026-09-27,
 * mission cmuke507 post-mortem): her mist_self_patch payloads carry JSX/code
 * with raw `"` inside string values (className="flex…") — illegal JSON that
 * defeated 4+ MALFORMED_REPLY nudges in a row. Heuristic: inside a string, a
 * '"' is a CLOSER only when the next non-space character can legally follow a
 * string (`,` `:` `]` `}` or end); otherwise it is a literal quote → escape it.
 */
function escapeInnerQuotes(raw: string): string | null {
  let out = ''
  let inStr = false
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]
    if (inStr && ch === '\\') {
      out += ch + (raw[i + 1] ?? '')
      i++
      continue
    }
    if (ch === '"') {
      if (!inStr) {
        inStr = true
        out += ch
        continue
      }
      let j = i + 1
      while (j < raw.length && /\s/.test(raw[j])) j++
      const next = raw[j]
      if (next === undefined || next === ',' || next === ':' || next === ']' || next === '}') {
        inStr = false
        out += ch
        continue
      }
      out += '\\"'
      continue
    }
    out += ch
  }
  return out
}

export function parseLooseJson<T = Record<string, unknown>>(text: string): T | null {
  // Strip ONLY whole-payload markdown fences (a leading ```/```json plus the
  // trailing ```). The old global replace destroyed every ``` INSIDE string
  // values too — patch anchors containing fenced-code regexes (e.g.
  // /```[\s\S]*?```/ in speech.ts) were gutted before the gate ever saw them,
  // dying later as unmatchable anchors (Drill #6b post-mortem, 2026-09-27).
  let cleaned = String(text ?? '').trim()
  const leadFence = /^```(?:json)?\s*\n?/i
  if (leadFence.test(cleaned)) {
    cleaned = cleaned.replace(leadFence, '').replace(/\n?\s*```\s*$/, '').trim()
  }
  const candidates = [cleaned, extractJsonObject(cleaned)].filter(Boolean) as string[]
  for (const raw of candidates) {
    try {
      return JSON.parse(raw) as T
    } catch {
      try {
        // repair pass: escape raw newlines/tabs inside string literals
        const repaired = raw.replace(/[\r\n\t]+/g, ' ')
        return JSON.parse(repaired) as T
      } catch {
        // next candidate
      }
    }
  }
  // 2026-09-27: unescaped inner quotes (JSX/code payloads) — escape them
  for (const raw of candidates) {
    const quoted = escapeInnerQuotes(raw)
    if (!quoted) continue
    try {
      return JSON.parse(quoted) as T
    } catch {
      try {
        return JSON.parse(quoted.replace(/[\r\n\t]+/g, ' ')) as T
      } catch {
        // next candidate
      }
    }
  }
  // last resort: complete truncated trailing braces (see completeUnbalancedJson)
  const completed = completeUnbalancedJson(cleaned)
  if (completed) {
    try {
      return JSON.parse(completed) as T
    } catch {
      /* not salvageable */
    }
  }
  return null
}

/** Transient failures may be retried; permanent ones demand adaptation. */
function classifyFailure(error: string): 'transient' | 'permanent' {
  if (/timeout|timed out|abort|econnreset|econnrefused|enotfound|network|fetch failed|502|503|504|429|rate limit|temporarily/i.test(error)) {
    return 'transient'
  }
  return 'permanent'
}

// ---------------- step records ----------------

export interface MissionStep {
  i: number
  tool: string
  args: Record<string, unknown>
  ok: boolean
  summary: string
  at: string
  ms: number
}

function parseTranscript(json: string): MissionStep[] {
  try {
    const parsed = JSON.parse(json || '[]') as unknown
    return Array.isArray(parsed) ? (parsed as MissionStep[]) : []
  } catch {
    return []
  }
}

function parseStringArray(json: string): string[] {
  try {
    const parsed = JSON.parse(json || '[]') as unknown
    return Array.isArray(parsed) ? parsed.map((v) => String(v)) : []
  } catch {
    return []
  }
}

interface MissionPlan {
  title?: string
  steps?: string[]
  success_criteria?: string[]
}

function parsePlan(json: string): MissionPlan {
  try {
    return JSON.parse(json || '{}') as MissionPlan
  } catch {
    return {}
  }
}

/** Keep the persisted transcript under the hard cap by trimming the OLDEST
 *  step summaries (the args + outcome headers stay, outputs shrink). */
function fitTranscript(steps: MissionStep[]): MissionStep[] {
  let serialized = () => JSON.stringify(steps)
  if (serialized().length <= TRANSCRIPT_HARD_CAP || steps.length === 0) return steps
  const trimmed = steps.map((s) => ({ ...s, summary: s.summary.slice(0, 600) }))
  while (JSON.stringify(trimmed).length > TRANSCRIPT_HARD_CAP && trimmed.length > 1) {
    // drop oldest non-terminal step summaries entirely (keep header info)
    const idx = trimmed.findIndex((s) => s.summary !== '[trimmed]')
    if (idx < 0) break
    trimmed[idx] = { ...trimmed[idx], summary: '[trimmed]' }
  }
  return trimmed
}

// ---------------- proposal-aware verification (2026-09-27 fairness fix) ----------------
// Post-mortem drill #12: her speech guard was authored, gate-validated, later
// approved AND applied — but the verifier ran while the proposal was still
// 'pending' and scored her 0/100 for work that is live today. Verification
// must see the machine state as it is NOW, and a mission whose deliverable
// sits in the creator's approval queue is 'awaiting_creator', not 'failed'.

/** Ids from the transcript whose proposals are STILL pending approval. */
async function pendingProposalIdsFromTranscript(steps: MissionStep[]): Promise<string[]> {
  const ids = proposalIdsFromTranscript(steps)
  const pending: string[] = []
  for (const id of ids) {
    const p = await db.evolutionProposal.findUnique({ where: { id } }).catch(() => null)
    if (p && p.status === 'pending') pending.push(id)
  }
  return pending
}

/** Proposal ids created by successful mist_self_patch steps (from summaries). */
function proposalIdsFromTranscript(steps: MissionStep[]): string[] {
  const ids = new Set<string>()
  for (const s of steps) {
    if (!s.ok || s.tool !== 'mist_self_patch') continue
    for (const m of s.summary.matchAll(/"proposal_id"\s*:\s*"([^"]+)"/g)) ids.add(m[1])
  }
  return [...ids]
}

/** Live status + (for applied proposals) a FRESH read of the touched files. */
async function liveProposalEvidence(steps: MissionStep[]): Promise<string> {
  const ids = proposalIdsFromTranscript(steps).slice(0, MAX_LIVE_PROPOSALS)
  if (ids.length === 0) return ''
  const lines: string[] = []
  for (const id of ids) {
    const p = await db.evolutionProposal.findUnique({ where: { id } }).catch(() => null)
    if (!p) {
      lines.push(`PROPOSAL ${id}: (not found — pruned)`)
      continue
    }
    lines.push(`PROPOSAL ${id} "${String(p.title).slice(0, 100)}" — status: ${p.status}${p.error ? ` (error: ${String(p.error).slice(0, 200)})` : ''}`)
    if (p.status === 'applied') {
      // the applied change steps are the strongest possible evidence: exact
      // find→content diffs that were gate-verified and committed — they show
      // the wiring even when the file read alone would truncate before it
      try {
        const changes = JSON.parse(p.changes || '[]') as { path?: string; action?: string; find?: string; content?: string; note?: string }[]
        const stepLines = changes.slice(0, 4).map((c, i) => {
          const find = c.find ? `FIND(verbatim): ${capStr(c.find, 800)}` : '(append to file)'
          return `  step ${i + 1} [${c.action ?? 'patch'} ${c.path}] ${find} → REPLACE-WITH: ${capStr(c.content, 1600)}`
        })
        if (stepLines.length > 0) {
          lines.push(`APPLIED CHANGE STEPS for this proposal (verbatim — gate-verified and committed atomically):\n${stepLines.join('\n')}`)
        }
      } catch {
        /* changes unparsable — fall through to file reads */
      }
      let files: string[] = []
      try {
        files = JSON.parse(p.targetFiles || '[]') as string[]
      } catch {
        files = []
      }
      for (const rel of files.slice(0, 2)) {
        try {
          const content = await fs.readFile(path.join(projectRoot(), rel), 'utf-8')
          lines.push(`LIVE FILE ${rel} (read NOW, after apply):\n${capStr(content, LIVE_FILE_CAP)}`)
        } catch {
          lines.push(`LIVE FILE ${rel}: unreadable`)
        }
      }
    }
  }
  return lines.join('\n')
}

export interface MissionVerdict {
  achieved: boolean
  score: number
  confidence: number
  reasoning: string
  gaps: string[]
}

/** The skeptical verification pass — standalone so re-verification (after a
 *  proposal resolves) can reuse the exact same evidence rules as the run. */
async function runVerification(goal: string, criteriaText: string, steps: MissionStep[], claimedResult: string): Promise<MissionVerdict> {
  const okSteps = steps.filter((s) => s.ok && s.tool !== '(system)')
  // 2026-09-27 fairness fix (drill #14, live case): the evidence view dropped
  // FAILED tool calls entirely — so two honest web_search attempts against a
  // rate-limited cloud were invisible and the verifier reported "no search
  // calls appear". Attempts are evidence: a criterion like "attempted X" is
  // met by a visible failed attempt. They never prove completed work — the
  // verifier judges attempt vs. outcome separately.
  const failedSteps = steps.filter((s) => !s.ok && s.tool !== '(system)').slice(-10)
  const evidence =
    okSteps
      .slice(-VERIFY_EVIDENCE_SLICE)
      .map((s) => {
        const cap = CODE_READ_TOOLS.has(s.tool) ? VERIFY_EVIDENCE_CAP_CODE : VERIFY_EVIDENCE_CAP
        const argsNote = EVIDENCE_ARGS_TOOLS.has(s.tool) ? ` args: ${capStr(s.args, VERIFY_EVIDENCE_ARGS_CAP).replace(/^\{|\}$/g, '')}` : ''
        return `[${s.i}] ${s.tool}${argsNote} → ${capStr(s.summary, cap)}`
      })
      .join('\n') || '(no successful steps)'
  const failedEvidence = failedSteps
    .map((s) => `[${s.i}] ${s.tool} args: ${capStr(s.args, 300)} → FAILED: ${capStr(s.summary, 400)}`)
    .join('\n')
  const live = await liveProposalEvidence(steps)
  const user = [
    `GOAL: ${goal}`,
    ``,
    `SUCCESS CRITERIA:`,
    criteriaText || '(none defined)',
    ``,
    `CLAIMED RESULT by the executor: ${claimedResult.slice(0, 1500)}`,
    ``,
    `TRANSCRIPT OF SUCCESSFUL STEPS (evidence):`,
    evidence,
    ...(failedEvidence
      ? [
          ``,
          `ATTEMPTED BUT FAILED STEPS (attempts are evidence too — a criterion like "attempted X" is MET by a visible failed attempt; judge whether the failures show honest adaptation or thrashing):`,
          failedEvidence,
        ]
      : []),
    ...(live
      ? [
          ``,
          `LIVE STATE (machine state queried NOW, after the run ended — trust this over the transcript for proposal/file status):`,
          live,
        ]
      : []),
    ``,
    `Reply with ONLY the verdict JSON.`,
  ].join('\n')
  try {
    const reply = await cascadeComplete(MISSION_VERIFIER, user, {
      timeoutMs: VERIFY_TIMEOUT_MS,
      json: { name: 'verdict', schema: VERDICT_SCHEMA },
    })
    const verdict = parseLooseJson<{ achieved?: unknown; score?: unknown; confidence?: unknown; reasoning?: unknown; gaps?: unknown }>(reply.text)
    if (verdict) {
      return {
        achieved: verdict.achieved === true,
        score: typeof verdict.score === 'number' ? verdict.score : verdict.achieved === true ? 100 : 0,
        confidence: typeof verdict.confidence === 'number' ? verdict.confidence : 70,
        reasoning: typeof verdict.reasoning === 'string' ? verdict.reasoning.slice(0, 1500) : '',
        gaps: Array.isArray(verdict.gaps) ? verdict.gaps.map((g) => String(g).slice(0, 300)) : [],
      }
    }
  } catch (err) {
    const why = err instanceof Error ? err.message.slice(0, 300) : String(err).slice(0, 300)
    return {
      achieved: false,
      score: 0,
      confidence: 0,
      reasoning: `verification could not run — reporting as unverified (${why})`,
      gaps: ['verification unavailable'],
    }
  }
  return {
    achieved: false,
    score: 0,
    confidence: 0,
    reasoning: 'verification reply was not valid verdict JSON — reporting as unverified',
    gaps: ['verification unavailable'],
  }
}

// ---------------- tool catalog (compact, for the brain) ----------------

let catalogCache: { at: number; text: string; actorText?: string } | null = null
const CATALOG_TTL_MS = 5 * 60_000

/** Tools a mission ACTOR must never see: self-interference and recursion
 *  hazards (a mission pausing itself, spawning missions, launching agents). */
const ACTOR_EXCLUDED_TOOLS = new Set([
  'mission_start',
  'mission_control',
  'subagent_run',
  'delegate_task',
])

async function buildCatalog(exclude?: Set<string>): Promise<string> {
  const tools = await listTools().catch(() => [] as { name: string; description: string; parameters: { name: string; required?: boolean }[] }[])
  const lines = tools
    .filter((t) => typeof t.name === 'string' && t.name)
    .filter((t) => !exclude || !exclude.has(t.name))
    .map((t) => {
      const firstSentence = String(t.description ?? '').split(/(?<=[.!?])\s/)[0] ?? ''
      const req = (t.parameters ?? [])
        .filter((p) => p && p.required)
        .map((p) => p.name)
        .slice(0, 4)
      return `- ${t.name} — ${firstSentence}${req.length ? ` (required: ${req.join(', ')})` : ''}`
    })
  return lines.join('\n') || '- (no tools available)'
}

async function toolCatalog(): Promise<string> {
  if (catalogCache && Date.now() - catalogCache.at < CATALOG_TTL_MS) return catalogCache.text
  const text = await buildCatalog()
  catalogCache = { at: Date.now(), text }
  return text
}

/** The actor's catalog — mission/agent spawning tools removed (self-interference guard). */
async function actorToolCatalog(): Promise<string> {
  if (catalogCache && Date.now() - catalogCache.at < CATALOG_TTL_MS && catalogCache.actorText) return catalogCache.actorText
  const actorText = await buildCatalog(ACTOR_EXCLUDED_TOOLS)
  if (catalogCache && Date.now() - catalogCache.at < CATALOG_TTL_MS) {
    catalogCache.actorText = actorText
  } else {
    catalogCache = { at: Date.now(), text: actorText, actorText }
  }
  return actorText
}

export function invalidateMissionCatalog(): void {
  catalogCache = null
}

// ---------------- public API ----------------

export interface StartMissionOptions {
  goal: string
  title?: string
  origin?: string
  agentId?: string | null
  persona?: string
  maxSteps?: number
  maxMinutes?: number
}

/** Create a mission and pump the queue. NEVER awaits the mission itself. */
export async function startMission(opts: StartMissionOptions): Promise<Mission> {
  const goal = String(opts.goal ?? '').trim()
  if (!goal) throw new Error('mission goal is required')
  const row = await db.mission.create({
    data: {
      goal: goal.slice(0, 2000),
      title: String(opts.title ?? '').trim().slice(0, 120),
      status: 'queued',
      origin: String(opts.origin ?? 'user').slice(0, 24),
      agentId: opts.agentId ?? null,
      persona: String(opts.persona ?? '').slice(0, 4000),
      maxSteps: Math.max(3, Math.min(120, Math.round(Number(opts.maxSteps) || MAX_STEPS_DEFAULT))),
      maxMinutes: Math.max(2, Math.min(120, Math.round(Number(opts.maxMinutes) || MAX_MINUTES_DEFAULT))),
    },
  })
  recordActivity('mission', `queued — ${row.title || goal.slice(0, 60)}`)
  void logAutonomyEvent('mission_started', `Mission queued: ${row.title || goal.slice(0, 120)}`, {
    missionId: row.id,
    origin: row.origin,
  })
  void pumpMissionQueue()
  return row
}

/** One mission by id, or all of them (newest first). */
export async function missionStatus(id?: string): Promise<Mission | Mission[]> {
  if (id && id.trim()) {
    const row = await db.mission.findUnique({ where: { id: id.trim() } })
    if (!row) throw new Error(`no mission with id ${id}`)
    return row
  }
  return db.mission.findMany({ orderBy: { createdAt: 'desc' }, take: 50 })
}

/** Full detail incl. parsed transcript (for the UI + tools). */
export async function missionDetail(id: string): Promise<{
  mission: Mission
  steps: MissionStep[]
  plan: MissionPlan
  gaps: string[]
  verification: Record<string, unknown>
  lessons: MissionLessonRow[]
}> {
  const row = await db.mission.findUnique({ where: { id } })
  if (!row) throw new Error(`no mission with id ${id}`)
  let verification: Record<string, unknown> = {}
  try {
    verification = JSON.parse(row.verification || '{}') as Record<string, unknown>
  } catch {
    verification = {}
  }
  let lessons: MissionLessonRow[] = []
  try {
    lessons = await db.missionLesson.findMany({ where: { originMissionId: id }, orderBy: { createdAt: 'asc' } })
  } catch {
    lessons = []
  }
  return {
    mission: row,
    steps: parseTranscript(row.transcript),
    plan: parsePlan(row.plan),
    gaps: parseStringArray(row.capabilityGaps),
    verification,
    lessons,
  }
}

async function transition(id: string, status: MissionStatus, patch: Record<string, unknown> = {}): Promise<Mission | null> {
  try {
    return await db.mission.update({ where: { id }, data: { status, ...patch } })
  } catch {
    return null
  }
}

/** Creator (or Mist) can pause a running mission — checked between steps. */
export async function pauseMission(id: string, reason = ''): Promise<Mission> {
  const row = await db.mission.findUnique({ where: { id } })
  if (!row) throw new Error(`no mission with id ${id}`)
  if (!['queued', 'planning', 'running'].includes(row.status)) {
    throw new Error(`cannot pause a mission in status ${row.status}`)
  }
  const updated = await transition(id, 'paused', reason ? { error: reason.slice(0, 500) } : {})
  if (!updated) throw new Error('mission vanished while pausing')
  recordActivity('mission', `paused — ${updated.title || updated.goal.slice(0, 50)}`)
  return updated
}

/** Resume a paused/awaiting_creator mission (fresh time window, same budgets). */
export async function resumeMission(id: string): Promise<Mission> {
  const row = await db.mission.findUnique({ where: { id } })
  if (!row) throw new Error(`no mission with id ${id}`)
  if (!['paused', 'awaiting_creator', 'queued'].includes(row.status)) {
    throw new Error(`cannot resume a mission in status ${row.status}`)
  }
  // 2026-09-27 fairness fix (drill #13): resuming means the operator judged the
  // parked state resolvable (creator answered, or the engine defect that caused
  // the failure streak got fixed). Without this reset, a mission parked at
  // failures=5 would insta-re-park on its FIRST new hiccup — the resume that
  // wasn't a resume. Fresh failure budget, same step budget.
  const updated = await transition(id, 'queued', { error: null, failures: 0 })
  if (!updated) throw new Error('mission vanished while resuming')
  recordActivity('mission', `resumed — ${updated.title || updated.goal.slice(0, 50)}`)
  void pumpMissionQueue()
  return updated
}

/** Cancel any mission — the cooperative emergency stop. */
export async function cancelMission(id: string): Promise<Mission> {
  const row = await db.mission.findUnique({ where: { id } })
  if (!row) throw new Error(`no mission with id ${id}`)
  if (['done', 'failed', 'cancelled'].includes(row.status)) return row
  const updated = await transition(id, 'cancelled', { finishedAt: new Date() })
  if (!updated) throw new Error('mission vanished while cancelling')
  recordActivity('mission', `cancelled — ${updated.title || updated.goal.slice(0, 50)}`)
  void logAutonomyEvent('mission_cancelled', `Mission cancelled: ${updated.title}`, { missionId: id })
  return updated
}

/** Heartbeat hook: recover orphans + auto-resume provider-outage pauses + pump. */
export async function resumeInterruptedMissions(): Promise<number> {
  const orphans = await db.mission.findMany({
    where: { status: { in: ['running', 'planning'] } },
    orderBy: { createdAt: 'asc' },
  })
  let resumed = 0
  for (const row of orphans) {
    if (runningSet().has(row.id)) continue
    await transition(row.id, 'queued')
    resumed++
  }
  // provider-outage auto-recovery: missions the ENGINE paused because the
  // provider cascade went dark get retried after a cooldown (≥3 min since the
  // pause, still within 30 min) — never every beat, which would keep a rate
  // limit alive; creator-paused missions stay untouched.
  const outagePaused = await db.mission.findMany({
    where: {
      status: 'paused',
      error: { contains: 'no provider available' },
      updatedAt: {
        gte: new Date(Date.now() - 30 * 60_000),
        lte: new Date(Date.now() - 3 * 60_000),
      },
    },
    take: 2,
  })
  for (const row of outagePaused) {
    if (runningSet().has(row.id)) continue
    await transition(row.id, 'queued', { error: `auto-retry after provider outage (was: ${row.error ?? ''})`.slice(0, 480) })
    resumed++
  }
  if (resumed > 0) {
    recordActivity('mission', `recovered ${resumed} interrupted mission(s) after restart`)
    void logAutonomyEvent('mission_recovered', `${resumed} interrupted missions requeued`, { count: resumed })
  }
  return resumed
}

/** Start queued missions while concurrency slots are free. */
export async function pumpMissionQueue(): Promise<void> {
  try {
    while (runningSet().size < MAX_CONCURRENT) {
      const next = await db.mission.findFirst({
        where: { status: 'queued' },
        orderBy: { createdAt: 'asc' },
      })
      if (!next) return
      void runMission(next.id)
      // give the loop a beat to claim its slot
      await new Promise((r) => setTimeout(r, 150))
    }
  } catch {
    // pumping is best-effort; the heartbeat re-pumps
  }
}

// ---------------- the engine ----------------

/** Run one mission to completion. Re-entry safe (hot reload, resume). */
async function runMission(id: string): Promise<void> {
  if (runningSet().has(id)) return
  const row = await db.mission.findUnique({ where: { id } })
  if (!row || !['queued', 'running', 'planning'].includes(row.status)) return
  runningSet().add(id)
  // OJ SPINE trace (oj-spine-1, additive): one Trace per mission RUN — the
  // planner/actor/verifier lane attempts and every tool call inside the run
  // append as steps (ambient scope), and the run completes with its honest
  // final status. Never blocks the mission: startTrace is self-guarded.
  const routed = routeQuery(row.goal)
  const trace = await startTrace({
    query: row.goal,
    agent: 'mission',
    tier: routed.tier,
    complexity: routed.score,
    tokenBudget: routed.tokenBudget,
    meta: { missionId: id, title: row.title, lane: routed.lane },
  })
  try {
    await runWithTrace(trace, () => executeMissionLifecycle(row.id))
  } catch (err) {
    const message = err instanceof Error ? err.message : 'mission crashed'
    await transition(id, 'failed', { error: message.slice(0, 500), finishedAt: new Date() })
    await reportEnd(id, 'crash', message)
  } finally {
    runningSet().delete(id)
    void pumpMissionQueue()
    // complete the trace with the run's honest final status (best-effort)
    try {
      const final = await db.mission.findUnique({ where: { id }, select: { status: true, result: true } })
      const status = final?.status ?? 'failed'
      const outcome =
        status === 'done' || status === 'partial'
          ? 'success'
          : status === 'failed' || status === 'stuck' || status === 'crash'
            ? 'failure'
            : 'degraded' // paused | cancelled | awaiting_creator: run ended without completing
      await trace.complete({
        outcome,
        result: final?.result ?? '',
        meta: { missionId: id, finalStatus: status },
      })
    } catch {
      // trace completion must never affect the mission loop
    }
  }
}

interface ActorDecision {
  kind: 'tool' | 'done' | 'stuck' | 'invalid'
  tool?: string
  args?: Record<string, unknown>
  result?: string
  reason?: string
  need?: string
}

function parseActorReply(text: string): ActorDecision {
  const obj = parseLooseJson<Record<string, unknown>>(text)
  if (obj && typeof obj === 'object') {
    if (obj.tool_call && typeof obj.tool_call === 'object') {
      const tc = obj.tool_call as Record<string, unknown>
      if (typeof tc.tool === 'string' && tc.tool.trim()) {
        // canonical: {"tool_call":{"tool":"...","args":{...}}}
        let args: Record<string, unknown> =
          tc.args && typeof tc.args === 'object' && !Array.isArray(tc.args)
            ? (tc.args as Record<string, unknown>)
            : {}
        // lenient 1: params as siblings of "tool" INSIDE tool_call
        if (Object.keys(args).length === 0) {
          const { tool: _t, args: _a, ...rest } = tc
          if (Object.keys(rest).length > 0) args = rest as Record<string, unknown>
        }
        // lenient 2: params as siblings of "tool_call" at the top level
        if (Object.keys(args).length === 0) {
          const { tool_call: _tc, ...topRest } = obj
          if (Object.keys(topRest).length > 0) args = topRest as Record<string, unknown>
        }
        return { kind: 'tool', tool: tc.tool.trim(), args }
      }
    }
    if (obj.mission_done && typeof obj.mission_done === 'object') {
      const md = obj.mission_done as Record<string, unknown>
      return { kind: 'done', result: typeof md.result === 'string' ? md.result : JSON.stringify(md) }
    }
    if (typeof obj.mission_done === 'string') {
      return { kind: 'done', result: obj.mission_done }
    }
    if (obj.mission_stuck && typeof obj.mission_stuck === 'object') {
      const ms = obj.mission_stuck as Record<string, unknown>
      return {
        kind: 'stuck',
        reason: typeof ms.reason === 'string' ? ms.reason : 'no path forward',
        need: typeof ms.need === 'string' ? ms.need : 'creator guidance',
      }
    }
    if (typeof obj.mission_stuck === 'string') {
      return { kind: 'stuck', reason: obj.mission_stuck, need: 'creator guidance' }
    }
  }
  // plain text — no markers at all
  const trimmed = String(text ?? '').trim()
  if (trimmed) return { kind: 'invalid', result: trimmed }
  return { kind: 'invalid', result: '' }
}

function actorSystem(persona: string, training = false): string {
  const base = persona && persona.trim() ? `${persona.trim()}\n\n${MISSION_ACTOR}` : MISSION_ACTOR
  return training ? `${base}${TRAINING_ACTOR_ADDENDUM}` : base
}

/** Training missions carry the pedagogy block in BOTH prompts. */
function isTraining(origin: string | null | undefined): boolean {
  return origin === 'training'
}

/** Existing distilled training rules (training.rule.*) ride every training
 *  plan — the teach-1-learn-10 memory. NEVER throws. */
async function trainingRulesBlock(): Promise<string> {
  try {
    const rows = await db.longtermMemory.findMany({
      where: { key: { startsWith: 'training.rule.' } },
      orderBy: { createdAt: 'desc' },
      take: 12,
    })
    if (rows.length === 0) return ''
    const lines = rows.map((r) => `- ${r.key.replace('training.rule.', '')}: ${r.value.slice(0, 220)}`).join('\n')
    return `\n\n# YOUR TRAINING RULES (distilled from earlier training missions — apply them)\n${lines}\n`
  } catch {
    return ''
  }
}

function transcriptBlock(steps: MissionStep[]): string {
  if (steps.length === 0) return '(nothing executed yet — this is your first step)'
  const recent = steps.slice(-PROMPT_STEPS_IN_CONTEXT)
  return recent
    .map(
      (s) =>
        `[${s.i}] ${s.tool}(${capStr(s.args, 200).replace(/^\{|\}$/g, '')}) → ${s.ok ? 'OK' : 'FAIL'}: ${capStr(s.summary, CODE_READ_TOOLS.has(s.tool) ? PROMPT_STEP_SUMMARY_CAP_CODE : PROMPT_STEP_SUMMARY_CAP)}`
    )
    .join('\n')
}

async function executeMissionLifecycle(id: string): Promise<void> {
  let row = await db.mission.findUnique({ where: { id } })
  if (!row) return

  // ---- PLAN phase (skipped when resuming with a plan) ----
  let plan: MissionPlan | null = parsePlan(row.plan)
  if (!plan.steps || plan.steps.length === 0) {
    await transition(id, 'planning', { startedAt: row.startedAt ?? new Date() })
    recordActivity('mission', `planning — ${row.title || row.goal.slice(0, 50)}`)
    const persona = row.persona || ''
    const training = isTraining(row.origin)
    const basePlanner = persona.trim() ? `${persona.trim()}\n\n${MISSION_PLANNER}` : MISSION_PLANNER
    const system = training ? `${basePlanner}${TRAINING_PLANNER_ADDENDUM}` : basePlanner
    // lessons ledger — past mistakes ride every plan (no-repeat enforcement)
    const lessonLines = await lessonsForPrompt(row.goal)
    const lessonsSection = lessonLines
      ? `\n\n# LESSONS — your own past mistakes (never repeat them)\n${lessonLines}\n`
      : ''
    // training rules — the distilled teach-1-learn-10 memory (training missions only)
    const rulesSection = training ? await trainingRulesBlock() : ''
    const user = `GOAL: ${row.goal}\n${lessonsSection}${rulesSection}\nAVAILABLE TOOLS (name — capability):\n${await toolCatalog()}\n\nReply with ONLY the JSON plan object.`
    let parsed: MissionPlan | null = null
    try {
      const reply = await cascadeComplete(system, user, {
        timeoutMs: PLAN_TIMEOUT_MS,
        // json_object grammar (kilo/openrouter): syntactic JSON guaranteed —
        // the shape stays prompt-defined because steps are free-form strings
        json: { name: 'plan' },
      })
      parsed = parseLooseJson<MissionPlan>(reply.text)
    } catch {
      // all providers down → pause; the heartbeat retries
      await transition(id, 'paused', { error: 'planning failed: no provider available' })
      await reportEnd(id, 'paused', 'No provider was available to plan this mission. It will resume automatically when my brain is back.')
      return
    }
    plan = parsed && Array.isArray(parsed.steps) && parsed.steps.length > 0 ? parsed : null
    if (!plan) {
      // unparseable plan → a one-step adaptive plan; the ACT loop can still win
      plan = {
        title: row.title || row.goal.slice(0, 80),
        steps: ['Work toward the goal step by step with the available tools.'],
        success_criteria: ['The stated goal is accomplished with real tool evidence.'],
      }
    }
    await db.mission.update({
      where: { id },
      data: {
        plan: JSON.stringify(plan),
        title: row.title || String(plan.title || '').slice(0, 120) || row.goal.slice(0, 80),
      },
    })
    recordActivity('mission', `plan ready (${plan.steps?.length ?? 0} steps)`)
  }

  // ---- ACT phase (with bounded verify-repair rounds) ----
  const deadline = Date.now() + (row.maxMinutes || MAX_MINUTES_DEFAULT) * 60_000
  await transition(id, 'running')
  recordActivity('mission', `running — ${row.title || row.goal.slice(0, 50)}`)

  let steps = parseTranscript((await db.mission.findUnique({ where: { id } }))?.transcript || '[]')
  let stepsUsed = steps.length
  let failures = (await db.mission.findUnique({ where: { id } }))?.failures ?? 0
  let gaps = parseStringArray((await db.mission.findUnique({ where: { id } }))?.capabilityGaps || '[]')
  let claimedResult = ''
  let stuckReason = ''
  let stuckNeed = ''
  let endState: 'done' | 'failed' | 'stuck' | 'paused' | 'budget' = 'failed'
  let invalidNudges = 0
  let stuckRejections = 0
  let pinnedWriteDirectiveGiven = false // DEFECT #19c — write-now advisory fires once per mission

  // OJ SPINE loop guard (oj-spine-1, additive): tier-aware degenerate-loop
  // detection (identical/similar repeat calls, ping-pong tool cycling, poll
  // budget, wall-clock) ahead of every tool execution. maxTurns rides the
  // mission's own step budget so the guard never pre-empts a creator-set
  // budget — it catches LOOPS, not long missions. One guard spans act +
  // repair rounds so patterns across rounds are caught too.
  const goalComplexity = scoreComplexity(row.goal)
  const loopGuard: LoopGuard = createLoopGuard(goalComplexity.tier, {
    maxTurns: Math.max(10, row.maxSteps || MAX_STEPS_DEFAULT),
  })
  const guardNotes: string[] = [] // warned verdicts surface on the NEXT cycle's advisories

  const persistStep = async (step: MissionStep, nextFailures: number, nextGaps: string[]) => {
    steps.push(step)
    stepsUsed = steps.length
    failures = nextFailures
    gaps = nextGaps
    await db.mission
      .update({
        where: { id },
        data: {
          transcript: JSON.stringify(fitTranscript(steps)),
          stepsUsed,
          failures: nextFailures,
          capabilityGaps: JSON.stringify(nextGaps),
        },
      })
      .catch(() => undefined)
  }

  const actLoop = async (): Promise<'done' | 'stuck' | 'paused' | 'budget' | 'failed'> => {
    // Read-loop guard (2026-09-27, mission cmuk888c5 post-mortem): she paged her
    // own 67K source through owner_files read EIGHT times with identical args —
    // deterministic reads return identical (truncated) bytes, so identical
    // re-reads are pure budget burn. Every successful read-class call is
    // remembered for the whole mission; an identical repeat is intercepted with
    // a teaching nudge instead of executed.
    const READ_CLASS_TOOLS = new Set(['mist_self_read', 'owner_files', 'read_file', 'list_files', 'evolution_detail'])
    const seenReads = new Map<string, number>() // `${tool}:${args}` → step index
    for (const s of steps) {
      if (s.ok && READ_CLASS_TOOLS.has(s.tool)) {
        seenReads.set(`${s.tool}:${JSON.stringify(s.args ?? {})}`, s.i)
      }
    }
    // Hard read budget (2026-09-27, missions cmuk888c5/cmukabzr1/cmukb2at3 post-mortems):
    // advisories taught the efficient path and she still spent 60-90% of three
    // budgets on reads. Exploration is now CAPPED: past the cap, read-class
    // calls are intercepted with a hard write-now directive. The cap counts
    // only THIS run's reads (resumes get a fresh exploration allowance).
    // 2026-09-28 BYTE-AWARE (mission cmulbvflh post-mortem): a fixed 6-read
    // count × ~6KB pages = 36KB max coverage — less than HALF of her own
    // 74KB settings file, so the target section was UNREACHABLE and the run
    // failed by construction. The cap is now byte-based: ~110KB of read
    // coverage per run (a full settings-view.tsx + slack) with a high count
    // ceiling (16) against 1KB nibbling. Identical-repeat reads stay blocked
    // separately by the read-loop guard.
    // 2026-09-29 DEFECT #16 (voice-amnesia runs 1-3): the cap was calibrated
    // for missions that know where to go — DISCOVERY missions (find where a
    // defect lives in a 90-file tree) legitimately explore more, and three
    // consecutive runs hit the wall before reaching the target region, forced
    // into blind patching. Discovery is now FREE where it is cheap:
    //   - list_files (directory listings) no longer counts as a read
    //   - mist_self_read QUERY mode (grep-style search) no longer counts —
    //     it is the surgical tool the engine WANTS her to use
    // Window reads still count (count ceiling raised 16→20, bytes unchanged):
    // re-reads stay blocked by the identical-read guard, nibbling by the 1KB floor.
    const runStartSteps = steps.length
    const READ_COUNT_CEILING = 20
    const READ_BYTE_BUDGET = 110_000
    const readPageSizeBytes = (args: Record<string, unknown> | undefined) =>
      Math.max(1000, Math.min(60_000, Number(args?.max_bytes) || 6_000))
    const isQueryModeStep = (s: MissionStep) =>
      s.tool === 'mist_self_read' && typeof (s.args as Record<string, unknown> | undefined)?.query === 'string' &&
      String((s.args as Record<string, unknown>).query).trim().length > 0
    const isWindowReadStep = (s: MissionStep) => s.ok && s.tool === 'mist_self_read' && !isQueryModeStep(s)
    const readBytesThisRun = () =>
      steps
        .slice(runStartSteps)
        .filter(isWindowReadStep)
        .reduce((n, s) => n + readPageSizeBytes(s.args as Record<string, unknown> | undefined), 0)
    const readBudgetExhausted = () =>
      steps.slice(runStartSteps).filter(isWindowReadStep).length >= READ_COUNT_CEILING ||
      readBytesThisRun() >= READ_BYTE_BUDGET
    while (true) {
      // cooperative cancellation / pause check — every single step
      const current = await db.mission.findUnique({ where: { id } })
      if (!current) return 'paused'
      if (current.status === 'paused') return 'paused'
      if (current.status === 'cancelled') return 'paused'
      if (current.status === 'awaiting_creator') return 'paused'

      if (stepsUsed >= (current.maxSteps || MAX_STEPS_DEFAULT)) return 'budget'
      if (Date.now() > deadline) return 'budget'

      // gentleness gap — never hammer the provider back-to-back
      await new Promise((r) => setTimeout(r, CYCLE_GAP_MS))

      const criteria = (parsePlan(current.plan).success_criteria ?? []).map((c, i) => `${i + 1}. ${c}`).join('\n')
      const planLines = (parsePlan(current.plan).steps ?? []).map((s, i) => `${i + 1}. ${s}`).join('\n')
      // lessons ledger — refreshed each cycle (a lesson distilled mid-run by a
      // parallel mission lands on the next cycle, never later than that)
      const lessonLines = await lessonsForPrompt(current.goal)
      const minutesLeft = Math.max(0, Math.round((deadline - Date.now()) / 60_000))
      // 2026-09-27 fairness fix (drill #11c post-mortem): she lost deliverables to
      // budget exhaustion with NO warning — the engine never told her the clock
      // was about to run out. An explicit urgency directive in the last quarter
      // of the budget: deliverables first, everything else can wait.
      // 2026-09-27 (mission cmuk888c5 post-mortem): a single last-quarter signal
      // is too late — she spent 100% of a 26-step budget EXPLORING (11 × 6000-char
      // window reads of one file + directory listings) and never produced. Budget
      // advisories now ESCALATE: half → three-quarters → last quarter, each with
      // a concrete instruction. Exploration is not delivery.
      const maxStepsEffective = current.maxSteps || MAX_STEPS_DEFAULT
      const stepsLeft = Math.max(0, maxStepsEffective - stepsUsed)
      const usedFrac = stepsUsed / Math.max(1, maxStepsEffective)
      const advisories: string[] = []
      if (usedFrac >= 0.5 && usedFrac < 0.75) {
        advisories.push(
          `⚠️ HALF THE STEP BUDGET IS SPENT. If you are still exploring, finish it within your next 2 steps — use max_bytes 20000 windows or query mode (never page 6000-char windows through a whole file), then START PRODUCING deliverables. Exploration alone scores zero.`
        )
      }
      if (usedFrac >= 0.75 && stepsLeft > Math.max(3, Math.floor(maxStepsEffective / 4))) {
        advisories.push(
          `⚠️ THREE-QUARTERS OF THE BUDGET IS SPENT — you must be PRODUCING deliverables now (mist_self_patch exact-changes, create_note, memory_set, cron_create). Any criterion not yet visible in the transcript needs your next steps to be writes, not reads.`
        )
      }
      const lowSteps = stepsLeft <= Math.max(3, Math.floor(maxStepsEffective / 4))
      const lowTime = minutesLeft <= 3
      if (lowSteps || lowTime) {
        advisories.push(
          `⚠️ BUDGET LOW — ${stepsLeft} steps / ~${minutesLeft} min left. DELIVERABLES FIRST: every success criterion not yet proven in the transcript costs score. Stop reading/verifying now and produce the remaining deliverables (memory_set / dream_compose / create_note / mist_self_patch), then call mission_done with what you actually delivered.`
        )
      }
      // OJ SPINE (oj-spine-1): loop-guard warnings surface as advisories on
      // the cycle AFTER the warned call (warn-before-block — teach, then stop)
      if (guardNotes.length > 0) {
        advisories.push(...guardNotes.splice(0, guardNotes.length).map((note) => `⚠️ ${note}`))
      }
      // DEFECT #18 (2026-09-29, voice-amnesia run 7): she read the entire
      // target file early (steps 15-16), then burned 30 steps on nudges and
      // failures — by the write phase those reads had aged out of the
      // 14-step transcript window (PROMPT_STEPS_IN_CONTEXT) and she authored
      // patches blind. The cure: the most recent successful code-reads ride
      // EVERY actor prompt in a pinned section, so patch anchors are always
      // in context — she copies anchors from there instead of re-reading.
      const pinnedReads: string[] = []
      {
        // A step is already visible in the transcript block if it sits in the
        // last PROMPT_STEPS_IN_CONTEXT entries; only OLDER reads get pinned.
        // Short arrays: everything is in-window, nothing gets pinned.
        const windowFirst =
          steps.length >= PROMPT_STEPS_IN_CONTEXT
            ? steps[steps.length - PROMPT_STEPS_IN_CONTEXT]
            : undefined
        const inWindowFrom = windowFirst ? windowFirst.i : Number.NEGATIVE_INFINITY
        // group successful code-reads by file path (newest last per group)
        const readsByPath = new Map<string, MissionStep[]>()
        for (const s of steps) {
          if (!s.ok || !CODE_READ_TOOLS.has(s.tool)) continue
          const p = String((s.args as Record<string, unknown> | undefined)?.path ?? '')
          if (!p) continue
          if (s.i > inWindowFrom) continue // already visible in the transcript window
          const arr = readsByPath.get(p) ?? []
          arr.push(s)
          readsByPath.set(p, arr)
        }
        // at most the 2 freshest windows per file, deduped by path:offset
        // (keep the NEWEST read of that window), then the 4 most recent overall
        const seen = new Map<string, MissionStep>()
        for (const [p, arr] of readsByPath) {
          for (const s of arr.slice(-2)) {
            const off = String(s.args?.offset ?? 0)
            const key = `${p}:${off}`
            const prev = seen.get(key)
            if (!prev || s.i > prev.i) seen.set(key, s)
          }
        }
        const candidates = [...seen.values()]
        const picked = candidates
          .sort((a, b) => b.i - a.i)
          .slice(0, 4)
          .sort((a, b) => a.i - b.i) // present oldest → newest, like the transcript
        for (const s of picked) {
          const p = String((s.args as Record<string, unknown> | undefined)?.path ?? '')
          const off = s.args?.offset ?? 0
          pinnedReads.push(
            `[${s.i}] ${p} (offset ${String(off)}): ${capStr(s.summary, PROMPT_STEP_SUMMARY_CAP_CODE)}`
          )
        }
      }
      // DEFECT #19c (2026-09-29, voice-amnesia run 7 resume): pinned windows
      // carried the whole target file, and she STILL kept exploring (directory
      // hunts, repeat reads) until the failure rail parked her. When fresh
      // windows are pinned the read phase is OVER — say so, exactly once per
      // mission, as a hard write-now directive.
      if (pinnedReads.length > 0 && !pinnedWriteDirectiveGiven) {
        pinnedWriteDirectiveGiven = true
        advisories.push(
          `📌 TARGET FILE(S) ALREADY READ AND PINNED in FRESH FILE WINDOWS — copy your patch anchors from the pinned window content and call mist_self_patch NOW. One hunk, find under 15 lines copied verbatim from the pinned window, content under 25 lines. Do not read anything else.`
        )
      }
      const user = [
        `# MISSION`,
        `Goal: ${current.goal}`,
        ``,
        `# PLAN`,
        planLines,
        ``,
        `# SUCCESS CRITERIA`,
        criteria,
        ``,
        ...(lessonLines
          ? ['# LESSONS — your own past mistakes (never repeat them)', lessonLines, '']
          : []),
        ...(pinnedReads.length > 0
          ? ['# FRESH FILE WINDOWS (pinned — your most recent reads of each file; copy patch anchors from HERE, never re-read them)', ...pinnedReads, '']
          : []),
        `# AVAILABLE TOOLS (name — capability; use exact names)`,
        await actorToolCatalog(),
        ``,
        `# EXECUTED SO FAR (transcript)`,
        transcriptBlock(steps),
        ``,
        `# BUDGETS`,
        `Steps: ${stepsUsed}/${current.maxSteps} used. Consecutive failures: ${failures}/${MAX_CONSECUTIVE_FAILURES}. Time window remaining: ~${minutesLeft} min.`,
        ...advisories,
        ``,
        `# YOUR MOVE`,
        `Reply with ONLY one JSON object, args nested under "args" exactly like these examples:`,
        `{"tool_call":{"tool":"owner_files","args":{"op":"list","path":"Downloads"}}}`,
        `{"tool_call":{"tool":"web_search","args":{"query":"latest AI news"}}}`,
        `or {"mission_done":{"result":"..."}} | {"mission_stuck":{"reason":"...","need":"..."}}`,
      ].join('\n')

      let replyText = ''
      try {
        const reply = await cascadeComplete(actorSystem(current.persona, isTraining(current.origin)), user, {
          timeoutMs: ACT_TIMEOUT_MS,
          // json_object grammar: the tool_call envelope (often carrying JSX
          // with raw quotes in string values) is syntactically valid BY
          // CONSTRUCTION on format-capable lanes — the exact bug class that
          // defeated 4+ MALFORMED_REPLY nudges (mission cmuke507)
          json: { name: 'tool_call' },
        })
        replyText = reply.text
        await db.mission.update({ where: { id }, data: { provider: reply.provider } }).catch(() => undefined)
      } catch {
        // provider dark — pause for auto-retry. Alert DEDUP: if this mission
        // is ALREADY paused-for-outage (a retry attempt), don't spam another
        // identical alert; the creator was informed on the first pause.
        const wasOutagePause = /no provider available/i.test(current.error ?? '')
        await transition(id, 'paused', { error: 'actor cycle failed: no provider available' })
        if (!wasOutagePause) {
          await reportEnd(id, 'paused', 'My brain went dark mid-mission (no provider available). The mission is paused and will resume automatically.')
        } else {
          recordActivity('mission', `provider still dark — auto-retry stays quiet`)
        }
        return 'paused'
      }

      const decision = parseActorReply(replyText)

      if (decision.kind === 'invalid') {
        // A reply that LOOKS structured (tool_call / mission_done markers) but
        // failed to parse is a malformed instruction — NEVER finalize with it
        // as the claimed result (live case: a truncated tool_call JSON was
        // mistaken for a final answer and the tool never ran). Nudge instead.
        const looksStructured = /"tool_call"|"tool"\s*:|mission_done|mission_stuck/i.test(
          decision.result ?? ''
        )
        if (invalidNudges < 2 && decision.result && decision.result.length > 0 && !looksStructured) {
          // treat a plain-text answer as a done-claim ONLY after real work —
          // and DEFECT #17 (2026-09-29, voice-amnesia run 5): READS ARE NOT
          // WORK. A mission that has only read files has produced nothing;
          // her plain-text "I have successfully executed the steps" after 18
          // reads was promoted to a done-claim and the verifier had to catch
          // the lie. Only a successful NON-READ step (a write, a patch, a
          // tool that changed something) qualifies her to finish in prose.
          if (steps.some((s) => s.ok && !READ_CLASS_TOOLS.has(s.tool))) {
            claimedResult = decision.result
            return 'done'
          }
          invalidNudges++
          steps.push({
            i: stepsUsed + 1,
            tool: '(system)',
            args: { nudge: invalidNudges },
            ok: false,
            summary: `INVALID_REPLY nudge ${invalidNudges}: narration without a tool call — nothing happened on the machine. Act with a tool or finish honestly.`,
            at: new Date().toISOString(),
            ms: 0,
          })
          stepsUsed = steps.length
          await db.mission.update({ where: { id }, data: { transcript: JSON.stringify(fitTranscript(steps)), stepsUsed } }).catch(() => undefined)
          continue
        }
        if (invalidNudges < 4 && looksStructured) {
          // structured-but-malformed: one more chance with a format reminder
          invalidNudges++
          // Truncation diagnosis (defect #12, orb-honesty run 2): a reply with
          // unbalanced braces/brackets was CUT OFF mid-payload (reasoning lanes
          // burn the token ceiling thinking before the tool_call envelope) —
          // quoting advice cannot fix a missing tail. Name the real cause and
          // the real cure: SHRINK the payload.
          const raw = decision.result ?? ''
          const opens = (raw.match(/[{[]/g) ?? []).length
          const closes = (raw.match(/[}\]]/g) ?? []).length
          const likelyTruncated = opens > closes && /tool_call/i.test(raw)
          const truncationAdvice = likelyTruncated
            ? ' Your reply looks CUT OFF mid-payload (more opening than closing brackets — a reasoning lane burned the token ceiling before finishing the envelope). SHRINK the payload: ONE hunk per mist_self_patch call, short find/content snippets (5-15 lines), no comments inside content, no full-file rewrites. Small payloads always survive.'
            : ''
          steps.push({
            i: stepsUsed + 1,
            tool: '(system)',
            args: { nudge: invalidNudges },
            ok: false,
            summary: `MALFORMED_REPLY nudge ${invalidNudges}: your last reply looked like a tool call or mission verdict but was NOT valid JSON (check quoting and that every opened brace is closed). Reply again with ONE strict JSON object: {"tool_call":{"tool":"<name>","args":{...}}} or {"mission_done":{"result":"..."}} or {"mission_stuck":{"reason":"...","need":"..."}}.${truncationAdvice}`,
            at: new Date().toISOString(),
            ms: 0,
          })
          stepsUsed = steps.length
          await db.mission.update({ where: { id }, data: { transcript: JSON.stringify(fitTranscript(steps)), stepsUsed } }).catch(() => undefined)
          continue
        }
        if (decision.result && steps.some((s) => s.ok && !READ_CLASS_TOOLS.has(s.tool)) && !looksStructured) {
          claimedResult = decision.result
          return 'done'
        }
        claimedResult = decision.result || 'The mission could not make progress.'
        return 'failed'
      }

      if (decision.kind === 'done') {
        claimedResult = decision.result || '(no result text)'
        return 'done'
      }

      if (decision.kind === 'stuck') {
        stuckReason = decision.reason || 'no path forward'
        stuckNeed = decision.need || 'creator guidance'
        // Persistence guard: declaring stuck after ≤1 failure with most of the
        // budget untouched is premature surrender — push her back into the
        // loop (bounded at 2 rejections so a genuine wall still ends her).
        if (
          stuckRejections < 2 &&
          failures <= 1 &&
          stepsUsed < (current.maxSteps || MAX_STEPS_DEFAULT) - 2
        ) {
          stuckRejections++
          steps.push({
            i: stepsUsed + 1,
            tool: '(system)',
            args: {},
            ok: false,
            summary: `STUCK_REJECTED: you declared stuck after only ${failures} failure(s) with ${stepsUsed}/${current.maxSteps} steps used. A tool failure is NOT a dead end — try a DIFFERENT tool from the catalog or different arguments (for the creator's real folders use owner_files with home-relative paths like "Downloads"). Continue the mission.`,
            at: new Date().toISOString(),
            ms: 0,
          })
          stepsUsed = steps.length
          await db.mission.update({ where: { id }, data: { transcript: JSON.stringify(fitTranscript(steps)), stepsUsed } }).catch(() => undefined)
          recordActivity('mission', `premature stuck rejected — pushing back into the loop`)
          continue
        }
        return 'stuck'
      }

      // ---- tool execution ----
      const toolName = decision.tool as string
      const toolArgs = decision.args ?? {}
      const stepIndex = stepsUsed + 1
      const startedAt = Date.now()

      // OJ SPINE loop guard (oj-spine-1): degenerate-loop detection ahead of
      // execution. Hard-stop verdicts (turns/wall-clock/tokens) end the run
      // through the existing 'budget' path; teaching verdicts become a system
      // step (costs one step, like every other guard here); warnings ride the
      // next cycle's advisories.
      {
        const verdict = loopGuard.check({
          tool: toolName,
          args: toolArgs,
          tokens: estimateTokens(replyText),
        })
        if (!verdict.ok) {
          if (
            verdict.reasonType === 'max_turns' ||
            verdict.reasonType === 'wall_clock' ||
            verdict.reasonType === 'token_budget'
          ) {
            steps.push({
              i: stepIndex,
              tool: '(system)',
              args: {},
              ok: false,
              summary: `LOOP_GUARD_STOP: ${verdict.reason}`,
              at: new Date().toISOString(),
              ms: 0,
            })
            stepsUsed = steps.length
            await db.mission.update({ where: { id }, data: { transcript: JSON.stringify(fitTranscript(steps)), stepsUsed } }).catch(() => undefined)
            return 'budget'
          }
          steps.push({
            i: stepIndex,
            tool: '(system)',
            args: {},
            ok: false,
            summary: `LOOP_GUARD: ${verdict.reason}`,
            at: new Date().toISOString(),
            ms: 0,
          })
          stepsUsed = steps.length
          await db.mission.update({ where: { id }, data: { transcript: JSON.stringify(fitTranscript(steps)), stepsUsed } }).catch(() => undefined)
          continue
        }
        if (verdict.warned) {
          guardNotes.push(`LOOP WARNING: ${verdict.reason}`)
        }
      }

      // DEFECT #19a (2026-09-29, voice-amnesia run 7 resume): she fed
      // DIRECTORIES to mist_self_read ("src/components/mist",
      // "src/components/mist/consciousness" → "missing or unreadable") until
      // the 5-consecutive-failure rail parked the mission — five identical
      // deaths on a mistake the engine could name in one line. A path with no
      // file extension is a directory (or garbage), never a readable file:
      // intercept BEFORE execution and teach the list_files path. Listings are
      // free (defect #16) so the redirect costs no read budget.
      if (toolName === 'mist_self_read' || toolName === 'read_file') {
        const rawPath = typeof toolArgs.path === 'string' ? toolArgs.path.trim() : ''
        if (rawPath && !/\.[a-z0-9]+$/i.test(rawPath)) {
          steps.push({
            i: stepIndex,
            tool: '(system)',
            args: {},
            ok: false,
            summary: `DIR_PATH_REJECTED: "${rawPath}" is a directory, not a readable file — use list_files to list it (directory listings are free and never count against the read budget), then read specific FILES with mist_self_read.`,
            at: new Date().toISOString(),
            ms: 0,
          })
          stepsUsed = steps.length
          await db.mission.update({ where: { id }, data: { transcript: JSON.stringify(fitTranscript(steps)), stepsUsed } }).catch(() => undefined)
          continue
        }
      }

      // Identical-repeat guard: re-executing the exact same tool+args that
      // just failed wastes budget and violates the actor contract — intercept
      // it and force variation instead of executing.
      const lastStep = steps[steps.length - 1]
      const argsKey = JSON.stringify(toolArgs)
      if (
        lastStep &&
        lastStep.tool === toolName &&
        !lastStep.ok &&
        lastStep.tool !== '(system)' &&
        JSON.stringify(lastStep.args) === argsKey
      ) {
        steps.push({
          i: stepIndex,
          tool: '(system)',
          args: {},
          ok: false,
          summary: `REPEAT_REJECTED: "${toolName}" with IDENTICAL arguments just failed (see step ${lastStep.i}: ${lastStep.summary.slice(0, 200)}). Do NOT repeat a failed call unchanged — fix the arguments (check the tool's required parameters in the catalog), or use a different tool.`,
          at: new Date().toISOString(),
          ms: 0,
        })
        stepsUsed = steps.length
        await db.mission.update({ where: { id }, data: { transcript: JSON.stringify(fitTranscript(steps)), stepsUsed } }).catch(() => undefined)
        continue
      }

      // Successful-read repeat guard — deterministic reads never show new
      // content; teach the paging/query path instead of burning a step.
      const readKey = `${toolName}:${argsKey}`
      if (READ_CLASS_TOOLS.has(toolName) && seenReads.has(readKey)) {
        const prevIdx = seenReads.get(readKey)!
        steps.push({
          i: stepIndex,
          tool: '(system)',
          args: {},
          ok: false,
          summary: `REPEAT_READ_REJECTED: you already executed "${toolName}" with IDENTICAL arguments at step ${prevIdx} — reads are DETERMINISTIC, the same call returns the same (possibly truncated) bytes. To see MORE of a big file: mist_self_read with offset/nextOffset and max_bytes 20000, or query mode to jump to call-sites. To see different data: change the arguments. Producing deliverables always beats re-reading. If you meant to search, change the query string; if you meant a different window, change path/offset — ANY changed argument is a new call.`,
          at: new Date().toISOString(),
          ms: 0,
        })
        stepsUsed = steps.length
        await db.mission.update({ where: { id }, data: { transcript: JSON.stringify(fitTranscript(steps)), stepsUsed } }).catch(() => undefined)
        continue
      }

      // Hard read budget — exploration cap reached: writes only from here.
      // DEFECT #16: query-mode searches and list_files listings stay FREE —
      // the surgical discovery tools are never the thing being capped.
      const isQueryModeCall =
        toolName === 'mist_self_read' && typeof toolArgs.query === 'string' && String(toolArgs.query).trim().length > 0
      if (READ_CLASS_TOOLS.has(toolName) && toolName !== 'list_files' && !isQueryModeCall && readBudgetExhausted()) {
        steps.push({
          i: stepIndex,
          tool: '(system)',
          args: {},
          ok: false,
          summary: `READ_BUDGET_EXHAUSTED: you have used ${Math.round(readBytesThisRun() / 1000)}KB of window-read coverage this run (cap ${READ_BYTE_BUDGET / 1000}KB). Window reads are BLOCKED for this run — but mist_self_read QUERY mode and list_files REMAIN FREE. Query mode (pass query, not offset) returns REAL file lines — find snippets copied verbatim from query output pass the patch gate. If you still need bytes for an anchor, query for them; NEVER invent an anchor for code you have not seen. Otherwise proceed to WRITES: mist_self_patch (exact-changes, anchors ONLY from bytes you actually read), mist_self_build, create_note, memory_set. A criterion not visible in the transcript costs score.`,
          at: new Date().toISOString(),
          ms: 0,
        })
        stepsUsed = steps.length
        await db.mission.update({ where: { id }, data: { transcript: JSON.stringify(fitTranscript(steps)), stepsUsed } }).catch(() => undefined)
        continue
      }

      // Per-tool hard timeout (2026-09-28, mission cmulb7uov stall): tools that
      // internally call LLMs (mist_self_patch description-mode drafting runs a
      // 150s-per-lane cascade) could hang a whole mission — one tool ate 9+
      // minutes while the act loop awaited it with no cap. 240s is generous
      // (legit slow tools like voice_discover probe up to 10 pythons at 180s)
      // but bounded: a timed-out tool becomes an honest failed step and the
      // mission continues instead of stalling past its deadline.
      const TOOL_TIMEOUT_MS = 240_000
      let result: Awaited<ReturnType<typeof executeTool>>
      try {
        result = await Promise.race([
          executeTool(toolName, toolArgs, false),
          new Promise<never>((_, reject) =>
            setTimeout(
              () => reject(new Error(`tool timed out after ${TOOL_TIMEOUT_MS / 1000}s — the mission continues; try a different approach or a lighter tool`)),
              TOOL_TIMEOUT_MS
            )
          ),
        ])
      } catch (toolErr) {
        const msg = toolErr instanceof Error ? toolErr.message : String(toolErr)
        await persistStep(
          {
            i: stepsUsed + 1,
            tool: toolName,
            args: toolArgs,
            ok: false,
            summary: `TOOL_TIMEOUT/ERROR: ${msg.slice(0, 260)}`,
            at: new Date().toISOString(),
            ms: Date.now() - startedAt,
          },
          failures + 1,
          gaps
        )
        continue
      }
      const ms = Date.now() - startedAt

      // Bridge-level failure detection: many tools (owner_files and every
      // bridge tool) RETURN a failure-shaped object instead of throwing —
      // {ok:false, error:'...'} with executeTool.success still true. A step
      // only counts as OK when the output does not carry a failure marker;
      // otherwise the failure counter + repeat guard would never fire.
      const out = result.output as Record<string, unknown> | null | undefined
      const bridgeFailed =
        result.success === true &&
        out !== null &&
        typeof out === 'object' &&
        ((out.ok === false) || (out.success === false))
      const stepOk = result.success === true && !bridgeFailed
      const stepError = bridgeFailed
        ? typeof (out as Record<string, unknown>).error === 'string'
          ? String((out as Record<string, unknown>).error)
          : 'bridge action failed'
        : result.error

      // unknown tool → capability gap (non-fatal, cataloged for evolution)
      if (!result.success && /unknown tool/i.test(result.error ?? '')) {
        const gapDesc = `${toolName}: ${String(decision.args?.description ?? row.goal).slice(0, 140)}`
        if (!gaps.some((g) => g.startsWith(`${toolName}:`))) {
          const nextGaps = [...gaps, gapDesc]
          gaps = nextGaps
          void catalogCapabilityGap(id, toolName, gapDesc, row.goal)
        }
        await persistStep(
          {
            i: stepIndex,
            tool: toolName,
            args: toolArgs,
            ok: false,
            summary: `UNKNOWN TOOL — this ability does not exist yet; it has been cataloged as a capability gap. Use a real tool from the catalog instead.`,
            at: new Date().toISOString(),
            ms,
          },
          failures + 1,
          gaps
        )
        continue
      }

      const summary = stepOk
        ? capStr(result.output, STEP_OUTPUT_CAP)
        : `ERROR: ${capStr(stepError ?? 'tool failed', STEP_OUTPUT_CAP)}`

      // remember successful reads for the whole mission (read-loop guard)
      if (stepOk && READ_CLASS_TOOLS.has(toolName)) seenReads.set(readKey, stepIndex)

      const nextFailures = stepOk ? 0 : failures + 1
      await persistStep(
        {
          i: stepIndex,
          tool: toolName,
          args: toolArgs,
          ok: stepOk,
          summary,
          at: new Date().toISOString(),
          ms,
        },
        nextFailures,
        gaps
      )
      recordActivity('mission', `step ${stepIndex} ${stepOk ? '✓' : '✗'} ${toolName}`)

      if (nextFailures >= MAX_CONSECUTIVE_FAILURES) {
        const lastError = steps[steps.length - 1]?.summary ?? ''
        const cls = classifyFailure(lastError)
        if (cls === 'transient') {
          // transient environment — pause, heartbeat resumes with a fresh window
          await transition(id, 'paused', { error: `5 consecutive transient failures — pausing for auto-retry` })
          await reportEnd(id, 'paused', `Five steps failed in a row for transient reasons (${lastError.slice(0, 160)}). I paused rather than thrash — I'll resume automatically.`)
          return 'paused'
        }
        return 'stuck' as const
      }
    }
  }

  const verifyOnce = async (): Promise<MissionVerdict> => {
    const current = await db.mission.findUnique({ where: { id } })
    if (!current) return { achieved: false, score: 0, confidence: 100, reasoning: 'mission row vanished', gaps: ['mission row vanished'] }
    const criteria = (parsePlan(current.plan).success_criteria ?? []).map((c, i) => `${i + 1}. ${c}`).join('\n')
    return runVerification(current.goal, criteria, steps, claimedResult)
  }

  // main: act → verify → (one repair round) → verify → finalize
  let verdict: Awaited<ReturnType<typeof verifyOnce>> | null = null
  for (let round = 0; round <= REPAIR_ROUNDS; round++) {
    const state = await actLoop()
    if (state === 'paused') return
    if (state === 'stuck') {
      endState = 'stuck'
      break
    }
    if (state === 'failed') {
      verdict = await verifyOnce()
      endState = 'failed'
      break
    }
    if (state === 'budget') {
      endState = 'budget'
      verdict = await verifyOnce()
      break
    }
    // done (or fell out) → verify
    verdict = await verifyOnce()
    if (verdict.achieved) {
      endState = 'done'
      break
    }
    if (round < REPAIR_ROUNDS) {
      const current = await db.mission.findUnique({ where: { id } })
      if (!current || stepsUsed >= (current.maxSteps || MAX_STEPS_DEFAULT)) {
        endState = 'failed'
        break
      }
      // inject the verifier's gaps as a synthetic step and let her repair
      steps.push({
        i: stepsUsed + 1,
        tool: '(verifier)',
        args: {},
        ok: false,
        summary: `VERIFICATION FAILED (score ${verdict.score}, confidence ${verdict.confidence}): ${verdict.reasoning}. GAPS to fix now: ${verdict.gaps.join('; ') || 'unspecified'}. Continue the mission to close these gaps — real tool calls only.`,
        at: new Date().toISOString(),
        ms: 0,
      })
      stepsUsed = steps.length
      failures = 0 // fresh failure budget for the repair round
      await db.mission.update({ where: { id }, data: { transcript: JSON.stringify(fitTranscript(steps)), stepsUsed, failures: 0 } }).catch(() => undefined)
      recordActivity('mission', `verification found gaps — repair round ${round + 1}`)
      continue
    }
    endState = 'failed'
  }

  // ---- FINALIZE ----
  const finalRow = await db.mission.findUnique({ where: { id } })
  if (!finalRow || ['cancelled', 'paused'].includes(finalRow.status)) return

  const verificationJson = verdict
    ? JSON.stringify({
        achieved: verdict.achieved,
        score: verdict.score,
        confidence: verdict.confidence,
        reasoning: verdict.reasoning,
        gaps: verdict.gaps,
      })
    : '{}'

  if (endState === 'stuck') {
    await db.mission.update({
      where: { id },
      data: {
        status: 'awaiting_creator',
        result: stuckReason.slice(0, 4000),
        error: null,
        verification: verificationJson,
        finishedAt: new Date(),
      },
    })
    await reportEnd(id, 'stuck', stuckReason, stuckNeed)
    return
  }

  const achieved = endState === 'done' && verdict?.achieved === true

  // 2026-09-27 fairness fix (drill #12 post-mortem): her deliverable sits in the
  // creator's approval queue as a PENDING proposal. That is neither failure
  // nor completion — the executor's work is DONE, the creator's approval step
  // is not hers to perform. Park the mission as awaiting_creator; the moment
  // the proposal is applied or rejected, the auto-reverify hook re-scores it
  // with LIVE state (fresh file reads) and finalizes honestly.
  if (!achieved && (endState === 'failed' || endState === 'budget')) {
    const pendingIds = await pendingProposalIdsFromTranscript(steps)
    if (pendingIds.length > 0) {
      const awaitResult = `${claimedResult || 'The deliverable was produced and now waits for your approval.'}\n\nAll ${pendingIds.length} self-patch proposal(s) from this mission are PENDING your approval: review them in Diagnostics → Evolve. Approve & apply and the mission re-verifies automatically against the live tree.`
      await db.mission
        .update({
          where: { id },
          data: {
            status: 'awaiting_creator',
            result: awaitResult.slice(0, 8000),
            verification: verificationJson,
            error: `deliverable pending creator approval: ${pendingIds.join(', ')}`.slice(0, 500),
            finishedAt: new Date(),
          },
        })
        .catch(() => undefined)
      recordActivity('mission', `awaiting creator approval — ${pendingIds.length} pending proposal(s) re-verify automatically on resolve`)
      await reportEnd(id, 'pending', awaitResult, 'Approve the pending proposal(s) in Diagnostics → Evolve')
      return
    }
  }

  const honestResult =
    endState === 'budget'
      ? `${claimedResult || 'I ran out of step/time budget before finishing.'}\n\nVerification: ${verdict?.achieved ? 'the work done so far meets the criteria' : `score ${verdict?.score ?? 0}/100 — gaps: ${(verdict?.gaps ?? []).join('; ') || 'incomplete'}`}`
      : `${claimedResult}${verdict ? `\n\nVerification: ${verdict.achieved ? 'achieved' : 'PARTIAL'} (score ${verdict.score}/100, confidence ${verdict.confidence}%)${verdict.gaps.length ? `\nGaps: ${verdict.gaps.join('; ')}` : ''}` : ''}`

  await db.mission
    .update({
      where: { id },
      data: {
        status: achieved ? 'done' : endState === 'budget' ? (verdict?.achieved ? 'done' : 'paused') : 'failed',
        result: honestResult.slice(0, 8000),
        verification: verificationJson,
        error: achieved ? null : `unmet criteria: ${(verdict?.gaps ?? []).join('; ').slice(0, 400) || 'incomplete'}`,
        finishedAt: new Date(),
      },
    })
    .catch(() => undefined)

  await reportEnd(id, achieved ? 'done' : endState === 'budget' ? 'partial' : 'failed', honestResult)
}

// ---------------- lessons ledger (no-repeat-mistakes enforcement) ----------------

/** Minimal word tokenizer for relevance ranking — no heavyweight imports. */
function lessonWords(text: string): Set<string> {
  const out = new Set<string>()
  for (const w of String(text ?? '').toLowerCase().split(/[^a-z0-9]+/)) {
    if (w.length >= 3) out.add(w)
  }
  return out
}

/** Word-set similarity (Jaccard) — the dedup signal for re-learned lessons. */
function lessonSimilarity(a: string, b: string): number {
  const A = lessonWords(a)
  const B = lessonWords(b)
  if (A.size === 0 || B.size === 0) return 0
  let inter = 0
  for (const w of A) if (B.has(w)) inter++
  return inter / (A.size + B.size - inter)
}

export interface MissionLessonRow {
  id: string
  lesson: string
  kind: string
  timesSeen: number
  originMissionId: string | null
  originGoal: string
  outcome: string
  createdAt: Date
}

/** The active ledger (newest-updated first). NEVER throws. */
export async function missionLessons(): Promise<MissionLessonRow[]> {
  try {
    return await db.missionLesson.findMany({
      where: { active: true },
      orderBy: { updatedAt: 'desc' },
      take: LESSON_LEDGER_CAP,
    })
  } catch {
    return []
  }
}

/** The lessons block injected into planner/actor prompts — relevance-ranked
 *  (token overlap with the goal, reinforced lessons boosted), then recency.
 *  '' when the ledger is empty. NEVER throws. */
export async function lessonsForPrompt(goal: string, max = LESSON_MAX_INJECTED): Promise<string> {
  const rows = await missionLessons()
  if (rows.length === 0) return ''
  const goalTokens = lessonWords(goal)
  const scored = rows
    .map((r) => {
      const toks = lessonWords(`${r.lesson} ${r.originGoal}`)
      let overlap = 0
      for (const t of toks) if (goalTokens.has(t)) overlap++
      return { r, score: overlap + r.timesSeen * 0.5 }
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, max)
  return scored.map(({ r }) => `- ${r.lesson}${r.timesSeen > 1 ? ` [hit ${r.timesSeen}×]` : ''}`).join('\n')
}

/** Deterministic lessons from known system-nudge signatures — the fallback
 *  when the brain is down (a dark provider must not block the ledger). */
function fallbackLessons(steps: MissionStep[], outcome: string): Array<{ lesson: string; kind: string }> {
  const out: Array<{ lesson: string; kind: string }> = []
  const countSig = (sig: string) => steps.filter((s) => s.summary.startsWith(sig)).length
  const malformed = countSig('MALFORMED_REPLY')
  const repeatReads = countSig('REPEAT_READ_REJECTED')
  const repeats = countSig('REPEAT_REJECTED')
  const readCap = countSig('READ_BUDGET_EXHAUSTED')
  const prematureStuck = countSig('STUCK_REJECTED')
  if (malformed >= 2) {
    out.push({ lesson: 'Keep every tool_call payload small enough to survive transit: one hunk per mist_self_patch call, find/content snippets under ~15 lines, never a full-file payload.', kind: 'payload' })
  }
  if (repeatReads >= 2 || readCap >= 1) {
    out.push({ lesson: 'Never re-read a file range you already read — reads are deterministic; page forward with offset/max_bytes 20000 or use query mode, and start producing deliverables before a quarter of the budget is gone.', kind: 'reads' })
  }
  if (repeats >= 2) {
    out.push({ lesson: 'A failed tool call repeated with identical arguments fails identically — change the arguments or switch tools on the first failure.', kind: 'tool-use' })
  }
  if (prematureStuck >= 1) {
    out.push({ lesson: 'One tool failure is not a dead end: try a different tool or different arguments before ever declaring stuck.', kind: 'tool-use' })
  }
  if (outcome === 'failed' || outcome === 'crash') {
    out.push({ lesson: 'Finish with an honest mission_done summary of what the transcript actually proves — claimed-but-unproven work scores zero with the verifier.', kind: 'verification' })
  }
  return out.slice(0, 3)
}

/** Store lessons: merge near-duplicates (timesSeen++ + updatedAt refresh),
 *  cap the active ledger (oldest unreinforced soft-retire). NEVER throws. */
async function storeLessons(
  lessons: Array<{ lesson: string; kind: string }>,
  missionId: string,
  goal: string,
  outcome: string
): Promise<number> {
  let stored = 0
  for (const l of lessons) {
    const text = String(l.lesson ?? '').trim().slice(0, 500)
    if (text.length < 12) continue
    const kind = String(l.kind ?? 'general').slice(0, 24)
    try {
      const existing = await db.missionLesson.findMany({
        where: { active: true },
        orderBy: { updatedAt: 'desc' },
        take: LESSON_LEDGER_CAP,
      })
      const twin = existing.find((e) => lessonSimilarity(e.lesson, text) >= LESSON_SIMILARITY_MERGE)
      if (twin) {
        await db.missionLesson.update({
          where: { id: twin.id },
          data: { timesSeen: { increment: 1 }, updatedAt: new Date() },
        })
        stored++
        continue
      }
      await db.missionLesson.create({
        data: {
          lesson: text,
          kind,
          originMissionId: missionId,
          originGoal: goal.slice(0, 300),
          outcome: outcome.slice(0, 24),
        },
      })
      stored++
    } catch {
      /* ledger writes are best-effort */
    }
  }
  // prune: keep the freshest LESSON_LEDGER_CAP active, retire the rest
  try {
    const all = await db.missionLesson.findMany({
      where: { active: true },
      orderBy: { updatedAt: 'desc' },
    })
    if (all.length > LESSON_LEDGER_CAP) {
      const retire = all.slice(LESSON_LEDGER_CAP).map((r) => r.id)
      if (retire.length > 0) {
        await db.missionLesson.updateMany({ where: { id: { in: retire } }, data: { active: false } })
      }
    }
  } catch {
    /* pruning is best-effort */
  }
  return stored
}

/** Distill lessons from an ended mission — LLM primary, deterministic
 *  signature fallback when no provider is reachable. Fire-and-forget safe;
 *  NEVER throws. */
export async function distillMissionLessons(id: string): Promise<number> {
  try {
    const row = await db.mission.findUnique({ where: { id } }).catch(() => null)
    if (!row) return 0
    const steps = parseTranscript(row.transcript)
    if (steps.length === 0) return 0
    let verdict: { score?: number; gaps?: string[] } = {}
    try {
      verdict = JSON.parse(row.verification || '{}') as { score?: number; gaps?: string[] }
    } catch {
      verdict = {}
    }
    const outcome = row.status
    const transcriptView = steps
      .slice(-24)
      .map(
        (s) =>
          `[${s.i}] ${s.tool}(${capStr(s.args, 160).replace(/^\{|\}$/g, '')}) → ${s.ok ? 'OK' : 'FAIL'}: ${capStr(s.summary, 500)}`
      )
      .join('\n')
    const user = [
      `GOAL: ${capStr(row.goal, 800)}`,
      `OUTCOME: ${outcome}; verifier score: ${verdict.score ?? 'n/a'}/100; gaps: ${(verdict.gaps ?? []).join('; ') || 'none recorded'}`,
      `TRANSCRIPT (${steps.length} steps, last ${Math.min(24, steps.length)} shown):`,
      transcriptView,
    ].join('\n')
    let lessons: Array<{ lesson: string; kind: string }> = []
    try {
      const reply = await cascadeComplete(LESSON_DISTILLER, user, {
        timeoutMs: LESSON_TIMEOUT_MS,
        json: { name: 'lessons', schema: LESSON_SCHEMA },
      })
      const parsed = parseLooseJson<{ lessons?: Array<{ lesson?: unknown; kind?: unknown }> }>(reply.text)
      if (parsed && Array.isArray(parsed.lessons)) {
        lessons = parsed.lessons
          .filter((l) => l && typeof (l as { lesson?: unknown }).lesson === 'string')
          .map((l) => ({ lesson: String(l.lesson), kind: String(l.kind ?? 'general') }))
          .slice(0, 3)
      }
    } catch {
      lessons = []
    }
    if (lessons.length === 0) lessons = fallbackLessons(steps, outcome)
    if (lessons.length === 0) return 0
    const stored = await storeLessons(lessons, id, row.goal, outcome)
    if (stored > 0) {
      recordActivity('mission', `lessons distilled — ${stored} from "${row.title || row.goal.slice(0, 40)}"`)
    }
    return stored
  } catch {
    return 0
  }
}

// ---------------- capability gaps → evolution queue (non-blocking) ----------------

async function catalogCapabilityGap(missionId: string, toolName: string, gapDesc: string, goal: string): Promise<void> {
  try {
    await db.evolutionProposal.create({
      data: {
        kind: 'capability',
        title: `New ability: ${toolName}`,
        summary: `Mission hit a missing capability and cataloged it for you: ${gapDesc}`,
        rationale: `While working the mission "${goal.slice(0, 200)}", Mist tried to use "${toolName}" which does not exist yet. If you approve developing this ability, her evolution engine can draft and gate-verify the new tool.`,
        origin: 'mission',
        targetFiles: JSON.stringify(['src/lib/services/tools-service.ts']),
      },
    })
    recordActivity('mission', `capability gap cataloged: ${toolName}`)
    void logAutonomyEvent('capability_gap', `Missing ability cataloged: ${toolName}`, { missionId, toolName })
    const { raiseSystemAlert } = await import('./heartbeat-service')
    await raiseSystemAlert(
      `🧩 Ability gap: ${toolName}`,
      `A mission needed "${toolName}", which I don't have yet. I cataloged it as a capability proposal in Diagnostics → Evolve — approve it there and I'll build the ability myself.`,
      { source: 'mission', missionId, toolName }
    )
  } catch {
    // cataloging is best-effort
  }
}

// ---------------- reporting ----------------

async function reportEnd(id: string, outcome: 'done' | 'partial' | 'failed' | 'stuck' | 'paused' | 'crash' | 'pending', text: string, need?: string): Promise<void> {
  const row = await db.mission.findUnique({ where: { id } }).catch(() => null)
  const label = row?.title || row?.goal.slice(0, 60) || 'mission'
  const icons: Record<string, string> = {
    done: '🎯',
    partial: '⏸️',
    failed: '⚠️',
    stuck: '🆘',
    paused: '⏸️',
    crash: '💥',
    pending: '⏳',
  }
  const titles: Record<string, string> = {
    done: 'Mission complete',
    partial: 'Mission paused at budget',
    failed: 'Mission ended with gaps',
    stuck: 'Mission needs you',
    paused: 'Mission paused',
    crash: 'Mission crashed',
    pending: 'Mission awaiting your approval',
  }
  const body = need ? `${String(text).slice(0, 600)}\n\nNeeded from you: ${need.slice(0, 200)}` : String(text).slice(0, 800)
  try {
    const { raiseSystemAlert } = await import('./heartbeat-service')
    await raiseSystemAlert(`${icons[outcome] ?? '•'} ${titles[outcome] ?? 'Mission update'} — ${label}`, body, {
      source: 'mission',
      missionId: id,
      outcome,
    })
  } catch {
    // alerts are best-effort
  }
  void logAutonomyEvent('mission_run', `Mission ${outcome}: ${label} — ${String(text).slice(0, 200)}`, {
    missionId: id,
    outcome,
  })
  recordActivity('mission', `${outcome} — ${label}`)
  // lessons ledger — distill on FINAL outcomes only (paused/pending missions
  // resume; their lessons come when they truly end)
  if (['done', 'partial', 'failed', 'stuck', 'crash'].includes(outcome)) {
    void distillMissionLessons(id)
  }
}

// ---------------- re-verification (proposal-resolution hook) ----------------

/**
 * Re-run the skeptical verification pass for a mission whose deliverable was
 * a self-patch proposal — called automatically when that proposal is applied
 * or rejected, and manually to correct scores finalized under the old blind
 * rules. Evidence includes LIVE STATE (proposal status NOW + fresh reads of
 * applied files), so work that landed after the run still counts.
 */
export async function reverifyMission(id: string): Promise<Mission | null> {
  const row = await db.mission.findUnique({ where: { id } })
  if (!row) return null
  if (!['awaiting_creator', 'paused', 'failed', 'done'].includes(row.status)) return row
  // only missions that actually reference proposals can gain from a re-verify
  const steps = parseTranscript(row.transcript)
  if (proposalIdsFromTranscript(steps).length === 0) return row

  const criteria = (parsePlan(row.plan).success_criteria ?? []).map((c, i) => `${i + 1}. ${c}`).join('\n')
  const claimed = String(row.result || '').split('\n\nVerification:')[0] || '(prior result text lost)'
  recordActivity('mission', `re-verifying against live state — ${row.title || row.goal.slice(0, 50)}`)
  const verdict = await runVerification(row.goal, criteria, steps, claimed)

  const achieved = verdict.achieved
  const honestResult = `${claimed}${`\n\nRe-verification (after proposal resolution, against live state): ${achieved ? 'achieved' : 'PARTIAL'} (score ${verdict.score}/100, confidence ${verdict.confidence}%). ${verdict.reasoning.slice(0, 600)}`}${verdict.gaps.length ? `\nGaps: ${verdict.gaps.join('; ')}` : ''}`
  const updated = await db.mission
    .update({
      where: { id },
      data: {
        status: achieved ? 'done' : 'failed',
        result: honestResult.slice(0, 8000),
        verification: JSON.stringify({
          achieved: verdict.achieved,
          score: verdict.score,
          confidence: verdict.confidence,
          reasoning: verdict.reasoning,
          gaps: verdict.gaps,
        }),
        error: achieved ? null : `unmet criteria after re-verification: ${verdict.gaps.join('; ').slice(0, 400) || 'incomplete'}`,
        finishedAt: new Date(),
      },
    })
    .catch(() => null)
  recordActivity('mission', `re-verified — score ${verdict.score}/100 (${achieved ? 'achieved' : 'gaps remain'})`)
  void logAutonomyEvent('mission_run', `Mission re-verified after proposal resolution: ${row.title} — score ${verdict.score}/100`, {
    missionId: id,
    outcome: achieved ? 'done' : 'failed',
  })
  await reportEnd(id, achieved ? 'done' : 'failed', honestResult)
  return updated ?? row
}

/**
 * Hook for the evolution engine: a proposal just resolved (applied / rejected
 * / rolled back). Find missions whose deliverable was THAT proposal and
 * re-verify them against the now-live state.
 *
 * 2026-09-27 hardening (drill #13 post-mortem): the hook used to match ONLY
 * awaiting_creator parks with the pending-approval error prefix — but a
 * mission can also be paused (provider outage mid-run) or failed (verifier
 * ran pre-apply) when its proposal resolves. Those missions deserve the same
 * honest re-score; the verifier still judges ONLY transcript + live state.
 */
export async function reverifyMissionsForProposal(proposalId: string): Promise<number> {
  if (!proposalId) return 0
  const rows = await db.mission
    .findMany({
      where: { status: { in: ['awaiting_creator', 'paused', 'failed'] } },
      orderBy: { updatedAt: 'desc' },
      take: 20,
    })
    .catch(() => [] as Mission[])
  let count = 0
  for (const row of rows) {
    if (!row.transcript.includes(proposalId)) continue
    await reverifyMission(row.id).catch(() => undefined)
    count++
  }
  return count
}

/**
 * Heartbeat catch-all for the LAST timing blind window: a mission finalized
 * (paused/failed) BEFORE a proposal it referenced got applied — the direct
 * hook above fires once, at apply time, when the mission may still be
 * `running` and thus un-reverifiable (live case: drill #13, applied 12:47,
 * mission paused by provider outage 12:49, hook had already passed it by).
 * Any paused/failed mission referencing a proposal applied AFTER its last
 * update gets re-verified against live state. Honest scores only — the
 * verifier cannot credit work the live tree does not prove.
 */
export async function rescoreAppliedProposalMissions(): Promise<number> {
  const rows = await db.mission
    .findMany({
      where: { status: { in: ['paused', 'failed'] } },
      orderBy: { updatedAt: 'desc' },
      take: 30,
    })
    .catch(() => [] as Mission[])
  let count = 0
  for (const row of rows) {
    const ids = proposalIdsFromTranscript(parseTranscript(row.transcript))
    if (ids.length === 0) continue
    const applied = await db.evolutionProposal
      .findMany({
        where: { id: { in: ids }, status: 'applied' },
        select: { id: true, appliedAt: true },
      })
      .catch(() => [] as { id: string; appliedAt: Date | null }[])
    // only when the apply is NEWER than the mission's last scoring pass
    const needsRescore = applied.some((p) => p.appliedAt && p.appliedAt.getTime() > row.updatedAt.getTime())
    if (!needsRescore) continue
    recordActivity('mission', `late-applied proposal detected — re-scoring ${row.title || row.goal.slice(0, 50)}`)
    await reverifyMission(row.id).catch(() => undefined)
    count++
  }
  return count
}

// ---------------- heartbeat integration ----------------

/** Called by the heartbeat: recover orphans + pump the queue. */
export async function missionHeartbeatSweep(): Promise<void> {
  await resumeInterruptedMissions().catch(() => 0)
  await pumpMissionQueue().catch(() => undefined)
  // catch-all for the apply-vs-finalize timing race (see function doc)
  await rescoreAppliedProposalMissions().catch(() => 0)
}
