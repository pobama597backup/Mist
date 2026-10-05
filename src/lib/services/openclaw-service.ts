// M.I.S. openclaw-service — the OpenClaw watchtower.
//
// WHY: MIST studies OpenClaw (github.com/openclaw/openclaw — the open-source
// sovereign assistant) and adopts its best ideas. To never "build on rusty
// stuff", this service AUTO-UPDATES MIST's local OpenClaw digest:
//   • release channel = npm registry `openclaw` (CalVer, e.g. 2026.9.5)
//   • digest = the latest release notes + changelog index, fetched fresh
//   • a guarded watch loop re-syncs every 12h (MIST_OPENCLAW_AUTO_UPDATE=off disables)
// A shallow git clone was measured at 897MB and rejected — the digest is ~50KB
// and carries everything the evolution engine needs (what changed upstream).
//
// No aliases, no guessing: state records exactly which upstream version MIST
// has studied, and every version change is logged to the activity feed.

import fs from 'node:fs/promises'
import path from 'node:path'
import type { OpenClawStatus } from '@/lib/types'
import { recordActivity } from './activity-service'

const OPENCLAW_REPO = 'openclaw/openclaw'
const OPENCLAW_UPSTREAM_URL = 'https://github.com/openclaw/openclaw'
const NPM_LATEST = 'https://registry.npmjs.org/openclaw/latest'
const RAW_BASE = 'https://raw.githubusercontent.com/openclaw/openclaw/main'
const DIGEST_DIR = path.join(process.cwd(), 'db', 'openclaw')
const STATE_FILE = path.join(DIGEST_DIR, 'state.json')
const CHECK_INTERVAL_MS = 12 * 60 * 60 * 1000 // 12h
const MIN_CHECK_GAP_MS = 10 * 60 * 1000 // don't hammer upstream on manual pings

interface OpenClawHistoryEntry {
  version: string
  seen_at: string
  notes_excerpt: string
}

interface OpenClawState {
  latest_version: string | null
  checked_at: string | null
  last_sync_at: string | null
  last_changed_at: string | null
  last_error: string | null
  history: OpenClawHistoryEntry[]
}

const EMPTY_STATE: OpenClawState = {
  latest_version: null,
  checked_at: null,
  last_sync_at: null,
  last_changed_at: null,
  last_error: null,
  history: [],
}

// ---------- persistence ----------

async function readState(): Promise<OpenClawState> {
  try {
    const raw = await fs.readFile(STATE_FILE, 'utf-8')
    const parsed = JSON.parse(raw) as OpenClawState
    return { ...EMPTY_STATE, ...parsed, history: Array.isArray(parsed.history) ? parsed.history : [] }
  } catch {
    return { ...EMPTY_STATE }
  }
}

async function writeState(state: OpenClawState): Promise<void> {
  await fs.mkdir(DIGEST_DIR, { recursive: true })
  await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2), 'utf-8')
}

// ---------- network ----------

async function fetchText(url: string, timeoutMs = 20_000): Promise<string | null> {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      signal: ac.signal,
      cache: 'no-store',
      headers: { 'User-Agent': 'mist-watchtower' },
    })
    if (!res.ok) return null
    return await res.text()
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

// ---------- sync ----------

export interface OpenClawSyncResult {
  ok: boolean
  changed: boolean
  version: string | null
  previous_version: string | null
  notes_excerpt: string
  message: string
}

