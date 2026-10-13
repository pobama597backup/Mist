// M.I.S.T. skills service — learned skills (Prisma is source of truth, SKILL.md mirrored)
import fs from 'node:fs/promises'
import path from 'node:path'
import { db } from '@/lib/db'
import { recordActivity } from './activity-service'
import { onSkillExecuted } from './learning-service'
import { shouldQuarantine, quarantineWrite } from '@/lib/arbiter/quarantine'
import { currentArbiterTurn } from '@/lib/arbiter/turn-context'
import type { SkillExecution, SkillInfo, ToolInfo } from '@/lib/types'

const SKILLS_DIR = path.join(process.cwd(), 'db', 'skills')

// ---------- Phase 3-a · R4: 5-minute list cache ----------
//
// context-builder calls listSkills() EVERY TURN (trigger matching), and the
// skills tab lists it too — each call was a full db.skill.findMany + the
// (already-throttled) ecosystem import check. The LIST RESULT (rows →
// SkillInfo metadata) is cached for 5 minutes; the raw SKILL.md FILES are
// never cached (importEcosystemSkills keeps its own 60s disk-scan throttle —
// unchanged by mandate). Invalidation is EVENT-driven, not just TTL: every
// save (owner UI, learning loop, quarantine-accept — it routes through
// saveSkill) and every delete drops the cache immediately.

interface SkillListCacheGlobal {
  __mistSkillListCache?: { at: number; rows: SkillInfo[] }
  /** test seam + honest metric: how many real DB scans listSkills performed */
  __mistSkillListScans?: number
}

const skillCacheGlobal = globalThis as unknown as SkillListCacheGlobal
const SKILL_LIST_TTL_MS = 5 * 60_000

/** Drop the cached skill list — call after ANY write that can change it.
 *  Phase 4-b: also drops the context-builder's memoized static tools block
 *  (its top-k candidates include skill tools; the core list has none today,
 *  but the invariant stays airtight for whenever that changes).
 *  Phase 7 (skills deep audit): also drops the Arbiter wiring's skill-chain
 *  cache (the chain-max effective-risk seam — same invalidation points:
 *  save / quarantine-accept / delete), so the next `skill:<name>` verdict
 *  sees the mutated chain immediately instead of within the 30s TTL. */
export function invalidateSkillListCache(): void {
  skillCacheGlobal.__mistSkillListCache = undefined
  try {
    // lazy import: context-builder imports this module (matchingSkills) — a
    // static back-import would be a cycle; the invalidation is fire-and-forget
    void import('./context-builder').then(({ invalidateToolBlockCache }) => invalidateToolBlockCache())
  } catch {
    /* best-effort — the block is static anyway */
  }
  try {
    // Phase 7: lazy for the same cycle-safety reason (wiring imports the
    // approval spine, not this module — but lazy keeps module-init order flat)
    void import('../arbiter/wiring').then(({ invalidateSkillChainCache }) => invalidateSkillChainCache())
  } catch {
    /* best-effort — the 30s TTL self-heals */
  }
}

/** How many DB scans listSkills has performed this process (test seam). */
export function skillListScanCount(): number {
  return skillCacheGlobal.__mistSkillListScans ?? 0
}

export function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'skill'
  )
}

function toSkillInfo(row: {
  name: string
  trigger: string
  steps: string
  toolChain: string
  notes: string
  uses: number
  origin?: string
  version?: number
  confidence?: number
  createdAt: Date
}): SkillInfo {
  let toolChain: string[] = []
  try {
    const parsed: unknown = JSON.parse(row.toolChain)
    if (Array.isArray(parsed)) toolChain = parsed.filter((t): t is string => typeof t === 'string')
  } catch {
    toolChain = []
  }
  return {
    name: row.name,
    trigger: row.trigger,
    steps: row.steps,
    tool_chain: toolChain,
    notes: row.notes,
    uses: row.uses,
    created_at: row.createdAt.toISOString(),
    origin: row.origin ?? 'user',
    version: row.version ?? 1,
    confidence: row.confidence ?? 0,
  }
}

export async function listSkills(): Promise<SkillInfo[]> {
  // Phase 3-a · R4: serve the cached list inside the TTL — the per-turn
  // context-builder call no longer pays a DB scan every chat turn.
  const cached = skillCacheGlobal.__mistSkillListCache
  if (cached && Date.now() - cached.at < SKILL_LIST_TTL_MS) {
    return cached.rows
  }
  await importEcosystemSkills().catch(() => undefined)
  const rows = await db.skill.findMany({ orderBy: { createdAt: 'desc' } })
  skillCacheGlobal.__mistSkillListScans = (skillCacheGlobal.__mistSkillListScans ?? 0) + 1
  const list = rows.map(toSkillInfo)
  skillCacheGlobal.__mistSkillListCache = { at: Date.now(), rows: list }
  return list
}

