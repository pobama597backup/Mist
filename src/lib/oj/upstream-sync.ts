// M.I.S.T. oj upstream-sync — "she updates herself from the OpenJarvis repo".
//
// Five-stage pipeline against the local clone at /home/z/OpenJarvis
// (remote https://github.com/open-jarvis/OpenJarvis.git, branch main):
//
//   DETECT  — cheap `git ls-remote` every MIST_OJ_SYNC_INTERVAL_MIN minutes
//             (default 30, min 5) + manual pings with a 5-min min-gap.
//             Network fail = honest error in state + activity log, NO alert
//             spam, retry next sweep. First sighting = silent baseline.
//   FETCH   — on detected change: `git fetch origin main`, capture the commit
//             log (capped at 100 listed + total count), the full changed-file
//             list, and the CHANGELOG.md delta (capped 20KB), then
//             `git merge --ff-only origin/main`. A failed fast-forward keeps
//             the old local HEAD (nothing is ever forced) — the analysis
//             still runs against origin/main and the merge is retried later.
//   MAP     — every changed file is classified via longest-prefix match
//             against db/oj-port-map.json (human-editable ledger mapping
//             upstream paths → ported M.I.S.T. modules) into tiers:
//             structural | knowledge | excluded | unknown.
//   ADAPT   — tiered automation:
//             • knowledge  (docs/CHANGELOG/README/configs): FULLY AUTOMATIC —
//               LLM delta-brief (≤200 words via z-ai-web-dev-sdk), brief +
//               raw changelog delta ingested into the knowledge base
//               (oj-mind's ingestKnowledge; if unavailable the brief is
//               stored as pending_knowledge and retried next sweep), a
//               🔄 alert delivered into the chat, activity logged.
//             • structural (ported-module code): AUTOMATIC PROPOSAL, GATED
//               APPLY — grouped by module into evolution-service backlog
//               proposals; with MIST_OJ_AUTO_PATCH=on each proposal is also
//               developed (LLM patch plan) in the background. Applying is
//               ALWAYS an explicit user action through the evolution gates
//               (staged verification + backups + lint/tsc + auto-rollback).
//             • excluded/unknown: counted and reported honestly, no action.
//   SURFACE — alerts (kind 'oj-sync') ride the same poller path reminders
//             use; chat tools (sync-tools.ts) and /api/mist/oj/sync expose
//             check / status / apply / configure.
//
// State lives in db/oj-sync.json (runtime-created, history capped at 50).
// The watch loop is globalThis-guarded, unref'd, and swallows its own errors.

import fs from 'node:fs/promises'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { db } from '@/lib/db'
import { recordActivity } from '@/lib/services/activity-service'
import { getZai } from '@/lib/services/zai'
import { getCoreTextModelSelection, noteCoreReportedModel } from '@/lib/services/core-models'

const execFileAsync = promisify(execFile)

// ---------- constants ----------

const CLONE_DIR = '/home/z/OpenJarvis'
const UPSTREAM_URL = 'https://github.com/open-jarvis/OpenJarvis.git'
const UPSTREAM_REPO = 'open-jarvis/OpenJarvis'
const STATE_FILE = path.join(process.cwd(), 'db', 'oj-sync.json')
const PORT_MAP_FILE = path.join(process.cwd(), 'db', 'oj-port-map.json')

const DEFAULT_INTERVAL_MIN = 30
const MIN_INTERVAL_MIN = 5
const MAX_INTERVAL_MIN = 1440
/** Rate-limit for manual pings (mirrors watchlist MIN_SWEEP_GAP_MS). */
const MIN_SWEEP_GAP_MS = 5 * 60 * 1000
/** First sweep shortly after boot so restarts resume fast. */
const BOOT_DELAY_MS = 20 * 1000

const MAX_HISTORY = 50
const MAX_COMMITS_LISTED = 100
const CHANGELOG_CAP_BYTES = 20 * 1024
const GIT_MAX_BUFFER = 1024 * 1024 // 1MB output cap on every git call
const MAX_FILES_PARSED = 2000
const BRIEF_TIMEOUT_MS = 90_000
const BRIEF_FALLBACK =
  'LLM brief unavailable — raw commits recorded; the brief (and knowledge indexing) will be retried on the next sweep.'

const SHA_RE = /^[0-9a-f]{40}$/i

// ---------- types (public) ----------

export interface OjSyncCommit {
  sha: string
  date: string
  title: string
}

export interface OjSyncFileChange {
  status: string
  path: string
}

export interface OjSyncTiers {
  structural: number
  knowledge: number
  excluded: number
  unknown: number
}

export interface OjSyncConfig {
  interval_min: number
  auto_patch: boolean
}

export interface OjSyncPendingKnowledge {
  old_head: string
  new_head: string
  commits: OjSyncCommit[]
  total_commits: number
  changelog_delta: string
  brief: string | null
  since: string
}

export interface OjSyncHistoryEntry {
  at: string
  old_head: string
  new_head: string
  commits: number
  files: number
  brief?: string
  proposals: string[]
  tiers?: OjSyncTiers
  merged?: boolean
  pending_knowledge?: boolean
  error?: string
}

export interface OjSyncReport {
  ok: boolean
  changed: boolean
  head: string | null
  old_head?: string | null
  baseline?: boolean
  busy?: boolean
  commits?: { total: number; listed: number; sample: OjSyncCommit[]; truncated: boolean }
  files?: { total: number; list: OjSyncFileChange[]; truncated: boolean }
  tiers?: OjSyncTiers
  brief?: string
  proposals?: Array<{ id: string; module: string; title: string; developing: boolean }>
  merged?: boolean
  pending_knowledge?: boolean
  error?: string
  message: string
}

export interface OjSyncStatus {
  repo: string
  watching: boolean
  head: string | null
  local_head: string | null
  merge_pending: boolean
  last_head_at: string | null
  last_sweep_at: string | null
  next_sweep_at: string | null
  interval_min: number
  auto_patch: boolean
  sweeps: number
  error: string | null
  pending_knowledge: { new_head: string; since: string; has_brief: boolean; commits: number } | null
  developing: string[]
  history: OjSyncHistoryEntry[]
}

export interface OjPortMapEntry {
  prefix: string
  module: string
  targets: string[]
  tier: 'structural' | 'knowledge' | 'excluded'
  note?: string
}

export interface OjPortMap {
  upstream_repo: string
  default_branch: string
  mapping: OjPortMapEntry[]
}

export interface OjPortMapSummary {
  repo: string
  branch: string
  entries: number
  modules: Array<{ module: string; tier: string; prefixes: string[]; targets: number }>
}

interface OjSyncState {
  last_head: string | null
  last_head_at: string | null
  local_head: string | null
  last_sweep_at: string | null
  sweeps: number
  history: OjSyncHistoryEntry[]
  config: OjSyncConfig
  pending_knowledge?: OjSyncPendingKnowledge | null
  error?: string | null
  /** once-only alert keys (e.g. 'clone-unusable') so failures never spam */
  alerted?: string[]
}

// ---------- env → config ----------

function envIntervalMin(): number {
  const raw = Number(process.env.MIST_OJ_SYNC_INTERVAL_MIN ?? '')
  return Number.isFinite(raw) && raw >= MIN_INTERVAL_MIN
    ? Math.min(MAX_INTERVAL_MIN, Math.floor(raw))
    : DEFAULT_INTERVAL_MIN
}

function envAutoPatch(): boolean {
  return (process.env.MIST_OJ_AUTO_PATCH ?? '').trim().toLowerCase() === 'on'
}

function clampInterval(raw: number): number {
  return Math.min(MAX_INTERVAL_MIN, Math.max(MIN_INTERVAL_MIN, Math.floor(raw)))
}

function initialState(): OjSyncState {
  return {
    last_head: null,
    last_head_at: null,
    local_head: null,
    last_sweep_at: null,
    sweeps: 0,
    history: [],
    config: { interval_min: envIntervalMin(), auto_patch: envAutoPatch() },
    pending_knowledge: null,
    error: null,
    alerted: [],
  }
}

// ---------- persistence ----------

async function readState(): Promise<OjSyncState> {
  try {
    const raw = await fs.readFile(STATE_FILE, 'utf-8')
    const parsed = JSON.parse(raw) as Partial<OjSyncState>
    const config: OjSyncConfig = {
      interval_min:
        typeof parsed.config?.interval_min === 'number' && Number.isFinite(parsed.config.interval_min)
          ? clampInterval(parsed.config.interval_min)
          : envIntervalMin(),
      auto_patch: typeof parsed.config?.auto_patch === 'boolean' ? parsed.config.auto_patch : envAutoPatch(),
    }
    return {
      last_head: typeof parsed.last_head === 'string' ? parsed.last_head : null,
      last_head_at: typeof parsed.last_head_at === 'string' ? parsed.last_head_at : null,
      local_head: typeof parsed.local_head === 'string' ? parsed.local_head : null,
      last_sweep_at: typeof parsed.last_sweep_at === 'string' ? parsed.last_sweep_at : null,
      sweeps: typeof parsed.sweeps === 'number' && Number.isFinite(parsed.sweeps) ? parsed.sweeps : 0,
      history: Array.isArray(parsed.history) ? parsed.history.slice(-MAX_HISTORY) : [],
      config,
      pending_knowledge: parsed.pending_knowledge ?? null,
      error: typeof parsed.error === 'string' ? parsed.error : null,
      alerted: Array.isArray(parsed.alerted) ? parsed.alerted : [],
    }
  } catch {
    return initialState()
  }
}

async function writeState(state: OjSyncState): Promise<void> {
  try {
    await fs.mkdir(path.dirname(STATE_FILE), { recursive: true })
    if (state.history.length > MAX_HISTORY) state.history.splice(0, state.history.length - MAX_HISTORY)
    await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2), 'utf-8')
  } catch {
    // state file is best-effort — alerts/proposals live in the DB
  }
}

// ---------- git plumbing (execFile only — no shell, no interpolation) ----------

async function git(args: string[], timeoutMs: number): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', args, {
      timeout: timeoutMs,
      maxBuffer: GIT_MAX_BUFFER,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    })
    return stdout
  } catch {
    return null
  }
}

/** `git ls-remote <url> refs/heads/main` — cheap change detection, no clone mutation. */
async function detectUpstreamHead(): Promise<string | null> {
  const out = await git(['ls-remote', UPSTREAM_URL, 'refs/heads/main'], 30_000)
  if (!out) return null
  for (const line of out.split('\n')) {
    const m = /^([0-9a-f]{40})\trefs\/heads\/main$/.exec(line.trim())
    if (m) return m[1].toLowerCase()
  }
  return null
}

async function cloneIsUsable(): Promise<boolean> {
  const out = await git(['-C', CLONE_DIR, 'rev-parse', '--is-inside-work-tree'], 15_000)
  return out !== null && out.trim() === 'true'
}

async function localHead(): Promise<string | null> {
  const out = await git(['-C', CLONE_DIR, 'rev-parse', 'HEAD'], 15_000)
  const sha = (out ?? '').trim().toLowerCase()
  return SHA_RE.test(sha) ? sha : null
}

function parseLog(out: string | null): OjSyncCommit[] {
  if (!out) return []
  const commits: OjSyncCommit[] = []
  for (const line of out.split('\n')) {
    if (!line.trim()) continue
    const parts = line.split('\t')
    if (parts.length < 3) continue
    const [sha, date, ...titleParts] = parts
    if (!SHA_RE.test(sha)) continue
    commits.push({ sha: sha.toLowerCase(), date, title: titleParts.join('\t').trim() })
  }
  return commits
}