/** Pull the latest upstream version + release notes into the local digest. */
export async function syncOpenClaw(force = false): Promise<OpenClawSyncResult> {
  const state = await readState()

  // rate-limit friendly: manual pings within the gap reuse the cached check
  if (
    !force &&
    state.checked_at &&
    Date.now() - new Date(state.checked_at).getTime() < MIN_CHECK_GAP_MS
  ) {
    return {
      ok: true,
      changed: false,
      version: state.latest_version,
      previous_version: state.latest_version,
      notes_excerpt: '',
      message: `checked recently — upstream at ${state.latest_version ?? 'unknown'}`,
    }
  }

  const manifestRaw = await fetchText(NPM_LATEST)
  let version: string | null = null
  try {
    const manifest = JSON.parse(manifestRaw ?? '{}') as { version?: unknown }
    if (typeof manifest.version === 'string' && manifest.version.trim()) {
      version = manifest.version.trim()
    }
  } catch {
    // fall through — version stays null
  }

  const checkedAt = new Date().toISOString()
  if (!version) {
    await writeState({ ...state, checked_at: checkedAt, last_error: 'npm registry unreachable' })
    return {
      ok: false,
      changed: false,
      version: state.latest_version,
      previous_version: state.latest_version,
      notes_excerpt: '',
      message: 'npm registry unreachable — keeping the current digest',
    }
  }

  // digest: changelog index + the release notes for this exact version
  const [changelogIndex, releaseNotes] = await Promise.all([
    fetchText(`${RAW_BASE}/CHANGELOG.md`),
    fetchText(`${RAW_BASE}/CHANGELOG/${encodeURIComponent(version)}.md`),
  ])

  let notes = releaseNotes
  try {
    await fs.mkdir(DIGEST_DIR, { recursive: true })
    if (changelogIndex) {
      await fs.writeFile(path.join(DIGEST_DIR, 'changelog-index.md'), changelogIndex.slice(0, 400_000), 'utf-8')
    }
    if (releaseNotes) {
      await fs.writeFile(path.join(DIGEST_DIR, 'release-notes.md'), releaseNotes.slice(0, 400_000), 'utf-8')
    }
  } catch {
    // digest write failure is non-fatal — state still tracks the version
  }

  const changed = state.latest_version !== null && state.latest_version !== version
  const notesExcerpt = (releaseNotes ?? '')
    .replace(/<!--[\s\S]*?-->/g, ' ') // strip doc-mirror HTML comments
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // markdown links -> label only
    .replace(/[#*`>_]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 400)

  const history = [...state.history]
  if (changed || state.latest_version === null) {
    history.unshift({
      version,
      seen_at: checkedAt,
      notes_excerpt: notesExcerpt,
    })
    while (history.length > 30) history.pop()
  } else if (history.length > 0 && history[0].version === version) {
    // same version, fresh digest → refresh the excerpt in place
    history[0] = { ...history[0], notes_excerpt: notesExcerpt }
  }

  await writeState({
    latest_version: version,
    checked_at: checkedAt,
    last_sync_at: checkedAt,
    last_changed_at: changed || state.latest_version === null ? checkedAt : state.last_changed_at,
    last_error: null,
    history,
  })

  if (changed) {
    recordActivity('openclaw', `upstream moved ${state.latest_version} → ${version} · digest auto-updated`)
  } else if (state.latest_version === null) {
    recordActivity('openclaw', `watchtower first sync · openclaw ${version}`)
  }

  return {
    ok: true,
    changed,
    version,
    previous_version: state.latest_version,
    notes_excerpt: notesExcerpt,
    message: changed
      ? `openclaw updated ${state.latest_version} → ${version} — digest refreshed`
      : `digest already current at ${version}`,
  }
}

// ---------- status + digest ----------

export async function getOpenClawStatus(): Promise<OpenClawStatus> {
  const state = await readState()
  let digestFiles: string[] = []
  try {
    digestFiles = (await fs.readdir(DIGEST_DIR)).filter((f) => f.endsWith('.md')).sort()
  } catch {
    // no digest yet
  }
  const autoUpdate = (process.env.MIST_OPENCLAW_AUTO_UPDATE ?? '').trim().toLowerCase() !== 'off'
  const first = state.history[0]

  return {
    tracked: true,
    latest_version: state.latest_version,
    published_at: null,
    head_summary: first ? first.notes_excerpt.slice(0, 200) : null,
    checked_at: state.checked_at,
    last_sync_at: state.last_sync_at,
    last_changed_at: state.last_changed_at,
    digest_files: digestFiles,
    history_count: state.history.length,
    auto_update: autoUpdate,
    upstream_url: OPENCLAW_UPSTREAM_URL,
    note: state.last_error
      ? `last check failed: ${state.last_error}`
      : state.latest_version
        ? `studying openclaw ${state.latest_version} · auto-sync every 12h`
        : 'first sync pending',
  }
}

/** Latest release notes digest — inspiration input for the evolution engine. */
export async function getOpenClawDigest(maxChars = 6000): Promise<string> {
  try {
    const notes = await fs.readFile(path.join(DIGEST_DIR, 'release-notes.md'), 'utf-8')
    return notes.slice(0, maxChars)
  } catch {
    return ''
  }
}

/** Changelog index (version list) — shows how fresh the digest is. */
export async function getOpenClawVersionList(maxEntries = 10): Promise<string[]> {
  try {
    const index = await fs.readFile(path.join(DIGEST_DIR, 'changelog-index.md'), 'utf-8')
    const versions: string[] = []
    for (const line of index.split('\n')) {
      const m = /\[([0-9][0-9.]*)\]/.exec(line)
      if (m) versions.push(m[1])
      if (versions.length >= maxEntries) break
    }
    return versions
  } catch {
    return []
  }
}

// ---------- auto-update watch loop ----------
// globalThis-guarded: Next dev gives each route its own module registry, so a
// plain module-level flag would start one loop per route compile.

const watchGlobal = globalThis as unknown as {
  __mistOpenClawWatch?: { started: boolean; timer?: ReturnType<typeof setInterval> }
}

export function ensureOpenClawWatch(): void {
  const g = (watchGlobal.__mistOpenClawWatch ??= { started: false })
  if (g.started) return
  if ((process.env.MIST_OPENCLAW_AUTO_UPDATE ?? '').trim().toLowerCase() === 'off') return
  g.started = true

  // first sync shortly after boot, then every 12h
  setTimeout(() => {
    void syncOpenClaw(true).catch(() => undefined)
  }, 90_000).unref?.()
  g.timer = setInterval(
    () => {
      void syncOpenClaw().catch(() => undefined)
    },
    CHECK_INTERVAL_MS
  )
  g.timer.unref?.()
}
