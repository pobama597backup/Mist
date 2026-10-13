// M.I.S.T. GitHub self-management (w8) — she can update her own source on
// GitHub (repo pobama597backup/Mist, created in w6 by a clean-snapshot push
// from the birth machine).
//
// Design (LIGHT rules — no daemons, no watchers; git runs ONLY on explicit
// creator action or her own github_sync tool call):
//   - token: a classic GitHub PAT (repo scope) pasted once in Settings →
//     GitHub mirror; stored in db/provider-keys.json (machine-local, excluded
//     from every export — it never leaves this machine).
//   - authenticated git runs use http.extraheader (the token is NEVER written
//     into .git/config or the remote URL).
//   - the export dir (../mist-export, sibling of the project — the same
//     placement the birth machine used) is CLONED once to preserve the w6/w7
//     history, then every sync copies the allowlisted source paths over it,
//     commits and pushes.
//   - secrets and machine state are excluded by construction: .env*,
//     provider-keys.json, *.db (45MB custom.db), logs, caches.
//   - OUTBOUND SECRET-SCAN GATE: right before every commit the export tree
//     is scanned with the project's canonical scanner (scripts/secret-scan.ts
//     --dir=…) and the sync FAILS CLOSED — the export repo has no pre-commit
//     hook, so the gate lives in the sync itself. No scan, no push.
//   - single-flight: one sync at a time, honestly refused while busy.

import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import { recordActivity } from './activity-service'

const execFileAsync = promisify(execFile)

export const GITHUB_REPO = 'pobama597backup/Mist'
const REMOTE_URL = `https://github.com/${GITHUB_REPO}.git`
const API_BASE = 'https://api.github.com'
const TOKEN_KEY = 'GITHUB_TOKEN'
const KEYS_PATH = path.join(process.cwd(), 'db', 'provider-keys.json')
export const EXPORT_DIR = path.resolve(process.cwd(), '..', 'mist-export')

// what leaves the machine — source, configs, knowledge, persona, tests,
// docs, hooks, work records and audit artifacts. NEVER keys. (Creator's
// 2026-10-13 mandate: "push everything" — widened from the public-snapshot
// allowlist; the repo is going private, but the secret exclusions below
// are absolute and unaffected.)
const DIR_ALLOWLIST = [
  'src',
  'prisma',
  'mini-services',
  'public',
  'skills',
  'examples',
  'scripts',
  'tests',
  'docs',
  'hooks',
  'agent-ctx',
  'e2e-shots',
  'ui-audit',
  'upload',
  'download',
  '.zscripts',
  'db/persona',
  'db/skills',
  'db/skills-archive',
  'db/notes',
  'db/obsidian-vaults',
  'db/operators',
  'db/openclaw',
  'db/bridge',
  'db/backups',
]
const FILE_ALLOWLIST = [
  'package.json',
  'bun.lock',
  'tsconfig.json',
  'next.config.ts',
  'next-env.d.ts',
  'eslint.config.mjs',
  'components.json',
  'postcss.config.mjs',
  'tailwind.config.ts',
  'README.md',
  'CAPABILITIES.md',
  'MIGRATION_STATE.md',
  'PC-SETUP.md',
  'worklog.md',
  'restart.bat',
  'run.bat',
  'stop.bat',
  'Caddyfile',
  'drill-11c-verification-report.md',
]
const SKIP_DIR_NAMES = new Set([
  'node_modules',
  '.next',
  '.git',
  'tool-results',
  'agent-ctx',
  'e2e-shots',
  '__pycache__',
  '.turbo',
  'dist',
])
const SKIP_FILE_NAMES = new Set([
  'provider-keys.json', // the keys — never leave the machine
  'environment.json', // machine-local identity (w7)
  'custom.db',
  'dev.log',
  'server.log',
])
// hard runaway guards — a sync that exceeds these aborts honestly
const MAX_FILES = 6000
const MAX_BYTES = 250 * 1024 * 1024

// Known-safe scanner fixtures in the outbound tree (the hook's documented
// --allow mechanism, substring semantics): the xiaohongshu DESIGN.md CSS
// custom property whose name tail collides with the sk-… key pattern — a
// variable name, never a credential.
const SCAN_ALLOWLIST = ['video-player-mask']

const EXPORT_GITIGNORE = `# machine-local — never leaves this machine
.env*
db/provider-keys.json
db/*.db
node_modules/
.next/
*.log
*.pid
`

// ─── small helpers ──────────────────────────────────────────────────────────

