// M.I.S.T. Sovereign Hardening · Phase 7 — skills deep audit: ONE-OFF triage
// execution (idempotent, bun-runnable, no args).
//
//   bun scripts/skills-audit-7.ts
//
// Executes the Phase 0 triage recorded in docs/phase-0/prisma-and-skills.md §D7
// (verified live by the Phase 7 dispatch):
//
//   MERGE (3 → 1)   adaptive-model-selector + gpt6-luna-evaluator +
//                   optimal-model-selector → ONE `model-selector` skill
//                   (chain = the LIVE subset of their chains, each entry
//                   verified against the frozen TOOL_RISK register; the dead
//                   omni_* entries are dropped)
//   ARCHIVE (4 + 3) agent-skills-integration, security-threat-monitor,
//                   exec-proof, generate-self-review-report (+ the three
//                   merged originals) → db/skills-archive/<name>.md, then the
//                   live rows deleted. exec-proof explicitly KEEPS its
//                   archived copy per the phase-0 note.
//   KEEP (11)       untouched — the script snapshots their rows before and
//                   asserts they are byte-identical after.
//
// Provenance is set honestly: source 'phase7-audit', trust 'owner' — the
// merge is an owner-mandated curation and runs as a script the owner's lead
// executes. The live dev server is untouched (WAL mode handles the concurrent
// writer; its 5-min listSkills cache and the 30s chain cache self-heal — this
// script invalidates only its own process caches through saveSkill/deleteSkill).

import fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { db } from '../src/lib/db'
import { saveSkill, deleteSkill } from '../src/lib/services/skills-service'
import { isKnownTool, TOOL_RISK } from '../src/lib/arbiter/risk-table'
import { skillChainRisk } from '../src/lib/arbiter/chain-risk'

const ARCHIVE_DIR = path.join(process.cwd(), 'db', 'skills-archive')

const KEEP_NAMES = [
  'hermes-operator',
  'research-first',
  'quick-math',
  'pdf-extract',
  'get-latest-version',
  'read-package-version',
  'count-images-downloads',
  'research-ai-agents',
  'self-review-report',
  'system-health-check',
  'system-status-with-weather',
] as const

const MERGE_SOURCES = ['adaptive-model-selector', 'gpt6-luna-evaluator', 'optimal-model-selector'] as const
const MERGED_NAME = 'model-selector'
/** The LIVE subset of the three sources' chains — each entry is verified
 *  against TOOL_RISK below before it may enter the merged chain. */
const MERGED_CHAIN_CANDIDATES = ['memory_get', 'memory_set', 'capability_check'] as const

const ARCHIVE_ONLY = ['agent-skills-integration', 'security-threat-monitor', 'exec-proof', 'generate-self-review-report'] as const

interface SkillRow {
  name: string
  trigger: string
  steps: string
  toolChain: string
  notes: string
  uses: number
  origin: string
  trust: string
  source: string | null
  createdByTurn: string | null
  pinned: boolean
  createdAt: Date
}

const surprises: string[] = []

function parseChain(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed) ? parsed.filter((t): t is string => typeof t === 'string') : []
  } catch {
    return []
  }
}

function rowSnapshot(r: SkillRow): string {
  return JSON.stringify([
    r.name, r.trigger, r.steps, r.toolChain, r.notes, r.uses,
    r.origin, r.trust, r.source, r.createdByTurn, r.pinned, r.createdAt.toISOString(),
  ])
}