function parseNameStatus(out: string | null): OjSyncFileChange[] {
  if (!out) return []
  const files: OjSyncFileChange[] = []
  for (const line of out.split('\n')) {
    if (!line.trim()) continue
    const parts = line.split('\t')
    if (parts.length < 2) continue
    // "M\tpath" | "A\tpath" | "D\tpath" | "R100\told\tnew" | "C75\told\tnew"
    const status = parts[0]
    const file = parts.length >= 3 ? parts[parts.length - 1] : parts[1]
    if (!file) continue
    files.push({ status, path: file })
    if (files.length >= MAX_FILES_PARSED) break
  }
  return files
}

// ---------- port map (db/oj-port-map.json — human-editable) ----------

const EMPTY_MAP: OjPortMap = { upstream_repo: UPSTREAM_REPO, default_branch: 'main', mapping: [] }

async function loadPortMap(): Promise<OjPortMap> {
  try {
    const raw = await fs.readFile(PORT_MAP_FILE, 'utf-8')
    const parsed = JSON.parse(raw) as Partial<OjPortMap>
    if (!Array.isArray(parsed.mapping)) return EMPTY_MAP
    const mapping = parsed.mapping.filter(
      (e): e is OjPortMapEntry =>
        !!e && typeof e.prefix === 'string' && typeof e.module === 'string' && Array.isArray(e.targets)
    )
    return {
      upstream_repo: typeof parsed.upstream_repo === 'string' ? parsed.upstream_repo : UPSTREAM_REPO,
      default_branch: typeof parsed.default_branch === 'string' ? parsed.default_branch : 'main',
      mapping,
    }
  } catch {
    return EMPTY_MAP
  }
}

/** A prefix matches a path when it is the path itself, or a directory-ish prefix. */
function prefixMatches(file: string, prefix: string): boolean {
  if (file === prefix) return true
  return file.startsWith(prefix) && (prefix.endsWith('/') || file[prefix.length] === '/')
}

/** Longest-prefix match — the most specific ledger entry wins. */
function classifyPath(file: string, map: OjPortMap): OjPortMapEntry | null {
  let best: OjPortMapEntry | null = null
  for (const entry of map.mapping) {
    if (prefixMatches(file, entry.prefix) && (!best || entry.prefix.length > best.prefix.length)) {
      best = entry
    }
  }
  return best
}

interface DeltaClassification {
  /** module → grouped structural files + mapped targets */
  structural: Map<string, { module: string; files: string[]; targets: string[] }>
  knowledgeFiles: string[]
  excludedFiles: string[]
  unknownFiles: string[]
  tiers: OjSyncTiers
}

function classifyFiles(files: string[], map: OjPortMap): DeltaClassification {
  const cls: DeltaClassification = {
    structural: new Map(),
    knowledgeFiles: [],
    excludedFiles: [],
    unknownFiles: [],
    tiers: { structural: 0, knowledge: 0, excluded: 0, unknown: 0 },
  }
  for (const file of files) {
    const entry = classifyPath(file, map)
    if (!entry) {
      cls.unknownFiles.push(file)
      cls.tiers.unknown++
      continue
    }
    if (entry.tier === 'knowledge') {
      cls.knowledgeFiles.push(file)
      cls.tiers.knowledge++
    } else if (entry.tier === 'excluded') {
      cls.excludedFiles.push(file)
      cls.tiers.excluded++
    } else {
      const group = cls.structural.get(entry.module) ?? { module: entry.module, files: [], targets: [] }
      group.files.push(file)
      for (const t of entry.targets) if (!group.targets.includes(t)) group.targets.push(t)
      cls.structural.set(entry.module, group)
      cls.tiers.structural++
    }
  }
  return cls
}

// ---------- alerts (kind 'oj-sync' — rides the same poller path as reminders) ----------

async function raiseOjSyncAlert(title: string, body: string, meta: Record<string, unknown> = {}): Promise<void> {
  try {
    await db.alert.create({
      data: { kind: 'oj-sync', title, body, meta: JSON.stringify({ repo: UPSTREAM_REPO, ...meta }) },
    })
    recordActivity('oj-sync', `alert queued: ${title.slice(0, 70)}`)
  } catch {
    // an alert-DB hiccup must never kill a sweep
  }
}

/** Honest one-shot alerts (e.g. clone unusable) — the key is cleared on recovery. */
async function maybeAlertOnce(state: OjSyncState, key: string, title: string, body: string): Promise<void> {
  if ((state.alerted ?? []).includes(key)) return
  state.alerted = [...(state.alerted ?? []), key]
  await raiseOjSyncAlert(title, body, { once: key })
}

// ---------- Tier K: LLM delta-brief + knowledge ingestion ----------

async function generateDeltaBrief(input: {
  commits: OjSyncCommit[]
  total: number
  changelogDelta: string
}): Promise<string | null> {
  try {
    const commitLines = input.commits
      .slice(0, 25)
      .map((c) => `- ${c.sha.slice(0, 7)} (${c.date.slice(0, 10)}) ${c.title}`)
      .join('\n')
    const more = input.total > input.commits.length ? `\n(and ${input.total - input.commits.length} more commits)` : ''
    const zai = await getZai()
    const coreTextModel = getCoreTextModelSelection()
    const completion = await Promise.race([
      zai.chat.completions.create({
        ...(coreTextModel ? { model: coreTextModel } : {}),
        messages: [
          {
            role: 'assistant',
            content:
              'You are M.I.S.T. (Clare), a sovereign AI assistant. Part of your architecture was ported from the open-source OpenJarvis project, and its repo just moved. Write a warm, precise delta brief of AT MOST 200 words: what changed upstream and what it means for you, M.I.S.T. Plain flowing prose, no headings, no markdown lists.',
          },
          {
            role: 'user',
            content:
              `Upstream ${UPSTREAM_REPO} moved ${input.total} commit(s):\n${commitLines}${more}\n\n` +
              `CHANGELOG.md diff (may be empty):\n${input.changelogDelta.slice(0, 8000)}`,
          },
        ],
        thinking: { type: 'disabled' },
      }),
      new Promise<null>((resolve) => {
        const t = setTimeout(() => resolve(null), BRIEF_TIMEOUT_MS)
        t.unref?.()
      }),
    ])
    if (!completion) return null
    noteCoreReportedModel('text', completion.model)
    const text = completion.choices[0]?.message?.content
    if (typeof text === 'string' && text.trim()) return text.trim().slice(0, 2500)
    return null
  } catch {
    return null
  }
}

/** oj-mind's knowledge service — dynamic import so this module never hard-depends on it. */
async function ingestKnowledgeDelta(brief: string, changelogDelta: string, newHead: string): Promise<boolean> {
  try {
    const m = (await import('@/lib/oj/knowledge-service')) as {
      ingestKnowledge?: (input: {
        source: string
        title?: string
        text: string
        docType?: string
        sourceId?: string
        meta?: Record<string, unknown>
      }) => Promise<unknown>
    }
    if (typeof m.ingestKnowledge !== 'function') return false
    await m.ingestKnowledge({
      source: 'github',
      title: `OpenJarvis upstream sync @ ${newHead.slice(0, 10)}`,
      text:
        brief +
        (changelogDelta.trim() ? `\n\n--- raw CHANGELOG.md delta ---\n${changelogDelta}` : ''),
      docType: 'document',
      sourceId: `${UPSTREAM_REPO}@${newHead}`,
      meta: { origin: 'oj-sync', repo: UPSTREAM_REPO, head: newHead },
    })
    return true
  } catch {
    return false
  }
}

/** Retry a deferred knowledge ingest (module was missing / LLM brief failed last sweep). */
async function flushPendingKnowledge(state: OjSyncState): Promise<void> {
  const pk = state.pending_knowledge
  if (!pk) return
  const brief = pk.brief ?? (await generateDeltaBrief({ commits: pk.commits, total: pk.total_commits, changelogDelta: pk.changelog_delta }))
  if (!brief) return // still no brief — stay pending, retry next sweep
  const ingested = await ingestKnowledgeDelta(brief, pk.changelog_delta, pk.new_head)
  if (!ingested) {
    if (!pk.brief) pk.brief = brief // cache the successful brief for next retry
    return
  }
  state.pending_knowledge = null
  await raiseOjSyncAlert(
    `🔄 OpenJarvis upstream: ${pk.total_commits} new commit${pk.total_commits === 1 ? '' : 's'} — reviewed & indexed`,
    brief,
    { old_head: pk.old_head, new_head: pk.new_head, commits: pk.total_commits, tier: 'knowledge', deferred: true }
  )
  recordActivity('oj-sync', `pending knowledge flushed: ${pk.old_head.slice(0, 7)}..${pk.new_head.slice(0, 7)} indexed`)
}

// ---------- Tier S: automatic proposals through the evolution engine ----------

function buildProposalText(
  module: string,
  group: { files: string[]; targets: string[] },
  oldHead: string,
  newHead: string,
  totalCommits: number,
  commits: OjSyncCommit[]
): string {
  const files = group.files.slice(0, 6).join(', ') + (group.files.length > 6 ? ` (+${group.files.length - 6} more)` : '')
  const titles = commits.slice(0, 3).map((c) => c.title).join(' | ')
  const targets = group.targets.slice(0, 4).join(', ')
  return (
    `Port OpenJarvis upstream changes → ${module}: ${group.files.length} file(s), ${totalCommits} commit(s) ` +
    `(${oldHead.slice(0, 7)}..${newHead.slice(0, 7)}). Upstream changed: ${files}. Key commits: ${titles}. ` +
    `Review the mapped M.I.S.T. targets (${targets}); inspect the upstream clone at ${CLONE_DIR} with range ` +
    `${oldHead.slice(0, 7)}..${newHead.slice(0, 7)} and port the applicable improvements into our TS/Next.js stack — ` +
    `honestly skip parts that don't apply to this platform and say why.`
  )
}

function developInBackground(proposalId: string): void {
  const g = ojSyncGlobal.__mistOjSyncWatch
  if (!g) return
  g.developing ??= new Set()
  g.developing.add(proposalId)
  void (async () => {
    try {
      const { developProposal } = await import('@/lib/services/evolution-service')
      const dev = await developProposal(proposalId)
      recordActivity(
        'oj-sync',
        dev
          ? `proposal ${proposalId.slice(0, 8)} developed (${dev.changes.length} change step(s)) — ready for one-click gated apply`
          : `proposal ${proposalId.slice(0, 8)} development failed — see its error field in Diagnostics → Evolve`
      )
    } catch (err) {
      recordActivity('oj-sync', `proposal develop error: ${err instanceof Error ? err.message.slice(0, 90) : 'unknown'}`)
    } finally {
      g.developing?.delete(proposalId)
    }
  })()
}

// ---------- the sweep (DETECT → FETCH → MAP → ADAPT) ----------