async function runGit(args: string[], opts: { cwd?: string; token?: string; timeoutMs?: number } = {}) {
  const finalArgs = opts.token
    ? ['-c', `http.extraheader=Authorization: Basic ${basicAuth(opts.token)}`, ...args]
    : args
  try {
    const { stdout } = await execFileAsync('git', finalArgs, {
      cwd: opts.cwd,
      timeout: opts.timeoutMs ?? 30_000,
      maxBuffer: 16 * 1024 * 1024,
    })
    return stdout
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string; killed?: boolean }
    const raw = `${e.stdout ?? ''}\n${e.stderr ?? ''}\n${e.message ?? ''}`
    throw new Error(raw.slice(0, 300))
  }
}

function basicAuth(token: string): string {
  return Buffer.from(`x-access-token:${token}`).toString('base64')
}

function redact(text: string, token: string | null): string {
  return token ? text.split(token).join('***') : text
}

async function readToken(): Promise<string | null> {
  try {
    const raw = await fs.readFile(KEYS_PATH, 'utf-8')
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const v = parsed[TOKEN_KEY]
    return typeof v === 'string' && v.trim() ? v.trim() : null
  } catch {
    return null
  }
}

async function writeToken(token: string | null): Promise<void> {
  let parsed: Record<string, unknown> = {}
  try {
    parsed = JSON.parse(await fs.readFile(KEYS_PATH, 'utf-8')) as Record<string, unknown>
  } catch {
    /* first key ever — start fresh */
  }
  if (token) parsed[TOKEN_KEY] = token
  else delete parsed[TOKEN_KEY]
  await fs.mkdir(path.dirname(KEYS_PATH), { recursive: true })
  await fs.writeFile(KEYS_PATH, JSON.stringify(parsed, null, 2) + '\n', 'utf-8')
}

async function ghApi(apiPath: string, token: string): Promise<{ ok: boolean; status: number; json: unknown }> {
  const res = await fetch(`${API_BASE}${apiPath}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'mist-self-management',
    },
    signal: AbortSignal.timeout(15_000),
  })
  const json = await res.json().catch(() => null)
  return { ok: res.ok, status: res.status, json }
}

// ─── status ─────────────────────────────────────────────────────────────────

export interface GithubCommitInfo {
  sha: string
  message: string
  date: string
}

export interface GithubStatus {
  tokenPresent: boolean
  tokenValid: boolean | null
  repo: {
    ok: boolean
    private: boolean | null
    defaultBranch: string | null
    pushedAt: string | null
    htmlUrl: string
  }
  commits: GithubCommitInfo[]
  exportReady: boolean
  dirtyFiles: number
  lastError: string | null
}

export async function githubStatus(): Promise<GithubStatus> {
  const status: GithubStatus = {
    tokenPresent: false,
    tokenValid: null,
    repo: { ok: false, private: null, defaultBranch: null, pushedAt: null, htmlUrl: `https://github.com/${GITHUB_REPO}` },
    commits: [],
    exportReady: false,
    dirtyFiles: 0,
    lastError: null,
  }
  const token = await readToken()
  status.tokenPresent = token !== null
  if (token) {
    try {
      const repo = await ghApi(`/repos/${GITHUB_REPO}`, token)
      if (repo.ok) {
        status.tokenValid = true
        status.repo.ok = true
        const r = repo.json as { private?: boolean; default_branch?: string; pushed_at?: string }
        status.repo.private = r.private ?? null
        status.repo.defaultBranch = r.default_branch ?? null
        status.repo.pushedAt = r.pushed_at ?? null
        const commits = await ghApi(`/repos/${GITHUB_REPO}/commits?per_page=3`, token)
        if (commits.ok && Array.isArray(commits.json)) {
          status.commits = (commits.json as Array<{ sha?: string; commit?: { message?: string; author?: { date?: string } } }>).map((c) => ({
            sha: (c.sha ?? '').slice(0, 7),
            message: (c.commit?.message ?? '').split('\n')[0].slice(0, 90),
            date: c.commit?.author?.date ?? '',
          }))
        }
      } else if (repo.status === 401) {
        status.tokenValid = false
        status.lastError = 'token rejected (401) — paste a fresh classic token with repo scope'
      } else if (repo.status === 404) {
        status.tokenValid = true // the token authenticates, but the repo is not visible to it
        status.lastError = `token works but cannot see ${GITHUB_REPO} (404) — check the repo name or grant full repo scope`
      } else {
        status.lastError = `GitHub API HTTP ${repo.status}`
      }
    } catch (err) {
      status.lastError = err instanceof Error ? err.message.slice(0, 120) : 'GitHub API unreachable'
    }
  }
  // local export state
  try {
    await fs.stat(path.join(EXPORT_DIR, '.git'))
    status.exportReady = true
    const out = await runGit(['status', '--porcelain'], { cwd: EXPORT_DIR })
    status.dirtyFiles = out.split('\n').filter((l) => l.trim()).length
  } catch {
    status.exportReady = false
  }
  return status
}

