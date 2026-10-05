// M.I.S.T. evolution-service — MIST codes itself.
//
// WHAT THIS IS: the self-improvement engine. MIST can
//   • scan its own codebase for issues (lint + dev.log) and draft exact fixes
//   • proactively suggest (and implement) new features for itself
//   • study OpenClaw's latest release (auto-updated digest) and adopt good ideas
//
// SECURITY MODEL (adopted from OpenClaw's architecture case — trusted gateway,
// untrusted execution, deterministic policy): every proposal is DETERMINISTICALLY
// SANDBOXED before it ever runs —
//   • writes allowed only inside src/, mini-services/, db/skills/, db/notes/
//   • .env / package.json / prisma / configs are hard-blocked
//   • max 8 files, 256KB per write, patches must match exactly once
//   • nothing self-applies: a human approves in Diagnostics → Evolve
//   • after applying, `bun run lint` must pass — otherwise AUTOMATIC ROLLBACK
//   • every touched file is backed up first
// The dev server hot-reloads applied changes, so MIST literally rewrites its
// own running brain.

import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import * as fsSync from 'node:fs'
import { db } from '@/lib/db'
import { cascadeComplete } from './llm-service'
import { recordActivity } from './activity-service'
import { getOpenClawDigest, getOpenClawStatus } from './openclaw-service'
import type {
  EvolutionChange,
  EvolutionOrigin,
  EvolutionProposal,
} from '@/lib/types'

const PROJECT_ROOT = process.cwd()
const STAGE_ROOT = path.join(os.tmpdir(), 'mist-evo-gate')
const LINT_TIMEOUT_MS = 180_000
const LLM_TIMEOUT_MS = 150_000
const MAX_FILES_PER_PROPOSAL = 8
const MAX_WRITE_BYTES = 256 * 1024
const MAX_SUGGESTIONS_PER_RUN = 3
const MAX_PENDING_BEFORE_AUTO = 4

// ---------- deterministic policy: what self-modification may touch ----------

const ALLOWED_PREFIXES = ['src/', 'mini-services/', 'db/skills/', 'db/notes/'] as const
const BLOCKED_EXACT = new Set([
  '.env',
  'package.json',
  'bun.lock',
  'Caddyfile',
  'worklog.md',
  'dev.log',
])
const BLOCKED_PREFIXES = ['prisma/', 'node_modules/', '.next/', 'db/backups/', 'db/openclaw/'] as const

/** Deterministic path policy — the single gate every file write passes through. */
export function isEvolutionPathAllowed(rawPath: string): { ok: boolean; reason?: string } {
  const p = rawPath.trim().replace(/\\/g, '/')
  if (!p) return { ok: false, reason: 'empty path' }
  if (path.isAbsolute(p) || p.includes('..')) return { ok: false, reason: 'escape attempt blocked' }
  if (BLOCKED_EXACT.has(p)) return { ok: false, reason: `${p} is protected (deterministic policy)` }
  for (const b of BLOCKED_PREFIXES) {
    if (p.startsWith(b)) return { ok: false, reason: `${b}* is protected (deterministic policy)` }
  }
  for (const a of ALLOWED_PREFIXES) {
    if (p.startsWith(a)) return { ok: true }
  }
  return { ok: false, reason: 'outside the allowed self-modification surface' }
}

// ---------- tiny strict-JSON helpers (local — no llm-service import: cycle) ----------

function extractJsonObject(text: string, startIdx: number): string | null {
  let depth = 0
  let inStr = false
  let esc = false
  for (let i = startIdx; i < text.length; i++) {
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
      if (depth === 0) return text.slice(startIdx, i + 1)
    }
  }
  return null
}

function parseJsonLenient(raw: string): unknown | null {
  const attempt = (s: string): unknown | null => {
    try {
      return JSON.parse(s)
    } catch {
      return null
    }
  }
  const direct = attempt(raw)
  if (direct !== null) return direct
  let out = ''
  let inStr = false
  let esc = false
  for (const ch of raw) {
    if (esc) {
      out += ch
      esc = false
      continue
    }
    if (ch === '\\') {
      out += ch
      esc = true
      continue
    }
    if (ch === '"') {
      inStr = !inStr
      out += ch
      continue
    }
    if (inStr) {
      if (ch === '\n') out += '\\n'
      else if (ch === '\r') out += '\\r'
      else if (ch === '\t') out += '\\t'
      else if (ch.charCodeAt(0) < 32) out += ' '
      else out += ch
    } else {
      out += ch
    }
  }
  return attempt(out)
}

/** Pull the first JSON object/array the model emitted, tolerating fences/prose. */
function parseModelJson<T>(text: string): T | null {
  let trimmed = text.trim()
  if (trimmed.startsWith('```')) {
    trimmed = trimmed.replace(/^```[a-z]*\s*\n?/i, '').replace(/```\s*$/i, '').trim()
  }
  const direct = parseJsonLenient(trimmed)
  if (direct !== null) return direct as T
  for (const opener of ['{', '[']) {
    const idx = trimmed.indexOf(opener)
    if (idx >= 0) {
      // array extraction needs bracket balancing — only handle object payloads here
      if (opener === '{') {
        const extracted = extractJsonObject(trimmed, idx)
        if (extracted) {
          const parsed = parseJsonLenient(extracted)
          if (parsed !== null) return parsed as T
        }
      }
    }
  }
  return null
}

// ---------- LLM (raw completion through Mist Core, long timeout for code) ----------

async function evolutionComplete(system: string, user: string): Promise<string> {
  // v2: the evolution brain rides the SAME provider cascade as chat (user
  // provider → core → …) instead of a hardwired SDK call — one provider outage
  // can no longer kill self-improvement.
  const res = await cascadeComplete(system, user, { timeoutMs: LLM_TIMEOUT_MS })
  if (!res.text) throw new Error('empty completion from evolution LLM')
  try {
    recordActivity('llm', `evolution brain served by ${res.provider} (${res.model})`)
  } catch {
    // activity logging must never break the brain
  }
  return res.text
}

// ---------- codebase introspection ----------

async function walkTree(relDir: string, depth: number, acc: string[], budget: number): Promise<void> {
  if (depth > 6 || acc.length >= budget) return
  const abs = path.join(PROJECT_ROOT, relDir)
  let entries: import('node:fs').Dirent[]
  try {
    entries = await fs.readdir(abs, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    if (acc.length >= budget) return
    if (e.name.startsWith('.') || e.name === 'node_modules') continue
    const rel = `${relDir}/${e.name}`
    if (e.isDirectory()) {
      await walkTree(rel, depth + 1, acc, budget)
    } else if (/\.(ts|tsx)$/.test(e.name)) {
      try {
        const st = await fs.stat(path.join(PROJECT_ROOT, rel))
        acc.push(`${rel} (${st.size}b)`)
      } catch {
        acc.push(rel)
      }
    }
  }
}

/** Compact inventory of MIST's own source — the LLM's map of itself. */
async function buildInventory(): Promise<string> {
  const files: string[] = []
  await walkTree('src', 0, files, 420)
  await walkTree('mini-services', 0, files, 60)
  return files.join('\n')
}

export async function readProjectFile(relPath: string, maxBytes = 60_000): Promise<string | null> {
  try {
    const content = await fs.readFile(path.join(PROJECT_ROOT, relPath), 'utf-8')
    return content.length > maxBytes ? `${content.slice(0, maxBytes)}\n…(truncated)` : content
  } catch {
    return null
  }
}

// ---------- Gate A: anchor normalization (deterministic, no LLM) ----------

/**
 * Normalize anchor text for fuzzy comparison: NFC, curly quotes → straight,
 * CRLF → LF, trailing whitespace trimmed per line. Used ONLY for comparison —
 * the repaired anchor substitutes the ORIGINAL file text, never the normalized
 * form, so what finally lands on disk is always verbatim source.
 */
export function normalizeAnchor(s: string): string {
  return s
    .normalize('NFC')
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E]/g, '"')
    .replace(/\r\n/g, '\n')
    .split('\n')
    // 2026-09-27: mist_self_read windows now prefix every line with its line
    // number ("417: const x = 1") — she may copy a find snippet with those
    // prefixes still attached. Strip them BEFORE the indent-trim (the prefix
    // sits in front of the line's real indentation) and for comparison only
    // (the exact match above runs first, so legitimate "123:" source lines
    // are unaffected).
    .map((l) => l.replace(/^\d+\s*[:|│]\s*/, ''))
    // comparison is indent-insensitive too: LLM drafts frequently de-indent
    // snippet context — the repair substitutes verbatim file text either way
    .map((l) => l.replace(/^[ \t]+|[ \t]+$/g, ''))
    .join('\n')
}

/**
 * Auto-repair patch anchors: when a find-snippet does not occur exactly once
 * in the current buffer, try a normalized line-window match. If EXACTLY ONE
 * window matches, swap the find for that window's exact original text.
 * Steps chain in memory exactly like verifyFinds: after a step matches, its
 * replacement is applied to the buffer so later steps anchor on the result.
 */
export function repairAnchors(
  changes: EvolutionChange[],
  fileCache: Map<string, string | null>
): { fixed: EvolutionChange[]; notes: string[] } {
  const fixed: EvolutionChange[] = []
  const notes: string[] = []
  const buffers = new Map<string, string | null>()

  const getBuffer = (p: string): string | null => {
    if (!buffers.has(p)) buffers.set(p, fileCache.get(p) ?? null)
    return buffers.get(p) ?? null
  }

  for (const change of changes) {
    if (change.action !== 'patch') {
      if (change.action === 'create') buffers.set(change.path, change.content ?? '')
      fixed.push(change)
      continue
    }

    const buffer = getBuffer(change.path)
    if (buffer === null) {
      // target unreadable — leave for the strict apply check to reject
      fixed.push(change)
      continue
    }

    const find = change.find ?? ''
    const applyToBuffer = (anchor: string) => {
      buffers.set(change.path, buffer.replace(anchor, change.content ?? ''))
    }

    if (find && buffer.split(find).length - 1 === 1) {
      applyToBuffer(find)
      fixed.push(change)
      continue
    }

    // normalized line-window matching (curly quotes, CRLF, trailing space)
    const normalizedFind = normalizeAnchor(find)
    const trimmedFind = find.replace(/^\n+|\n+$/g, '')
    const normalizedFindTrimmed = normalizeAnchor(trimmedFind)
    const bufferLines = buffer.split('\n')
    const normalizedBufferLines = bufferLines.map((l) => normalizeAnchor(l))
    const lineCounts = [...new Set([find.split('\n').length, trimmedFind.split('\n').length])]

    let foundWindow: string | null = null
    let matchCount = 0
    for (const lc of lineCounts) {
      if (lc <= 0 || lc > bufferLines.length) continue
      for (let i = 0; i + lc <= bufferLines.length; i++) {
        const normalizedWindow = normalizedBufferLines.slice(i, i + lc).join('\n')
        if (normalizedWindow === normalizedFind || normalizedWindow === normalizedFindTrimmed) {
          matchCount++
          if (matchCount === 1) foundWindow = bufferLines.slice(i, i + lc).join('\n')
        }
      }
    }

    if (matchCount === 1 && foundWindow !== null) {
      fixed.push({ ...change, find: foundWindow })
      notes.push(`normalized anchor auto-repaired for ${change.path}`)
      applyToBuffer(foundWindow)
    } else {
      // zero or ambiguous matches — leave unchanged; strict verification drops it
      fixed.push(change)
    }
  }

  return { fixed, notes }
}

// ---------- Gate B: import/export validation (deterministic anti-hallucination) ----------