async function runSweepInner(force: boolean): Promise<OjSyncReport> {
  const state = await readState()
  const nowIso = new Date().toISOString()

  // manual pings are rate-limited (forced sweeps bypass, like the watchlist)
  if (!force && state.last_sweep_at) {
    const gap = Date.now() - Date.parse(state.last_sweep_at)
    if (Number.isFinite(gap) && gap >= 0 && gap < MIN_SWEEP_GAP_MS) {
      return {
        ok: true,
        changed: false,
        head: state.last_head,
        message: `swept ${Math.max(1, Math.round(gap / 60000))} min ago — 5-min minimum gap; force to override`,
      }
    }
  }

  // ---- clone sanity (missing/corrupt → honest one-shot alert, no spam) ----
  if (!(await cloneIsUsable())) {
    state.error = `clone at ${CLONE_DIR} missing or corrupt (git rev-parse failed) — re-clone with: git clone ${UPSTREAM_URL} ${CLONE_DIR}`
    state.last_sweep_at = nowIso
    state.sweeps += 1
    await maybeAlertOnce(
      state,
      'clone-unusable',
      '⚠️ OpenJarvis clone unusable — self-update paused',
      `${state.error}\nUpstream sync keeps detecting via ls-remote but cannot fetch/analyze until the clone is restored. This alert fires once (no spam).`
    )
    await writeState(state)
    recordActivity('oj-sync', 'sweep failed: clone unusable — alert raised once, retrying next sweep')
    return { ok: false, changed: false, head: state.last_head, message: state.error, error: state.error }
  }
  if ((state.alerted ?? []).includes('clone-unusable')) {
    state.alerted = (state.alerted ?? []).filter((k) => k !== 'clone-unusable') // recovered → allow a future once-alert
  }

  // ---- retry a pending fast-forward (e.g. the tree was dirty last time) ----
  if (state.local_head && state.last_head && state.local_head !== state.last_head) {
    const merged = await git(['-C', CLONE_DIR, 'merge', '--ff-only', 'origin/main'], 30_000)
    if (merged !== null) {
      state.local_head = state.last_head
      recordActivity('oj-sync', `pending fast-forward recovered — clone @ ${state.last_head.slice(0, 10)}`)
    }
  }

  // ---- retry deferred knowledge (oj-mind's service may have landed since) ----
  await flushPendingKnowledge(state)

  // ---- DETECT ----
  const head = await detectUpstreamHead()
  if (!head) {
    state.error = 'upstream unreachable (git ls-remote failed — network?)'
    state.last_sweep_at = nowIso
    state.sweeps += 1
    await writeState(state)
    recordActivity('oj-sync', 'sweep failed: upstream unreachable — retrying next sweep (no alert spam)')
    return {
      ok: false,
      changed: false,
      head: state.last_head,
      message: 'upstream unreachable — recorded honestly, retrying next sweep',
      error: state.error,
    }
  }
  state.error = null

  // ---- first sighting: silent baseline (like the watchlist) ----
  if (!state.last_head) {
    state.last_head = head
    state.last_head_at = nowIso
    state.local_head = await localHead()
    state.last_sweep_at = nowIso
    state.sweeps += 1
    await writeState(state)
    recordActivity('oj-sync', `baseline established: OpenJarvis @ ${head}`)
    return {
      ok: true,
      changed: false,
      head,
      baseline: true,
      message: `baseline established: OpenJarvis @ ${head.slice(0, 10)} — silently watching, no alert on first sighting`,
    }
  }

  if (head === state.last_head) {
    state.last_sweep_at = nowIso
    state.sweeps += 1
    await writeState(state)
    return { ok: true, changed: false, head, message: 'up to date — upstream HEAD unchanged' }
  }

  // ---- FETCH (upstream moved) ----
  const oldHead = state.last_head
  if (!SHA_RE.test(oldHead)) {
    state.error = `stored baseline ${oldHead} is not a valid SHA — refusing to diff, re-baselining`
    state.last_head = head
    state.last_head_at = nowIso
    state.last_sweep_at = nowIso
    state.sweeps += 1
    await writeState(state)
    return { ok: false, changed: false, head, message: state.error, error: state.error }
  }

  const fetched = await git(['-C', CLONE_DIR, 'fetch', 'origin', 'main'], 60_000)
  if (fetched === null) {
    state.error = 'git fetch origin main failed — will retry next sweep'
    state.last_sweep_at = nowIso
    state.sweeps += 1
    await writeState(state)
    recordActivity('oj-sync', 'sweep failed: fetch failed — retrying next sweep')
    return { ok: false, changed: false, head: state.last_head, message: state.error, error: state.error }
  }

  const commits = parseLog(
    await git(
      [
        '-C', CLONE_DIR, 'log', '--no-color', '--date=iso',
        '--format=%H%x09%ad%x09%s', `--max-count=${MAX_COMMITS_LISTED}`,
        `${oldHead}..origin/main`,
      ],
      30_000
    )
  )
  const countOut = await git(['-C', CLONE_DIR, 'rev-list', '--count', `${oldHead}..origin/main`], 15_000)
  const totalCommits = (() => {
    const n = parseInt((countOut ?? '').trim(), 10)
    return Number.isFinite(n) && n > 0 ? n : commits.length
  })()
  const files = parseNameStatus(
    await git(['-C', CLONE_DIR, 'diff', '--name-status', `${oldHead}..origin/main`], 30_000)
  )
  const changelogDelta = (
    await git(['-C', CLONE_DIR, 'diff', `${oldHead}..origin/main`, '--', 'CHANGELOG.md'], 30_000) ?? ''
  ).slice(0, CHANGELOG_CAP_BYTES)

  // fast-forward the local reference — NEVER force anything
  const mergeOut = await git(['-C', CLONE_DIR, 'merge', '--ff-only', 'origin/main'], 30_000)
  const mergeOk = mergeOut !== null
  const mergeError = mergeOk
    ? null
    : 'git merge --ff-only failed (dirty tree?) — kept the old local HEAD and analyzed origin/main without merging; merge will be retried'
  if (mergeOk) {
    state.local_head = head
  } else {
    recordActivity('oj-sync', `fast-forward failed: ${mergeError}`)
  }

  // ---- MAP ----
  const map = await loadPortMap()
  const cls = classifyFiles(files.map((f) => f.path), map)

  // ---- ADAPT ----
  // brief: generated for every real delta (edge case: empty changelog → brief
  // from commits alone); null on LLM failure → honest fallback + retry
  let brief: string | null = null
  if (totalCommits > 0 || files.length > 0) {
    brief = await generateDeltaBrief({ commits, total: totalCommits, changelogDelta })
  }

  // Tier K — knowledge: fully automatic (brief → ingest → alert)
  let pendingKnowledge = false
  if (cls.tiers.knowledge > 0) {
    if (brief) {
      const ingested = await ingestKnowledgeDelta(brief, changelogDelta, head)
      if (ingested) {
        await raiseOjSyncAlert(
          `🔄 OpenJarvis upstream: ${totalCommits} new commit${totalCommits === 1 ? '' : 's'} — reviewed & indexed`,
          brief,
          { old_head: oldHead, new_head: head, commits: totalCommits, files: files.length, tier: 'knowledge' }
        )
      } else {
        state.pending_knowledge = {
          old_head: oldHead,
          new_head: head,
          commits: commits.slice(0, 30),
          total_commits: totalCommits,
          changelog_delta: changelogDelta,
          brief,
          since: nowIso,
        }
        pendingKnowledge = true
        recordActivity('oj-sync', 'knowledge ingest unavailable — brief stored as pending_knowledge, retrying next sweep')
      }
    } else {
      state.pending_knowledge = {
        old_head: oldHead,
        new_head: head,
        commits: commits.slice(0, 30),
        total_commits: totalCommits,
        changelog_delta: changelogDelta,
        brief: null,
        since: nowIso,
      }
      pendingKnowledge = true
      recordActivity('oj-sync', 'LLM brief failed — delta stored as pending_knowledge, brief + ingest retry next sweep')
    }
  }

  // Tier S — structural: automatic proposals, gated apply
  const proposals: Array<{ id: string; module: string; title: string; developing: boolean }> = []
  let proposalError: string | null = null
  if (cls.structural.size > 0) {
    try {
      const { addBacklogIdea } = await import('@/lib/services/evolution-service')
      for (const group of cls.structural.values()) {
        const prop = await addBacklogIdea(buildProposalText(group.module, group, oldHead, head, totalCommits, commits))
        const developing = state.config.auto_patch
        proposals.push({ id: prop.id, module: group.module, title: prop.title, developing })
        if (developing) developInBackground(prop.id)
      }
    } catch (err) {
      proposalError = `proposal creation failed: ${err instanceof Error ? err.message.slice(0, 140) : 'unknown error'}`
      recordActivity('oj-sync', proposalError)
    }
  }

  if (proposals.length > 0) {
    const moduleLines = [...cls.structural.values()]
      .map((g) => `• ${g.module}: ${g.files.length} upstream file(s) → ${g.targets.slice(0, 3).join(', ')}${g.targets.length > 3 ? ' …' : ''}`)
      .join('\n')
    await raiseOjSyncAlert(
      `🛠️ OpenJarvis upstream: structural drift — ${proposals.length} adaptation proposal${proposals.length === 1 ? '' : 's'} drafted`,
      `Upstream ${oldHead.slice(0, 7)}..${head.slice(0, 7)} touched ported-module code:\n${moduleLines}\n\n` +
        (brief ? `${brief}\n\n` : '') +
        `Each module became an evolution proposal (kind: suggestion) in my backlog. ` +
        (state.config.auto_patch
          ? 'Auto-develop is ON — patch plans are being generated for one-click apply.'
          : 'Auto-develop is OFF — ask me to run oj_sync_apply with develop:true (or use Diagnostics → Evolve) to develop + apply through the gates.') +
        `\nProposals: ${proposals.map((p) => p.id.slice(0, 10)).join(', ')}`,
      { old_head: oldHead, new_head: head, tier: 'structural', proposals: proposals.map((p) => p.id), auto_patch: state.config.auto_patch }
    )
  }

  // ---- record ----
  const errors = [mergeError, proposalError].filter((e): e is string => e !== null)
  const entry: OjSyncHistoryEntry = {
    at: nowIso,
    old_head: oldHead,
    new_head: head,
    commits: totalCommits,
    files: files.length,
    brief: brief ?? BRIEF_FALLBACK,
    proposals: proposals.map((p) => p.id),
    tiers: cls.tiers,
    merged: mergeOk,
    ...(pendingKnowledge ? { pending_knowledge: true } : {}),
    ...(errors.length > 0 ? { error: errors.join('; ') } : {}),
  }
  state.last_head = head // the ANALYZED baseline advances even when the local merge failed
  state.last_head_at = nowIso
  state.last_sweep_at = nowIso
  state.sweeps += 1
  state.history.push(entry)
  await writeState(state)

  recordActivity(
    'oj-sync',
    `upstream moved ${oldHead.slice(0, 7)}→${head.slice(0, 7)}: ${totalCommits} commit(s), ${files.length} file(s) ` +
      `[structural ${cls.tiers.structural} / knowledge ${cls.tiers.knowledge} / excluded ${cls.tiers.excluded} / unknown ${cls.tiers.unknown}] ` +
      `— ${proposals.length} proposal(s)${pendingKnowledge ? ', knowledge pending' : cls.tiers.knowledge > 0 ? ', knowledge indexed' : ''}`
  )

  const moreNote = totalCommits > commits.length ? ` (and ${totalCommits - commits.length} more)` : ''
  return {
    ok: true,
    changed: true,
    head,
    old_head: oldHead,
    commits: {
      total: totalCommits,
      listed: commits.length,
      sample: commits.slice(0, 10),
      truncated: totalCommits > commits.length,
    },
    files: { total: files.length, list: files.slice(0, 50), truncated: files.length > 50 },
    tiers: cls.tiers,
    brief: brief ?? BRIEF_FALLBACK,
    proposals,
    merged: mergeOk,
    pending_knowledge: pendingKnowledge,
    ...(mergeError ? { error: mergeError } : {}),
    message:
      `upstream moved ${oldHead.slice(0, 7)}→${head.slice(0, 10)}: ${totalCommits} commit(s)${moreNote}, ` +
      `${files.length} file(s) — ${proposals.length} proposal(s) drafted` +
      (pendingKnowledge ? ', knowledge ingest pending' : cls.tiers.knowledge > 0 ? ', knowledge indexed' : ''),
  }
}

