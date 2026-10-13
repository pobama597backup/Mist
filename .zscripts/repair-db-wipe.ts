/**
 * v-redesign · DB-wipe repair (2026-10-12 incident)
 *
 * A platform session boundary reset db/custom.db between Phase 8's green
 * closeout (14:12Z) and this session (16:32Z): conversations, the audit
 * history, the execution ledger, provider keys, and every skill row were
 * lost. The boot then re-imported the 12 skills from their db/skills/
 * mirrors — the pre-fix importer hardcodes toolChain '[]', and three mirrors
 * were already stale (declaring TOOL_RISK-unknown names).
 *
 * This script restores the DOCUMENTED Phase 7 end-state (the state the
 * skills7 test suite pins — no guessing, every value traceable):
 *   1. Every live chain re-filtered through the frozen TOOL_RISK register
 *      (the same rule the Phase 7 triage applied to the merged chain:
 *      dead/unknown entries dropped, live subset kept).
 *   2. model-selector re-saved via saveSkill with the exact Phase 7 merged
 *      content + provenance (source 'phase7-audit', trust 'owner').
 */
import { isKnownTool } from '../src/lib/arbiter/risk-table'
import { saveSkill } from '../src/lib/services/skills-service'
import { db } from '../src/lib/db'

const MERGED_NAME = 'model-selector'
const MERGED_TRIGGER = 'When selecting or evaluating the best model for a task or capability'
const MERGED_STEPS = [
  '1. Analyze task requirements and complexity',
  '2. Check available models, their capabilities, and current quota',
  '3. Review historical performance and cost-efficiency metrics',
  '4. Select the best model with a short justification (weighted criteria)',
  '5. Monitor performance and update the selection criteria',
].join('\n')

async function main() {
  const skills = await db.skill.findMany()
  let filtered = 0
  for (const s of skills) {
    if (s.name === MERGED_NAME) continue // handled by the saveSkill restore below
    let chain: string[] = []
    try {
      chain = JSON.parse(s.toolChain) as string[]
    } catch {
      chain = []
    }
    const live = chain.filter(isKnownTool)
    if (live.length !== chain.length) {
      const dropped = chain.filter((t) => !isKnownTool(t))
      await db.skill.update({ where: { name: s.name }, data: { toolChain: JSON.stringify(live) } })
      console.log(`  filtered ${s.name}: dropped dead entries [${dropped.join(', ')}] → [${live.join(', ')}]`)
      filtered++
    }
  }

  // model-selector — the Phase 7 merged row (content + provenance from the
  // phase7 audit script verbatim; pinned by tests/security/skills7.test.ts T3)
  const row = await db.skill.findUnique({ where: { name: MERGED_NAME } })
  const currentChain = (() => {
    try { return JSON.parse(row?.toolChain ?? '[]') as string[] } catch { return [] }
  })()
  const mergedChain = currentChain.filter(isKnownTool)
  const notes = [
    'Phase 7 skills deep audit (docs/phase-0/prisma-and-skills.md §D7 MERGE): unified from',
    'adaptive-model-selector + gpt6-luna-evaluator + optimal-model-selector — three overlapping',
    'model-selection skills with conflicting tool probes. Dead omni_* chain entries dropped;',
    `the merged chain is the live TOOL_RISK-verified subset (${mergedChain.join(', ')}).`,
    '(Row restored by .zscripts/repair-db-wipe.ts after the 2026-10-12 DB wipe.)',
  ].join(' ')
  await saveSkill(
    { name: MERGED_NAME, trigger: MERGED_TRIGGER, steps: MERGED_STEPS, notes, tool_chain: mergedChain },
    { source: 'phase7-audit', trust: 'owner' }
  )
  console.log(`  restored ${MERGED_NAME} — source phase7-audit, chain [${mergedChain.join(', ')}]`)

  // verify end-state
  const after = await db.skill.findMany({ select: { name: true, toolChain: true, source: true } })
  after.sort((a, b) => a.name.localeCompare(b.name))
  const offenders = after.filter((s) => {
    try {
      return (JSON.parse(s.toolChain) as string[]).some((t) => !isKnownTool(t))
    } catch {
      return false
    }
  })
  console.log(`\nAFTER: ${after.length} live skills, ${filtered} chains filtered, unknown-entry offenders: ${offenders.length}`)
  for (const s of after) console.log(' ', s.name.padEnd(28), (s.source || '').padEnd(16), 'chain=' + s.toolChain)
  await db.$disconnect()
}

void main()
