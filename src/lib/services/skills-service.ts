// M.I.S.T. skills service — learned skills (Prisma is source of truth, SKILL.md mirrored)
import fs from 'node:fs/promises'
import path from 'node:path'
import { db } from '@/lib/db'
import { recordActivity } from './activity-service'
import { onSkillExecuted } from './learning-service'
import type { SkillExecution, SkillInfo, ToolInfo } from '@/lib/types'

const SKILLS_DIR = path.join(process.cwd(), 'db', 'skills')

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
  await importEcosystemSkills().catch(() => undefined)
  const rows = await db.skill.findMany({ orderBy: { createdAt: 'desc' } })
  return rows.map(toSkillInfo)
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
  }
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
  const known = new Set((await db.skill.findMany({ select: { name: true } })).map((s) => s.name.toLowerCase()))

  let imported = 0
  for (const file of files) {
    try {
      const raw = await fs.readFile(path.join(SKILLS_DIR, file), 'utf-8')
      const parsed = parseSkillFrontmatter(raw)
      if (!parsed) continue
      const name = (parsed.name ?? path.basename(file, '.md')).trim()
      if (!name || known.has(name.toLowerCase())) continue
      const trigger = (parsed.trigger ?? parsed.description ?? name).slice(0, 300)
      const steps = parsed.body.slice(0, 20_000)
      await db.skill.create({
        data: {
          name,
          trigger,
          steps,
          toolChain: '[]',
          notes: 'imported from an ecosystem SKILL.md file (OpenClaw/Anthropic frontmatter)',
        },
      })
      known.add(name.toLowerCase())
      imported++
      recordActivity('skill', `ecosystem SKILL.md imported: ${name}`)
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

/** Upsert a skill by name and mirror a SKILL.md file into db/skills/. */
export async function saveSkill(payload: SkillSavePayload): Promise<SkillInfo> {
  const name = payload.name.trim()
  const trigger = payload.trigger.trim()
  const steps = payload.steps ?? ''
  const notes = payload.notes ?? ''
  const toolChain = Array.isArray(payload.tool_chain)
    ? payload.tool_chain.filter((t): t is string => typeof t === 'string')
    : []

  const row = await db.skill.upsert({
    where: { name },
    update: { trigger, steps, notes, toolChain: JSON.stringify(toolChain) },
    create: { name, trigger, steps, notes, toolChain: JSON.stringify(toolChain) },
  })

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
