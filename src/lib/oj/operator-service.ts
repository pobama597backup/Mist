// OpenJarvis operators port (oj-ops-3) — always-on scheduled agents driven by
// manifests, the pattern from openjarvis/operators/ (manifest + manager tick):
//
//   db/operators/*.json  — builtin manifests (morning-brief, repo-watch,
//                          memory-curator, skill-hygiene): {slug, name,
//                          description, schedule{type,value}, enabled,
//                          budget{maxActionsPerRun,maxTokens}, systemPrompt}
//   ensureOperatorsSeeded() — idempotent manifest → Operator row upsert
//   listOperators()       — rows + humanized schedules + next-run state
//   runOperator(slug)     — collects honest context per operator, executes via
//                          LLM (z-ai-web-dev-sdk, backend-only), files reports /
//                          digests / approvals, records lastRunAt/lastStatus/runCount
//   operatorTick()        — the 60s scheduler tick: globalThis-guarded (50s
//                          throttle + in-flight set), self-swallowing; driven by
//                          the existing heartbeat beat (no second loop)
//
// State (next-run) persists in LongtermMemory under "operator:{slug}:state"
// (the Operator.stateKey pattern from the master plan). Side effects go through
// approval-service — operators themselves only ever compose reports and queue
// actions.

import fs from 'node:fs/promises'
import path from 'node:path'
import { db } from '@/lib/db'
import { getZai } from '@/lib/services/zai'
import { recordActivity } from '@/lib/services/activity-service'
import { logAutonomyEvent } from '@/lib/services/autonomy-service'
import { parseCronExpression, nextCronRunUtc } from '@/lib/services/scheduler-service'
import { createApproval, type CreateApprovalResult } from './approval-service'
import { generateDigest } from './digest-service'

const OPERATORS_DIR = path.join(process.cwd(), 'db', 'operators')
const DEFAULT_TZ = 'Africa/Lagos'
const TICK_THROTTLE_MS = 50_000 // one tick per ~60s window even if driven twice
const MAX_RESULT_CHARS = 4000

export interface OperatorManifest {
  slug: string
  name: string
  description: string
  systemPrompt: string
  schedule: { type: 'cron' | 'interval'; value: string | number } // cron expr | seconds
  enabled: boolean
  budget: { maxActionsPerRun: number; maxTokens: number }
  tools: string[]
  metrics?: string[]
}

interface OperatorState {
  nextRunAt: string | null
}

export interface OperatorOut {
  slug: string
  name: string
  description: string
  status: string
  schedule: { type: string; value: string | number }
  humanSchedule: string
  budget: { maxActionsPerRun: number; maxTokens: number }
  tools: string[]
  enabled: boolean
  lastRunAt: string | null
  lastStatus: string | null
  runCount: number
  nextRunAt: string | null
}

// ---------- manifest loading + seeding ----------

function parseManifest(raw: unknown, file: string): OperatorManifest | null {
  if (!raw || typeof raw !== 'object') return null
  const m = raw as Record<string, unknown>
  const slug = String(m.slug ?? '').trim()
  const sched = (m.schedule ?? {}) as Record<string, unknown>
  const budget = (m.budget ?? {}) as Record<string, unknown>
  if (!slug) return null
  const type = sched.type === 'cron' ? 'cron' : 'interval'
  const value = type === 'cron' ? String(sched.value ?? '').trim() : Math.max(60, Number(sched.value ?? 3600) | 0)
  if (type === 'cron' && !parseCronExpression(String(value))) return null
  return {
    slug,
    name: String(m.name ?? slug).slice(0, 80),
    description: String(m.description ?? '').slice(0, 400),
    systemPrompt: String(m.systemPrompt ?? '').slice(0, 4000),
    schedule: { type, value },
    enabled: m.enabled !== false,
    budget: {
      maxActionsPerRun: Math.max(0, Math.min(20, Number(budget.maxActionsPerRun ?? 3) | 0)),
      maxTokens: Math.max(128, Math.min(4096, Number(budget.maxTokens ?? 700) | 0)),
    },
    tools: Array.isArray(m.tools) ? (m.tools as unknown[]).map(String).slice(0, 12) : [],
    metrics: Array.isArray(m.metrics) ? (m.metrics as unknown[]).map(String).slice(0, 10) : [],
  }
}