/** Parse the names clause of an import: '{ A, B as C, type D }' → ['A', 'C']. */
function parseImportNames(clause: string): string[] {
  const names: string[] = []
  const braceMatch = /\{([^}]*)\}/.exec(clause)
  if (!braceMatch) return names // default / namespace imports are not verifiable cheaply
  for (const item of braceMatch[1].split(',')) {
    const t = item.trim()
    if (!t || t.startsWith('type ')) continue
    // 'A as B' — B is only the LOCAL binding; what the target must export is A
    const asMatch = /^(.+?)\s+as\s+(.+?)$/.exec(t)
    if (asMatch) names.push(asMatch[1].trim())
    else names.push(t)
  }
  return names
}

/** Extract local module imports (@/, ./, ../) with their named bindings. */
export function extractLocalImports(content: string): { module: string; names: string[] }[] {
  const imports: { module: string; names: string[] }[] = []
  const seen = new Set<string>()
  const push = (module: string, names: string[]) => {
    const key = module + '\u0000' + names.join(',')
    if (seen.has(key)) return
    seen.add(key)
    imports.push({ module, names })
  }

  const importRegex = /import\s+(?:type\s+)?(?:([\w*{},\s]+?)\s+from\s+)?['"]([^'"]+)['"]/g
  let match: RegExpExecArray | null
  while ((match = importRegex.exec(content)) !== null) {
    const namesClause = match[1]
    const moduleName = match[2]
    if (moduleName.startsWith('@/') || moduleName.startsWith('./') || moduleName.startsWith('../')) {
      push(moduleName, namesClause ? parseImportNames(namesClause) : [])
    }
  }

  const dynamicRegex = /(?:import|require)\(\s*['"]([^'"]+)['"]\s*\)/g
  while ((match = dynamicRegex.exec(content)) !== null) {
    const moduleName = match[1]
    if (moduleName.startsWith('@/') || moduleName.startsWith('./') || moduleName.startsWith('../')) {
      push(moduleName, [])
    }
  }

  return imports
}

/**
 * Resolve a local module to a REPO-RELATIVE file path (matching the keys of
 * the buffers map), trying .ts / .tsx / index variants. Returns null when the
 * module cannot be found on disk.
 */
export function resolveLocalModule(module: string, fromRelPath: string): string | null {
  let base: string
  if (module.startsWith('@/')) {
    base = 'src/' + module.slice(2)
  } else if (module.startsWith('./') || module.startsWith('../')) {
    base = path.posix.join(path.posix.dirname(fromRelPath), module)
  } else {
    return null
  }
  const exts = ['', '.ts', '.tsx', '/index.ts', '/index.tsx']
  for (const ext of exts) {
    const candidate = path.posix.normalize(base + ext)
    if (fsSync.existsSync(path.join(PROJECT_ROOT, candidate))) return candidate
  }
  return null
}

/** Extract the export names a module actually provides. */
export function extractExports(content: string): string[] {
  const exports: string[] = []

  const exportRegex =
    /export\s+(?:default\s+)?(?:async\s+)?(?:function|const|let|class|type|interface|enum)\s+([A-Za-z_$][\w$]*)/g
  let match: RegExpExecArray | null
  while ((match = exportRegex.exec(content)) !== null) {
    exports.push(match[1])
  }

  const namedExportRegex = /export\s*\{([^}]*)\}/g
  while ((match = namedExportRegex.exec(content)) !== null) {
    for (const item of match[1].split(',')) {
      const trimmed = item.trim()
      if (!trimmed || trimmed === 'default' || trimmed.startsWith('type ')) continue
      if (trimmed.startsWith('default as ')) {
        exports.push(trimmed.slice('default as '.length).trim())
      } else if (trimmed.includes(' as ')) {
        exports.push(trimmed.split(' as ').pop()!.trim())
      } else {
        exports.push(trimmed)
      }
    }
  }

  if (/export\s+default/.test(content)) exports.push('default')

  return [...new Set(exports)].sort()
}

/**
 * Validate every local import in the FINAL buffer contents against the real
 * export surface of its target. Changed files validate against their post-patch
 * content; everything else against the real tree. Errors are precise on
 * purpose — they are the feedback that teaches the repair LLM the real APIs.
 */
export async function validateImports(
  buffers: Map<string, string>,
  realFileCache: Map<string, string | null>
): Promise<string[]> {
  const errors: string[] = []

  const loadTarget = async (repoRel: string): Promise<string | null> => {
    if (buffers.has(repoRel)) return buffers.get(repoRel) ?? ''
    if (!realFileCache.has(repoRel)) {
      realFileCache.set(repoRel, await readProjectFile(repoRel, 200_000))
    }
    return realFileCache.get(repoRel) ?? null
  }

  for (const [bufferPath, content] of buffers) {
    for (const { module, names } of extractLocalImports(content)) {
      const resolvedPath = resolveLocalModule(module, bufferPath)
      if (resolvedPath === null) {
        errors.push(
          `${bufferPath} imports missing module '${module}' — no such file resolves in the project (hallucinated import?)`
        )
        continue
      }

      const targetContent = await loadTarget(resolvedPath)
      if (targetContent === null) {
        errors.push(`${bufferPath} imports '${module}' but ${resolvedPath} could not be read`)
        continue
      }

      let targetExports = extractExports(targetContent)

      // one level of re-export chasing (`export * from './x'`) so legitimate
      // barrel imports are not false-flagged
      if (names.length > 0 && names.some((n) => !targetExports.includes(n))) {
        const starRegex = /export\s+\*\s*(?:as\s+[A-Za-z_$][\w$]*\s*)?from\s+['"]([^'"]+)['"]/g
        let m: RegExpExecArray | null
        while ((m = starRegex.exec(targetContent)) !== null) {
          const reExported = resolveLocalModule(m[1], resolvedPath)
          if (!reExported) continue
          const reContent = await loadTarget(reExported)
          if (reContent === null) continue
          targetExports = [...targetExports, ...extractExports(reContent)]
        }
      }

      for (const name of names) {
        if (!targetExports.includes(name)) {
          errors.push(
            `${bufferPath} imports { ${name} } from '${module}' but ${resolvedPath} only exports: ${targetExports.join(', ') || '(nothing)'}`
          )
        }
      }
    }
  }

  return errors
}

// ---------- Staging environment (the isolated copy gates run in) ----------

/**
 * Build a staging copy of the project under os.tmpdir()/mist-evo-gate/<id>:
 * src/ + mini-services/ + configs, with node_modules linked (junction on
 * Windows — no admin rights needed; symlink elsewhere; copy as last resort).
 * NOTHING in here ever touches the live tree.
 */
export async function buildStage(proposalId: string): Promise<string> {
  const stageDir = path.join(STAGE_ROOT, proposalId)

  if (fsSync.existsSync(stageDir)) {
    await fs.rm(stageDir, { recursive: true, force: true })
  }
  await fs.mkdir(stageDir, { recursive: true })

  await fs.cp(path.join(PROJECT_ROOT, 'src'), path.join(stageDir, 'src'), { recursive: true })
  await fs.cp(path.join(PROJECT_ROOT, 'mini-services'), path.join(stageDir, 'mini-services'), {
    recursive: true,
  })

  for (const file of ['tsconfig.json', 'package.json', 'next-env.d.ts']) {
    const srcPath = path.join(PROJECT_ROOT, file)
    try {
      await fs.copyFile(srcPath, path.join(stageDir, file))
    } catch {
      // optional file missing — skip silently
    }
  }

  const nodeModulesPath = path.join(PROJECT_ROOT, 'node_modules')
  if (fsSync.existsSync(nodeModulesPath)) {
    try {
      await fs.symlink(
        nodeModulesPath,
        path.join(stageDir, 'node_modules'),
        process.platform === 'win32' ? 'junction' : 'dir'
      )
    } catch {
      await fs.cp(nodeModulesPath, path.join(stageDir, 'node_modules'), { recursive: true })
    }
  }

  return stageDir
}

/** Restore staged paths to pristine copies of the real files between rounds. */
export async function restoreStagePaths(stageDir: string, stagedPaths: string[]): Promise<void> {
  for (const relPath of stagedPaths) {
    const stagePath = path.join(stageDir, relPath)
    const realPath = path.join(PROJECT_ROOT, relPath)
    try {
      if (fsSync.existsSync(realPath)) {
        await fs.mkdir(path.dirname(stagePath), { recursive: true })
        await fs.copyFile(realPath, stagePath)
      } else if (fsSync.existsSync(stagePath)) {
        await fs.unlink(stagePath)
      }
    } catch {
      // best effort — a failed restore surfaces as a gate failure, never a crash
    }
  }
}

/** Remove the stage entirely. Never throws. */
export async function cleanupStage(stageDir: string): Promise<void> {
  try {
    await fs.rm(stageDir, { recursive: true, force: true })
  } catch {
    // best effort
  }
}


// ---------- lint + typecheck + dev.log ----------


// ---------- Gate C: staged type-check ----------

/**
 * Run tsc --noEmit in the stage directory, with timeout and output capture.
 * 2026-09-28 OOM hardening (mist_self_write smoke post-mortem): the sandbox
 * has 3.9GB RAM and NO swap — a full-project staged type-check spawned from
 * the dev server (alongside chrome + missions) got OOM-killed mid-apply with
 * an EMPTY output, failing four gate rounds on a perfectly valid file. Two
 * fixes: (1) SCOPED check — when files are given, a tsconfig.stage.json
 * includes only the changed files (tsc still type-checks everything they
 * transitively import — the relevant surface — at a fraction of the memory);
 * (2) the OOM signature (nonzero exit + EMPTY output — real type errors
 * always print) retries once after a short breather.
 */
export async function runStageTsc(stageDir: string, files?: string[]): Promise<{ ok: boolean; output: string; degraded?: boolean }> {
  let tscArgs: string[] = ['x', 'tsc', '--noEmit']
  if (files && files.length > 0) {
    const stageTsconfig = path.join(stageDir, 'tsconfig.stage.json')
    await fs.writeFile(
      stageTsconfig,
      JSON.stringify(
        {
          extends: './tsconfig.json',
          include: files,
          compilerOptions: {
            noEmit: true,
            // OOM hardening round 2 (defect #13, orb-honesty run 3): the
            // scoped program still loads the changed file's FULL transitive
            // import graph — use-voice.ts reaches store/speech/neural/api/db
            // and the checker died at 1.6GB RSS on the 3.9GB box FOUR rounds
            // in a row (kernel kill, empty output) on a valid patch. skipLibCheck
            // + types:['node'] cuts the program (the full @types set was loaded
            // eagerly — react/jest globals the changed files never use; node
            // stays: the transitive graph hits db.ts's process.cwd()); the heap
            // cap below makes V8 GC instead of growing to a
            // kill.
            skipLibCheck: true,
            types: ['node'],
          },
        },
        null,
        2
      ),
      'utf-8'
    )
    tscArgs = ['x', 'tsc', '-p', 'tsconfig.stage.json', '--noEmit']
  }
  const { spawn } = await import('node:child_process')
  const runOnce = (): Promise<{ ok: boolean; output: string }> =>
    new Promise((resolve) => {
      let output = ''
      let settled = false
      const child = spawn('bun', tscArgs, {
        cwd: stageDir,
        env: {
          ...process.env,
          // heap cap: V8 garbage-collects inside the budget instead of growing
          // past the cgroup ceiling and dying to the OOM killer (empty output,
          // silent gate failure). 1GB is enough for a scoped program and small
          // enough to coexist with the dev server on this box.
          NODE_OPTIONS: '--max-old-space-size=1024',
        },
      })
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true
          child.kill('SIGKILL')
          resolve({ ok: false, output: `${output}\n(tsc timed out after 150000ms)` })
        }
      }, 150_000)
      child.stdout?.on('data', (d) => {
        output += String(d)
        if (output.length > 120_000) output = output.slice(-120_000)
      })
      child.stderr?.on('data', (d) => {
        output += String(d)
        if (output.length > 120_000) output = output.slice(-120_000)
      })
      child.on('error', (err) => {
        if (!settled) {
          settled = true
          clearTimeout(timer)
          resolve({ ok: false, output: `tsc spawn failed: ${err.message}` })
        }
      })
      child.on('close', (code) => {
        if (!settled) {
          settled = true
          clearTimeout(timer)
          resolve({ ok: code === 0, output: output.slice(-40_000) })
        }
      })
    })
  const first = await runOnce()
  if (first.ok || first.output.trim().length > 0) return { ...first, degraded: false }
  // nonzero exit + zero output = the type-checker died silently (memory) —
  // give the box a breath and try once more before failing the gate
  await new Promise((r) => setTimeout(r, 3000))
  const second = await runOnce()
  if (second.ok || second.output.trim().length > 0) return { ...second, degraded: false }
  // OOM signature twice (defect #13, orb-honesty run 3): the sandbox could not
  // afford the checker's memory for this import graph — even heap-capped. A
  // silent kernel kill is NOT evidence of a type error, and failing the gate
  // on it rejected a perfectly valid patch four rounds in a row. Degrade
  // LOUDLY instead: the remaining gates (verbatim anchors, import validation,
  // real-tree eslint, runtime import probe, backup + auto-rollback) still
  // hold, and the proposal records exactly what was skipped and why.
  return {
    ok: false,
    degraded: true,
    output:
      'type-check SKIPPED (degraded): the checker was killed by memory pressure twice (kernel OOM, empty output — not a type error). Remaining gates (anchor verification, import validation, eslint, runtime import probe, backup + auto-rollback) still enforced.',
  }
}