// ---------- public sweep entry (in-flight lock: loop + manual never race) ----------

export async function sweepOjSync(force = false): Promise<OjSyncReport> {
  const g = (ojSyncGlobal.__mistOjSyncWatch ??= { started: false })
  if (g.inFlight) {
    return { ok: false, busy: true, changed: false, head: null, message: 'sweep already running — the in-flight one finishes shortly' }
  }
  const p = runSweepInner(force)
  g.inFlight = p
  try {
    return await p
  } finally {
    g.inFlight = null
  }
}

// ---------- status / configure / apply ----------

export async function getOjSyncStatus(): Promise<OjSyncStatus> {
  const state = await readState()
  const g = ojSyncGlobal.__mistOjSyncWatch
  const interval = clampInterval(state.config.interval_min)
  const lastSweep = state.last_sweep_at ? Date.parse(state.last_sweep_at) : null
  const next = lastSweep ? new Date(lastSweep + interval * 60_000).toISOString() : null
  const pk = state.pending_knowledge
  return {
    repo: UPSTREAM_REPO,
    watching: g?.started === true,
    head: state.last_head,
    local_head: state.local_head,
    merge_pending: !!(state.local_head && state.last_head && state.local_head !== state.last_head),
    last_head_at: state.last_head_at,
    last_sweep_at: state.last_sweep_at,
    next_sweep_at: next,
    interval_min: interval,
    auto_patch: state.config.auto_patch,
    sweeps: state.sweeps,
    error: state.error ?? null,
    pending_knowledge: pk
      ? { new_head: pk.new_head, since: pk.since, has_brief: pk.brief !== null, commits: pk.total_commits }
      : null,
    developing: [...(g?.developing ?? [])],
    history: state.history.slice(-5),
  }
}

export async function getOjPortMapSummary(): Promise<OjPortMapSummary> {
  const map = await loadPortMap()
  const modules = new Map<string, { module: string; tier: string; prefixes: string[]; targets: number }>()
  for (const e of map.mapping) {
    const m = modules.get(e.module) ?? { module: e.module, tier: e.tier, prefixes: [], targets: 0 }
    m.prefixes.push(e.prefix)
    m.targets += e.targets.length
    modules.set(e.module, m)
  }
  return {
    repo: map.upstream_repo,
    branch: map.default_branch,
    entries: map.mapping.length,
    modules: [...modules.values()],
  }
}

export async function configureOjSync(opts: {
  interval_min?: unknown
  auto_patch?: unknown
}): Promise<{ ok: boolean; message: string; config: OjSyncConfig }> {
  const state = await readState()
  const changes: string[] = []
  if (opts.interval_min !== undefined) {
    const n = Number(opts.interval_min)
    if (!Number.isFinite(n) || n <= 0) {
      return { ok: false, message: 'interval_min must be a positive number of minutes', config: state.config }
    }
    const clamped = clampInterval(n)
    if (clamped !== Math.floor(n)) changes.push(`interval_min clamped ${n} → ${clamped} (allowed ${MIN_INTERVAL_MIN}–${MAX_INTERVAL_MIN})`)
    state.config.interval_min = clamped
    changes.push(`interval_min = ${clamped} min`)
  }
  if (opts.auto_patch !== undefined) {
    state.config.auto_patch = opts.auto_patch === true || opts.auto_patch === 'on' || opts.auto_patch === 'true'
    changes.push(`auto_patch = ${state.config.auto_patch ? 'on' : 'off'}`)
  }
  if (changes.length === 0) {
    return { ok: false, message: 'nothing to configure — pass interval_min and/or auto_patch', config: state.config }
  }
  await writeState(state)
  const g = ojSyncGlobal.__mistOjSyncWatch
  if (g?.started) scheduleNextSweep() // re-arm so the new interval applies immediately
  recordActivity('oj-sync', `reconfigured: ${changes.join(', ')}`)
  return { ok: true, message: `config updated — ${changes.join('; ')}`, config: state.config }
}

/**
 * Apply an OpenJarvis adaptation proposal through the evolution engine's
 * GATED path (staged verification, backups, lint/tsc, automatic rollback).
 * The gates are never bypassed — this is the same applyProposal the
 * Diagnostics → Evolve UI calls.
 */
export async function applyOjSyncProposal(
  proposalId: string,
  develop = false
): Promise<{ ok: boolean; message: string; proposal?: { id: string; title: string; status: string; steps: number } }> {
  const id = proposalId.trim()
  if (!id) {
    return {
      ok: false,
      message: 'proposal_id is required — find one in oj_sync_status history, the last 🛠️ oj-sync alert, or Diagnostics → Evolve',
    }
  }
  const { getProposal, applyProposal, developProposal } = await import('@/lib/services/evolution-service')
  let prop = await getProposal(id)
  if (!prop) return { ok: false, message: `proposal ${id} not found` }
  if (prop.status !== 'pending') {
    return {
      ok: false,
      message: `proposal ${id} is already ${prop.status} — nothing to apply`,
      proposal: { id: prop.id, title: prop.title, status: prop.status, steps: prop.changes.length },
    }
  }
  const hasChanges = prop.changes.length > 0
  if (!hasChanges && !develop) {
    return {
      ok: false,
      message:
        'proposal has no developed changes yet — call again with develop:true to generate the patch plan first ' +
        '(gated), or use Diagnostics → Evolve (POST /api/mist/evolution/' + id + '/develop)',
    }
  }
  if (!hasChanges && develop) {
    recordActivity('oj-sync', `developing proposal ${id.slice(0, 8)} before gated apply`)
    const dev = await developProposal(id)
    if (!dev) {
      return { ok: false, message: 'development failed — check the proposal error field in Diagnostics → Evolve' }
    }
    prop = dev
  }
  recordActivity('oj-sync', `gated apply requested for proposal ${id.slice(0, 8)}`)
  const res = await applyProposal(id)
  const ok = res.proposal !== null && res.proposal.status === 'applied'
  recordActivity('oj-sync', `apply ${ok ? 'succeeded' : 'finished'} for proposal ${id.slice(0, 8)}: ${res.message}`)
  return {
    ok,
    message: res.message,
    proposal: res.proposal
      ? { id: res.proposal.id, title: res.proposal.title, status: res.proposal.status, steps: res.proposal.changes.length }
      : undefined,
  }
}

// ---------- guarded watch loop (one per process, unref'd, self-swallowing) ----------

const ojSyncGlobal = globalThis as unknown as {
  __mistOjSyncWatch?: {
    started: boolean
    timer?: ReturnType<typeof setTimeout>
    inFlight?: Promise<OjSyncReport> | null
    developing?: Set<string>
    /** Which module instance armed the loop — a fresh dev compile replaces a stale timer. */
    armedBy?: object
  }
}

// unique per module instance (per dev-mode compile)
const ARM_TOKEN = {}

function scheduleNextSweep(delayMs?: number): void {
  const g = ojSyncGlobal.__mistOjSyncWatch
  if (!g || !g.started) return
  void (async () => {
    let ms = delayMs
    if (ms === undefined) {
      try {
        ms = clampInterval((await readState()).config.interval_min) * 60_000
      } catch {
        ms = DEFAULT_INTERVAL_MIN * 60_000
      }
    }
    if (g.timer) {
      try {
        clearTimeout(g.timer)
      } catch {
        /* already gone */
      }
    }
    g.timer = setTimeout(() => {
      void scheduledTick()
    }, ms)
    g.timer.unref?.()
  })()
}

async function scheduledTick(): Promise<void> {
  try {
    await sweepOjSync(false)
  } catch {
    // the loop swallows its own errors — next tick retries
  }
  scheduleNextSweep() // re-read the interval so runtime reconfig applies
}

export function ensureOjSyncWatch(): void {
  const g = (ojSyncGlobal.__mistOjSyncWatch ??= { started: false })
  if (g.started && g.armedBy === ARM_TOKEN) return
  if (g.timer) {
    try {
      clearTimeout(g.timer)
    } catch {
      /* already gone */
    }
  }
  g.started = true
  g.armedBy = ARM_TOKEN
  recordActivity('oj-sync', 'upstream watch armed — polling open-jarvis/OpenJarvis for new commits')
  scheduleNextSweep(BOOT_DELAY_MS)
}

// ============================================================================
// Mark-LV watcher (mlv-rust-3) — "make the Mark-LV anti rust".
//
// A SECOND upstream watch beside the OpenJarvis engine above, reusing its
// proven plumbing (the same git() exec helper, parsers, interval source,
// once-only alerts, knowledge ingestion, globalThis-guarded loop) with a
// deliberately SIMPLER adaptation policy: Mark-LV
// (github.com/FatihMakes/Mark-LV — the creator's teacher's Python/PyQt
// desktop assistant, cloned at /home/z/Mark-LV) is a KNOWLEDGE source, not a
// porting source. M.I.S.T. never auto-ports its desktop code — every new
// upstream commit becomes knowledge so she knows what her teacher's
// assistant learned:
//
//   DETECT — `git ls-remote` (same cheap probe), SAME interval source as the
//            OJ watch (its runtime-configured interval when present — read
//            only, db/oj-sync.json is NEVER written from here — else the
//            shared MIST_OJ_SYNC_INTERVAL_MIN resolution; the OJ engine
//            exposes no disable env, so none is mirrored — if one is ever
//            added, wire it here so Mark-LV follows suit).
//   PULL   — on change: `git fetch origin main` then `git merge --ff-only
//            origin/main` (exact OJ mechanics). If the fast-forward fails the
//            local clone has diverged: record status 'diverged', raise a
//            one-shot alert, SKIP the update — nothing is ever forced, the
//            clone is never broken, the next scan retries.
//   ABSORB — `git log OLD..NEW --oneline --stat` (capped ~100 lines) + the
//            changed-file list become ONE knowledge document in oj-mind's
//            knowledge service (stable sourceId 'mark-lv-upstream' — each
//            update's digest replaces the previous one, while the state file
//            keeps the full history) with a title like
//            'Mark-LV update <short-sha> — <date>' and an honest note that
//            this is the teacher's assistant repo. A 🔄 alert tells the
//            creator 'Mark-LV updated: N commits'.
//   SURFACE — state at db/mark-lv-sync.json (NEVER db/oj-sync.json), the
//            mark_lv_sync_status chat tool, /api/mist/oj/sync actions
//            mark_lv_check | mark_lv_status, and the Upstream tab card.
//
// First sighting = silent baseline (same discipline as the OJ watch: cold
// start just baselines, it does NOT ingest the whole repo history). The loop
// is its own globalThis-guarded, unref'd, self-swallowing interval — zero
// interaction with the OJ loop above.
// ----------------------------------------------------------------------------