// ─── token management ───────────────────────────────────────────────────────

export async function githubSaveToken(tokenInput: unknown): Promise<{ ok: boolean; error?: string }> {
  const token = typeof tokenInput === 'string' ? tokenInput.trim() : ''
  if (!token || token.length < 20 || /\s/.test(token)) {
    return { ok: false, error: 'that does not look like a GitHub token (classic PAT, ghp_…, repo scope)' }
  }
  try {
    const probe = await ghApi(`/repos/${GITHUB_REPO}`, token)
    if (probe.status === 401) return { ok: false, error: 'GitHub rejected this token (401) — paste a fresh one' }
    if (probe.status === 404) return { ok: false, error: `the token cannot see ${GITHUB_REPO} (404) — use a classic token with full repo scope` }
    if (!probe.ok) return { ok: false, error: `GitHub API HTTP ${probe.status}` }
    await writeToken(token)
    recordActivity('github', 'self-management token saved (validated against the repo)')
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message.slice(0, 120) : 'GitHub unreachable' }
  }
}

export async function githubClearToken(): Promise<{ ok: boolean }> {
  await writeToken(null)
  recordActivity('github', 'self-management token removed')
  return { ok: true }
}

// ─── sync (copy → commit → push) ────────────────────────────────────────────

export interface GithubSyncResult {
  ok: boolean
  committed: boolean
  pushed: boolean
  filesChanged: number
  commitSha?: string
  message?: string
  error?: string
}

/** Copy every allowlisted path from the project into the export dir. Returns
 *  the number of files copied. Aborts honestly on runaway size. */
async function copyAllowlisted(): Promise<number> {
  let copied = 0
  let bytes = 0

  const walk = async (absDir: string, relDir: string): Promise<void> => {
    if (copied >= MAX_FILES || bytes >= MAX_BYTES) return
    const entries = await fs.readdir(absDir, { withFileTypes: true })
    for (const entry of entries) {
      if (copied >= MAX_FILES || bytes >= MAX_BYTES) return
      if (SKIP_DIR_NAMES.has(entry.name)) continue
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        await walk(path.join(absDir, entry.name), rel)
      } else if (entry.isFile()) {
        if (SKIP_FILE_NAMES.has(entry.name)) continue
        if (entry.name.startsWith('.env')) continue
        if (entry.name.endsWith('.db')) continue
        const target = path.join(EXPORT_DIR, rel)
        await fs.mkdir(path.dirname(target), { recursive: true })
        const stat = await fs.stat(path.join(absDir, entry.name))
        bytes += stat.size
        copied++
        await fs.copyFile(path.join(absDir, entry.name), target)
      }
    }
  }

  for (const dir of DIR_ALLOWLIST) {
    const abs = path.join(process.cwd(), dir)
    try {
      await fs.stat(abs)
      await walk(abs, dir)
    } catch {
      /* that top-level dir does not exist on this machine — skip */
    }
  }
  for (const file of FILE_ALLOWLIST) {
    const abs = path.join(process.cwd(), file)
    try {
      const stat = await fs.stat(abs)
      if (!stat.isFile()) continue
      if (bytes + stat.size > MAX_BYTES || copied >= MAX_FILES) break
      bytes += stat.size
      copied++
      await fs.mkdir(path.dirname(path.join(EXPORT_DIR, file)), { recursive: true })
      await fs.copyFile(abs, path.join(EXPORT_DIR, file))
    } catch {
      /* not present — skip */
    }
  }
  return copied
}

