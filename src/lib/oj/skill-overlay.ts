// OJ skill overlay (port of openjarvis/learning/agents/skill_optimizer.py +
// skills/overlay.py — the DSPy/GEPA optimization loop, adapted "outside the
// box": no GPU, no training. The optimizer becomes ONE cheap LLM call that
// synthesizes 3 example input→output pairs from the skill's own description
// plus its past SkillExecution rows (the trace bucket), cached as a sidecar
// JSON at db/skills/overlays/{skillId}.json.
//
// Honesty rules (same as the Python loop's min_traces gate):
//   - no executions yet → overlay is null (nothing to optimize from)
//   - LLM failure → null (never a fabricated overlay)
//   - the original skill row is never touched (sidecar only, like optimized.toml)
import fs from 'node:fs/promises'
import path from 'node:path'
import { db } from '@/lib/db'
import { getZai } from '@/lib/services/zai'
import { recordActivity } from '@/lib/services/activity-service'
import { slugify } from '@/lib/services/skills-service'

const OVERLAY_DIR = path.join(process.cwd(), 'db', 'skills', 'overlays')

export interface SkillOverlayExample {
  input: string
  output: string
}

export interface SkillOverlay {
  skillId: string
  skillName: string
  optimizer: 'llm-fewshot' // the honest name of what replaced dspy/gepa here
  generatedAt: string
  executionCount: number
  description: string
  examples: SkillOverlayExample[]
}

/** Resolve a skill by id OR by name (callers hold either). */
async function resolveSkillRow(ref: string): Promise<{
  id: string
  name: string
  trigger: string
  steps: string
  notes: string
} | null> {
  const clean = ref.trim()
  if (!clean) return null
  const byId = await db.skill.findUnique({ where: { id: clean } }).catch(() => null)
  if (byId) return byId
  const byName = await db.skill.findUnique({ where: { name: clean } }).catch(() => null)
  return byName
}

function overlayPath(skillId: string): string {
  return path.join(OVERLAY_DIR, `${skillId}.json`)
}

async function readOverlayFile(skillId: string): Promise<SkillOverlay | null> {
  try {
    const raw = await fs.readFile(overlayPath(skillId), 'utf-8')
    const parsed: unknown = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && Array.isArray((parsed as SkillOverlay).examples)) {
      const o = parsed as SkillOverlay
      if (o.examples.length > 0) return o
    }
    return null
  } catch {
    return null
  }
}

async function writeOverlayFile(overlay: SkillOverlay): Promise<void> {
  await fs.mkdir(OVERLAY_DIR, { recursive: true })
  await fs.writeFile(overlayPath(overlay.skillId), JSON.stringify(overlay, null, 2), 'utf-8')
}

/** Robustly pull a JSON array of {input, output} pairs out of an LLM reply. */
function parseExamples(text: string): SkillOverlayExample[] {
  const trimmed = text.trim()
  // strip possible markdown fences
  const fenceMatch = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed)
  const candidate = fenceMatch ? fenceMatch[1] : trimmed
  // find the outermost JSON array
  const start = candidate.indexOf('[')
  const end = candidate.lastIndexOf(']')
  if (start < 0 || end <= start) return []
  try {
    const parsed: unknown = JSON.parse(candidate.slice(start, end + 1))
    if (!Array.isArray(parsed)) return []
    const out: SkillOverlayExample[] = []
    for (const item of parsed) {
      if (item && typeof item === 'object') {
        const rec = item as Record<string, unknown>
        if (typeof rec.input === 'string' && typeof rec.output === 'string' && rec.input && rec.output) {
          out.push({ input: rec.input.slice(0, 400), output: rec.output.slice(0, 600) })
        }
      }
    }
    return out.slice(0, 3)
  } catch {
    return []
  }
}

/**
 * Generate (or regenerate) the overlay for a skill — the LLM stands in for
 * DSPy/GEPA: it reads the skill description + up to 5 successful past
 * executions and distills 3 canonical input→output pairs. Returns null when
 * there are no executions yet (min_traces gate) or the LLM fails — never a
 * fabricated overlay.
 */
export async function buildOverlay(skillRef: string): Promise<SkillOverlay | null> {
  const row = await resolveSkillRow(skillRef)
  if (!row) return null

  const executions = await db.skillExecution.findMany({
    where: { skill_name: row.name, success: true },
    orderBy: { timestamp: 'desc' },
    take: 5,
  })
  if (executions.length === 0) return null // honest: nothing to optimize from yet

  const execDigest = executions
    .map((e, i) => {
      const input = (e.input ?? '(no input)').slice(0, 200)
      let outputNote = ''
      try {
        const parsed: unknown = JSON.parse(e.output)
        if (parsed && typeof parsed === 'object') {
          const rec = parsed as Record<string, unknown>
          outputNote = typeof rec.output === 'string' ? rec.output.slice(0, 200) : ''
        }
      } catch {
        outputNote = ''
      }
      return `${i + 1}. input: ${input}${outputNote ? ` → served: ${outputNote}` : ''}`
    })
    .join('\n')

  try {
    const zai = await getZai()
    const completion = (await Promise.race([
      zai.chat.completions.create({
        messages: [
          {
            role: 'assistant',
            content:
              'You optimize AI skill prompts with few-shot examples. Given a skill description and its past successful executions, write EXACTLY 3 canonical example input→output pairs that teach the assistant when and how to apply this skill. Respond with ONLY a JSON array: [{"input": "...", "output": "..."}] — no prose, no markdown fences.',
          },
          {
            role: 'user',
            content:
              `Skill name: ${row.name}\nTrigger: ${row.trigger}\n` +
              `Description/steps: ${(row.steps || row.notes || '(none)').slice(0, 1200)}\n\n` +
              `Past successful executions:\n${execDigest}`,
          },
        ],
        thinking: { type: 'disabled' },
      }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('overlay timeout')), 45_000)),
    ])) as { choices?: Array<{ message?: { content?: unknown } }> }
    const text = completion?.choices?.[0]?.message?.content
    if (typeof text !== 'string') return null
    const examples = parseExamples(text)
    if (examples.length === 0) return null

    const overlay: SkillOverlay = {
      skillId: row.id,
      skillName: row.name,
      optimizer: 'llm-fewshot',
      generatedAt: new Date().toISOString(),
      executionCount: executions.length,
      description: (row.steps || row.notes || row.trigger).slice(0, 200),
      examples,
    }
    await writeOverlayFile(overlay).catch(() => undefined) // cache is best-effort
    recordActivity('skill', `overlay synthesized for "${row.name}" (${examples.length} examples)`)
    return overlay
  } catch {
    return null // honest degradation — no overlay rather than a fabricated one
  }
}

/**
 * Get the overlay for a skill: cached sidecar first, else synthesize once.
 * Returns null when the skill doesn't exist, has no executions yet, or the
 * LLM is unavailable. Callers treat null as "no change to the skill prompt".
 */
export async function getOverlay(skillRef: string): Promise<SkillOverlay | null> {
  const row = await resolveSkillRow(skillRef)
  if (!row) return null
  const cached = await readOverlayFile(row.id)
  if (cached) return cached
  // Only synthesize when there is something to synthesize from (min-traces gate)
  const hasExecutions = await db.skillExecution
    .findFirst({ where: { skill_name: row.name, success: true }, select: { id: true } })
    .then((r) => r !== null)
    .catch(() => false)
  if (!hasExecutions) return null
  return buildOverlay(row.id)
}

/** Overlay file stem for a skill (audit/UI path). */
export function overlayRefForName(name: string): string {
  return slugify(name)
}