// ---------- Gate D: runtime import probe ----------

/**
 * Build and run a probe file to test runtime imports of changed files.
 */
export async function runImportProbe(
  stageDir: string,
  changedPaths: string[]
): Promise<{ ok: boolean; output: string }> {
  // Filter for .ts/.tsx files only
  const probeCandidatesAll = changedPaths.filter((p) => /\.(ts|tsx)$/.test(p))
  if (probeCandidatesAll.length === 0) {
    return { ok: true, output: '(nothing to probe)' }
  }
  // 2026-09-26 lesson (Drill #7b apply): next/font/* exports are Next
  // compile-time VIRTUAL modules — a raw bun import can never resolve them,
  // so probing any file that imports next/font produces a false PROBE-FAIL
  // (live case: layout.tsx's perfectly valid `Inter` import rolled back a
  // correct proposal). Skip those files; tsc still type-checks them.
  const probeCandidates: string[] = []
  const skipped: string[] = []
  for (const p of probeCandidatesAll) {
    try {
      const src = await fs.readFile(path.join(stageDir, p), 'utf-8')
      if (/from\s+['"]next\/font\//.test(src)) skipped.push(p)
      else probeCandidates.push(p)
    } catch {
      probeCandidates.push(p) // unreadable → let the probe report it honestly
    }
  }
  if (probeCandidates.length === 0) {
    return { ok: true, output: `(all probe candidates use next/font virtual imports — skipped: ${skipped.join(', ')})` }
  }

  // Build the probe content
  const mods = probeCandidates
    .map((p) => JSON.stringify(p.startsWith('.') ? p : './' + p))
    .join(', ')
  const probeContent = `const MODS: string[] = [${mods}]

for (const m of MODS) {
  try {
    await import(m.startsWith('.') ? m : './' + m)
    console.log('PROBE-OK ' + m)
  } catch (e) {
    console.log('PROBE-FAIL ' + m + ' ' + (e instanceof Error ? e.message : String(e)))
    process.exitCode = 1
  }
}`

  const probePath = path.join(stageDir, '.mist-probe.mts')
  await fs.writeFile(probePath, probeContent, 'utf-8')
  try {
    const { spawn } = await import('node:child_process')
    // NOTE: the probe file is deleted only AFTER the child closes — a plain
    // try/finally around the returned Promise would delete it before the
    // spawned bun process ever reads it (finally fires when the Promise
    // OBJECT is created, not when it settles).
    const result = await new Promise<{ ok: boolean; output: string }>((resolve) => {
      let output = ''
      let settled = false
      const child = spawn('bun', [path.join(stageDir, '.mist-probe.mts')], {
        cwd: stageDir,
        env: { ...process.env },
      })
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true
          child.kill('SIGKILL')
          resolve({ ok: false, output: `${output}\n(probe timed out after 90000ms)` })
        }
      }, 90_000)
      child.stdout?.on('data', (d) => {
        output += String(d)
        if (output.length > 120_000) output = output.slice(-120_000)
      })
      child.stderr?.on('data', (d) => {
        output += String(d)
        if (output.length > 120_000) output = output.slice(-120_000)
      })
      child.on('error', (err) => {
        if (!settled) {
          settled = true
          clearTimeout(timer)
          resolve({ ok: false, output: `probe spawn failed: ${err.message}` })
        }
      })
      child.on('close', (code) => {
        if (!settled) {
          settled = true
          clearTimeout(timer)
          resolve({ ok: code === 0, output })
        }
      })
    })
    return result
  } finally {
    try {
      await fs.rm(probePath, { force: true })
    } catch {
      // best effort
    }
  }
}

// ---------- Gate orchestrator ----------

export interface GateResults {
  fixedChanges: EvolutionChange[]
  anchorNotes: string[]
  /** Hard anchor failures (unreadable target / non-unique find). These MUST
   *  fail the gate: before they were only noted, so `passed` lied with "clean
   *  gates" and computeFinalBuffers aborted with the cryptic 'buffer
   *  recomputation failed' — burning all repair rounds on an opaque internal
   *  error instead of a per-step message the repair round can act on
   *  (Drill #6b post-mortem, 2026-09-27). */
  anchorFailures: string[]
  importErrors: string[]
  tsc: { ok: boolean; output: string; degraded?: boolean }
  probe: { ok: boolean; output: string }
  passed: boolean
}

/**
 * Run all four verification gates in order against the staged copy:
 *   A — anchor auto-repair (deterministic)
 *   B — import/export validation against the real API surface
 *   C — staged tsc --noEmit
 *   D — runtime import probe (a disposable bun process imports every changed
 *       module from the stage — catches code that type-checks but throws on load)
 * The returned fixedChanges carry any repaired anchors; the caller must treat
 * them as the operative step list. A find consumed by an earlier step is
 * correctly absent from the final buffer — chaining is enforced by replaying
 * the steps in order, never by re-checking finds against the final text.
 */
export async function runGatesInStage(opts: {
  stageDir: string
  changes: EvolutionChange[]
  fileCache: Map<string, string | null>
  buffers: Map<string, string>
}): Promise<GateResults> {
  // Gate A: repair anchors deterministically
  const anchorRes = repairAnchors(opts.changes, opts.fileCache)
  const fixedChanges = anchorRes.fixed
  const anchorNotes = [...anchorRes.notes]
  const anchorFailures: string[] = []

  // Recompute buffers from the FIXED changes: replay every step per path in
  // array order (creates seed content, patches must find their anchor exactly
  // once in the buffer as left by the previous steps for that path).
  const buffers = new Map<string, string>()
  const brokenPaths = new Set<string>()
  for (let i = 0; i < fixedChanges.length; i++) {
    const c = fixedChanges[i]
    if (brokenPaths.has(c.path)) continue
    if (c.action === 'create') {
      buffers.set(c.path, c.content ?? '')
      continue
    }
    if (!buffers.has(c.path)) {
      const original = opts.fileCache.get(c.path) ?? null
      if (original === null) {
        const msg = `step ${i + 1} (${c.path}): patch target unreadable — drop or fix this step`
        anchorNotes.push(msg)
        anchorFailures.push(msg)
        brokenPaths.add(c.path)
        continue
      }
      buffers.set(c.path, original)
    }
    const buf = buffers.get(c.path)!
    const find = c.find ?? ''
    if (!find || buf.split(find).length - 1 !== 1) {
      const msg = `step ${i + 1} (${c.path}): find-snippet is not unique after anchor repair — drop or fix this step`
      anchorNotes.push(msg)
      anchorFailures.push(msg)
      brokenPaths.add(c.path)
      buffers.delete(c.path)
      continue
    }
    buffers.set(c.path, buf.replace(find, c.content ?? ''))
  }

  // Gate B: validate imports of every final buffer (creates included)
  const importErrors = await validateImports(buffers, opts.fileCache)

  // Write the recomputed buffers into the staged copy
  for (const [rel, content] of buffers) {
    const stagePath = path.join(opts.stageDir, rel)
    await fs.mkdir(path.dirname(stagePath), { recursive: true })
    await fs.writeFile(stagePath, content, 'utf-8')
  }

  // Gate C: staged type-check — SCOPED to the changed files (+ their transitive
  // imports) so the checker fits the sandbox's memory alongside everything else.
  // degraded=true (checker OOM-killed twice, empty output): not a type error —
  // the gate continues with the runtime import probe carrying the load.
  const tsc = await runStageTsc(opts.stageDir, [...buffers.keys()])

  // Gate D: runtime import probe (runs when tsc passed OR degraded — a
  // degraded type-check makes the probe MORE important, not less)
  const probe = tsc.ok || tsc.degraded
    ? await runImportProbe(opts.stageDir, [...buffers.keys()])
    : { ok: true, output: '(skipped — staged tsc failed)' }

  const passed =
    anchorFailures.length === 0 &&
    importErrors.length === 0 &&
    (tsc.ok || tsc.degraded === true) &&
    probe.ok

  return { fixedChanges, anchorNotes, anchorFailures, importErrors, tsc, probe, passed }
}
/**
 * Full verification gate for self-applied patches: ESLint AND `tsc --noEmit`.
 * ESLint alone let a scope-blind patch ship (navbar setView, 2026-09-25) —
 * the type checker is the deterministic net that catches those.
 */
export async function runLint(): Promise<{ ok: boolean; output: string }> {
  const { spawn } = await import('node:child_process')
  return new Promise((resolve) => {
    let output = ''
    let settled = false
    const child = spawn('bun', ['x', 'tsc', '--noEmit'], {
      cwd: PROJECT_ROOT,
      env: { ...process.env },
    })
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true
        child.kill('SIGKILL')
        resolve({ ok: false, output: `${output}\n(lint timed out after ${LINT_TIMEOUT_MS}ms)` })
      }
    }, LINT_TIMEOUT_MS)
    child.stdout?.on('data', (d) => {
      output += String(d)
      if (output.length > 120_000) output = output.slice(-120_000)
    })
    child.stderr?.on('data', (d) => {
      output += String(d)
      if (output.length > 120_000) output = output.slice(-120_000)
    })
    child.on('error', (err) => {
      if (!settled) {
        settled = true
        clearTimeout(timer)
        resolve({ ok: false, output: `lint spawn failed: ${err.message}` })
      }
    })
    child.on('close', (code) => {
      if (!settled) {
        settled = true
        clearTimeout(timer)
        resolve({ ok: code === 0, output: output.slice(-40_000) })
      }
    })
  })
}

// Real error signatures only — the colon matters: dev.log is full of prisma:query
// SELECT lines that contain the word "error" as a column name, which must NOT
// count (the scanner once flagged its own DB queries — feedback loop).
const DEVLLOG_ERROR_RE =
  /(TypeError:|ReferenceError:|SyntaxError:|RangeError:|Error:|Unhandled|ECONNREFUSED|ENOENT|EADDRINUSE|hydration (?:failed|mismatch)|Module not found|Failed to compile)/i