/** Full markdown export of a skill row — the honest archive record. */
function archiveMarkdown(row: SkillRow, reason: string, chainMax: { risk: string; dead: string[]; nested: string[] }): string {
  const chain = parseChain(row.toolChain)
  return [
    '---',
    `name: ${row.name}`,
    `archivedAt: ${new Date().toISOString()}`,
    `archiveReason: ${reason}`,
    '---',
    '',
    `# ${row.name} (ARCHIVED)`,
    '',
    'Archived by scripts/skills-audit-7.ts — M.I.S.T. Sovereign Hardening Mandate,',
    'Phase 7 (skills deep audit), executing the Phase 0 triage recorded in',
    'docs/phase-0/prisma-and-skills.md §D7.',
    '',
    '## Trigger',
    '',
    row.trigger,
    '',
    '## Steps',
    '',
    row.steps.trim() || '(none recorded)',
    '',
    '## Tool chain (as stored)',
    '',
    JSON.stringify(chain),
    '',
    '## Chain-max effective risk at archive time',
    '',
    `- risk class: ${chainMax.risk}`,
    chainMax.dead.length > 0 ? `- dead tools (unknown to the frozen TOOL_RISK register, counted at the conservative unknown default 'write'): ${chainMax.dead.join(', ')}` : '- dead tools: none',
    chainMax.nested.length > 0 ? `- unresolved nested skill entries (depth-cap/unknown, counted at the unknown default): ${chainMax.nested.join(', ')}` : '- unresolved nested entries: none',
    '',
    '## Notes',
    '',
    row.notes.trim() || '(none recorded)',
    '',
    '## Provenance (as stored on the live row)',
    '',
    `- uses: ${row.uses}`,
    `- origin: ${row.origin}`,
    `- trust: ${row.trust}`,
    `- source: ${row.source ?? '(null)'}`,
    `- createdByTurn: ${row.createdByTurn ?? '(null)'}`,
    `- pinned: ${row.pinned}`,
    `- createdAt: ${row.createdAt.toISOString()}`,
    '',
    '## Archive reason',
    '',
    reason,
    '',
  ].join('\n')
}

async function archiveSkill(row: SkillRow, reason: string, liveChains: Map<string, string[]>): Promise<void> {
  const chainMax = skillChainRisk(
    parseChain(row.toolChain),
    (nested) => liveChains.get(nested) ?? null
  )
  await fs.mkdir(ARCHIVE_DIR, { recursive: true })
  const file = path.join(ARCHIVE_DIR, `${row.name}.md`)
  await fs.writeFile(file, archiveMarkdown(row, reason, chainMax), 'utf-8')
  // deleteSkill removes the live row + its db/skills mirror and invalidates
  // the caches (one code path, same as the owner UI)
  await deleteSkill(row.name)
  console.log(`  archived → ${path.relative(process.cwd(), file)} (uses ${row.uses})`)
}