async function readManifests(): Promise<OperatorManifest[]> {
  const out: OperatorManifest[] = []
  try {
    const files = (await fs.readdir(OPERATORS_DIR)).filter((f) => f.endsWith('.json')).sort()
    for (const f of files) {
      try {
        const raw = JSON.parse(await fs.readFile(path.join(OPERATORS_DIR, f), 'utf-8')) as unknown
        const manifest = parseManifest(raw, f)
        if (manifest) out.push(manifest)
      } catch {
        // a malformed manifest is skipped honestly — it never blocks the rest
      }
    }
  } catch {
    // no operators dir — callers see an empty list
  }
  return out
}

interface OperatorGlobal {
  seeded: boolean
  lastTickAt: number
  inFlight: Set<string>
}
function operatorGlobal(): OperatorGlobal {
  const g = globalThis as unknown as { __mistOperators?: OperatorGlobal }
  return (g.__mistOperators ??= { seeded: false, lastTickAt: 0, inFlight: new Set<string>() })
}

/** Idempotent: manifest files → Operator rows (paused rows keep their status). */
export async function ensureOperatorsSeeded(): Promise<number> {
  const g = operatorGlobal()
  if (g.seeded) return 0
  const manifests = await readManifests()
  let created = 0
  for (const m of manifests) {
    try {
      const existing = await db.operator.findUnique({ where: { slug: m.slug } })
      const manifestJson = JSON.stringify(m)
      if (!existing) {
        // interval operators start one interval from seeding; cron operators
        // start at their next cron occurrence
        const next = nextRunForSchedule(m) ?? new Date(Date.now() + 60_000)
        await db.operator.create({
          data: {
            slug: m.slug,
            name: m.name,
            manifest: manifestJson,
            status: m.enabled ? 'active' : 'paused',
            stateKey: `operator:${m.slug}:state`,
          },
        })
        await saveState(m.slug, { nextRunAt: next.toISOString() })
        created++
      } else if (existing.manifest !== manifestJson) {
        // manifest file changed on disk — refresh the definition, keep status
        await db.operator.update({ where: { slug: m.slug }, data: { name: m.name, manifest: manifestJson } })
      }
    } catch {
      // per-operator seeding failure never blocks the rest
    }
  }
  if (created > 0) {
    recordActivity('operators', `seeded ${created} builtin operator${created === 1 ? '' : 's'} from db/operators`)
  }
  g.seeded = true
  return created
}

// ---------- schedule math (reuses scheduler-service cron parsing) ----------

function nextRunForSchedule(m: OperatorManifest, fromMs?: number): Date | null {
  if (m.schedule.type === 'cron') {
    return nextCronRunUtc(String(m.schedule.value), DEFAULT_TZ, fromMs)
  }
  const seconds = Math.max(60, Number(m.schedule.value) || 3600)
  return new Date((fromMs ?? Date.now()) + seconds * 1000)
}

function humanSchedule(m: OperatorManifest): string {
  if (m.schedule.type === 'interval') {
    const seconds = Math.max(60, Number(m.schedule.value) || 3600)
    const h = Math.floor(seconds / 3600)
    const min = Math.floor((seconds % 3600) / 60)
    const parts: string[] = []
    if (h) parts.push(`${h}h`)
    if (min) parts.push(`${min}m`)
    return `every ${parts.join(' ') || '60s'}`
  }
  const expr = String(m.schedule.value)
  const parsed = parseCronExpression(expr)
  if (!parsed) return `cron '${expr}' (${DEFAULT_TZ})`
  const daily =
    parsed.doms.length === 31 && parsed.months.length === 12 && parsed.dows.length === 7 &&
    parsed.hours.length === 1 && parsed.minutes.length === 1
  if (daily) {
    return `daily at ${String(parsed.hours[0]).padStart(2, '0')}:${String(parsed.minutes[0]).padStart(2, '0')} (${DEFAULT_TZ})`
  }
  return `cron '${expr}' (${DEFAULT_TZ})`
}

// ---------- operator state (LongtermMemory, the stateKey pattern) ----------

async function loadState(slug: string): Promise<OperatorState> {
  const key = `operator:${slug}:state`
  try {
    const row = await db.longtermMemory.findUnique({ where: { key } })
    if (row) {
      const parsed = JSON.parse(row.value) as OperatorState
      if (parsed && typeof parsed === 'object' && typeof parsed.nextRunAt !== 'undefined') return parsed
    }
  } catch {
    // fall through to empty state
  }
  return { nextRunAt: null }
}