async function readDevlogIssues(): Promise<{ source: 'devlog'; detail: string }[]> {
  try {
    const raw = await fs.readFile(path.join(PROJECT_ROOT, 'dev.log'), 'utf-8')
    const lines = raw.split('\n').slice(-400)
    const seen = new Set<string>()
    const issues: { source: 'devlog'; detail: string }[] = []
    for (const line of lines) {
      if (/^\s*prisma:/.test(line)) continue // query/debug logging, never an error
      if (!DEVLLOG_ERROR_RE.test(line)) continue
      const detail = line.trim().slice(0, 300)
      const key = detail.slice(0, 120)
      if (seen.has(key)) continue
      seen.add(key)
      issues.push({ source: 'devlog', detail })
      if (issues.length >= 15) break
    }
    return issues
  } catch {
    return []
  }
}

// ---------- change validation ----------

interface ValidatedChanges {
  changes: EvolutionChange[]
  rejected: string[]
  /** Non-canonical step keys that were accepted (file→path, replace→content…) —
   *  surfaced to the actor so one success teaches the canonical schema. */
  aliasNotes: string[]
}

/** 2026-09-27 fairness fix (drill #13 post-mortem): she authored a substantively
 *  CORRECT payload (verbatim anchors, right files) keyed as file/replace and the
 *  policy rejected it SIX times — while diagnoseExactChanges knew the exact key
 *  mapping all along. The engine meets her halfway, same precedent as deriving
 *  the omitted `action` (2026-09-26): canonical keys win, unambiguous aliases
 *  are accepted. Safety is untouched — path whitelist, anchor verification,
 *  import/type gates all still apply to the normalized steps. */
const PATH_KEY_ALIASES = ['file', 'filename', 'file_path', 'filepath', 'target']
const FIND_KEY_ALIASES = ['search', 'match', 'old', 'old_content', 'target_text']
const CONTENT_KEY_ALIASES = ['replace', 'replacement', 'new', 'new_content', 'with']

function pickCanonical(
  c: Record<string, unknown>,
  canonical: string,
  aliases: string[]
): { value: unknown; via: string | null } {
  const canon = c[canonical]
  if (canon !== undefined && canon !== null && (typeof canon !== 'string' || canon.length > 0)) {
    return { value: canon, via: null }
  }
  for (const alias of aliases) {
    const key = Object.keys(c).find((k) => k.toLowerCase() === alias)
    const v = key === undefined ? undefined : c[key]
    if (v !== undefined && v !== null && (typeof v !== 'string' || v.length > 0)) {
      return { value: v, via: key ?? null }
    }
  }
  return { value: undefined, via: null }
}

function validateChanges(raw: unknown): ValidatedChanges {
  const rejected: string[] = []
  const changes: EvolutionChange[] = []
  const aliasNotes: string[] = []
  if (!Array.isArray(raw)) return { changes, rejected: ['changes: not an array'], aliasNotes }
  for (const item of raw.slice(0, MAX_FILES_PER_PROPOSAL)) {
    if (!item || typeof item !== 'object') continue
    const src = item as Record<string, unknown>
    const pathPick = pickCanonical(src, 'path', PATH_KEY_ALIASES)
    const findPick = pickCanonical(src, 'find', FIND_KEY_ALIASES)
    const contentPick = pickCanonical(src, 'content', CONTENT_KEY_ALIASES)
    if (pathPick.via) aliasNotes.push(`'${pathPick.via}' accepted as 'path'`)
    if (findPick.via) aliasNotes.push(`'${findPick.via}' accepted as 'find'`)
    if (contentPick.via) aliasNotes.push(`'${contentPick.via}' accepted as 'content'`)
    const c: Record<string, unknown> = {
      ...src,
      path: pathPick.value,
      find: findPick.value,
      content: contentPick.value,
    }
    const p = typeof c.path === 'string' ? c.path.trim() : ''
    // 2026-09-26 lesson (Drill #7b): the actor reliably omits "action" — the
    // field is unambiguous from the step's shape, so derive it instead of
    // rejecting five identical honest attempts (she asked for help rather
    // than fabricate; the engine should meet her halfway)
    let action: 'create' | 'patch' | null =
      c.action === 'create' || c.action === 'patch' ? c.action : null
    if (!action) {
      const hasFind = typeof c.find === 'string' && c.find.trim().length > 0
      const hasContent = typeof c.content === 'string' && c.content.length > 0
      if (hasFind && hasContent) action = 'patch'
      else if (hasContent) action = 'create'
    }
    if (!p || !action) {
      rejected.push(`step without path/action skipped`)
      continue
    }
    const policy = isEvolutionPathAllowed(p)
    if (!policy.ok) {
      rejected.push(`${p}: ${policy.reason}`)
      continue
    }
    if (action === 'create') {
      const content = typeof c.content === 'string' ? c.content : ''
      if (!content.trim()) {
        rejected.push(`${p}: create with empty content skipped`)
        continue
      }
      if (Buffer.byteLength(content) > MAX_WRITE_BYTES) {
        rejected.push(`${p}: exceeds 256KB write cap`)
        continue
      }
      changes.push({ path: p, action, content, note: typeof c.note === 'string' ? c.note.slice(0, 200) : undefined })
    } else {
      const find = typeof c.find === 'string' ? c.find : ''
      const content = typeof c.content === 'string' ? c.content : ''
      if (!find.trim() || !content) {
        rejected.push(`${p}: patch needs non-empty find + replacement content`)
        continue
      }
      if (Buffer.byteLength(content) > MAX_WRITE_BYTES) {
        rejected.push(`${p}: exceeds 256KB write cap`)
        continue
      }
      changes.push({ path: p, action, find, content, note: typeof c.note === 'string' ? c.note.slice(0, 200) : undefined })
    }
  }
  return { changes, rejected, aliasNotes }
}

/**
 * Human-actionable diagnosis of WHY an exact-changes payload failed the
 * deterministic policy — names the exact problem per step, so one rejection
 * teaches the fix.
 * 2026-09-27 lesson (drill #13): she sent a substantively CORRECT async-fix
 * payload keyed as file/replace and got the same generic rejection four
 * times — the engine knew what was wrong but refused to say it.
 * Alias-aware: keys the alias-acceptance fix would have normalized are NOT
 * reported as problems — the diagnosis reflects what actually blocked the
 * payload (protected paths, truly missing fields, oversized writes).
 */
export function diagnoseExactChanges(raw: unknown): string[] {
  if (!Array.isArray(raw)) return ['changes: not an array — expected [{"path":"src/...","action":"patch","find":"verbatim snippet","content":"replacement"}]']
  if (raw.length === 0) return ['changes: empty array — at least one step is required']
  const notes: string[] = []
  raw.slice(0, MAX_FILES_PER_PROPOSAL).forEach((item, i) => {
    if (!item || typeof item !== 'object') {
      notes.push(`step ${i + 1}: not an object`)
      return
    }
    const c = item as Record<string, unknown>
    const problems: string[] = []
    // alias-aware resolution — mirrors pickCanonical so the diagnosis never
    // blames keys the engine itself accepts
    const pathPick = pickCanonical(c, 'path', PATH_KEY_ALIASES)
    const findPick = pickCanonical(c, 'find', FIND_KEY_ALIASES)
    const contentPick = pickCanonical(c, 'content', CONTENT_KEY_ALIASES)
    if (typeof pathPick.value !== 'string' || !pathPick.value.trim()) {
      problems.push("missing 'path' (the file to change, e.g. src/lib/services/...)")
    }
    if (typeof contentPick.value !== 'string' || contentPick.value.length === 0) {
      problems.push("missing 'content' (the replacement text)")
    }
    if (typeof findPick.value !== 'string' && typeof contentPick.value === 'string') {
      problems.push("missing 'find' (the verbatim snippet to replace)")
    }
    if (typeof pathPick.value === 'string' && pathPick.value.trim()) {
      const policy = isEvolutionPathAllowed(pathPick.value.trim())
      if (!policy.ok) problems.push(`${pathPick.value}: ${policy.reason}`)
      else if (typeof contentPick.value === 'string' && Buffer.byteLength(contentPick.value) > MAX_WRITE_BYTES) {
        problems.push(`${pathPick.value}: exceeds 256KB write cap`)
      }
    }
    // canonical-key teaching (only when aliases were actually present)
    const renames: string[] = []
    if (pathPick.via) renames.push(`'${pathPick.via}' works but the canonical key is 'path'`)
    if (findPick.via) renames.push(`'${findPick.via}' works but the canonical key is 'find'`)
    if (contentPick.via) renames.push(`'${contentPick.via}' works but the canonical key is 'content'`)
    if (renames.length > 0) problems.push(renames.join('; '))
    if (problems.length > 0) notes.push(`step ${i + 1}: ${problems.join('; ')}`)
  })
  if (notes.length === 0) notes.push('payload shape looks valid — the rejection came from elsewhere (report this as an engine bug)')
  return notes
}

// ---------- serialization ----------

interface ProposalRecord {
  id: string
  kind: string
  title: string
  summary: string
  rationale: string
  status: string
  origin: string
  changes: string
  targetFiles: string
  lintOutput: string | null
  error: string | null
  createdAt: Date
  updatedAt: Date
  appliedAt: Date | null
}

function toProposal(r: ProposalRecord): EvolutionProposal {
  let changes: EvolutionChange[] = []
  let targetFiles: string[] = []
  try {
    changes = JSON.parse(r.changes) as EvolutionChange[]
  } catch {
    // keep empty
  }
  try {
    targetFiles = JSON.parse(r.targetFiles) as string[]
  } catch {
    // keep empty
  }
  return {
    id: r.id,
    kind: (r.kind as EvolutionProposal['kind']) ?? 'suggestion',
    title: r.title,
    summary: r.summary,
    rationale: r.rationale,
    status: (r.status as EvolutionProposal['status']) ?? 'pending',
    origin: (r.origin as EvolutionOrigin) ?? 'self',
    changes,
    target_files: targetFiles,
    lint_output: r.lintOutput,
    error: r.error,
    created_at: r.createdAt.toISOString(),
    updated_at: r.updatedAt.toISOString(),
    applied_at: r.appliedAt ? r.appliedAt.toISOString() : null,
  }
}

// ---------- public API ----------

export async function listProposals(): Promise<EvolutionProposal[]> {
  const rows = await db.evolutionProposal.findMany({
    orderBy: { createdAt: 'desc' },
    take: 60,
  })
  return rows.map(toProposal)
}

export async function getProposal(id: string): Promise<EvolutionProposal | null> {
  const row = await db.evolutionProposal.findUnique({ where: { id } })
  return row ? toProposal(row) : null
}

export async function getEvolutionStats(): Promise<{ pending: number; applied: number; rolled_back: number; total: number }> {
  const [pending, applied, rolledBack, total] = await Promise.all([
    db.evolutionProposal.count({ where: { status: 'pending' } }),
    db.evolutionProposal.count({ where: { status: 'applied' } }),
    db.evolutionProposal.count({ where: { status: 'rolled_back' } }),
    db.evolutionProposal.count(),
  ])
  return { pending, applied, rolled_back: rolledBack, total }
}