async function main(): Promise<number> {
  console.log('PHASE 7 SKILLS DEEP AUDIT — triage execution (docs/phase-0/prisma-and-skills.md §D7)')
  console.log('='.repeat(78))

  const before = (await db.skill.findMany()) as unknown as SkillRow[]
  const byName = new Map(before.map((r) => [r.name, r]))
  console.log(`Before: ${before.length} live skills`)
  if (before.length !== 18) {
    surprises.push(`expected 18 live skills before the triage, found ${before.length} (re-run or drift — continuing honestly on the live state)`)
  }

  // ---- KEEP guard: snapshot the 11 rows, assert untouched at the end ----
  const keepBefore = new Map<string, string>()
  for (const name of KEEP_NAMES) {
    const row = byName.get(name)
    if (!row) surprises.push(`KEEP skill missing at start: ${name}`)
    else keepBefore.set(name, rowSnapshot(row))
  }

  // live chain map for archive-time chain-max computation (nested skill: entries)
  const liveChains = new Map(before.map((r) => [r.name, parseChain(r.toolChain)]))

  // ---- MERGE: the three model-selector skills → ONE ----
  console.log('\nMERGE: adaptive-model-selector + gpt6-luna-evaluator + optimal-model-selector → model-selector')
  const presentSources = MERGE_SOURCES.filter((n) => byName.has(n))
  const mergedExists = byName.has(MERGED_NAME)

  if (presentSources.length === 0 && mergedExists) {
    console.log('  no merge sources present + model-selector already exists → idempotent skip')
  } else {
    if (presentSources.length !== MERGE_SOURCES.length) {
      surprises.push(
        `partial merge state: only ${presentSources.length}/${MERGE_SOURCES.length} sources present` +
          (mergedExists ? ' (model-selector already exists — re-saving from the present subset)' : '')
      )
    }

    // LIVE chain subset: every candidate verified against the frozen register
    const chain: string[] = []
    const dropped: string[] = []
    for (const candidate of MERGED_CHAIN_CANDIDATES) {
      if (isKnownTool(candidate)) chain.push(candidate)
      else dropped.push(candidate)
    }
    if (dropped.length > 0) surprises.push(`merged-chain candidates not in TOOL_RISK (dropped): ${dropped.join(', ')}`)
    // the dead omni_* entries that were present in the sources' chains, for the record
    const deadOmni = new Set<string>()
    for (const src of presentSources) {
      for (const entry of parseChain(byName.get(src)?.toolChain ?? '[]')) {
        if (!isKnownTool(entry)) deadOmni.add(entry)
      }
    }

    // merged content: best trigger (concise, no conflicts), deduped steps/notes
    const trigger = 'When selecting or evaluating the best model for a task or capability'
    const steps = [
      '1. Analyze task requirements and complexity',
      '2. Check available models, their capabilities, and current quota',
      '3. Review historical performance and cost-efficiency metrics',
      '4. Select the best model with a short justification (weighted criteria)',
      '5. Monitor performance and update the selection criteria',
    ].join('\n')
    const notes = [
      'Phase 7 skills deep audit (docs/phase-0/prisma-and-skills.md §D7 MERGE): unified from',
      'adaptive-model-selector + gpt6-luna-evaluator + optimal-model-selector — three overlapping',
      'model-selection skills with conflicting tool probes. Dead omni_* chain entries dropped',
      `(present in the sources: ${[...deadOmni].join(', ') || 'none'}); the merged chain is the live`,
      `TOOL_RISK-verified subset (${chain.join(', ')}).`,
    ].join(' ')

    await saveSkill(
      { name: MERGED_NAME, trigger, steps, notes, tool_chain: chain },
      { source: 'phase7-audit', trust: 'owner' } // owner-mandated curation, executed by the owner's lead
    )
    console.log(`  created/updated ${MERGED_NAME} — chain: [${chain.join(', ')}]`)

    // archive the merged originals BEFORE deleting (the archive keeps their full rows)
    for (const name of presentSources) {
      const row = byName.get(name)
      if (!row) continue
      await archiveSkill(
        row,
        `phase7-audit MERGE — folded into \`${MERGED_NAME}\` (docs/phase-0/prisma-and-skills.md §D7: three model-selector skills with overlapping triggers and conflicting tool probes)`,
        liveChains
      )
    }
  }

  // ---- ARCHIVE: the four phase-0 ARCHIVE decisions ----
  console.log('\nARCHIVE: 4 dead/duplicate skills → db/skills-archive/')
  const archiveReasons: Record<string, string> = {
    'agent-skills-integration':
      'phase7-audit ARCHIVE — docs/phase-0/prisma-and-skills.md §D7: chains DEAD omni_skills_catalog (the omni tools exist only via the mesh gateway probe; the chain breaks when the gateway is down)',
    'security-threat-monitor':
      'phase7-audit ARCHIVE — docs/phase-0/prisma-and-skills.md §D7: over-broad trigger ("during system interactions") + duplicates the oj spine guardrails',
    'exec-proof':
      'phase7-audit ARCHIVE — docs/phase-0/prisma-and-skills.md §D7: test-generated; the archived copy is KEPT on disk per the phase-0 note (ledger evidence)',
    'generate-self-review-report':
      'phase7-audit ARCHIVE — docs/phase-0/prisma-and-skills.md §D7: strict duplicate of the self-review-report chain',
  }
  for (const name of ARCHIVE_ONLY) {
    const row = byName.get(name)
    if (!row) {
      const fileExists = await fs
        .access(path.join(ARCHIVE_DIR, `${name}.md`))
        .then(() => true)
        .catch(() => false)
      console.log(
        fileExists
          ? `  ${name}: live row already gone, archive file present → idempotent skip`
          : `  ${name}: NEITHER live row NOR archive file present — nothing to do`
      )
      if (!fileExists) surprises.push(`${name}: no live row and no archive file (deleted by hand before this run?)`)
      continue
    }
    await archiveSkill(row, archiveReasons[name] ?? 'phase7-audit ARCHIVE (docs/phase-0/prisma-and-skills.md §D7)', liveChains)
  }

  // ---- VERIFY the mandate's post-triage invariants ----
  console.log('\nVERIFY:')
  let ok = true

  const after = (await db.skill.findMany()) as unknown as SkillRow[]
  const afterNames = new Set(after.map((r) => r.name))
  console.log(`  live skills: ${after.length} (expected 12: 11 KEEP + ${MERGED_NAME})`)
  if (after.length !== 12) {
    ok = false
    surprises.push(`post-triage live skill count is ${after.length}, expected 12`)
  }

  // KEEP rows byte-identical
  let keepClean = true
  for (const name of KEEP_NAMES) {
    const row = after.find((r) => r.name === name)
    if (!row) {
      keepClean = false
      surprises.push(`KEEP skill vanished: ${name}`)
    } else if (rowSnapshot(row) !== keepBefore.get(name)) {
      keepClean = false
      surprises.push(`KEEP skill row CHANGED: ${name}`)
    }
  }
  console.log(`  11 KEEP rows untouched: ${keepClean ? 'OK' : 'DRIFT'}`)
  if (!keepClean) ok = false

  // zero live skills chain omni_* (or any unknown tool)
  const omniOffenders: string[] = []
  for (const row of after) {
    for (const entry of parseChain(row.toolChain)) {
      if (entry.startsWith('omni_') || !isKnownTool(entry)) omniOffenders.push(`${row.name}→${entry}`)
    }
  }
  console.log(`  live chains free of dead/unknown tools: ${omniOffenders.length === 0 ? 'OK' : omniOffenders.join(', ')}`)
  if (omniOffenders.length > 0) ok = false

  // model-selector: exists, clean chain, live-subset contents, phase7 provenance
  const merged = after.find((r) => r.name === MERGED_NAME)
  const wantChain = [...MERGED_CHAIN_CANDIDATES]
  const mergedChain = merged ? parseChain(merged.toolChain) : []
  const mergedOk =
    !!merged &&
    mergedChain.length === wantChain.length &&
    wantChain.every((c, i) => mergedChain[i] === c) &&
    mergedChain.every((c) => isKnownTool(c) && TOOL_RISK[c] !== undefined) &&
    merged.source === 'phase7-audit' &&
    merged.trust === 'owner'
  console.log(`  ${MERGED_NAME}: ${mergedOk ? 'OK' : 'MISMATCH'} (chain [${mergedChain.join(', ')}], source ${merged?.source ?? '-'}, trust ${merged?.trust ?? '-'})`)
  if (!mergedOk) ok = false

  // the 7 archive files
  const wantedArchives = [...MERGE_SOURCES, ...ARCHIVE_ONLY]
  const archiveFiles = (await fs.readdir(ARCHIVE_DIR).catch(() => [] as string[])).filter((f) => f.endsWith('.md')).sort()
  const wantedSorted = [...wantedArchives].sort().map((n) => `${n}.md`)
  const archivesOk = archiveFiles.length === wantedSorted.length && archiveFiles.every((f, i) => f === wantedSorted[i])
  console.log(`  db/skills-archive/: ${archiveFiles.length} files (expected 7) ${archivesOk ? 'OK' : `— MISMATCH: ${archiveFiles.join(', ')}`}`)
  if (!archivesOk) ok = false

  // the 7 originals gone from the live table + their mirrors gone (no resurrection via importEcosystemSkills)
  const stillLive = wantedArchives.filter((n) => afterNames.has(n))
  const staleMirrors = wantedArchives.filter((n) =>
    existsSync(path.join(process.cwd(), 'db', 'skills', `${n}.md`))
  )
  console.log(`  archived originals gone from live table: ${stillLive.length === 0 ? 'OK' : stillLive.join(', ')}`)
  console.log(`  archived mirrors removed from db/skills/: ${staleMirrors.length === 0 ? 'OK' : staleMirrors.join(', ')}`)
  if (stillLive.length > 0 || staleMirrors.length > 0) ok = false

  // ---- honest summary ----
  console.log('\n' + '='.repeat(78))
  console.log('SUMMARY')
  console.log(`  kept:     11 (rows untouched: ${keepClean ? 'yes' : 'DRIFT — see surprises'})`)
  console.log(`  merged:   ${MERGE_SOURCES.length} → 1 (${MERGED_NAME})`)
  console.log(`  archived: ${wantedArchives.length} → db/skills-archive/ (${archiveFiles.map((f) => f.replace(/\.md$/, '')).join(', ')})`)
  console.log(`  live skills: ${before.length} → ${after.length}`)
  if (surprises.length > 0) {
    console.log('  surprises:')
    for (const s of surprises) console.log(`    - ${s}`)
  } else {
    console.log('  surprises: none')
  }
  console.log(
    '\nNote: the live dev server keeps its own process caches (5-min listSkills, 30s chain cache);\n' +
      'both self-heal — deleted skill: tools vanish from her tool list within 5 minutes.\n' +
      'This script invalidates only its own process caches (via saveSkill/deleteSkill).'
  )
  console.log(ok ? '\nPHASE 7 TRIAGE: VERIFIED OK' : '\nPHASE 7 TRIAGE: VERIFICATION FAILED (see above)')
  return ok ? 0 : 1
}

process.exitCode = await main()