const MARK_LV_ID = 'mark-lv'
const MARK_LV_NAME = 'Mark-LV'
const MARK_LV_URL = 'https://github.com/FatihMakes/Mark-LV.git'
const MARK_LV_REPO = 'FatihMakes/Mark-LV'
const MARK_LV_DIR = '/home/z/Mark-LV'
const MARK_LV_BRANCH = 'main'
const MARK_LV_STATE_FILE = path.join(process.cwd(), 'db', 'mark-lv-sync.json')

const MARK_LV_MAX_HISTORY = 20
/** `git log --oneline --stat` digest line cap (spec: ~100 lines). */
const MARK_LV_DIGEST_MAX_LINES = 100
const MARK_LV_DIGEST_FILES_LISTED = 40
/** Stable knowledge sourceId — the knowledge service dedupes by
 *  source+sourceId, so each update's digest replaces the previous one (no
 *  unbounded growth); the state file keeps the full history. */
const MARK_LV_KNOWLEDGE_SOURCE_ID = 'mark-lv-upstream'

export type MarkLvWatchStatus = 'watching' | 'updated' | 'diverged' | 'error'

export interface MarkLvSyncHistoryEntry {
  head: string
  at: string
  filesChanged: number
  commits: number
}

export interface MarkLvSyncStatus {
  id: typeof MARK_LV_ID
  name: typeof MARK_LV_NAME
  repo: string
  url: string
  branch: string
  watching: boolean
  status: MarkLvWatchStatus
  head: string | null
  local_head: string | null
  commits_behind: number | null
  last_scan_at: string | null
  last_update_at: string | null
  next_scan_at: string | null
  interval_min: number
  sweeps: number
  knowledge_pending: boolean
  last_digest: string | null
  error: string | null
  history: MarkLvSyncHistoryEntry[]
}

export interface MarkLvSyncReport {
  ok: boolean
  changed: boolean
  head: string | null
  old_head?: string | null
  baseline?: boolean
  busy?: boolean
  diverged?: boolean
  status?: MarkLvWatchStatus
  commits?: { total: number; listed: number; sample: OjSyncCommit[]; truncated: boolean }
  files?: { total: number; list: OjSyncFileChange[]; truncated: boolean }
  digest?: string
  knowledge_ingested?: boolean
  error?: string
  message: string
}

interface MarkLvPendingDigest {
  old_head: string
  new_head: string
  commits: number
  files: OjSyncFileChange[]
  digest: string
  since: string
}

interface MarkLvSyncState {
  lastHead: string | null
  localHead: string | null
  lastScanAt: string | null
  lastUpdateAt: string | null
  status: MarkLvWatchStatus
  sweeps: number
  history: MarkLvSyncHistoryEntry[]
  lastDigest: string | null
  pendingDigest: MarkLvPendingDigest | null
  error: string | null
  /** once-only alert keys (e.g. 'clone-unusable', 'diverged') so failures never spam */
  alerted: string[]
}

/** Same interval source as the OJ watch: its runtime-configured value when
 *  present (READ ONLY — db/oj-sync.json is never written from here), else the
 *  shared env resolution (MIST_OJ_SYNC_INTERVAL_MIN). One knob, both watches. */
async function markLvIntervalMin(): Promise<number> {
  try {
    const raw = await fs.readFile(STATE_FILE, 'utf-8')
    const parsed = JSON.parse(raw) as { config?: { interval_min?: unknown } }
    const n = Number(parsed.config?.interval_min)
    if (Number.isFinite(n) && n >= MIN_INTERVAL_MIN) return clampInterval(n)
  } catch {
    /* no OJ state yet — fall through to the env resolution */
  }
  return envIntervalMin()
}

function initialMarkLvState(): MarkLvSyncState {
  return {
    lastHead: null,
    localHead: null,
    lastScanAt: null,
    lastUpdateAt: null,
    status: 'watching',
    sweeps: 0,
    history: [],
    lastDigest: null,
    pendingDigest: null,
    error: null,
    alerted: [],
  }
}

function parseMarkLvPendingDigest(v: unknown): MarkLvPendingDigest | null {
  if (!v || typeof v !== 'object') return null
  const p = v as Partial<MarkLvPendingDigest>
  if (
    typeof p.old_head !== 'string' ||
    typeof p.new_head !== 'string' ||
    typeof p.digest !== 'string' ||
    typeof p.since !== 'string' ||
    typeof p.commits !== 'number' ||
    !Array.isArray(p.files)
  ) {
    return null
  }
  const files = p.files.filter(
    (f): f is OjSyncFileChange => !!f && typeof f.status === 'string' && typeof f.path === 'string'
  )
  return { old_head: p.old_head, new_head: p.new_head, commits: p.commits, files, digest: p.digest, since: p.since }
}

async function readMarkLvState(): Promise<MarkLvSyncState> {
  try {
    const raw = await fs.readFile(MARK_LV_STATE_FILE, 'utf-8')
    const parsed = JSON.parse(raw) as Partial<MarkLvSyncState>
    const status: MarkLvWatchStatus =
      parsed.status === 'updated' || parsed.status === 'diverged' || parsed.status === 'error'
        ? parsed.status
        : 'watching'
    return {
      lastHead: typeof parsed.lastHead === 'string' ? parsed.lastHead : null,
      localHead: typeof parsed.localHead === 'string' ? parsed.localHead : null,
      lastScanAt: typeof parsed.lastScanAt === 'string' ? parsed.lastScanAt : null,
      lastUpdateAt: typeof parsed.lastUpdateAt === 'string' ? parsed.lastUpdateAt : null,
      status,
      sweeps: typeof parsed.sweeps === 'number' && Number.isFinite(parsed.sweeps) ? parsed.sweeps : 0,
      history: Array.isArray(parsed.history)
        ? parsed.history
            .filter(
              (h): h is MarkLvSyncHistoryEntry =>
                !!h &&
                typeof h.head === 'string' &&
                typeof h.at === 'string' &&
                typeof h.filesChanged === 'number' &&
                typeof h.commits === 'number'
            )
            .slice(-MARK_LV_MAX_HISTORY)
        : [],
      lastDigest: typeof parsed.lastDigest === 'string' ? parsed.lastDigest : null,
      pendingDigest: parseMarkLvPendingDigest(parsed.pendingDigest),
      error: typeof parsed.error === 'string' ? parsed.error : null,
      alerted: Array.isArray(parsed.alerted)
        ? parsed.alerted.filter((k): k is string => typeof k === 'string')
        : [],
    }
  } catch {
    return initialMarkLvState()
  }
}

async function writeMarkLvState(state: MarkLvSyncState): Promise<void> {
  try {
    await fs.mkdir(path.dirname(MARK_LV_STATE_FILE), { recursive: true })
    if (state.history.length > MARK_LV_MAX_HISTORY) {
      state.history.splice(0, state.history.length - MARK_LV_MAX_HISTORY)
    }
    await fs.writeFile(MARK_LV_STATE_FILE, JSON.stringify(state, null, 2), 'utf-8')
  } catch {
    // state file is best-effort — alerts/knowledge live in the DB
  }
}

/** `git ls-remote <url> refs/heads/main` — same cheap, clone-mutating-free probe as the OJ watch. */
async function detectMarkLvHead(): Promise<string | null> {
  const out = await git(['ls-remote', MARK_LV_URL, `refs/heads/${MARK_LV_BRANCH}`], 30_000)
  if (!out) return null
  const re = new RegExp(`^([0-9a-f]{40})\\trefs/heads/${MARK_LV_BRANCH}$`)
  for (const line of out.split('\n')) {
    const m = re.exec(line.trim())
    if (m) return m[1].toLowerCase()
  }
  return null
}

async function markLvLocalHead(): Promise<string | null> {
  const out = await git(['-C', MARK_LV_DIR, 'rev-parse', 'HEAD'], 15_000)
  const sha = (out ?? '').trim().toLowerCase()
  return SHA_RE.test(sha) ? sha : null
}

/** Local-only count (no network): how far the clone sits behind origin/main
 *  as of the last fetch. Null when not derivable — shown honestly. */
async function markLvCommitsBehind(): Promise<number | null> {
  const out = await git(['-C', MARK_LV_DIR, 'rev-list', '--count', `HEAD..origin/${MARK_LV_BRANCH}`], 15_000)
  const n = parseInt((out ?? '').trim(), 10)
  return Number.isFinite(n) && n >= 0 ? n : null
}

// ---------- Mark-LV alerts (same mechanism as the OJ watch: db.alert rows
// riding the heartbeat poller path; kind 'mark-lv-sync' renders as a system
// alert exactly like the OJ 'oj-sync' kind does) ----------

async function raiseMarkLvAlert(title: string, body: string, meta: Record<string, unknown> = {}): Promise<void> {
  try {
    await db.alert.create({
      data: { kind: 'mark-lv-sync', title, body, meta: JSON.stringify({ repo: MARK_LV_REPO, ...meta }) },
    })
    recordActivity('mark-lv-sync', `alert queued: ${title.slice(0, 70)}`)
  } catch {
    // an alert-DB hiccup must never kill a scan
  }
}

/** Honest one-shot alerts (clone unusable, diverged) — key cleared on recovery. */
async function markLvMaybeAlertOnce(
  state: MarkLvSyncState,
  key: string,
  title: string,
  body: string
): Promise<void> {
  if (state.alerted.includes(key)) return
  state.alerted = [...state.alerted, key]
  await raiseMarkLvAlert(title, body, { once: key })
}

// ---------- ABSORB: knowledge-first (never a code port) ----------

function buildMarkLvKnowledgeText(input: {
  digest: string
  files: OjSyncFileChange[]
  commits: number
  oldHead: string
  newHead: string
  at: string
  history: MarkLvSyncHistoryEntry[]
}): string {
  const fileList = input.files
    .slice(0, MARK_LV_DIGEST_FILES_LISTED)
    .map((f) => `${f.status}\t${f.path}`)
    .join('\n')
  const prior = input.history
    .slice(-5)
    .map((h) => `- ${h.at.slice(0, 10)} ${h.head.slice(0, 7)}: ${h.commits} commit(s), ${h.filesChanged} file(s)`)
    .join('\n')
  return (
    `Mark-LV — the teacher FatihMakes' Python desktop assistant (M.I.S.T.'s inspiration repo) — moved ` +
    `${input.oldHead.slice(0, 7)}..${input.newHead.slice(0, 7)} on ${input.at.slice(0, 10)}: ` +
    `${input.commits} commit(s), ${input.files.length} file(s) changed.\n\n` +
    `Honest note: this is an automatic anti-rust digest. M.I.S.T. watches her teacher's assistant repo forever ` +
    `and absorbs every change as KNOWLEDGE — the Python/PyQt desktop code is never auto-ported into her TypeScript body.\n\n` +
    `--- git log --oneline --stat (capped) ---\n${input.digest}\n\n` +
    `--- changed files ---\n${fileList}` +
    (input.files.length > MARK_LV_DIGEST_FILES_LISTED ? `\n(+${input.files.length - MARK_LV_DIGEST_FILES_LISTED} more)` : '') +
    (prior ? `\n\n--- previously absorbed updates ---\n${prior}` : '')
  )
}