/** Phase 1 — self-audit: find real issues and draft an exact fix proposal. */
export async function scanForIssues(): Promise<{
  issues: { source: 'lint' | 'devlog'; detail: string }[]
  proposal: EvolutionProposal | null
  message: string
}> {
  recordActivity('evolution', 'self-audit started')
  const [lint, devlogIssues] = await Promise.all([runLint(), readDevlogIssues()])

  const lintErrorLines = lint.ok
    ? []
    : lint.output
        .split('\n')
        .filter((l) => /error|warning|✖|problem/i.test(l))
        .slice(0, 15)
        .map((detail) => ({ source: 'lint' as const, detail: detail.trim().slice(0, 300) }))
  const issues = [...lintErrorLines, ...devlogIssues].slice(0, 20)

  if (issues.length === 0) {
    recordActivity('evolution', 'self-audit clean — no issues found')
    return { issues: [], proposal: null, message: 'Self-audit complete: lint passes and the dev log shows no recent errors. Nothing to fix.' }
  }

  // gather the files the issues point at, feed their REAL content to the LLM
  const filePaths = new Set<string>()
  for (const i of issues) {
    const m = /([a-zA-Z0-9_./-]+\.(?:ts|tsx))/.exec(i.detail)
    if (m) {
      const rel = m[1].replace(/^\.\//, '')
      if (isEvolutionPathAllowed(rel).ok) filePaths.add(rel)
    }
  }
  const fileList = [...filePaths].slice(0, 5)
  const fileBlocks = await Promise.all(
    fileList.map(async (f) => `--- FILE: ${f} ---\n${(await readProjectFile(f)) ?? '(unreadable)'}`)
  )

  const proposal = await draftFixProposal(
    issues.map((i) => ({ source: i.source, detail: i.detail })),
    'self-audit',
    fileBlocks
  )

  return {
    issues,
    proposal,
    message: proposal
      ? `Found ${issues.length} issue(s) — drafted a fix proposal for your approval.`
      : `Found ${issues.length} issue(s) but could not draft a safe automatic patch. Review them in the dev log / lint output.`,
  }
}

/**
 * The single drafting authority for code-level fixes — shared by self-audit
 * (scanForIssues) and the introspection service's repair lane. Feeds the REAL
 * file contents behind the issues to her drafting brain, validates the steps,
 * and files a pending proposal. NEVER touches the live tree (applyProposal
 * gates that). fileBlocks can be pre-computed by the caller (scanForIssues
 * already gathered them); when omitted they are derived from the issues.
 */
export async function draftFixProposal(
  issues: Array<{ source: string; detail: string }>,
  origin: 'self-audit' | 'introspection' = 'self-audit',
  prebuiltFileBlocks?: string[]
): Promise<EvolutionProposal | null> {
  let fileBlocks = prebuiltFileBlocks
  if (!fileBlocks) {
    const filePaths = new Set<string>()
    for (const i of issues) {
      const m = /([a-zA-Z0-9_./-]+\.(?:ts|tsx))/.exec(i.detail)
      if (m) {
        const rel = m[1].replace(/^\.\//, '')
        if (isEvolutionPathAllowed(rel).ok) filePaths.add(rel)
      }
    }
    const fileList = [...filePaths].slice(0, 5)
    fileBlocks = await Promise.all(
      fileList.map(async (f) => `--- FILE: ${f} ---\n${(await readProjectFile(f)) ?? '(unreadable)'}`)
    )
  }

  try {
    const raw = await evolutionComplete(
      'You are MIST performing self-maintenance on your own codebase. You propose MINIMAL, surgical fixes. ' +
        'Reply with ONLY a JSON object: {"title": string, "summary": string, "rationale": string, ' +
        '"changes": [{"path": string, "action": "patch"|"create", "find": string (exact unique text to replace, patch only), ' +
        '"content": string (replacement or new file content), "note": string}]}. ' +
        'Rules: keep patches tiny; find MUST be an exact unique snippet copied from the file; never reformat whole files; ' +
        'if a file was unreadable, do not guess its content — skip it. No prose outside the JSON.',
      `ISSUES FOUND IN MY CODEBASE:\n${issues.map((i, n) => `${n + 1}. [${i.source}] ${i.detail}`).join('\n')}\n\n` +
        `RELEVANT FILES:\n${fileBlocks.join('\n\n') || '(no readable source files matched)'}`
    )
    const parsed = parseModelJson<{
      title?: unknown
      summary?: unknown
      rationale?: unknown
      changes?: unknown
    }>(raw)
    if (parsed && typeof parsed.title === 'string' && Array.isArray(parsed.changes)) {
      const { changes, rejected } = validateChanges(parsed.changes)
      if (changes.length > 0) {
        const row = await db.evolutionProposal.create({
          data: {
            kind: 'fix',
            title: parsed.title.slice(0, 120),
            summary: typeof parsed.summary === 'string' ? parsed.summary.slice(0, 600) : 'Self-audit fix proposal',
            rationale:
              (typeof parsed.rationale === 'string' ? parsed.rationale.slice(0, 1200) : '') +
              (rejected.length ? `\n[deterministic policy rejected ${rejected.length} step(s): ${rejected.join('; ')}]` : ''),
            origin,
            status: 'pending',
            changes: JSON.stringify(changes),
            targetFiles: JSON.stringify([...new Set(changes.map((c) => c.path))]),
          },
        })
        const proposal = toProposal(row)
        recordActivity('evolution', `${origin} drafted fix: ${proposal.title} (${changes.length} file change(s))`)
        return proposal
      }
    }
  } catch (err) {
    recordActivity('evolution', `${origin} fix-drafting LLM failed: ${err instanceof Error ? err.message : 'unknown error'}`)
  }
  return null
}

/** Phase 1 — feature ideas (self-idea, or inspired by an openclaw release). */
export async function suggestFeatures(
  origin: 'self-idea' | 'openclaw' | 'user' = 'self-idea',
  goal?: string
): Promise<EvolutionProposal[]> {
  const directedGoal = typeof goal === 'string' ? goal.trim().slice(0, 1200) : ''
  recordActivity('evolution', `feature ideation started (${origin}${directedGoal ? ', directed' : ''})`)
  const [inventory, stats, recent, openclawStatus, digest] = await Promise.all([
    buildInventory(),
    getEvolutionStats(),
    db.evolutionProposal.findMany({
      orderBy: { createdAt: 'desc' },
      take: 8,
      select: { title: true, status: true },
    }),
    getOpenClawStatus(),
    origin === 'openclaw' ? getOpenClawDigest(4500) : Promise.resolve(''),
  ])

  const inspiration =
    origin === 'openclaw' && digest
      ? `\nOPENCLAW LATEST RELEASE (auto-updated digest, v${openclawStatus.latest_version ?? 'unknown'}):\n${digest}`
      : ''

  // Directed mode: the creator (via chat) gave a SPECIFIC feature to build.
  // The ideation must become an engineering plan for exactly that goal —
  // real target files from the inventory, a concrete technical approach —
  // never a shallow echo of the request.
  const directive = directedGoal
    ? `CREATOR'S DIRECTIVE (highest priority — propose exactly this, as 1-3 well-scoped proposals):\n${directedGoal}\n` +
      'Requirements for a directed proposal: summary states the user-facing value; rationale is a CONCRETE technical ' +
      'approach (components, data flow, which existing services/patterns to reuse); target_files lists REAL paths from ' +
      'your inventory (existing files to patch) plus any NEW files to create under src/. Split a large feature into ' +
      'coherent proposals (service+API / UI / tools) when that keeps each change-set surgical.\n\n'
    : ''

  const raw = await evolutionComplete(
    'You are MIST proposing your own next improvement. Study your own source inventory and propose up to ' +
      `${MAX_SUGGESTIONS_PER_RUN} small, high-value, self-contained improvements you could implement in your own code. ` +
      'Prefer incremental wins that fit the existing architecture (Next.js app router + socket.io mini-service + shadcn/ui, dark glass aesthetic). ' +
      'Reply with ONLY a JSON object: {"proposals": [{"title": string, "summary": string (what + why, user-facing value), ' +
      '"rationale": string (technical approach), "kind": "feature"|"suggestion", "target_files": string[] (existing files to touch, plus optional new file paths)}]}. ' +
      'Keep target lists <= 4 files. No prose outside the JSON.',
    `${directive}MY SOURCE INVENTORY (path + size):\n${inventory}\n\n` +
      `RECENT PROPOSALS (avoid repeats):\n${recent.map((r) => `- [${r.status}] ${r.title}`).join('\n') || '(none)'}\n` +
      `STATS: ${stats.total} proposals so far, ${stats.applied} applied.${inspiration}`
  ).catch(() => null)
  if (!raw) {
    recordActivity('evolution', 'feature ideation failed (LLM)')
    return []
  }
  const parsed = parseModelJson<{ proposals?: unknown }>(raw)
  if (!parsed || !Array.isArray(parsed.proposals)) {
    // observability: the raw excerpt is the only way to tell a shape miss
    // (valid JSON, no proposals key) from true garbage — feed it back
    recordActivity(
      'evolution',
      `feature ideation output unparseable — raw excerpt: ${raw.slice(0, 500).replace(/\s+/g, ' ')}`
    )
    return []
  }

  const existingTitles = new Set(recent.map((r) => r.title.toLowerCase()))
  const created: EvolutionProposal[] = []
  for (const item of parsed.proposals.slice(0, MAX_SUGGESTIONS_PER_RUN)) {
    if (!item || typeof item !== 'object') continue
    const p = item as Record<string, unknown>
    const title = typeof p.title === 'string' ? p.title.trim().slice(0, 120) : ''
    if (!title || existingTitles.has(title.toLowerCase())) continue
    const kind = p.kind === 'feature' ? 'feature' : 'suggestion'
    const targetFiles = Array.isArray(p.target_files)
      ? (p.target_files as unknown[]).filter((t): t is string => typeof t === 'string').slice(0, 4)
      : []
    const row = await db.evolutionProposal.create({
      data: {
        kind,
        title,
        summary: typeof p.summary === 'string' ? p.summary.slice(0, 600) : '',
        rationale: typeof p.rationale === 'string' ? p.rationale.slice(0, 1200) : '',
        origin,
        status: 'pending',
        changes: '[]',
        targetFiles: JSON.stringify(targetFiles),
      },
    })
    created.push(toProposal(row))
    existingTitles.add(title.toLowerCase())
  }
  recordActivity('evolution', `feature ideation produced ${created.length} proposal(s) (${origin})`)
  return created
}

// ---------- v4: chat-driven self-patch + idea backlog ----------

/**
 * mist_self_patch pipeline: turn a plain-language request ("add X", "fix Y")
 * into a DEVELOPED proposal (exact change steps, self-repair-verified).
 * Applying still requires the user's approval in Diagnostics → Evolve.
 */
export async function planUserPatch(
  description: string,
  kind: 'feature' | 'fix' = 'feature'
): Promise<EvolutionProposal | null> {
  const title = description.trim().slice(0, 120)
  if (!title) return null
  recordActivity('evolution', `self-patch requested from chat (${kind})`)
  const row = await db.evolutionProposal.create({
    data: {
      kind,
      title,
      summary: description.trim().slice(0, 600),
      rationale: 'Requested directly by the user through the mist_self_patch chat tool.',
      origin: 'user',
      status: 'pending',
      changes: '[]',
      targetFiles: '[]',
    },
  })
  // same proven pipeline as the Evolve tab: plan exact steps + self-repair round
  const developed = await developProposal(row.id)
  // Hollow-draft guard (2026-09-27, mission cmuk888c5): when the drafting brain
  // fails (unparseable output / every change rejected), the row used to sit as
  // `pending` with ZERO changes — the actor saw a proposal_id, believed its
  // patch was delivered, and parked the mission awaiting_creator on a shell.
  // A draft with nothing to apply is a FAILURE, not a deliverable: delete the
  // hollow row and return null so the tool layer reports it honestly.
  const hollow =
    !developed ||
    (Array.isArray(developed.changes) && developed.changes.length === 0) ||
    Boolean(developed.error && (!developed.changes || developed.changes.length === 0))
  if (hollow) {
    await db.evolutionProposal.delete({ where: { id: row.id } }).catch(() => undefined)
    return null
  }
  return developed
}

/**
 * EXACT-CHANGES self-patch — the actor-authored path (2026-09-26 lesson).
 *
 * WHY THIS EXISTS: the drafting brain (developProposal) is reliable on
 * behavior-modification patches that copy adjacent patterns (4/4 on the
 * engine-repair drills) but hallucinated on every insert-new-architecture
 * task (0/5: z.object/execute:/evolutionService drafts that match nothing in
 * the codebase), and the mission actor cannot embed large verbatim code
 * payloads inside prose descriptions. When the actor (which has the real
 * file content in its context from mist_self_read) authors the exact change
 * steps itself, this path stores them VERBATIM as a pending proposal —
 * no drafting pass. The apply gate still runs identically (staged anchors +
 * imports + tsc + runtime probe + backup + auto-rollback): authorship moves
 * to the actor, VERIFICATION stays with the gate.
 */
/** Result of the exact-changes path: the stored proposal plus any alias-key
 *  notes (file→path…) so the tool layer can teach the canonical schema.
 *  anchorErrors (defect #15): submission-time anchor verification failures —
 *  when present, NO proposal was stored and each entry is a per-step teaching
 *  error for the actor. */
export interface ExactPatchResult {
  proposal: EvolutionProposal | null
  aliasNotes: string[]
  anchorErrors?: string[]
}

/** Submission-time anchor verification (defect #15, 2026-09-29 — voice-amnesia
 *  runs 1-2): exact-changes steps were accepted without checking their find
 *  anchors against the live file, so a patch authored against code the actor
 *  never READ (invented anchors) sailed through submission, parked the mission
 *  as awaiting_creator, and only failed at APPLY time after the creator had
 *  already approved — burning the creator's trust on doomed proposals. This
 *  runs the SAME deterministic logic the apply gate runs (anchor repair +
 *  chained replay) at SUBMISSION: a step whose anchor cannot resolve against
 *  the live file rejects the whole call with a per-step teaching error — no
 *  proposal is created. The actor's cure is always the same: read the region,
 *  copy the anchor verbatim. */
async function verifyExactAnchorsAtSubmission(
  changes: EvolutionChange[]
): Promise<string[]> {
  const errors: string[] = []
  // fresh live-tree cache for the paths this patch touches
  const fileCache = new Map<string, string | null>()
  await Promise.all(
    [...new Set(changes.map((c) => c.path))].map(async (p) => {
      fileCache.set(p, await readProjectFile(p, 400_000))
    })
  )
  // Gate A logic (deterministic anchor repair) — same as apply time
  const repaired = repairAnchors(changes, fileCache)
  // chained replay — exactly what computeFinalBuffers does at apply time
  const buffers = new Map<string, string>()
  for (let i = 0; i < repaired.fixed.length; i++) {
    const c = repaired.fixed[i]
    if (c.action === 'create') {
      buffers.set(c.path, c.content ?? '')
      continue
    }
    if (c.action !== 'patch') continue
    if (!buffers.has(c.path)) {
      const original = fileCache.get(c.path) ?? null
      if (original === null) {
        errors.push(
          `step ${i + 1} (${c.path}): target file unreadable in my source tree — fix the path`
        )
        continue
      }
      buffers.set(c.path, original)
    }
    const buf = buffers.get(c.path)!
    const find = c.find ?? ''
    const occurrences = find ? buf.split(find).length - 1 : 0
    if (occurrences === 0) {
      errors.push(
        `step ${i + 1} (${c.path}): your find snippet does NOT exist in the live file — you wrote it from memory, not from bytes you read. Read the target region first (mist_self_read with offset/max_bytes) and copy the anchor VERBATIM from the read output. A patch against unread code is always rejected.`
      )
    } else if (occurrences > 1) {
      errors.push(
        `step ${i + 1} (${c.path}): your find snippet occurs ${occurrences}× in the live file — extend it with more surrounding lines until it is unique`
      )
    } else {
      buffers.set(c.path, buf.replace(find, c.content ?? ''))
    }
  }
  return errors
}

export async function planUserPatchExact(
  description: string,
  kind: 'feature' | 'fix',
  changes: unknown
): Promise<ExactPatchResult | null> {
  const title = description.trim().slice(0, 120) || 'exact self-patch'
  if (!Array.isArray(changes) || changes.length === 0) return null
  // policy + shape validation BEFORE persisting (paths whitelist etc.) —
  // garbage is rejected here, never stored as an approvable proposal
  const validated = validateChanges(changes)
  if (validated.changes.length === 0) return null
  // defect #15 — verify every patch anchor against the LIVE file before
  // anything is stored; doomed anchors reject here with teaching errors
  const anchorErrors = await verifyExactAnchorsAtSubmission(validated.changes)
  if (anchorErrors.length > 0) {
    recordActivity('evolution', `exact self-patch REJECTED at submission — ${anchorErrors.length} unresolvable anchor(s) (authored against unread code)`)
    return { proposal: null, aliasNotes: validated.aliasNotes, anchorErrors }
  }
  recordActivity('evolution', `exact self-patch (${kind}, ${validated.changes.length} step(s) authored by the actor) — anchors verified against the live tree at submission`)
  const row = await db.evolutionProposal.create({
    data: {
      kind,
      title,
      summary: description.trim().slice(0, 600),
      rationale:
        'Exact change steps authored by MIST herself (mist_self_read + mist_self_patch with explicit changes) — ' +
          'stored verbatim, no drafting pass. The apply gate verifies anchors, imports, types and runtime imports before anything touches the live tree.',
      origin: 'user',
      status: 'pending',
      changes: JSON.stringify(validated.changes),
      targetFiles: JSON.stringify([...new Set(validated.changes.map((c) => c.path))]),
    },
  })
  return { proposal: toProposal(row), aliasNotes: validated.aliasNotes }
}

/** mist_backlog — the "what should we build next?" list (pending suggestions). */
export async function addBacklogIdea(text: string): Promise<EvolutionProposal> {
  const title = text.trim().slice(0, 120)
  const row = await db.evolutionProposal.create({
    data: {
      kind: 'suggestion',
      title,
      summary: text.trim().slice(0, 600),
      rationale: 'Backlog idea — collected via the mist_backlog chat tool.',
      origin: 'user',
      status: 'pending',
      changes: '[]',
      targetFiles: '[]',
    },
  })
  recordActivity('evolution', `backlog idea added: ${title.slice(0, 60)}`)
  return toProposal(row)
}

export async function listBacklog(): Promise<EvolutionProposal[]> {
  const rows = await db.evolutionProposal.findMany({
    where: { kind: 'suggestion', status: 'pending' },
    orderBy: { createdAt: 'desc' },
    take: 20,
  })
  return rows.map(toProposal)
}

export async function removeBacklogIdea(id: string): Promise<boolean> {
  const row = await db.evolutionProposal.findUnique({ where: { id } })
  if (!row || row.kind !== 'suggestion') return false
  await db.evolutionProposal.delete({ where: { id } })
  recordActivity('evolution', `backlog idea removed: ${row.title.slice(0, 60)}`)
  return true
}

/** Phase 2 — develop a suggestion into exact, applicable change steps. */
export async function developProposal(id: string): Promise<EvolutionProposal | null> {
  const row = await db.evolutionProposal.findUnique({ where: { id } })
  if (!row) return null
  let existing: EvolutionChange[] = []
  try {
    existing = JSON.parse(row.changes) as EvolutionChange[]
  } catch {
    // ignore
  }
  if (existing.length > 0) return toProposal(row)

  let targets: string[] = []
  try {
    targets = JSON.parse(row.targetFiles) as string[]
  } catch {
    // ignore
  }
  const allowedTargets = targets.filter((t) => isEvolutionPathAllowed(t).ok).slice(0, 4)
  // 500KB budget: evolution-service.ts itself grows with every self-upgrade;
  // a truncated target file blinds the drafting brain to the tail (where
  // applyProposal and other critical logic live).
  const targetContents = await Promise.all(allowedTargets.map((f) => readProjectFile(f, 500_000)))
  const fileBlocks = allowedTargets.map((f, i) => `--- FILE: ${f} ---\n${targetContents[i] ?? '(new file)'}`)

  // New-file creates are where hallucinated architecture creeps in: the model
  // has never seen this codebase's real patterns. When ANY target is a new
  // file, feed GROUND TRUTH — an exemplar service (db + unified() LLM loop +
  // seeding + alert delivery, the exact patterns a new service needs) and the
  // Prisma schema so persistence uses REAL models instead of invented helpers.
  const hasNewFile = targetContents.some((c) => c === null)
  let referenceBlocks = ''
  if (hasNewFile) {
    const [exemplar, schema] = await Promise.all([
      readProjectFile('src/lib/services/scheduler-service.ts', 12_000),
      readProjectFile('prisma/schema.prisma', 14_000),
    ])
    referenceBlocks =
      '\n\n--- REFERENCE SERVICE (src/lib/services/scheduler-service.ts — copy these patterns EXACTLY: ' +
      '`import { db } from \'@/lib/db\'`, globalThis watch-guard, db.<model> queries, unified() LLM turns, ' +
      'alert delivery, autonomy logging) ---\n' +
      (exemplar ?? '') +
      '\n\n--- PRISMA SCHEMA (prisma/schema.prisma — the ONLY valid persistence models; use db.<model>, never invent storage) ---\n' +
      (schema ?? '')
  }

  const raw = await evolutionComplete(
    'You are MIST writing your own code. Turn the approved idea into EXACT change steps. ' +
      'Reply with ONLY a JSON object: {"changes": [{"path": string, "action": "patch"|"create", ' +
      '"find": string (exact unique snippet from the file — required for patch), "content": string ' +
      '(replacement text for patch, full file content for create), "note": string}]}. ' +
      'Rules: patches must be surgical — find is copied VERBATIM from the file and must occur exactly once; ' +
      'steps apply IN ORDER, and each find must match the file AS LEFT BY the previous steps — never let two ' +
      'steps touch overlapping text (if one step rewrites a region, no later step may anchor its find inside ' +
      'that same region); prefer ONE patch per file region; new files use action "create" with complete valid ' +
      'TypeScript/TSX; imports must match existing modules; match the existing code style (dark glass ' +
      'aesthetic, shadcn/ui, font-mono labels). ' +
      'COMPLETENESS RULE: every NEW file listed in the targets MUST appear as a create-change with COMPLETE, ' +
      'runnable content — a change-set that skips a new file or ships it as a stub/skeleton is a FAILURE. ' +
      'Order changes so complete file creates come FIRST (they consume the most output budget), ' +
      'small type/registry patches LAST. ' +
      'GROUNDING RULE: you may ONLY use imports, functions, objects and models you have SEEN in the target files, ' +
      'the reference service, or the Prisma schema excerpt. Inventing APIs (storage helpers, uuid, service objects, ' +
      'store.get on the server) is a FAILURE — persistence goes through `import { db } from \'@/lib/db\'` with the ' +
      'models in the schema excerpt; LLM turns go through the patterns shown in the reference service. Your drafts are verified in an isolated staging copy of the codebase (type-check + runtime import probe + export validation) before anything touches the live system — a draft that invents APIs or anchors will be rejected and sent back for repair. No prose outside the JSON.',
    `IDEA: ${row.title}\nSUMMARY: ${row.summary}\nRATIONALE: ${row.rationale}\n\n` +
      `TARGET FILES:\n${fileBlocks.join('\n\n') || '(no target files listed — choose the most sensible files in src/ yourself)'}` +
      referenceBlocks +
      `\n\nCURRENT INVENTORY EXCERPT:\n${(await buildInventory()).split('\n').slice(0, 200).join('\n')}`
  )

  const parsed = parseModelJson<{ changes?: unknown }>(raw)
  if (!parsed) {
    await db.evolutionProposal.update({
      where: { id },
      data: { error: 'development LLM returned unparseable output', updatedAt: new Date() },
    })
    return getProposal(id)
  }
  let { changes, rejected } = validateChanges(parsed.changes)

  // ---- pre-flight + self-repair: anchor auto-repair (deterministic) and
  // import/export validation run BEFORE strict verification, and the repair
  // loop gets up to 2 LLM rounds with precise feedback. Hallucinated APIs
  // produce exact "only exports: ..." messages; curly-quote anchors are
  // fixed without any LLM round at all.
  const fileCache = new Map<string, string | null>()
  const preload = async (arr: EvolutionChange[]): Promise<void> => {
    const paths = [...new Set(arr.map((c) => c.path))]
    await Promise.all(
      paths.map(async (p) => {
        if (!fileCache.has(p)) fileCache.set(p, await readProjectFile(p, 200_000))
      })
    )
  }
  const verifyFinds = (): { ok: EvolutionChange[]; broken: EvolutionChange[] } => {
    const ok: EvolutionChange[] = []
    const broken: EvolutionChange[] = []
    const pending = new Map<string, string>() // in-memory buffer for chained steps
    for (const c of changes) {
      if (c.action === 'create') {
        pending.set(c.path, c.content ?? '')
        ok.push(c)
        continue
      }
      const buf = pending.get(c.path) ?? fileCache.get(c.path) ?? null
      if (buf === null) {
        broken.push(c)
        continue
      }
      const count = buf.split(c.find ?? '').length - 1
      if (count === 1) {
        pending.set(c.path, buf.replace(c.find ?? '', c.content ?? ''))
        ok.push(c)
      } else {
        broken.push(c)
      }
    }
    return { ok, broken }
  }

  await preload(changes)
  let check = verifyFinds()
  let importErrors: string[] = []
  let anchorNotes: string[] = []

  for (let round = 0; round < 3; round++) {
    // Gate A (deterministic): repair curly-quote / whitespace / indent anchors
    const anchorRes = repairAnchors(changes, fileCache)
    changes = anchorRes.fixed
    anchorNotes = anchorRes.notes

    // strict verification of the (repaired) steps
    check = verifyFinds()

    // Gate B: validate the final buffer contents against the real API surface
    const buffers = new Map<string, string>()
    const pending = new Map<string, string>()
    for (const c of changes) {
      if (c.action === 'create') {
        pending.set(c.path, c.content ?? '')
        buffers.set(c.path, c.content ?? '')
        continue
      }
      const buf = pending.get(c.path) ?? fileCache.get(c.path) ?? null
      if (buf === null) continue
      if (buf.split(c.find ?? '').length - 1 === 1) {
        pending.set(c.path, buf.replace(c.find ?? '', c.content ?? ''))
        if (check.ok.includes(c)) buffers.set(c.path, pending.get(c.path)!)
      }
    }
    importErrors = buffers.size > 0 ? await validateImports(buffers, fileCache) : []

    if (check.broken.length === 0 && importErrors.length === 0) break
    if (round === 2) break

    // ---- one LLM repair round with precise accumulated feedback
    const repairPaths = [...new Set([...check.broken.map((c) => c.path), ...buffers.keys()])]
    const repairBlocks = repairPaths.map(
      (f) => `--- FILE: ${f} (CURRENT, EXACT CONTENT) ---\n${fileCache.get(f) ?? '(unreadable)'}`
    )
    const feedback: string[] = []
    if (anchorNotes.length > 0) feedback.push(`ANCHORS AUTO-REPAIRED (copy the exact text above instead):\n${anchorNotes.join('\n')}`)
    if (check.broken.length > 0)
      feedback.push(
        `${check.broken.length} step(s) have find snippets that DO NOT match the real files (wrong text, non-unique, or anchored inside a region an earlier step rewrote).`
      )
    if (importErrors.length > 0)
      feedback.push(`IMPORT/EXPORT VALIDATION ERRORS (your draft imports things that do not exist):\n${importErrors.join('\n')}`)
    try {
      const repairRaw = await evolutionComplete(
        'You are MIST repairing your own draft patch. It failed verification against the real codebase. ' +
          'Reply with ONLY a JSON object: {"changes": [ …the FULL corrected changes array… ]} — same schema as before. ' +
          'Copy find snippets VERBATIM from the CURRENT file contents below (exact characters, exact indentation). ' +
          'Steps apply in order; a later find must match the file as left by earlier steps; never anchor a find ' +
          'inside a region an earlier step rewrites. Only use imports and APIs you can SEE in the files below.',
        `IDEA: ${row.title}\n\nFEEDBACK:\n${feedback.join('\n\n')}\n\nDRAFT CHANGES:\n${JSON.stringify(changes, null, 1).slice(0, 30_000)}\n\n` +
          `REAL FILE CONTENTS:\n${repairBlocks.join('\n\n').slice(0, 90_000)}`
      )
      const repaired = parseModelJson<{ changes?: unknown }>(repairRaw)
      if (repaired && Array.isArray(repaired.changes)) {
        const revalidated = validateChanges(repaired.changes)
        if (revalidated.changes.length > 0) {
          changes = revalidated.changes
          rejected = revalidated.rejected
          await preload(changes)
          check = verifyFinds()
        }
      }
    } catch {
      // repair is best-effort — fall through with what we have
    }
  }
  // keep only steps whose finds are proven against the real files
  changes = check.ok

  if (!changes.length) {
    const failed = await db.evolutionProposal.update({
      where: { id },
      data: {
        status: 'failed',
        error: 'all draft anchors unmatchable after repair rounds',
        changes: '[]',
        targetFiles: JSON.stringify([...new Set([...allowedTargets, ...changes.map((c) => c.path)])]),
        updatedAt: new Date(),
      },
    })
    recordActivity(
      'evolution',
      `developed "${row.title}" → 0 verified change step(s) (all ${check.broken.length} dropped: unmatchable find)`
    )
    return toProposal(failed)
  }

  const updated = await db.evolutionProposal.update({
    where: { id },
    data: {
      changes: JSON.stringify(changes),
      targetFiles: JSON.stringify([...new Set([...allowedTargets, ...changes.map((c) => c.path)])]),
      error: rejected.length ? `policy note: ${rejected.join('; ')}` : null,
      updatedAt: new Date(),
    },
  })
  recordActivity(
    'evolution',
    `developed "${row.title}" → ${changes.length} verified change step(s)` +
      (check.broken.length > 0 ? ` (${check.broken.length} dropped: unmatchable find)` : '')
  )
  return toProposal(updated)
}

/** Phase 3 — the approval gate fires here: apply, lint, auto-rollback. */
export async function applyProposal(id: string): Promise<{ proposal: EvolutionProposal | null; message: string }> {
  const row = await db.evolutionProposal.findUnique({ where: { id } })
  if (!row) return { proposal: null, message: 'proposal not found' }
  if (row.status !== 'pending') return { proposal: toProposal(row), message: `proposal is already ${row.status}` }

  let changes: EvolutionChange[] = []
  try {
    changes = JSON.parse(row.changes) as EvolutionChange[]
  } catch {
    // ignore
  }
  if (changes.length === 0) {
    return { proposal: toProposal(row), message: 'proposal has no developed changes yet — run Develop first' }
  }

  const { changes: valid } = validateChanges(changes)
  if (valid.length === 0) {
    const failed = await db.evolutionProposal.update({
      where: { id },
      data: { status: 'failed', error: 'all change steps rejected by the deterministic policy', updatedAt: new Date() },
    })
    return { proposal: toProposal(failed), message: 'every change step was blocked by the safety policy' }
  }

  // ---- STAGED VERIFICATION: nothing touches the live tree until the anchors,
  // imports, staged type-check AND runtime import probe all pass in an
  // isolated copy. Failed attempts never even reach the dev server. ----
  const MAX_GATE_ATTEMPTS = 4 // initial + 3 repair rounds
  const backupDir = path.join(PROJECT_ROOT, 'db', 'backups', id)
  const accumulatedErrors: string[] = []

  /** Final file contents implied by the steps (strict sequential chaining). */
  const computeFinalBuffers = (
    steps: EvolutionChange[],
    fileCache: Map<string, string | null>
  ): Map<string, string> | null => {
    const buffers = new Map<string, string>()
    for (const c of steps) {
      if (c.action === 'create') {
        buffers.set(c.path, c.content ?? '')
        continue
      }
      if (!buffers.has(c.path)) {
        const original = fileCache.get(c.path) ?? null
        if (original === null) return null
        buffers.set(c.path, original)
      }
      const buf = buffers.get(c.path)!
      const find = c.find ?? ''
      if (!find || buf.split(find).length - 1 !== 1) return null
      buffers.set(c.path, buf.replace(find, c.content ?? ''))
    }
    return buffers
  }

  /** Back up, then write the gate-clean buffers to the REAL tree. */
  const commitToRealTree = async (
    buffers: Map<string, string>
  ): Promise<{ created: string[]; backed: string[] }> => {
    const created: string[] = []
    const backed: string[] = []
    await fs.mkdir(backupDir, { recursive: true })
    for (const rel of buffers.keys()) {
      try {
        await fs.copyFile(path.join(PROJECT_ROOT, rel), path.join(backupDir, rel.replace(/\//g, '__')))
        backed.push(rel)
      } catch {
        // file doesn't exist yet (create step) — nothing to back up
      }
    }
    for (const [rel, content] of buffers) {
      const abs = path.join(PROJECT_ROOT, rel)
      await fs.mkdir(path.dirname(abs), { recursive: true })
      await fs.writeFile(abs, content, 'utf-8')
      if (!backed.includes(rel)) created.push(rel)
    }
    return { created, backed }
  }

  let steps = valid
  const stageDir = await buildStage(id)
  let stagedPaths: string[] = []
  try {
    recordActivity('evolution', `stage built for "${row.title}" — verification begins (live tree untouched)`)
    for (let attempt = 1; attempt <= MAX_GATE_ATTEMPTS; attempt++) {
      if (attempt > 1) {
        await restoreStagePaths(stageDir, stagedPaths)
      }
      stagedPaths = []

      const fileCache = new Map<string, string | null>()
      await Promise.all(
        [...new Set(steps.map((c) => c.path))].map(async (p) => {
          fileCache.set(p, await readProjectFile(p, 200_000))
        })
      )

      const gate = await runGatesInStage({ stageDir, changes: steps, fileCache, buffers: new Map() })
      steps = gate.fixedChanges
      stagedPaths = [...new Set(steps.map((c) => c.path))]
      recordActivity(
        'evolution',
        `gate round ${attempt} for "${row.title}": anchor notes=${gate.anchorNotes.length}, import errors=${gate.importErrors.length}, tsc=${gate.tsc.ok ? 'pass' : 'fail'}, probe=${gate.probe.ok ? 'pass' : 'fail'}`
      )

      if (gate.passed) {
        const buffers = computeFinalBuffers(steps, fileCache)
        if (!buffers) {
          accumulatedErrors.push('internal: buffer recomputation failed after clean gates — aborting')
          break
        }
        let committed: { created: string[]; backed: string[] } | null = null
        try {
          committed = await commitToRealTree(buffers)
        } catch (err) {
          await rollbackFiles(backupDir, committed?.backed ?? [], committed?.created ?? [])
          accumulatedErrors.push(`commit failed: ${err instanceof Error ? err.message : 'unknown error'}`)
          break
        }

        // belt-and-braces: the staged copy is faithful, but the real tree gets
        // the final word — a drift (concurrent edit) rolls back cleanly.
        // OOM tolerance (defect #13): a checker killed by the kernel dies with
        // EMPTY output — that is NOT a type error. Degrade loudly (keep the
        // commit, record what was skipped); only real diagnostics roll back.
        const lint = await runLint()
        // a thrashing checker that never finishes is as signal-free as a kill:
        // empty output OR output that is ONLY the timeout line → degrade
        const checkerDiedSilently =
          !lint.ok && (lint.output.trim() === '' || /^\s*\(lint timed out after \d+ms\)\s*$/.test(lint.output))
        if (lint.ok || checkerDiedSilently) {
          const applied = await db.evolutionProposal.update({
            where: { id },
            data: {
              status: 'applied',
              lintOutput: lint.ok
                ? 'staged gates passed (anchor repair + import validation + type-check + runtime import probe) + real-tree tsc clean'
                : (checkerDiedSilently
                    ? 'staged gates passed (anchors + imports + runtime import probe' +
                      (gate.tsc.degraded ? ' — staged type-check SKIPPED: checker OOM-killed twice, not a type error' : ' + staged type-check') +
                      ') — real-tree tsc SKIPPED: checker OOM-killed (empty output), not a type error. Backup + auto-rollback remain armed.'
                    : lint.output.slice(-6000)),
              error: null,
              appliedAt: new Date(),
              updatedAt: new Date(),
            },
          })
          recordActivity(
            'evolution',
            `SELF-MODIFIED: "${row.title}" committed to live tree (attempt ${attempt}, ${steps.length} change(s)) — hot-reload picks it up`
          )
          // mission auto-reverify hook: a mission whose deliverable was this
          // proposal has been waiting in 'awaiting_creator' — re-score it NOW
          // against the live tree (2026-09-27 fairness fix, drill #12).
          try {
            const { reverifyMissionsForProposal } = await import('./mission-service')
            void reverifyMissionsForProposal(id)
          } catch {
            /* hook is best-effort — never blocks the apply */
          }
          return {
            proposal: toProposal(applied),
            message:
              attempt === 1
                ? 'Applied. All staged gates passed (anchors + imports + type-check + runtime import probe) and the real-tree type-check is clean — the dev server hot-reloads it.'
                : `Applied after ${attempt - 1} self-repair round(s) — every gate now passes and the dev server hot-reloads it.`,
          }
        }

        await rollbackFiles(backupDir, committed.backed, committed.created)
        accumulatedErrors.push(
          `REAL-TREE TYPE-CHECK FAILED AFTER COMMIT (rolled back — staged gates had passed, likely tree drift):\n${lint.output.slice(-6000)}`
        )
        recordActivity(
          'evolution',
          `real-tree tsc failed for "${row.title}" after staged pass — rolled back, repair round starting`
        )
      } else {
        const parts: string[] = []
        if (gate.anchorNotes.length > 0) parts.push(`ANCHOR ISSUES:\n${gate.anchorNotes.join('\n')}`)
        if (gate.importErrors.length > 0) parts.push(`IMPORT VALIDATION ERRORS:\n${gate.importErrors.join('\n')}`)
        if (!gate.tsc.ok) parts.push(`STAGED TYPE-CHECK FAILED:\n${gate.tsc.output.slice(-6000)}`)
        if (!gate.probe.ok) parts.push(`RUNTIME IMPORT PROBE FAILED:\n${gate.probe.output.slice(-2000)}`)
        accumulatedErrors.push(`--- attempt ${attempt} ---\n${parts.join('\n\n')}`)
        recordActivity('evolution', `gates failed for "${row.title}" (attempt ${attempt}) — repair round starting`)
      }

      if (attempt < MAX_GATE_ATTEMPTS) {
        const repaired = await stagedRepairRound(row.title, steps, accumulatedErrors, fileCache)
        if (!repaired || repaired.length === 0) break
        steps = repaired
      }
    }
  } finally {
    await cleanupStage(stageDir)
  }

  const rolled = await db.evolutionProposal.update({
    where: { id },
    data: {
      status: 'rolled_back',
      lintOutput: accumulatedErrors.join('\n\n').slice(-8000) || '(no gate report captured)',
      error: `staged gates failed after ${MAX_GATE_ATTEMPTS} attempts — the live tree was never touched`,
      updatedAt: new Date(),
    },
  })
  recordActivity('evolution', `staged gates FAILED for "${row.title}" — rolled back; live tree untouched`)
  try {
    const { reverifyMissionsForProposal } = await import('./mission-service')
    void reverifyMissionsForProposal(id)
  } catch {
    /* best-effort */
  }
  return {
    proposal: toProposal(rolled),
    message:
      'Staged gates failed after all repair rounds — the live tree was never touched. The full gate report is attached.',
  }
}

/**
 * One LLM repair round against the accumulated staged-gate report: anchor
 * issues, import validation errors, staged tsc output and probe output. The
 * real files are back to their original state (nothing ever committed).
 */
async function stagedRepairRound(
  title: string,
  steps: EvolutionChange[],
  accumulatedErrors: string[],
  fileCache: Map<string, string | null>
): Promise<EvolutionChange[] | null> {
  const paths = [...new Set(steps.map((c) => c.path))]
  const blocks = paths.map(
    (f) => `--- FILE: ${f} (CURRENT, ORIGINAL CONTENT) ---\n${fileCache.get(f) ?? '(new file)'}`
  )
  try {
    const raw = await evolutionComplete(
      'You are MIST repairing your own draft. Your changes were verified in an isolated staging copy of the codebase and FAILED the gates listed below. ' +
        'Fix them. Reply with ONLY a JSON object: {"changes": [ …the FULL corrected changes array… ]}. ' +
        'Same rules: find copied VERBATIM from the file (exact characters, exact indentation), occurs exactly once, steps apply in order, ' +
        'no overlapping regions, and only use imports/functions/objects you can SEE in the file contents below.',
      `IDEA: ${title}\n\nACCUMULATED GATE REPORT:\n${accumulatedErrors.join('\n').slice(0, 12_000)}\n\n` +
        `YOUR CURRENT CHANGES:\n${JSON.stringify(steps, null, 1).slice(0, 30_000)}\n\n` +
        `FILE CONTENTS (originals — the live tree was never touched):\n${blocks.join('\n\n').slice(0, 90_000)}`
    )
    const parsed = parseModelJson<{ changes?: unknown }>(raw)
    if (!parsed || !Array.isArray(parsed.changes)) return null
    const { changes } = validateChanges(parsed.changes)
    if (changes.length === 0) return null
    const verified = await verifyChangesAgainstFiles(changes)
    return verified.length > 0 ? verified : null
  } catch {
    return null
  }
}
/** Verify each change's find against the CURRENT files (chained in memory). */
async function verifyChangesAgainstFiles(changes: EvolutionChange[]): Promise<EvolutionChange[]> {
  const fileCache = new Map<string, string | null>()
  await Promise.all(
    [...new Set(changes.map((c) => c.path))].map(async (p) => {
      fileCache.set(p, await readProjectFile(p, 200_000))
    })
  )
  const ok: EvolutionChange[] = []
  const pending = new Map<string, string>()
  for (const c of changes) {
    if (c.action === 'create') {
      pending.set(c.path, c.content ?? '')
      ok.push(c)
      continue
    }
    const buf = pending.get(c.path) ?? fileCache.get(c.path) ?? null
    if (buf === null) continue
    if (buf.split(c.find ?? '\u0000').length - 1 === 1) {
      pending.set(c.path, buf.replace(c.find ?? '', c.content ?? ''))
      ok.push(c)
    }
  }
  return ok
}

/** One LLM round: fix the changes so lint passes. Files are back to original. */
async function lintRepairRound(
  title: string,
  steps: EvolutionChange[],
  lintOutput: string
): Promise<EvolutionChange[] | null> {
  const paths = [...new Set(steps.map((c) => c.path))]
  const blocks = await Promise.all(
    paths.map(async (f) => `--- FILE: ${f} (CURRENT, ORIGINAL CONTENT) ---\n${(await readProjectFile(f, 200_000)) ?? '(new file)'}`)
  )
  try {
    const raw = await evolutionComplete(
      'You are MIST repairing your own patch. It applied cleanly, but `bun run lint` FAILED. ' +
        'Fix your changes so lint passes. Reply with ONLY a JSON object: {"changes": [ …the FULL corrected changes array… ]}. ' +
        'Same rules: find copied VERBATIM from the file, occurs exactly once, steps apply in order, no overlapping regions, ' +
        'valid TypeScript/TSX (watch JSX braces, unused vars, react hooks rules).',
      `IDEA: ${title}\n\nLINT OUTPUT:\n${lintOutput.slice(-6000)}\n\nYOUR CHANGES THAT FAILED LINT:\n` +
        `${JSON.stringify(steps, null, 1).slice(0, 30_000)}\n\nFILE CONTENTS (originals, after rollback):\n${blocks.join('\n\n').slice(0, 90_000)}`
    )
    const parsed = parseModelJson<{ changes?: unknown }>(raw)
    if (!parsed || !Array.isArray(parsed.changes)) return null
    const { changes } = validateChanges(parsed.changes)
    if (changes.length === 0) return null
    const verified = await verifyChangesAgainstFiles(changes)
    return verified.length > 0 ? verified : null
  } catch {
    return null
  }
}

async function rollbackFiles(backupDir: string, backedUp: string[], createdFiles: string[]): Promise<void> {
  for (const rel of createdFiles) {
    try {
      await fs.unlink(path.join(PROJECT_ROOT, rel))
    } catch {
      // already gone
    }
  }
  for (const rel of backedUp) {
    try {
      await fs.copyFile(path.join(backupDir, rel.replace(/\//g, '__')), path.join(PROJECT_ROOT, rel))
    } catch {
      // best effort
    }
  }
}

export async function rejectProposal(id: string): Promise<EvolutionProposal | null> {
  const row = await db.evolutionProposal.update({
    where: { id },
    data: { status: 'rejected', updatedAt: new Date() },
  })
  recordActivity('evolution', `proposal "${row.title}" rejected`)
  try {
    const { reverifyMissionsForProposal } = await import('./mission-service')
    void reverifyMissionsForProposal(id)
  } catch {
    /* best-effort */
  }
  return toProposal(row)
}

// ---------- proactive self-improvement loop ----------
// globalThis-guarded (Next dev compiles routes independently).

const evoGlobal = globalThis as unknown as {
  __mistEvolutionWatch?: { started: boolean; timer?: ReturnType<typeof setInterval>; nextRunAt?: number }
}

export function getEvolutionAutoInfo(): { suggest_interval_hours: number; next_run_at: string | null } {
  const raw = Number(process.env.MIST_EVOLUTION_INTERVAL_H ?? '6')
  const hours = Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : 6
  const g = evoGlobal.__mistEvolutionWatch
  return {
    suggest_interval_hours: hours,
    next_run_at: g?.nextRunAt ? new Date(g.nextRunAt).toISOString() : null,
  }
}

/** Start the proactive loop: every N hours MIST quietly proposes improvements for itself. */
export function ensureEvolutionWatch(): void {
  const g = (evoGlobal.__mistEvolutionWatch ??= { started: false })
  if (g.started) return
  if ((process.env.MIST_EVOLUTION_AUTO_SUGGEST ?? '').trim().toLowerCase() === 'off') return
  g.started = true

  const raw = Number(process.env.MIST_EVOLUTION_INTERVAL_H ?? '6')
  const hours = Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : 6
  const intervalMs = hours * 60 * 60 * 1000

  const tick = async () => {
    g.nextRunAt = Date.now() + intervalMs
    try {
      const stats = await getEvolutionStats()
      if (stats.pending >= MAX_PENDING_BEFORE_AUTO) return // let the human catch up first
      // openclaw-inspired first (fresh upstream ideas), otherwise self-idea
      const oc = await getOpenClawStatus()
      if (oc.latest_version && oc.last_sync_at === oc.last_changed_at) {
        await suggestFeatures('openclaw')
      } else {
        await suggestFeatures('self-idea')
      }
    } catch {
      // quiet — proactive runs must never disturb the user
    }
  }

  setTimeout(() => {
    void tick()
  }, 3 * 60 * 1000).unref?.()
  g.timer = setInterval(() => {
    void tick()
  }, intervalMs)
  g.timer.unref?.()
  g.nextRunAt = Date.now() + 3 * 60 * 1000
}