async function saveState(slug: string, state: OperatorState): Promise<void> {
  const key = `operator:${slug}:state`
  try {
    await db.longtermMemory.upsert({
      where: { key },
      create: { key, value: JSON.stringify(state) },
      update: { value: JSON.stringify(state) },
    })
  } catch {
    // state persistence is best-effort; the Operator row still carries run facts
  }
}

function parseManifestFromRow(row: { slug: string; manifest: string }): OperatorManifest | null {
  try {
    return parseManifest(JSON.parse(row.manifest || '{}'), row.slug)
  } catch {
    return null
  }
}

// ---------- listing ----------

export async function listOperators(): Promise<OperatorOut[]> {
  await ensureOperatorsSeeded()
  try {
    const rows = await db.operator.findMany({ orderBy: { slug: 'asc' } })
    const out: OperatorOut[] = []
    for (const row of rows) {
      const m = parseManifestFromRow(row)
      if (!m) continue
      const state = await loadState(row.slug)
      out.push({
        slug: row.slug,
        name: row.name,
        description: m.description,
        status: row.status,
        schedule: m.schedule,
        humanSchedule: humanSchedule(m),
        budget: m.budget,
        tools: m.tools,
        enabled: m.enabled,
        lastRunAt: row.lastRunAt ? row.lastRunAt.toISOString() : null,
        lastStatus: row.lastStatus ?? null,
        runCount: row.runCount,
        nextRunAt: state.nextRunAt,
      })
    }
    return out
  } catch {
    return []
  }
}

// ---------- execution ----------

function extractJson(text: string): unknown | null {
  const start = text.indexOf('{')
  if (start === -1) return null
  let depth = 0
  for (let i = start; i < text.length; i++) {
    if (text[i] === '{') depth++
    else if (text[i] === '}') {
      depth--
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1)) as unknown
        } catch {
          return null
        }
      }
    }
  }
  return null
}

async function operatorLLM(m: OperatorManifest, userContent: string): Promise<{ text: string; error?: string }> {
  try {
    const zai = await getZai()
    const completion = await zai.chat.completions.create({
      messages: [
        { role: 'assistant', content: m.systemPrompt || 'You are a MIST operator. Do your job honestly with the data provided.' },
        { role: 'user', content: userContent },
      ],
      max_tokens: m.budget.maxTokens,
      thinking: { type: 'disabled' },
    })
    const text = String(completion.choices[0]?.message?.content ?? '').trim()
    if (!text) return { text: '', error: 'the operator brain returned no text' }
    return { text }
  } catch (err) {
    return { text: '', error: err instanceof Error ? err.message : 'operator brain call failed' }
  }
}

async function raiseOperatorAlert(title: string, body: string, meta: Record<string, unknown>): Promise<void> {
  try {
    await db.alert.create({
      data: { kind: 'system', title, body: body.slice(0, MAX_RESULT_CHARS), meta: JSON.stringify({ ...meta, source: 'operator' }) },
    })
  } catch {
    // alert delivery is best-effort
  }
}

// ---- per-operator context collectors (honest data only) ----

async function collectRepoWatch(): Promise<string> {
  const lines: string[] = []
  try {
    const raw = JSON.parse(await fs.readFile(path.join(process.cwd(), 'db', 'watchlist.json'), 'utf-8')) as {
      entries?: Array<Record<string, unknown>>
      last_sweep_at?: string | null
    }
    lines.push(`Watchlist (last sweep ${raw.last_sweep_at ?? 'unknown'}):`)
    for (const e of raw.entries ?? []) {
      lines.push(
        `- ${String(e.label ?? e.repo ?? 'repo')} (${String(e.repo ?? '?')}): version ${String(e.version ?? '?')}` +
          (e.version_label ? ` — ${String(e.version_label).slice(0, 120)}` : '') +
          (e.changed ? ' [CHANGED since last check]' : '') +
          (e.error ? ` [error: ${String(e.error)}]` : '')
      )
    }
  } catch {
    lines.push('watchlist unavailable (db/watchlist.json could not be read)')
  }
  try {
    const raw = JSON.parse(await fs.readFile(path.join(process.cwd(), 'db', 'openclaw', 'state.json'), 'utf-8')) as {
      latest_version?: string
      checked_at?: string
      last_changed_at?: string
      last_error?: string | null
      history?: Array<{ version?: string; seen_at?: string; notes_excerpt?: string }>
    }
    lines.push(
      `\nOpenClaw upstream digest: latest ${raw.latest_version ?? '?'} (checked ${raw.checked_at ?? '?'}, last change ${raw.last_changed_at ?? '?'})${raw.last_error ? ` — last check error: ${raw.last_error}` : ''}`
    )
    for (const h of (raw.history ?? []).slice(0, 3)) {
      lines.push(`- ${h.version ?? '?'} (seen ${h.seen_at ?? '?'}): ${String(h.notes_excerpt ?? '').slice(0, 180)}`)
    }
  } catch {
    lines.push('openclaw upstream state unavailable (db/openclaw/state.json could not be read)')
  }
  return lines.join('\n')
}