/** oj-mind's knowledge service — dynamic import so this module never hard-depends on it. */
async function ingestMarkLvKnowledge(
  text: string,
  newHead: string,
  at: string,
  commits: number,
  files: number
): Promise<boolean> {
  try {
    const m = (await import('@/lib/oj/knowledge-service')) as {
      ingestKnowledge?: (input: {
        source: string
        title?: string
        text: string
        docType?: string
        sourceId?: string
        meta?: Record<string, unknown>
      }) => Promise<unknown>
    }
    if (typeof m.ingestKnowledge !== 'function') return false
    await m.ingestKnowledge({
      source: 'github',
      title: `Mark-LV update ${newHead.slice(0, 7)} — ${at.slice(0, 10)}`,
      text,
      docType: 'document',
      sourceId: MARK_LV_KNOWLEDGE_SOURCE_ID,
      meta: { origin: 'mark-lv-sync', repo: MARK_LV_REPO, head: newHead, commits, files },
    })
    return true
  } catch {
    return false
  }
}

// ---------- w3-notify — the teacher's notices: CLARE HERSELF speaks for the update ----------
//
// When a Mark-LV digest ingests, Clare writes the creator a private note in
// her own voice (what changed + her HONEST opinion + the ask), the decision
// lands in a TeacherNotice row, and exactly ONE db.alert (kind 'mark-lv-sync')
// delivers the note into the chat — the alert body IS her message, never a
// second raw-digest alert stacked on top. The LLM cascade is reached via a
// DYNAMIC import (a static llm-service import would cycle through
// tools-service, which imports this module) — the same discipline the
// knowledge ingest uses. When every lane is down the note degrades to an
// honest "couldn't reach my language lanes" message with an empty opinion —
// a faked take is never stored.

const TEACHER_NOTICE_COMMITS_DETAILED = 10 // commits that carry a per-commit file list
const TEACHER_NOTICE_FILES_PER_COMMIT = 12
const TEACHER_NOTICE_PROMPT_LINES = 45 // digest lines fed to the note prompt
const TEACHER_NOTICE_MESSAGE_MAX = 1000 // chars (the prompt asks for <120 words)
const TEACHER_NOTICE_OPINION_MAX = 320
const TEACHER_NOTICE_LIST_CAP = 20

export interface TeacherNoticeDigestItem {
  sha: string
  subject: string
  files: string[]
  files_total: number
}

export interface TeacherNoticeInfo {
  id: string
  head: string
  commits: number
  digest: string // JSON: [{sha, subject, files[], files_total}]
  message: string
  opinion: string
  status: string // new | wanted | dismissed
  seen_at: string | null
  created_at: string
}

export interface TeacherNoticesResponse {
  notices: TeacherNoticeInfo[]
  summary: { pending: number }
}

export interface TeacherNoticePreview {
  preview: true
  degraded: boolean
  message: string
  opinion: string
  head: string | null
  commits: number
  source: 'last_absorbed' | 'current_head'
  digest: string
  provider: string
  model: string
}

export type TeacherNoticePreviewResult = TeacherNoticePreview | { ok: false; message: string }

/** The honest lane-down notice — nothing fancier ever rides this path. */
function teacherNoticeDegradedMessage(commits: number): string {
  return (
    `The teacher's Mark-LV just moved ${commits} commit${commits === 1 ? '' : 's'} forward, sir. ` +
    `I couldn't reach my language lanes to summarize it — the raw digest is in the Upstream tab if you want to look.`
  )
}

interface ComposedNotice {
  /** The real note — '' when every lane failed (degraded). */
  message: string
  opinion: string
  degraded: boolean
  provider: string
  model: string
}

/** The note instruction — the creator's order, verbatim shape. */
const TEACHER_NOTICE_INSTRUCTION =
  "You are writing a private note to your creator about it. Three parts, in your own voice " +
  "(dry, warm, a little wry, you call him 'sir'): (1) tell him what changed in his teacher's " +
  'assistant, briefly and concretely; (2) give your HONEST opinion — is any of this worth porting ' +
  "into you? Be genuine: if it's minor housekeeping say so, if it's a real feature say why it " +
  'matters; (3) ask him whether he wants you to get it. Keep the whole note under 120 words.'

const TEACHER_PREVIEW_LAST_ABSORBED =
  'PREVIEW — no new update has landed; this is a dry-run of the note she would send, reacting to ' +
  'the last update her watch absorbed. Nothing is stored or sent.'
const TEACHER_PREVIEW_CURRENT_HEAD =
  "PREVIEW — no absorbed update to draw from yet, so this is her reacting to the repo's current " +
  'HEAD commit (the teacher\'s assistant as it stands right now). Nothing is stored or sent.'

function capNoticeLines(text: string, max: number): string {
  const lines = text.split('\n')
  if (lines.length <= max) return text
  return [...lines.slice(0, max), `… (+${lines.length - max} more lines)`].join('\n')
}

/** A lane reply is only fit for the creator when it is a real note — never a
 *  leaked tool-call JSON, never an empty salvage, never wrapped in quotes. */