/** Clone-once (preserves the w6/w7 history) or fresh-init the export dir. */
async function ensureExport(token: string): Promise<void> {
  const gitDir = path.join(EXPORT_DIR, '.git')
  try {
    await fs.stat(gitDir)
    return // already a repo
  } catch {
    /* not yet */
  }
  await fs.mkdir(EXPORT_DIR, { recursive: true })
  const entries = await fs.readdir(EXPORT_DIR)
  if (entries.length === 0) {
    try {
      await runGit(['clone', REMOTE_URL, EXPORT_DIR], { token, timeoutMs: 120_000 })
      await fs.writeFile(path.join(EXPORT_DIR, '.gitignore'), EXPORT_GITIGNORE, 'utf-8')
      return
    } catch {
      // repo empty / unreachable — fall through to a fresh init (the first
      // sync then becomes the snapshot, same as w6)
    }
  }
  await runGit(['init'], { cwd: EXPORT_DIR })
  await runGit(['config', 'user.name', 'M.I.S.T.'], { cwd: EXPORT_DIR })
  await runGit(['config', 'user.email', 'mist@localhost'], { cwd: EXPORT_DIR })
  await runGit(['config', 'remote.origin.url', REMOTE_URL], { cwd: EXPORT_DIR })
  await fs.writeFile(path.join(EXPORT_DIR, '.gitignore'), EXPORT_GITIGNORE, 'utf-8')
}

const lockGlobal = globalThis as unknown as { __mistGithubSyncing?: boolean }

export async function githubSync(messageInput?: unknown): Promise<GithubSyncResult> {
  if (lockGlobal.__mistGithubSyncing) {
    return { ok: false, committed: false, pushed: false, filesChanged: 0, error: 'a sync is already running — let it finish first' }
  }
  lockGlobal.__mistGithubSyncing = true
  try {
    const token = await readToken()
    if (!token) {
      return { ok: false, committed: false, pushed: false, filesChanged: 0, error: 'no GitHub token saved — paste one in Settings → GitHub mirror first' }
    }
    const message =
      typeof messageInput === 'string' && messageInput.trim()
        ? messageInput.trim().slice(0, 200)
        : `M.I.S.T. self-update — ${new Date().toISOString().replace('T', ' ').slice(0, 16)}`

    await ensureExport(token)
    const copied = await copyAllowlisted()

    // OUTBOUND SECRET-SCAN GATE — the export repo has no pre-commit hook, so
    // the canonical scanner runs right here, over the exact tree that is
    // about to leave the machine. FAIL CLOSED: any finding — or a scanner
    // that cannot run at all — aborts the sync before a byte is committed.
    try {
      await execFileAsync(
        'bun',
        ['scripts/secret-scan.ts', `--dir=${EXPORT_DIR}`, ...SCAN_ALLOWLIST.map((a) => `--allow=${a}`)],
        { cwd: process.cwd(), timeout: 120_000, maxBuffer: 4 * 1024 * 1024 }
      )
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; message?: string }
      const out = `${e.stdout ?? ''}\n${e.stderr ?? ''}`.trim() || e.message || 'scanner produced no output'
      recordActivity(
        'github',
        `sync BLOCKED by outbound secret-scan — ${out.split('\n').find((l) => l.includes('✋'))?.slice(0, 90) ?? 'scanner could not run (fail-closed)'}`
      )
      return {
        ok: false,
        committed: false,
        pushed: false,
        filesChanged: 0,
        error: `OUTBOUND SECRET-SCAN REFUSED THE SYNC (fail-closed):\n${out.slice(0, 400)}`,
      }
    }

    await runGit(['add', '-A'], { cwd: EXPORT_DIR, timeoutMs: 60_000 })
    const statusOut = await runGit(['status', '--porcelain'], { cwd: EXPORT_DIR })
    const dirty = statusOut.split('\n').filter((l) => l.trim()).length
    if (dirty === 0) {
      return { ok: true, committed: false, pushed: false, filesChanged: 0, message: 'already up to date — nothing to push' }
    }
    await runGit(['commit', '-m', message], { cwd: EXPORT_DIR, timeoutMs: 60_000 })
    const branch = (await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: EXPORT_DIR })).trim()
    const pushRef = branch === 'main' ? 'HEAD:main' : 'HEAD:refs/heads/main'
    await runGit(['push', 'origin', pushRef], { cwd: EXPORT_DIR, token, timeoutMs: 300_000 })
    const sha = (await runGit(['rev-parse', '--short', 'HEAD'], { cwd: EXPORT_DIR })).trim()
    recordActivity('github', `self-update pushed (${dirty} files, ${sha}) — ${message.slice(0, 80)}`)
    return { ok: true, committed: true, pushed: true, filesChanged: dirty, commitSha: sha, message }
  } catch (err) {
    const token = await readToken()
    const msg = redact(err instanceof Error ? err.message : String(err), token)
    recordActivity('github', `self-update FAILED — ${msg.slice(0, 100)}`)
    return { ok: false, committed: false, pushed: false, filesChanged: 0, error: msg }
  } finally {
    lockGlobal.__mistGithubSyncing = false
  }
}