async function collectMemoryCurator(): Promise<{ context: string; rows: Array<{ key: string; value: string }> }> {
  try {
    const rows = await db.longtermMemory.findMany({ where: { trust: 'untrusted' }, take: 20 })
    const context = rows.length
      ? ['Untrusted (quarantined) longterm-memory rows:'].concat(rows.map((r) => `- ${r.key}: ${r.value.slice(0, 140)}`)).join('\n')
      : 'No untrusted (quarantined) longterm-memory rows — nothing to review.'
    return { context, rows: rows.map((r) => ({ key: r.key, value: r.value })) }
  } catch {
    return { context: 'longterm memory unavailable (database read failed)', rows: [] }
  }
}

async function collectSkillHygiene(): Promise<{ context: string; stale: string[] }> {
  try {
    const skills = await db.skill.findMany({ orderBy: { updatedAt: 'desc' } })
    const cutoff = Date.now() - 14 * 24 * 3600_000
    const lines: string[] = []
    const stale: string[] = []
    for (const s of skills) {
      const lastActivity = Math.max(s.updatedAt.getTime(), s.createdAt.getTime())
      const unusedDays = Math.floor((Date.now() - lastActivity) / 86_400_000)
      const isStale = lastActivity < cutoff
      if (isStale) stale.push(s.name)
      lines.push(`- ${s.name}: ${s.uses} uses, origin ${s.origin}, last touched ${unusedDays}d ago${isStale ? ' [STALE]' : ''}`)
    }
    const context = skills.length
      ? [`Skill list (${skills.length} skills; stale = unused for over 14 days):`].concat(lines).join('\n')
      : 'No skills registered — nothing to review.'
    return { context, stale }
  } catch {
    return { context: 'skills unavailable (database read failed)', stale: [] }
  }
}

// ---- the operator run itself ----

export interface RunOperatorResult {
  ok: boolean
  slug: string
  status: 'ok' | 'error' | 'degraded'
  result: string
  digestId?: string
  approvalsQueued?: number
}