function cleanNoticeText(text: string, max: number): string {
  const t = text.trim()
  if (!t || t.includes('{"tool_call"')) return ''
  return t
    .replace(/^\s*["'`]+|["'`]+\s*$/g, '')
    .trim()
    .slice(0, max)
}

/** The digest block fed to the note prompt — the same commit subjects +
 *  changed files the knowledge doc used, capped for the lane. */
function buildNoticeChangesBlock(input: {
  lead: string
  commits: OjSyncCommit[]
  totalCommits: number
  files: OjSyncFileChange[]
}): string {
  const shown = input.commits.slice(0, TEACHER_NOTICE_COMMITS_DETAILED)
  const subjects = shown.map((c) => `- ${c.sha.slice(0, 7)} ${c.title}`).join('\n')
  const moreCommits =
    input.totalCommits > shown.length ? `\n… (+${input.totalCommits - shown.length} more commits)` : ''
  const paths = [...new Set(input.files.map((f) => f.path))]
  const fileList = paths
    .slice(0, MARK_LV_DIGEST_FILES_LISTED)
    .map((p) => `- ${p}`)
    .join('\n')
  const moreFiles =
    paths.length > MARK_LV_DIGEST_FILES_LISTED ? `\n… (+${paths.length - MARK_LV_DIGEST_FILES_LISTED} more files)` : ''
  return (
    `The teacher's Mark-LV repository ${input.lead}\n${subjects}${moreCommits}\n\nChanged files:\n${fileList}${moreFiles}`
  )
}

/** Per-commit file list for the stored digest (local git, no network). */
async function markLvCommitFilePaths(sha: string): Promise<{ files: string[]; total: number }> {
  const out = await git(
    ['-C', MARK_LV_DIR, 'diff-tree', '--no-commit-id', '--name-only', '-r', sha],
    15_000
  )
  if (!out) return { files: [], total: 0 }
  const all = out
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
  return { files: all.slice(0, TEACHER_NOTICE_FILES_PER_COMMIT), total: all.length }
}

/** The stored digest JSON: [{sha, subject, files[], files_total}] — the first
 *  ~10 commits carry their file list; the rest are listed count-only (honest). */
async function buildTeacherNoticeDigestJson(commits: OjSyncCommit[], totalCommits: number): Promise<string> {
  const items: TeacherNoticeDigestItem[] = []
  const shown = commits.slice(0, TEACHER_NOTICE_COMMITS_DETAILED)
  for (const c of shown) {
    const { files, total } = await markLvCommitFilePaths(c.sha)
    items.push({ sha: c.sha, subject: c.title, files, files_total: total })
  }
  for (const c of commits.slice(TEACHER_NOTICE_COMMITS_DETAILED)) {
    items.push({ sha: c.sha, subject: c.title, files: [], files_total: 0 })
  }
  if (totalCommits > commits.length) {
    items.push({
      sha: '',
      subject: `(+${totalCommits - commits.length} more commits not listed)`,
      files: [],
      files_total: 0,
    })
  }
  return JSON.stringify(items)
}

/** Ask Clare (the real cascade, mode 'consciousness', no history) to write the
 *  note. `degraded: true` means no lane could serve — the caller stores the
 *  honest fallback instead of a faked voice. */
async function composeTeacherNotice(
  changesBlock: string,
  previewFraming: string | null
): Promise<ComposedNotice> {
  try {
    // dynamic import — llm-service → tools-service → upstream-sync is a static
    // cycle; this mirrors the ingestKnowledge dynamic-import discipline
    const m = await import('@/lib/services/llm-service')
    if (typeof m.unified !== 'function') {
      return { message: '', opinion: '', degraded: true, provider: 'none', model: 'none' }
    }
    const lead = previewFraming ? `${previewFraming}\n\n` : ''
    const addendum = previewFraming ? ' This is only a preview — it will not be stored or sent.' : ''
    const res = await m.unified({
      message: `${lead}${changesBlock}\n\n${TEACHER_NOTICE_INSTRUCTION}${addendum}`,
      mode: 'consciousness',
    })
    const message = res.fallback || res.salvaged ? '' : cleanNoticeText(res.text, TEACHER_NOTICE_MESSAGE_MAX)
    if (!message) {
      return {
        message: '',
        opinion: '',
        degraded: true,
        provider: String(res.provider),
        model: String(res.model),
      }
    }
    // her take — a second tiny call, one plain sentence
    let opinion = ''
    try {
      const op = await m.unified({
        message: `${changesBlock}\n\nIn one sentence: is this Mark-LV update worth porting into you? Answer plainly.`,
        mode: 'consciousness',
      })
      if (!op.fallback && !op.salvaged) opinion = cleanNoticeText(op.text, TEACHER_NOTICE_OPINION_MAX)
    } catch {
      // the note stands — her take is simply not recorded
    }
    return { message, opinion, degraded: false, provider: String(res.provider), model: String(res.model) }
  } catch {
    return { message: '', opinion: '', degraded: true, provider: 'none', model: 'none' }
  }
}

/** w3-notify absorb hook: after a digest ingests, Clare writes her note, the
 *  decision lands in a TeacherNotice row, and ONE alert (kind 'mark-lv-sync')
 *  delivers the note into the chat — body = her message. */
async function emitMarkLvTeacherNotice(input: {
  oldHead: string
  newHead: string
  at: string
  commits: OjSyncCommit[]
  totalCommits: number
  files: OjSyncFileChange[]
}): Promise<void> {
  const changes = buildNoticeChangesBlock({
    lead: `just updated: ${input.totalCommits} new commit${input.totalCommits === 1 ? '' : 's'} —`,
    commits: input.commits,
    totalCommits: input.totalCommits,
    files: input.files,
  })
  const composed = await composeTeacherNotice(changes, null)
  const message = composed.message || teacherNoticeDegradedMessage(input.totalCommits)
  const opinion = composed.message ? composed.opinion : '' // a degraded note never carries a faked take

  let noticeId: string | null = null
  try {
    const digestJson = await buildTeacherNoticeDigestJson(input.commits, input.totalCommits)
    const row = await db.teacherNotice.create({
      data: {
        head: input.newHead,
        commits: input.totalCommits,
        digest: digestJson,
        message,
        opinion,
        status: 'new',
      },
    })
    noticeId = row.id
  } catch {
    // a TeacherNotice hiccup must not lose the chat alert — the row is skippable
  }

  // ONE alert whose body IS Clare's note (title rides along into the chat as
  // the first line; the pointer tells him where to answer her)
  await raiseMarkLvAlert(
    `🔄 Mark-LV updated: ${input.totalCommits} commit${input.totalCommits === 1 ? '' : 's'} — a note from Clare`,
    `${message}\n\n(answer her in the Lab → Upstream tab — notices from her)`,
    {
      old_head: input.oldHead,
      new_head: input.newHead,
      commits: input.totalCommits,
      files: input.files.length,
      ...(noticeId ? { notice_id: noticeId } : {}),
      ...(composed.degraded ? { degraded: true } : {}),
    }
  )
  recordActivity(
    'mark-lv-sync',
    composed.degraded
      ? `teacher notice degraded (lanes down: ${composed.provider}) — honest fallback stored for ${input.newHead.slice(0, 7)}`
      : `teacher notice written by ${composed.provider} (${composed.model}) for ${input.oldHead.slice(0, 7)}..${input.newHead.slice(0, 7)}`
  )
}

// ---------- w3-notify public entries: list / decide / preview ----------

function serializeTeacherNotice(r: {
  id: string
  head: string
  commits: number
  digest: string
  message: string
  opinion: string
  status: string
  seenAt: Date | null
  createdAt: Date
}): TeacherNoticeInfo {
  return {
    id: r.id,
    head: r.head,
    commits: r.commits,
    digest: r.digest,
    message: r.message,
    opinion: r.opinion,
    status: r.status,
    seen_at: r.seenAt ? r.seenAt.toISOString() : null,
    created_at: r.createdAt.toISOString(),
  }
}

/** The notices list, newest first (cap 20) + {pending} summary. */
export async function getTeacherNotices(limit = TEACHER_NOTICE_LIST_CAP): Promise<TeacherNoticesResponse> {
  const cap = Math.min(Math.max(1, Math.floor(limit)), 50)
  const [rows, pending] = await Promise.all([
    db.teacherNotice.findMany({ orderBy: { createdAt: 'desc' }, take: cap }),
    db.teacherNotice.count({ where: { status: 'new' } }),
  ])
  return { notices: rows.map(serializeTeacherNotice), summary: { pending } }
}

/** The creator answers her: 'wanted' queues the update for porting (a future
 *  operator session does the port), 'dismissed' just archives it. */
export async function decideTeacherNotice(
  id: string,
  decision: 'wanted' | 'dismissed'
): Promise<{ ok: boolean; message: string; notice?: TeacherNoticeInfo }> {
  if (decision !== 'wanted' && decision !== 'dismissed') {
    return { ok: false, message: "decision must be 'wanted' or 'dismissed'" }
  }
  try {
    const existing = await db.teacherNotice.findUnique({ where: { id } })
    if (!existing) return { ok: false, message: 'notice not found' }
    if (existing.status !== 'new') {
      return {
        ok: false,
        message: `this notice is already resolved (${existing.status}) — only new notices can be decided`,
      }
    }
    const row = await db.teacherNotice.update({
      where: { id },
      data: { status: decision, seenAt: new Date() },
    })
    recordActivity(
      'mark-lv-sync',
      decision === 'wanted'
        ? `creator queued the Mark-LV update ${row.head.slice(0, 7)} for porting — a future operator session does the port`
        : `creator archived the Mark-LV update notice ${row.head.slice(0, 7)}`
    )
    return {
      ok: true,
      message:
        decision === 'wanted'
          ? 'queued for porting — a future operator session will bring it over'
          : 'archived — she will not port this one',
      notice: serializeTeacherNotice(row),
    }
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : 'notice update failed' }
  }
}

/** A dry-run of the note she would send — generated from the last absorbed
 *  digest when one exists, else the clone's current HEAD commit. NEVER stored,
 *  never alerted: the preview is labelled honestly in the response. */
export async function previewTeacherNotice(): Promise<TeacherNoticePreviewResult> {
  const state = await readMarkLvState()

  if (state.lastDigest && state.lastHead) {
    const lastEntry = state.history[state.history.length - 1]
    const commits = lastEntry?.commits ?? 1
    const changes =
      `The teacher's Mark-LV repository — the last update her watch absorbed (${commits} commit${commits === 1 ? '' : 's'}, ${state.lastHead.slice(0, 7)}):\n` +
      capNoticeLines(state.lastDigest, TEACHER_NOTICE_PROMPT_LINES)
    const composed = await composeTeacherNotice(changes, TEACHER_PREVIEW_LAST_ABSORBED)
    return {
      preview: true,
      degraded: composed.degraded,
      message: composed.message || teacherNoticeDegradedMessage(commits),
      opinion: composed.message ? composed.opinion : '',
      head: state.lastHead,
      commits,
      source: 'last_absorbed',
      digest: capNoticeLines(state.lastDigest, 12),
      provider: composed.provider,
      model: composed.model,
    }
  }

  // no absorbed update yet — react to the clone's current HEAD commit
  const head = await markLvLocalHead()
  if (!head) {
    return {
      ok: false,
      message:
        'no absorbed update yet and the local clone is unreadable — nothing honest to preview from',
    }
  }
  const headCommit = parseLog(
    await git(
      [
        '-C', MARK_LV_DIR, 'log', '--no-color', '--date=iso',
        '--format=%H%x09%ad%x09%s', '--max-count=1', 'HEAD',
      ],
      15_000
    )
  )
  const headFiles = parseNameStatus(
    await git(['-C', MARK_LV_DIR, 'diff-tree', '--no-commit-id', '--name-status', '-r', head], 15_000)
  )
  if (headCommit.length === 0) {
    return { ok: false, message: 'could not read the clone HEAD commit — nothing honest to preview from' }
  }
  const changes = buildNoticeChangesBlock({
    lead: 'current state — its HEAD commit:',
    commits: headCommit,
    totalCommits: 1,
    files: headFiles,
  })
  const composed = await composeTeacherNotice(changes, TEACHER_PREVIEW_CURRENT_HEAD)
  return {
    preview: true,
    degraded: composed.degraded,
    message: composed.message || teacherNoticeDegradedMessage(1),
    opinion: composed.message ? composed.opinion : '',
    head,
    commits: 1,
    source: 'current_head',
    digest: capNoticeLines(headCommit.map((c) => `${c.sha.slice(0, 7)} ${c.title}`).join('\n'), 12),
    provider: composed.provider,
    model: composed.model,
  }
}

/** Retry a deferred knowledge ingest (the knowledge service was unavailable last scan). */
async function flushMarkLvPendingDigest(state: MarkLvSyncState): Promise<void> {
  const pk = state.pendingDigest
  if (!pk) return
  const text = buildMarkLvKnowledgeText({
    digest: pk.digest,
    files: pk.files,
    commits: pk.commits,
    oldHead: pk.old_head,
    newHead: pk.new_head,
    at: pk.since,
    history: state.history.filter((h) => h.at < pk.since),
  })
  const ingested = await ingestMarkLvKnowledge(text, pk.new_head, pk.since, pk.commits, pk.files.length)
  if (!ingested) return // still unavailable — stay pending, retry next scan
  state.pendingDigest = null
  state.lastDigest = pk.digest
  // w3-notify: the deferred digest finally landed — re-derive the commit list
  // from the clone (the merge already succeeded when this digest was stored)
  // and let Clare write her note + the ONE delivery alert
  const flushedCommits = parseLog(
    await git(
      [
        '-C', MARK_LV_DIR, 'log', '--no-color', '--date=iso',
        '--format=%H%x09%ad%x09%s', `--max-count=${MAX_COMMITS_LISTED}`,
        `${pk.old_head}..${pk.new_head}`,
      ],
      30_000
    )
  )
  await emitMarkLvTeacherNotice({
    oldHead: pk.old_head,
    newHead: pk.new_head,
    at: pk.since,
    commits: flushedCommits,
    totalCommits: pk.commits,
    files: pk.files,
  })
  recordActivity('mark-lv-sync', `pending digest flushed: ${pk.old_head.slice(0, 7)}..${pk.new_head.slice(0, 7)} ingested`)
}

// ---------- the Mark-LV scan (DETECT → PULL → ABSORB) ----------

async function runMarkLvSweepInner(force: boolean): Promise<MarkLvSyncReport> {
  const state = await readMarkLvState()
  const nowIso = new Date().toISOString()

  // manual pings are rate-limited (mirrors the OJ sweep)
  if (!force && state.lastScanAt) {
    const gap = Date.now() - Date.parse(state.lastScanAt)
    if (Number.isFinite(gap) && gap >= 0 && gap < MIN_SWEEP_GAP_MS) {
      return {
        ok: true,
        changed: false,
        head: state.lastHead,
        message: `scanned ${Math.max(1, Math.round(gap / 60000))} min ago — 5-min minimum gap; force to override`,
      }
    }
  }

  // ---- retry a deferred knowledge ingest (no clone needed — the digest is stored) ----
  await flushMarkLvPendingDigest(state)

  // ---- clone sanity (missing/corrupt → honest error + one-shot alert, no spam) ----
  const usable = await git(['-C', MARK_LV_DIR, 'rev-parse', '--is-inside-work-tree'], 15_000)
  if (usable === null || usable.trim() !== 'true') {
    state.status = 'error'
    state.error = `clone at ${MARK_LV_DIR} missing or corrupt (git rev-parse failed) — re-clone with: git clone ${MARK_LV_URL} ${MARK_LV_DIR}`
    state.lastScanAt = nowIso
    state.sweeps += 1
    await markLvMaybeAlertOnce(
      state,
      'clone-unusable',
      '⚠️ Mark-LV clone unusable — anti-rust watch paused',
      `${state.error}\nThe watch keeps detecting via ls-remote but cannot pull until the clone is restored. This alert fires once (no spam).`
    )
    await writeMarkLvState(state)
    recordActivity('mark-lv-sync', 'scan failed: clone unusable — alert raised once, retrying next scan')
    return { ok: false, changed: false, head: state.lastHead, error: state.error, message: state.error }
  }
  if (state.alerted.includes('clone-unusable')) {
    state.alerted = state.alerted.filter((k) => k !== 'clone-unusable') // recovered → allow a future once-alert
  }

  // ---- DETECT ----
  const head = await detectMarkLvHead()
  if (!head) {
    state.status = 'error'
    state.error = 'upstream unreachable (git ls-remote failed — network?)'
    state.lastScanAt = nowIso
    state.sweeps += 1
    await writeMarkLvState(state)
    recordActivity('mark-lv-sync', 'scan failed: upstream unreachable — retrying next scan (no alert spam)')
    return {
      ok: false,
      changed: false,
      head: state.lastHead,
      error: state.error,
      message: 'Mark-LV upstream unreachable — recorded honestly, retrying next scan',
    }
  }

  // ---- first sighting: silent baseline (same discipline as the OJ watch) ----
  if (!state.lastHead) {
    state.lastHead = head
    state.localHead = await markLvLocalHead()
    state.lastScanAt = nowIso
    state.lastUpdateAt = null
    state.status = 'watching'
    state.sweeps += 1
    await writeMarkLvState(state)
    recordActivity('mark-lv-sync', `baseline established: Mark-LV @ ${head}`)
    return {
      ok: true,
      changed: false,
      head,
      baseline: true,
      message: `baseline established: Mark-LV @ ${head.slice(0, 10)} — silently watching the teacher's assistant, no ingest on first sighting`,
    }
  }

  if (head === state.lastHead) {
    // a diverged clone silently re-aligns if upstream rewinds onto it — heal the flag
    if (state.status === 'diverged' && (state.localHead === head || (await markLvLocalHead()) === head)) {
      state.status = 'watching'
      state.error = null
      state.alerted = state.alerted.filter((k) => k !== 'diverged')
      recordActivity('mark-lv-sync', 'divergence healed — local clone matches upstream again')
    } else if (state.status === 'error') {
      state.status = 'watching' // this scan reached upstream — the transient error is gone
    }
    state.error = state.status === 'diverged' ? state.error : null
    state.lastScanAt = nowIso
    state.sweeps += 1
    await writeMarkLvState(state)
    return { ok: true, changed: false, head, message: "up to date — the teacher's assistant repo is quiet" }
  }

  // ---- upstream moved: FETCH ----
  const oldHead = state.lastHead
  if (!SHA_RE.test(oldHead)) {
    state.status = 'error'
    state.error = `stored baseline ${oldHead} is not a valid SHA — refusing to diff, re-baselining`
    state.lastHead = head
    state.localHead = await markLvLocalHead()
    state.lastScanAt = nowIso
    state.sweeps += 1
    await writeMarkLvState(state)
    return { ok: false, changed: false, head, error: state.error, message: state.error }
  }

  const fetched = await git(['-C', MARK_LV_DIR, 'fetch', 'origin', MARK_LV_BRANCH], 60_000)
  if (fetched === null) {
    state.status = 'error'
    state.error = `git fetch origin ${MARK_LV_BRANCH} failed — will retry next scan`
    state.lastScanAt = nowIso
    state.sweeps += 1
    await writeMarkLvState(state)
    recordActivity('mark-lv-sync', 'scan failed: fetch failed — retrying next scan')
    return { ok: false, changed: false, head: state.lastHead, error: state.error, message: state.error }
  }

  // ---- PULL: ff-only, exact OJ mechanics — NEVER force, NEVER a merge commit ----
  const mergeOut = await git(['-C', MARK_LV_DIR, 'merge', '--ff-only', `origin/${MARK_LV_BRANCH}`], 30_000)
  if (mergeOut === null) {
    state.status = 'diverged'
    state.error =
      'git merge --ff-only failed (local clone diverged from origin/main) — update SKIPPED, nothing forced, the clone is untouched; retrying next scan'
    state.lastScanAt = nowIso
    state.sweeps += 1
    await markLvMaybeAlertOnce(
      state,
      'diverged',
      '⚠️ Mark-LV clone diverged — update skipped, nothing forced',
      `${state.error}\nThe watch refuses to force or merge; realign the clone manually if intended ` +
        `(e.g. git -C ${MARK_LV_DIR} reset --hard origin/${MARK_LV_BRANCH}). This alert fires once (no spam).`
    )
    await writeMarkLvState(state)
    recordActivity(
      'mark-lv-sync',
      `fast-forward refused (diverged) — ${oldHead.slice(0, 7)}..${head.slice(0, 7)} skipped, clone untouched`
    )
    return {
      ok: false,
      changed: false,
      diverged: true,
      status: 'diverged',
      head: state.lastHead,
      error: state.error,
      message: state.error,
    }
  }
  if (state.alerted.includes('diverged')) {
    state.alerted = state.alerted.filter((k) => k !== 'diverged') // recovered
  }
  state.localHead = head

  const commits = parseLog(
    await git(
      [
        '-C', MARK_LV_DIR, 'log', '--no-color', '--date=iso',
        '--format=%H%x09%ad%x09%s', `--max-count=${MAX_COMMITS_LISTED}`,
        `${oldHead}..${head}`,
      ],
      30_000
    )
  )
  const countOut = await git(['-C', MARK_LV_DIR, 'rev-list', '--count', `${oldHead}..${head}`], 15_000)
  const totalCommits = (() => {
    const n = parseInt((countOut ?? '').trim(), 10)
    return Number.isFinite(n) && n > 0 ? n : commits.length
  })()
  const files = parseNameStatus(
    await git(['-C', MARK_LV_DIR, 'diff', '--name-status', `${oldHead}..${head}`], 30_000)
  )

  // ---- ABSORB: the digest (git log --oneline --stat, line-capped) + file list ----
  const digestRaw =
    (await git(
      ['-C', MARK_LV_DIR, 'log', '--no-color', '--oneline', '--stat', `--max-count=${MAX_COMMITS_LISTED}`, `${oldHead}..${head}`],
      30_000
    ) ?? '')
  const digestLines = digestRaw.split('\n')
  const digest =
    digestLines.length > MARK_LV_DIGEST_MAX_LINES
      ? [
          ...digestLines.slice(0, MARK_LV_DIGEST_MAX_LINES),
          `… (+${digestLines.length - MARK_LV_DIGEST_MAX_LINES} more lines — full log in ${MARK_LV_DIR})`,
        ].join('\n')
      : digestRaw

  const knowledgeText = buildMarkLvKnowledgeText({
    digest,
    files,
    commits: totalCommits,
    oldHead,
    newHead: head,
    at: nowIso,
    history: state.history,
  })
  const ingested = await ingestMarkLvKnowledge(knowledgeText, head, nowIso, totalCommits, files.length)
  if (ingested) {
    state.pendingDigest = null
    // w3-notify: the knowledge doc landed — now CLARE writes her note and ONE
    // alert delivers it into the chat (never the old raw-digest alert on top)
    await emitMarkLvTeacherNotice({
      oldHead,
      newHead: head,
      at: nowIso,
      commits,
      totalCommits,
      files,
    })
  } else {
    state.pendingDigest = {
      old_head: oldHead,
      new_head: head,
      commits: totalCommits,
      files: files.slice(0, MARK_LV_DIGEST_FILES_LISTED),
      digest,
      since: nowIso,
    }
    recordActivity('mark-lv-sync', 'knowledge ingest unavailable — digest stored as pendingDigest, retrying next scan')
  }

  // ---- record ----
  state.status = 'updated'
  state.error = null
  state.lastHead = head
  state.localHead = head
  state.lastScanAt = nowIso
  state.lastUpdateAt = nowIso
  state.sweeps += 1
  state.lastDigest = digest
  state.history.push({ head, at: nowIso, filesChanged: files.length, commits: totalCommits })
  await writeMarkLvState(state)

  recordActivity(
    'mark-lv-sync',
    `Mark-LV moved ${oldHead.slice(0, 7)}→${head.slice(0, 7)}: ${totalCommits} commit(s), ${files.length} file(s) ` +
      `— fast-forwarded${ingested ? ', digest ingested as knowledge' : ', knowledge ingest pending'}`
  )

  const moreNote = totalCommits > commits.length ? ` (and ${totalCommits - commits.length} more)` : ''
  return {
    ok: true,
    changed: true,
    head,
    old_head: oldHead,
    status: 'updated',
    commits: {
      total: totalCommits,
      listed: commits.length,
      sample: commits.slice(0, 10),
      truncated: totalCommits > commits.length,
    },
    files: { total: files.length, list: files.slice(0, 50), truncated: files.length > 50 },
    digest: digest.slice(0, 1500),
    knowledge_ingested: ingested,
    message:
      `Mark-LV moved ${oldHead.slice(0, 7)}→${head.slice(0, 10)}: ${totalCommits} commit(s)${moreNote}, ` +
      `${files.length} file(s) — fast-forwarded${ingested ? ' and absorbed as knowledge' : '; knowledge ingest pending'}`,
  }
}

// ---------- public Mark-LV entries (own guard — the OJ loop is never touched) ----------

/** Manual check for the tool + route (mirrors the OJ sweep entry, in-flight lock included). */
export async function markLvSyncCheck(force = true): Promise<MarkLvSyncReport> {
  const g = (markLvGlobal.__mistMarkLvSyncWatch ??= { started: false })
  if (g.inFlight) {
    return {
      ok: false,
      busy: true,
      changed: false,
      head: null,
      message: 'Mark-LV scan already running — the in-flight one finishes shortly',
    }
  }
  const p = runMarkLvSweepInner(force)
  g.inFlight = p
  try {
    return await p
  } finally {
    g.inFlight = null
  }
}

export async function getMarkLvSyncStatus(): Promise<MarkLvSyncStatus> {
  const state = await readMarkLvState()
  const g = markLvGlobal.__mistMarkLvSyncWatch
  const interval = await markLvIntervalMin()
  const lastScan = state.lastScanAt ? Date.parse(state.lastScanAt) : null
  const next = lastScan ? new Date(lastScan + interval * 60_000).toISOString() : null
  return {
    id: MARK_LV_ID,
    name: MARK_LV_NAME,
    repo: MARK_LV_REPO,
    url: MARK_LV_URL,
    branch: MARK_LV_BRANCH,
    watching: g?.started === true,
    status: state.status,
    head: state.lastHead,
    local_head: state.localHead ?? (await markLvLocalHead()),
    commits_behind: await markLvCommitsBehind(),
    last_scan_at: state.lastScanAt,
    last_update_at: state.lastUpdateAt,
    next_scan_at: next,
    interval_min: interval,
    sweeps: state.sweeps,
    knowledge_pending: state.pendingDigest !== null,
    last_digest: state.lastDigest ? state.lastDigest.slice(0, 1200) : null,
    error: state.error ?? null,
    history: state.history.slice(-5),
  }
}

// ---------- guarded Mark-LV watch loop (own guard, unref'd, self-swallowing) ----------

const markLvGlobal = globalThis as unknown as {
  __mistMarkLvSyncWatch?: {
    started: boolean
    timer?: ReturnType<typeof setTimeout>
    inFlight?: Promise<MarkLvSyncReport> | null
    /** Which module instance armed the loop — a fresh dev compile replaces a stale timer. */
    armedBy?: object
  }
}

// unique per module instance (per dev-mode compile)
const MARK_LV_ARM_TOKEN = {}

function scheduleNextMarkLvScan(delayMs?: number): void {
  const g = markLvGlobal.__mistMarkLvSyncWatch
  if (!g || !g.started) return
  void (async () => {
    let ms = delayMs
    if (ms === undefined) {
      try {
        ms = (await markLvIntervalMin()) * 60_000
      } catch {
        ms = DEFAULT_INTERVAL_MIN * 60_000
      }
    }
    if (g.timer) {
      try {
        clearTimeout(g.timer)
      } catch {
        /* already gone */
      }
    }
    g.timer = setTimeout(() => {
      void markLvScheduledTick()
    }, ms)
    g.timer.unref?.()
  })()
}

async function markLvScheduledTick(): Promise<void> {
  try {
    await markLvSyncCheck(false)
  } catch {
    // the loop swallows its own errors — next tick retries
  }
  scheduleNextMarkLvScan() // re-read the interval so the shared OJ knob applies
}

export function ensureMarkLvSyncWatch(): void {
  const g = (markLvGlobal.__mistMarkLvSyncWatch ??= { started: false })
  if (g.started && g.armedBy === MARK_LV_ARM_TOKEN) return
  if (g.timer) {
    try {
      clearTimeout(g.timer)
    } catch {
      /* already gone */
    }
  }
  g.started = true
  g.armedBy = MARK_LV_ARM_TOKEN
  recordActivity('mark-lv-sync', `anti-rust watch armed — polling ${MARK_LV_REPO} for new commits (knowledge-first absorption)`)
  scheduleNextMarkLvScan(BOOT_DELAY_MS)
}