export async function listSkillExecutions(skillName?: string): Promise<SkillExecution[]> {
  const whereClause = skillName ? { skill_name: skillName } : {}
  const executions = await db.skillExecution.findMany({
    where: whereClause,
    orderBy: { timestamp: 'desc' },
    take: 100, // limit to most recent 100 executions
  })
  return executions.map((exec) => ({
    id: exec.id,
    skill_name: exec.skill_name,
    input: exec.input,
    output: typeof exec.output === 'string' ? JSON.parse(exec.output) : exec.output,
    success: exec.success,
    error: exec.error,
    timestamp: exec.timestamp.toISOString(),
  }))
}

// ---------- ecosystem SKILL.md importer (OpenClaw / Anthropic-style) ----------
//
// Drop any ecosystem skill file (frontmatter with `name` + `description`, the
// OpenClaw/Anthropic convention — our own mirrors add `trigger`) into
// db/skills/ and it LOADS NATIVELY on the next skills listing. First sighting
// is imported; files that mirror existing DB rows are left untouched.

interface ParsedFrontmatter {
  name: string | null
  description: string | null
  trigger: string | null
  body: string
  /** declared `tool_chain` from the mirror — null when the mirror doesn't declare one */
  toolChain: string[] | null
}

function parseSkillFrontmatter(raw: string): ParsedFrontmatter | null {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw)
  if (!match) return null
  const [, fmRaw, body] = match
  const fm: Record<string, string> = {}
  for (const line of fmRaw.split('\n')) {
    const kv = /^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/.exec(line.trim())
    if (kv) fm[kv[1].toLowerCase()] = kv[2].trim().replace(/^["']|["']$/g, '')
  }
  if (!fm.name && !fm.description && !fm.trigger) return null
  return {
    name: fm.name ?? null,
    description: fm.description ?? null,
    trigger: fm.trigger ?? null,
    body: body.trim(),
    // v-redesign repair: the mirror's tool_chain line (saveSkill always
    // writes one, even "[]") — parsed leniently so a hand-edited mirror
    // can never crash the listing.
    toolChain: parseToolChainFrontmatter(fm.tool_chain),
  }
}

/** `tool_chain: ["a","b"]` → ['a','b']. Accepts JSON arrays and lenient
 *  comma-separated forms; anything unreadable → null (treated as "not
 *  declared" — the caller must not guess a chain). */
function parseToolChainFrontmatter(value: string | undefined): string[] | null {
  if (value == null || value.trim() === '') return null
  const v = value.trim()
  try {
    const parsed = JSON.parse(v)
    if (Array.isArray(parsed) && parsed.every((x) => typeof x === 'string')) return parsed
    return null
  } catch {
    /* fall through to lenient */
  }
  if (!v.startsWith('[') || !v.endsWith(']')) return null
  const items = v
    .slice(1, -1)
    .split(',')
    .map((s) => s.trim().replace(/^["']|["']$/g, ''))
    .filter((s) => s.length > 0)
  return items
}

const ecosystemGlobal = globalThis as unknown as { __mistSkillImport?: { at: number; imported: number } }

export async function importEcosystemSkills(): Promise<number> {
  const g = (ecosystemGlobal.__mistSkillImport ??= { at: 0, imported: 0 })
  if (Date.now() - g.at < 60_000) return g.imported // scan at most once a minute
  g.at = Date.now()

  let files: string[] = []
  try {
    files = (await fs.readdir(SKILLS_DIR)).filter((f) => f.endsWith('.md'))
  } catch {
    return 0
  }
  const known = new Map(
    (await db.skill.findMany({ select: { name: true, toolChain: true } })).map((s) => [s.name.toLowerCase(), s])
  )

  let imported = 0
  for (const file of files) {
    try {
      const raw = await fs.readFile(path.join(SKILLS_DIR, file), 'utf-8')
      const parsed = parseSkillFrontmatter(raw)
      if (!parsed) continue
      const name = (parsed.name ?? path.basename(file, '.md')).trim()
      if (!name) continue
      const trigger = (parsed.trigger ?? parsed.description ?? name).slice(0, 300)
      const steps = parsed.body.slice(0, 20_000)
      const existing = known.get(name.toLowerCase())

      if (!existing) {
        // first sighting — import natively, carrying the mirror's declared
        // chain (v-redesign repair: the old import hardcoded '[]', so any
        // wipe-and-resurrect silently lobotomized the skill's chain — and
        // with it the Phase 7 chain-max risk arbitration).
        await db.skill.create({
          data: {
            name,
            trigger,
            steps,
            toolChain: JSON.stringify(parsed.toolChain ?? []),
            notes: 'imported from an ecosystem SKILL.md file (OpenClaw/Anthropic frontmatter)',
            source: 'ecosystem-import',
          },
        })
        known.set(name.toLowerCase(), { name, toolChain: JSON.stringify(parsed.toolChain ?? []) })
        imported++
        recordActivity('skill', `ecosystem SKILL.md imported: ${name}`)
      } else if (
        parsed.toolChain !== null &&
        parsed.toolChain.length > 0 &&
        existing.toolChain === '[]'
      ) {
        // wipe-heal (v-redesign repair): the DB row exists with an EMPTY
        // chain while its own mirror declares one — the fingerprint of the
        // 2026-10-12 wipe-and-resurrect (platform session boundary reset the
        // DB; the pre-fix import rebuilt rows chain-less). Owner intent is
        // safe: saveSkill mirrors every chain change (a deliberately cleared
        // chain writes tool_chain: [] into the mirror), so this state only
        // ever means DATA LOSS, never intent.
        await db.skill.update({
          where: { name },
          data: { toolChain: JSON.stringify(parsed.toolChain) },
        })
        known.set(name.toLowerCase(), { name, toolChain: JSON.stringify(parsed.toolChain) })
        imported++
        recordActivity('skill', `skill chain restored from mirror: ${name}`)
      }
    } catch {
      // unreadable file — skip it, never crash the listing
    }
  }
  g.imported = imported
  return imported
}

export interface SkillSavePayload {
  name: string
  trigger: string
  steps?: string
  tool_chain?: string[]
  notes?: string
}

/** Phase 2-c provenance + quarantine routing for skill saves.
 *  auto:true marks an INTERNAL auto-save (learning loop, self-upgrade cycle)
 *  — a tainted turn routes to the quarantine inbox instead of writing.
 *  Tool-path and owner-UI saves never set auto: the Arbiter (or the owner's
 *  own hands) already covered them. */
export interface SkillSaveContext {
  turnId?: string | null
  source?: string
  auto?: boolean
  trust?: 'owner' | 'derived'
}

/** Thrown when an internal auto-save was routed to the quarantine inbox —
 *  the write did NOT happen; the owner decides in the memory drawer. */
export class SkillQuarantinedError extends Error {
  constructor(name: string, reason: string) {
    super(`skill "${name}" quarantined — ${reason}; it waits in the quarantine inbox (memory drawer) for the owner`)
    this.name = 'SkillQuarantinedError'
  }
}

/** Upsert a skill by name and mirror a SKILL.md file into db/skills/. */
export async function saveSkill(payload: SkillSavePayload, ctx: SkillSaveContext = {}): Promise<SkillInfo> {
  const name = payload.name.trim()
  const trigger = payload.trigger.trim()
  const steps = payload.steps ?? ''
  const notes = payload.notes ?? ''
  const toolChain = Array.isArray(payload.tool_chain)
    ? payload.tool_chain.filter((t): t is string => typeof t === 'string')
    : []

  // Phase 2-c (S11): internal auto-saves from a tainted turn never land —
  // the exact proposed write goes to the quarantine inbox instead.
  if (ctx.auto === true) {
    const check = shouldQuarantine(ctx.turnId ?? null, { ...payload })
    if (check.hit) {
      await quarantineWrite('skill', JSON.stringify({ ...payload }), {
        source: ctx.source ?? 'internal',
        reason: check.reason,
        turnId: ctx.turnId ?? null,
      })
      throw new SkillQuarantinedError(name, check.reason)
    }
  }

  const trust = ctx.trust ?? (ctx.auto === true || ctx.turnId ? 'derived' : 'owner')
  const provenance = {
    trust,
    source: ctx.source ?? null,
    createdByTurn: ctx.turnId ?? null,
  }
  const row = await db.skill.upsert({
    where: { name },
    update: { trigger, steps, notes, toolChain: JSON.stringify(toolChain), ...provenance },
    create: { name, trigger, steps, notes, toolChain: JSON.stringify(toolChain), ...provenance },
  })
  invalidateSkillListCache() // Phase 3-a · R4: a write invalidates the 5-min list cache

  // Mirror SKILL.md (best-effort — DB remains source of truth)
  try {
    const frontmatter = [
      '---',
      `name: ${row.name}`,
      `trigger: ${row.trigger}`,
      `created: ${row.createdAt.toISOString()}`,
      `tool_chain: ${JSON.stringify(toolChain)}`,
      '---',
      '',
      `# ${row.name}`,
      '',
      '## Steps',
      steps.trim() || '(none recorded)',
      '',
      '## Notes',
      notes.trim() || '(none recorded)',
      '',
    ].join('\n')
    await fs.mkdir(SKILLS_DIR, { recursive: true })
    await fs.writeFile(path.join(SKILLS_DIR, `${slugify(name)}.md`), frontmatter, 'utf-8')
  } catch {
    // mirror is best-effort
  }

  recordActivity('skill', `learned skill saved: ${name}`)
  return toSkillInfo(row)
}

export async function deleteSkill(name: string): Promise<void> {
  try {
    await db.skill.delete({ where: { name } })
  } catch {
    // already gone — idempotent delete
  }
  try {
    await fs.unlink(path.join(SKILLS_DIR, `${slugify(name)}.md`))
  } catch {
    // best-effort file removal
  }
  invalidateSkillListCache() // Phase 3-a · R4: a delete invalidates the 5-min list cache
  recordActivity('skill', `skill removed: ${name}`)
}

/** Every saved skill is exposed to the LLM as a callable tool named `skill:<name>`. */
export async function skillTools(): Promise<ToolInfo[]> {
  const skills = await listSkills()
  return skills.map((s) => ({
    name: `skill:${s.name}`,
    description: `Learned skill: ${s.trigger}`,
    category: 'skill' as const,
    implemented: true,
    parameters: [
      { name: 'input', type: 'string' as const, required: false, description: 'Optional input for this skill' },
    ],
  }))
}

/** Execute a learned skill: bump uses, return its content as the tool output. */
export async function executeSkillTool(
  name: string,
  args: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const row = await db.skill.findUnique({ where: { name } })
  if (!row) throw new Error(`skill not found: ${name}`)
  const updated = await db.skill.update({ where: { name }, data: { uses: { increment: 1 } } })
  
  const skillInfo = toSkillInfo(updated)
  const input = typeof args.input === 'string' ? args.input : null
  
  try {
    // Record the execution
    const execution = await db.skillExecution.create({
      data: {
        skill_name: name,
        input,
        output: JSON.stringify({
          ...skillInfo,
          input,
        }),
        success: true,
        error: null,
      },
    })
    
    recordActivity('skill', `skill invoked: ${name} (uses: ${updated.uses})`)

    // v5 learning loop: fire-and-forget refinement signal (never breaks execution)
    try {
      onSkillExecuted({
        skill: name,
        input: input ?? undefined,
        output: `skill content served · uses: ${updated.uses}`,
        success: true,
        turnId: currentArbiterTurn()?.turnId ?? null,
      })
    } catch {
      // the learning loop must never break skill execution
    }

    return {
      ...skillInfo,
      input,
      execution_id: execution.id,
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error'
    
    // Record the failed execution
    await db.skillExecution.create({
      data: {
        skill_name: name,
        input,
        output: JSON.stringify({
          ...skillInfo,
          input,
        }),
        success: false,
        error: errorMessage,
      },
    })

    // v5 learning loop: fire-and-forget refinement signal (never breaks the error path)
    try {
      onSkillExecuted({
        skill: name,
        input: input ?? undefined,
        output: 'skill execution failed',
        success: false,
        error: errorMessage,
        turnId: currentArbiterTurn()?.turnId ?? null,
      })
    } catch {
      // the learning loop must never break skill execution
    }

    throw error
  }
}

// ---------- OJ skill overlays (few-shot distilled from past executions) ----------
//
// Port of the OpenJarvis SkillOptimizer overlay path: when a skill has past
// successful executions, ONE cheap LLM call distills 3 example input→output
// pairs, cached at db/skills/overlays/{id}.json. This loader injects them
// into the skill prompt block (context-builder) — null overlay = no change.

const overlayCacheGlobal = globalThis as unknown as {
  __mistSkillOverlayCache?: Map<string, { at: number; examples: Array<{ input: string; output: string }> | null }>
}

/** Cached overlay examples for a skill (60s TTL — null when none/no executions). */
export async function overlayExamplesFor(
  skillName: string
): Promise<Array<{ input: string; output: string }> | null> {
  const cache = (overlayCacheGlobal.__mistSkillOverlayCache ??= new Map())
  const hit = cache.get(skillName)
  if (hit && Date.now() - hit.at < 60_000) return hit.examples
  let examples: Array<{ input: string; output: string }> | null = null
  try {
    const { getOverlay } = await import('@/lib/oj/skill-overlay')
    const overlay = await getOverlay(skillName)
    examples = overlay ? overlay.examples : null
  } catch {
    examples = null // overlay is optional — never breaks the skill path
  }
  cache.set(skillName, { at: Date.now(), examples })
  return examples
}