export async function runOperator(
  slug: string,
  opts: { origin?: 'manual' | 'schedule' } = {}
): Promise<RunOperatorResult> {
  const origin = opts.origin ?? 'manual'
  let m: OperatorManifest | null = null
  try {
    const row = await db.operator.findUnique({ where: { slug } })
    if (!row) {
      return { ok: false, slug, status: 'error', result: `operator '${slug}' is not registered` }
    }
    m = parseManifestFromRow(row)
    if (!m) {
      return { ok: false, slug, status: 'error', result: `operator '${slug}' has an unreadable manifest` }
    }
  } catch (err) {
    return { ok: false, slug, status: 'error', result: err instanceof Error ? err.message : 'operator lookup failed' }
  }
  const manifest = m // non-null from here
  const fail = async (message: string): Promise<RunOperatorResult> => {
    await recordRun(slug, 'error', message, origin, manifest)
    return { ok: false, slug, status: 'error', result: message }
  }
  try {
    recordActivity('operators', `operator '${slug}' started (${origin})`)

    // ---- per-operator execution ----
    if (slug === 'morning-brief') {
      // the morning brief IS a digest: collected sections → LLM synthesis (with
      // this operator's voice) → Digest row → chat alert. One LLM call total.
      try {
        const digest = await generateDigest('daily', { systemPrompt: manifest.systemPrompt })
        const summary =
          `digest filed: ${digest.headline} — ${digest.items.length} item${digest.items.length === 1 ? '' : 's'}, tone ${digest.tone}` +
          (digest.degraded ? ' (LLM synthesis unavailable — honest item list used)' : '')
        await recordRun(slug, digest.degraded ? 'degraded' : 'ok', summary, origin, manifest)
        return { ok: true, slug, status: digest.degraded ? 'degraded' : 'ok', result: summary, digestId: digest.id }
      } catch (err) {
        return await fail(`digest generation failed: ${err instanceof Error ? err.message : 'unknown error'}`)
      }
    }

    if (slug === 'repo-watch') {
      const context = await collectRepoWatch()
      const llm = await operatorLLM(manifest, `[OPERATOR TICK] Upstream state (honest data only):\n\n${context}`)
      if (llm.error) {
        // honest degradation: deliver the raw collected state as the report
        const degraded = `LLM summary unavailable (${llm.error}) — raw upstream state:\n${context}`.slice(0, MAX_RESULT_CHARS)
        await raiseOperatorAlert('🛰️ Repo watch (degraded)', degraded, { operator: slug, degraded: true })
        await recordRun(slug, 'degraded', degraded, origin, manifest)
        return { ok: true, slug, status: 'degraded', result: degraded }
      }
      await raiseOperatorAlert('🛰️ Repo watch', llm.text, { operator: slug })
      await recordRun(slug, 'ok', llm.text, origin, manifest)
      return { ok: true, slug, status: 'ok', result: llm.text.slice(0, MAX_RESULT_CHARS) }
    }

    if (slug === 'memory-curator') {
      const { context, rows } = await collectMemoryCurator()
      const llm = await operatorLLM(manifest, `[OPERATOR TICK] Review these quarantined memory rows and reply with the JSON object:\n\n${context}`)
      let proposals: string[] = []
      let note = llm.error
        ? `LLM triage unavailable (${llm.error}) — nothing proposed this run; ${rows.length} untrusted rows remain for review`
        : ''
      if (!llm.error) {
        const parsed = extractJson(llm.text) as { propose?: unknown; reason?: unknown } | null
        if (parsed && Array.isArray(parsed.propose) && parsed.propose.every((p) => typeof p === 'string')) {
          const validKeys = new Set(rows.map((r) => r.key))
          proposals = (parsed.propose as string[]).filter((k) => validKeys.has(k)).slice(0, manifest.budget.maxActionsPerRun)
          note = typeof parsed.reason === 'string' ? parsed.reason.slice(0, 200) : ''
          if (proposals.length < (parsed.propose as string[]).length) {
            note += `${note ? ' — ' : ''}filtered to known keys and the per-run action budget`
          }
        } else {
          note = 'the brain did not return a usable JSON proposal — nothing queued this run (no rows were invented)'
        }
      }
      let queued = 0
      for (const key of proposals) {
        const res = await createApproval({
          actionType: 'memory_trust_flip',
          title: `Promote memory "${key}" to trusted`,
          payload: { key },
          origin: 'operator',
        })
        if (res.ok && !res.deniedByMemory) queued++
      }
      const result = `reviewed ${rows.length} untrusted rows; ${queued} trust-flip proposal${queued === 1 ? '' : 's'} queued${note ? ` — ${note}` : ''}`
      await recordRun(slug, queued > 0 || !llm.error ? 'ok' : 'degraded', result, origin, manifest)
      return { ok: true, slug, status: 'ok', result, approvalsQueued: queued }
    }

    if (slug === 'skill-hygiene') {
      const { context, stale } = await collectSkillHygiene()
      const llm = await operatorLLM(manifest, `[OPERATOR TICK] Review the skill list and reply with the JSON object:\n\n${context}`)
      let proposals: string[] = []
      let note = llm.error
        ? `LLM triage unavailable (${llm.error}) — nothing proposed this run; ${stale.length} stale skills detected by the deterministic check`
        : ''
      if (!llm.error) {
        const parsed = extractJson(llm.text) as { archive?: unknown; reason?: unknown } | null
        if (parsed && Array.isArray(parsed.archive) && parsed.archive.every((p) => typeof p === 'string')) {
          const known = new Set(stale)
          proposals = (parsed.archive as string[]).filter((s) => known.has(s)).slice(0, manifest.budget.maxActionsPerRun)
          note = typeof parsed.reason === 'string' ? parsed.reason.slice(0, 200) : ''
          if (proposals.length < (parsed.archive as string[]).length) {
            note += `${note ? ' — ' : ''}filtered to deterministically-stale skills and the per-run action budget`
          }
        } else {
          note = 'the brain did not return a usable JSON proposal — nothing queued this run (no skills were invented)'
        }
      }
      let queued = 0
      for (const name of proposals) {
        const res = await createApproval({
          actionType: 'skill_archive',
          title: `Archive skill "${name}"`,
          payload: { skill: name },
          origin: 'operator',
        })
        if (res.ok && !res.deniedByMemory) queued++
      }
      const result = `listed skills (${stale.length} stale by the 14-day check); ${queued} archive proposal${queued === 1 ? '' : 's'} queued${note ? ` — ${note}` : ''}`
      await recordRun(slug, queued > 0 || !llm.error ? 'ok' : 'degraded', result, origin, manifest)
      return { ok: true, slug, status: 'ok', result, approvalsQueued: queued }
    }

    // unknown slug with a valid manifest: honest, no generic magic
    return await fail(
      `operator '${slug}' has a manifest but no registered execution routine — nothing was run (honest no-op)`
    )
  } catch (err) {
    return await fail(err instanceof Error ? err.message : 'operator run crashed')
  }
}

/** Bookkeeping: Operator row + schedule state + autonomy ledger. */
async function recordRun(
  slug: string,
  status: 'ok' | 'error' | 'degraded',
  result: string,
  origin: 'manual' | 'schedule',
  manifest: OperatorManifest
): Promise<void> {
  const trimmed = result.slice(0, MAX_RESULT_CHARS)
  try {
    await db.operator.update({
      where: { slug },
      data: { lastRunAt: new Date(), lastStatus: status, runCount: { increment: 1 } },
    })
  } catch {
    // row update is best-effort
  }
  if (origin === 'schedule') {
    const next = nextRunForSchedule(manifest) ?? new Date(Date.now() + 3_600_000)
    await saveState(slug, { nextRunAt: next.toISOString() })
  }
  await logAutonomyEvent('cron_run', `operator '${slug}' ${status} (${origin}): ${trimmed.slice(0, 160)}`, {
    operator: slug,
    status,
    origin,
  })
}

// ---------- pause / resume ----------

export async function setOperatorStatus(slug: string, status: 'active' | 'paused'): Promise<{ ok: boolean; error?: string }> {
  try {
    const row = await db.operator.findUnique({ where: { slug } })
    if (!row) return { ok: false, error: `operator '${slug}' is not registered` }
    await db.operator.update({ where: { slug }, data: { status } })
    recordActivity('operators', `operator '${slug}' ${status === 'active' ? 'resumed' : 'paused'}`)
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'failed to update operator' }
  }
}

// ---------- the guarded tick (driven by the heartbeat's 60s beat) ----------

/** One scheduler pass: seed if needed, then fire every active, due operator.
 *  GlobalThis-guarded (50s throttle + per-operator in-flight set) so it is
 *  safe to call from multiple host loops. NEVER throws. */
export async function operatorTick(): Promise<number> {
  const g = operatorGlobal()
  const now = Date.now()
  if (now - g.lastTickAt < TICK_THROTTLE_MS) return 0
  g.lastTickAt = now
  let fired = 0
  try {
    await ensureOperatorsSeeded()
    const rows = await db.operator.findMany({ where: { status: 'active' } })
    for (const row of rows) {
      if (g.inFlight.has(row.slug)) continue
      const m = parseManifestFromRow(row)
      if (!m || !m.enabled) continue
      const state = await loadState(row.slug)
      let nextRunAt = state.nextRunAt ? Date.parse(state.nextRunAt) : NaN
      if (!Number.isFinite(nextRunAt)) {
        // first scheduling for a row that predates state (or state was lost)
        const seeded = nextRunForSchedule(m)
        nextRunAt = seeded ? seeded.getTime() : Date.now()
        await saveState(row.slug, { nextRunAt: new Date(nextRunAt).toISOString() })
      }
      if (Date.now() < nextRunAt) continue
      g.inFlight.add(row.slug)
      fired++
      void runOperator(row.slug, { origin: 'schedule' })
        .catch(() => undefined)
        .finally(() => {
          g.inFlight.delete(row.slug)
        })
    }
  } catch {
    // the tick must never throw to its host loop
  }
  return fired
}

/** Boot hook: seed manifests + one immediate tick. The 60s cadence is driven by
 *  the existing heartbeat beat (operatorTick's own throttle makes double
 *  driving harmless) — deliberately NO second interval loop here. */
export function ensureOperatorWatch(): void {
  void operatorTick().catch(() => undefined)
}
