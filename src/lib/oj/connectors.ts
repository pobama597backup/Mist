// OJ connectors (port of openjarvis/connectors — the sync-into-knowledge-store
// architecture: every connector ingests into the KnowledgeChunk store with
// source=`connector:{id}` and a per-document sourceId so re-sync replaces
// instead of duplicating — the openjarvis SyncEngine checkpoint pattern).
//
// HONEST CONNECTOR MATRIX for this sandbox:
//   LIVE     — upload folder (db/upload + project upload/), obsidian vault
//              (existing obsidian-service), local notes (db/notes), github
//              public repos (api.github.com, read-only, 60 req/h unauth),
//              hackernews (public firebase API, no auth)
//   CONFIG-GATED — reddit (public .json endpoints; needs a subreddit, may be
//              rate-limited — honest errors when it is)
//   UNCONFIGURED (honest, never connected:true) — gmail, gdrive, gcal, slack,
//              notion, linear, discord, twitter/x: these need OAuth app
//              credentials that do not exist in this deployment. Listed with
//              setup notes instead of faked connections.
//
// State/config persists at db/connectors/state.json (globalThis-cached).
import fs from 'node:fs/promises'
import path from 'node:path'
import { db } from '@/lib/db'
import { recordActivity } from '@/lib/services/activity-service'
import {
  getVaultStatus,
  listNotes as vaultListNotes,
  readNote as vaultReadNote,
} from '@/lib/services/obsidian-service'
import { ingestKnowledge } from './knowledge-service'

// ---------------------------------------------------------------------------
// Frozen contracts
// ---------------------------------------------------------------------------

export type ConnectorKind = 'local' | 'api' | 'oauth'

export interface ConnectorStatus {
  id: string
  name: string
  kind: ConnectorKind
  connected: boolean
  available: boolean
  items: number // distinct documents this connector has contributed to the knowledge store
  lastSyncAt: string | null
  note: string
}

export interface ConnectorSyncResult {
  ok: boolean
  id: string
  ingested: number
  skipped: number
  note: string
  lastSyncAt: string
}

// ---------------------------------------------------------------------------
// State (db/connectors/state.json)
// ---------------------------------------------------------------------------

const CONNECTORS_STATE_PATH = path.join(process.cwd(), 'db', 'connectors', 'state.json')

interface ConnectorStateEntry {
  lastSyncAt?: string
  lastNote?: string
  lastSyncOk?: boolean
  config?: Record<string, unknown>
}

type ConnectorStateMap = Record<string, ConnectorStateEntry>

const stateGlobal = globalThis as unknown as { __mistOjConnectorState?: ConnectorStateMap }

async function loadState(): Promise<ConnectorStateMap> {
  const g = stateGlobal
  if (g.__mistOjConnectorState) return g.__mistOjConnectorState
  let map: ConnectorStateMap = {}
  try {
    const raw = await fs.readFile(CONNECTORS_STATE_PATH, 'utf-8')
    const parsed: unknown = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      map = parsed as ConnectorStateMap
    }
  } catch {
    map = {}
  }
  g.__mistOjConnectorState = map
  return map
}

async function saveStateEntry(id: string, entry: ConnectorStateEntry): Promise<void> {
  const map = await loadState()
  map[id] = { ...map[id], ...entry }
  try {
    await fs.mkdir(path.dirname(CONNECTORS_STATE_PATH), { recursive: true })
    await fs.writeFile(CONNECTORS_STATE_PATH, JSON.stringify(map, null, 2), 'utf-8')
  } catch {
    // state persistence is best-effort — sync results still return honestly
  }
}

/** Distinct documents (sourceId) a connector source has in the knowledge store. */
async function connectorDocCount(id: string): Promise<number> {
  try {
    const rows = await db.$queryRaw<Array<{ c: number | bigint }>>`
      SELECT COUNT(DISTINCT CASE WHEN sourceId != '' THEN sourceId ELSE id END) AS c
      FROM KnowledgeChunk WHERE source = ${`connector:${id}`}`
    return rows.length > 0 ? Number(rows[0].c) : 0
  } catch {
    return 0
  }
}

// ---------------------------------------------------------------------------
// Local source helpers
// ---------------------------------------------------------------------------

const TEXT_EXTENSIONS = new Set([
  '.md', '.txt', '.json', '.csv', '.log', '.yml', '.yaml', '.ts', '.tsx', '.js', '.py', '.sh', '.toml',
])
const MAX_FILES_PER_SYNC = 60
const MAX_FILE_BYTES = 512_000

const UPLOAD_DIRS = [
  path.join(process.cwd(), 'db', 'upload'),
  path.join(process.cwd(), 'upload'),
]
const NOTES_DIR = path.join(process.cwd(), 'db', 'notes')

async function walkTextFiles(
  dir: string,
  out: Array<{ abs: string, rel: string }>,
  depth = 0
): Promise<void> {
  if (out.length >= MAX_FILES_PER_SYNC || depth > 3) return
  let entries: Array<{ name: string; isDirectory: boolean }> = []
  try {
    entries = (await fs.readdir(dir, { withFileTypes: true })).map((e) => ({
      name: e.name,
      isDirectory: e.isDirectory(),
    }))
  } catch {
    return // dir missing — nothing to ingest
  }
  for (const entry of entries) {
    if (out.length >= MAX_FILES_PER_SYNC) return
    const abs = path.join(dir, entry.name)
    if (entry.isDirectory) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
      await walkTextFiles(abs, out, depth + 1)
    } else if (TEXT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      out.push({ abs, rel: path.relative(process.cwd(), abs) })
    }
  }
}

async function readTextFileSafe(abs: string): Promise<string | null> {
  try {
    const stat = await fs.stat(abs)
    if (stat.size > MAX_FILE_BYTES) return null // honest skip: too large
    const buf = await fs.readFile(abs)
    // binary sniff: NUL byte or >10% control chars in the first 4 KB
    const probe = buf.subarray(0, 4096)
    let control = 0
    for (const byte of probe) {
      if (byte === 0) return null
      if (byte < 9 || (byte > 13 && byte < 32)) control++
    }
    if (probe.length > 0 && control / probe.length > 0.1) return null
    return buf.toString('utf-8')
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Public API fetch helpers (read-only, honest about failures)
// ---------------------------------------------------------------------------

async function fetchJson(url: string, headers: Record<string, string> = {}, timeoutMs = 15_000): Promise<unknown> {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), timeoutMs)
  try {
    const res = await fetch(url, { headers: { 'user-agent': 'MIST-Console/1.0 (+knowledge-sync)', ...headers }, signal: ctl.signal, cache: 'no-store' })
    if (!res.ok) throw new Error(`HTTP ${res.status}${res.status === 403 ? ' (rate limited)' : ''}`)
    return await res.json()
  } finally {
    clearTimeout(timer)
  }
}

interface GhRepoInfo {
  full_name?: string
  description?: string
  topics?: string[]
  html_url?: string
  default_branch?: string
}

async function syncGithub(config: Record<string, unknown>): Promise<Omit<ConnectorSyncResult, 'id' | 'lastSyncAt'>> {
  const owner = typeof config.owner === 'string' ? config.owner.trim() : ''
  const repo = typeof config.repo === 'string' ? config.repo.trim() : ''
  if (!owner || !repo) {
    return {
      ok: false,
      ingested: 0,
      skipped: 0,
      note: 'not configured — set config {owner, repo} (public repos only, read-only; unauthenticated GitHub API is limited to 60 requests/hour)',
    }
  }
  try {
    const info = (await fetchJson(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, { accept: 'application/vnd.github+json' })) as GhRepoInfo
    const readme = (await fetchJson(
      `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/readme`,
      { accept: 'application/vnd.github.raw+json' }
    )) as unknown
    const readmeText = typeof readme === 'string' ? readme : '(readme unavailable)'
    const doc =
      `# ${info.full_name ?? `${owner}/${repo}`}\n\n` +
      `${info.description ?? '(no description)'}\n\n` +
      `## Topics\n${(info.topics ?? []).join(', ') || '(none)'}\n\n` +
      `## README\n${readmeText.slice(0, 100_000)}`
    const res = await ingestKnowledge({
      source: 'connector:github',
      title: info.full_name ?? `${owner}/${repo}`,
      text: doc,
      docType: 'web',
      sourceId: info.html_url ?? `github:${owner}/${repo}`,
      meta: { url: info.html_url, owner, repo },
    })
    return { ok: true, ingested: 1, skipped: 0, note: `synced ${owner}/${repo} (repo metadata + README)` }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'github sync failed'
    return { ok: false, ingested: 0, skipped: 0, note: `github sync failed: ${message}` }
  }
}

interface HnItem {
  id?: number
  title?: string
  score?: number
  descendants?: number
  url?: string
  by?: string
  time?: number
}

async function syncHackernews(): Promise<Omit<ConnectorSyncResult, 'id' | 'lastSyncAt'>> {
  try {
    const ids = (await fetchJson('https://hacker-news.firebaseio.com/v0/topstories.json')) as unknown
    if (!Array.isArray(ids) || ids.length === 0) throw new Error('no stories returned')
    let ingested = 0
    let skipped = 0
    for (const id of ids.slice(0, 5)) {
      try {
        const item = (await fetchJson(`https://hacker-news.firebaseio.com/v0/item/${id}.json`)) as HnItem
        if (!item || typeof item.title !== 'string') {
          skipped++
          continue
        }
        const when = item.time ? new Date(item.time * 1000).toISOString() : new Date().toISOString()
        const doc =
          `${item.title}\n\n` +
          `Score: ${item.score ?? 0}, Comments: ${item.descendants ?? 0}\n` +
          `URL: ${item.url ?? `https://news.ycombinator.com/item?id=${id}`}\n` +
          `By: ${item.by ?? 'unknown'} at ${when}`
        await ingestKnowledge({
          source: 'connector:hackernews',
          title: item.title,
          text: doc,
          docType: 'web',
          sourceId: `hn-${id}`,
          meta: { storyId: id, url: item.url, score: item.score, comments: item.descendants, author: item.by },
        })
        ingested++
      } catch {
        skipped++
      }
    }
    return { ok: true, ingested, skipped, note: `top 5 Hacker News stories (public firebase API, no auth)` }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'hackernews sync failed'
    return { ok: false, ingested: 0, skipped: 0, note: `hackernews sync failed: ${message}` }
  }
}

interface RedditListing {
  data?: {
    children?: Array<{ data?: { title?: string; selftext?: string; score?: number; num_comments?: number; permalink?: string; author?: string; subreddit?: string } }>
  }
}

async function syncReddit(config: Record<string, unknown>): Promise<Omit<ConnectorSyncResult, 'id' | 'lastSyncAt'>> {
  const subreddit = typeof config.subreddit === 'string' ? config.subreddit.trim().replace(/^r\//, '') : ''
  if (!subreddit) {
    return {
      ok: false,
      ingested: 0,
      skipped: 0,
      note: 'not configured — set config {subreddit} (public read-only .json endpoints; Reddit heavily rate-limits unauthenticated clients — errors are reported honestly)',
    }
  }
  try {
    const listing = (await fetchJson(
      `https://www.reddit.com/r/${encodeURIComponent(subreddit)}/top.json?t=week&limit=5`
    )) as RedditListing
    const children = listing?.data?.children ?? []
    if (children.length === 0) throw new Error('no posts returned')
    let ingested = 0
    for (const child of children) {
      const post = child?.data
      if (!post || typeof post.title !== 'string') continue
      const doc =
        `${post.title}\n\n` +
        `r/${post.subreddit ?? subreddit} · score ${post.score ?? 0} · ${post.num_comments ?? 0} comments · by u/${post.author ?? 'unknown'}\n\n` +
        `${(post.selftext ?? '').slice(0, 2000) || '(link post)'}\n\nhttps://www.reddit.com${post.permalink ?? ''}`
      await ingestKnowledge({
        source: 'connector:reddit',
        title: post.title,
        text: doc,
        docType: 'web',
        sourceId: post.permalink ? `reddit:${post.permalink}` : `reddit:${post.title}`,
        meta: { subreddit, author: post.author, score: post.score },
      })
      ingested++
    }
    return { ok: true, ingested, skipped: 0, note: `top ${ingested} posts from r/${subreddit} this week (public read-only API)` }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'reddit sync failed'
    return { ok: false, ingested: 0, skipped: 0, note: `reddit sync failed: ${message} — unauthenticated access is frequently rate-limited; this is reported, not retried silently` }
  }
}

// ---------------------------------------------------------------------------
// Connector definitions + sync dispatch
// ---------------------------------------------------------------------------

interface ConnectorDef {
  id: string
  name: string
  kind: ConnectorKind
  note: (state: ConnectorStateEntry) => string
  available: () => Promise<boolean>
  connected: () => Promise<boolean>
  sync: (config: Record<string, unknown>) => Promise<Omit<ConnectorSyncResult, 'id' | 'lastSyncAt'>>
}

async function dirExists(p: string): Promise<boolean> {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

const OAUTH_CONNECTORS: Array<{ id: string; name: string; note: string }> = [
  { id: 'gmail', name: 'Gmail', note: 'needs a Google OAuth app + consent — no credentials exist in this deployment; listed honestly, not connected' },
  { id: 'gdrive', name: 'Google Drive', note: 'needs Google OAuth scopes for Drive — no credentials in this deployment; not connected' },
  { id: 'gcal', name: 'Google Calendar', note: 'needs Google OAuth calendar scopes — no credentials in this deployment; not connected' },
  { id: 'slack', name: 'Slack', note: 'needs a Slack app token (Socket Mode) — no credentials in this deployment; not connected' },
  { id: 'notion', name: 'Notion', note: 'needs a Notion integration token — no credentials in this deployment; not connected' },
  { id: 'linear', name: 'Linear', note: 'needs a Linear API key — no credentials in this deployment; not connected' },
  { id: 'discord', name: 'Discord', note: 'needs a Discord bot token — no credentials in this deployment; not connected' },
  { id: 'twitter', name: 'Twitter / X', note: 'needs X API v2 credentials — no credentials in this deployment; not connected' },
]

const CONNECTOR_DEFS: ConnectorDef[] = [
  {
    id: 'upload',
    name: 'Upload folder',
    kind: 'local',
    note: () => 'text files from db/upload and upload/ (md/txt/json/csv/code — binary files are skipped with a note)',
    available: async () => (await Promise.all(UPLOAD_DIRS.map(dirExists))).some(Boolean),
    connected: async () => (await Promise.all(UPLOAD_DIRS.map(dirExists))).some(Boolean),
    sync: async () => {
      const files: Array<{ abs: string; rel: string }> = []
      for (const dir of UPLOAD_DIRS) await walkTextFiles(dir, files)
      if (files.length === 0) return { ok: true, ingested: 0, skipped: 0, note: 'no text files found in upload folders yet' }
      let ingested = 0
      let skipped = 0
      for (const f of files) {
        const text = await readTextFileSafe(f.abs)
        if (text === null) {
          skipped++
          continue
        }
        await ingestKnowledge({
          source: 'connector:upload',
          title: path.basename(f.rel),
          text,
          docType: 'document',
          sourceId: f.rel,
          meta: { path: f.rel },
        })
        ingested++
      }
      return { ok: true, ingested, skipped, note: `ingested ${ingested} file(s)${skipped > 0 ? `, skipped ${skipped} binary/oversized` : ''}` }
    },
  },
  {
    id: 'obsidian',
    name: 'Obsidian vault',
    kind: 'local',
    note: (state) => state.lastNote ?? 'uses the connected vault from the Obsidian integration (vault notes → knowledge chunks)',
    available: async () => true,
    connected: async () => (await getVaultStatus()).connected,
    sync: async () => {
      const status = await getVaultStatus()
      if (!status.connected) {
        return { ok: false, ingested: 0, skipped: 0, note: 'no vault connected — POST /api/mist/obsidian {"action":"set_path","path":"demo"} first' }
      }
      const notes = await vaultListNotes()
      if (notes.length === 0) return { ok: true, ingested: 0, skipped: 0, note: 'vault connected but has no notes' }
      let ingested = 0
      let skipped = 0
      for (const meta of notes.slice(0, 40)) {
        const read = await vaultReadNote(meta.path)
        if (!read.ok) {
          skipped++
          continue
        }
        const body = read.note.content.trim()
        if (!body) {
          skipped++
          continue
        }
        const tags = read.note.tags.length > 0 ? `\n\ntags: ${read.note.tags.join(', ')}` : ''
        await ingestKnowledge({
          source: 'connector:obsidian',
          title: meta.title,
          text: `${body}${tags}`,
          docType: 'vault',
          sourceId: meta.path,
          meta: { path: meta.path, tags: read.note.tags, vault: status.vaultPath },
        })
        ingested++
      }
      return { ok: true, ingested, skipped, note: `ingested ${ingested} vault note(s)${skipped > 0 ? `, skipped ${skipped}` : ''}` }
    },
  },
  {
    id: 'notes',
    name: 'Local notes',
    kind: 'local',
    note: () => 'markdown notes from db/notes/ (her own research briefs, runbooks, digests)',
    available: async () => dirExists(NOTES_DIR),
    connected: async () => dirExists(NOTES_DIR),
    sync: async () => {
      const files: Array<{ abs: string; rel: string }> = []
      await walkTextFiles(NOTES_DIR, files)
      if (files.length === 0) return { ok: true, ingested: 0, skipped: 0, note: 'no notes found in db/notes yet' }
      let ingested = 0
      let skipped = 0
      for (const f of files) {
        const text = await readTextFileSafe(f.abs)
        if (text === null) {
          skipped++
          continue
        }
        await ingestKnowledge({
          source: 'connector:notes',
          title: path.basename(f.rel),
          text,
          docType: 'note',
          sourceId: f.rel,
          meta: { path: f.rel },
        })
        ingested++
      }
      return { ok: true, ingested, skipped, note: `ingested ${ingested} note(s)${skipped > 0 ? `, skipped ${skipped}` : ''}` }
    },
  },
  {
    id: 'github',
    name: 'GitHub repo',
    kind: 'api',
    note: (state) => {
      const cfg = state.config ?? {}
      if (typeof cfg.owner === 'string' && typeof cfg.repo === 'string' && cfg.owner && cfg.repo) {
        return `configured for ${cfg.owner}/${cfg.repo} — read-only public repo sync (README + metadata); unauthenticated API is capped at 60 req/h`
      }
      return 'not configured — POST {"id":"github","action":"sync","config":{"owner":"…","repo":"…"}} for a public repo (read-only, 60 req/h unauth rate limit)'
    },
    available: async () => true,
    connected: async () => false, // connected only after a configured, successful sync
    sync: async (config) => syncGithub(config),
  },
  {
    id: 'hackernews',
    name: 'Hacker News',
    kind: 'api',
    note: () => 'current top 5 stories from the public firebase API — no auth needed, always available',
    available: async () => true,
    connected: async () => true,
    sync: async () => syncHackernews(),
  },
  {
    id: 'reddit',
    name: 'Reddit',
    kind: 'api',
    note: (state) => {
      const cfg = state.config ?? {}
      if (typeof cfg.subreddit === 'string' && cfg.subreddit) {
        return `configured for r/${cfg.subreddit} — top posts of the week via public read-only .json endpoints (unauthenticated access is frequently rate-limited; failures reported honestly)`
      }
      return 'not configured — POST {"id":"reddit","action":"sync","config":{"subreddit":"…"}} (public read-only API; rate limits are real and reported honestly)'
    },
    available: async () => true,
    connected: async () => false,
    sync: async (config) => syncReddit(config),
  },
  ...OAUTH_CONNECTORS.map(
    (o): ConnectorDef => ({
      id: o.id,
      name: o.name,
      kind: 'oauth' as const,
      note: () => o.note,
      available: async () => false, // no OAuth credential surface exists here — honest
      connected: async () => false, // NEVER faked
      sync: async () => ({
        ok: false,
        ingested: 0,
        skipped: 0,
        note: `${o.name} requires external credentials that are not configured in this deployment — sync refused honestly (no fake connection)`,
      }),
    })
  ),
]

export const CONNECTOR_IDS = CONNECTOR_DEFS.map((d) => d.id)

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Full connector listing (frozen shape). Never throws. */
export async function listConnectors(): Promise<{ connectors: ConnectorStatus[] }> {
  const state = await loadState()
  const statuses = await Promise.all(
    CONNECTOR_DEFS.map(async (def) => {
      const entry = state[def.id] ?? {}
      const [available, connected, items] = await Promise.all([
        def.available().catch(() => false),
        def.connected().catch(() => false),
        connectorDocCount(def.id).catch(() => 0),
      ])
      // a connector with a SUCCESSFUL last sync counts as connected even if
      // its live probe is momentarily unavailable (honest, state-backed)
      const wasSynced = Boolean(entry.lastSyncAt && entry.lastSyncOk)
      return {
        id: def.id,
        name: def.name,
        kind: def.kind,
        connected: connected || (wasSynced && available),
        available,
        items,
        lastSyncAt: entry.lastSyncAt ?? null,
        note: def.note(entry),
      }
    })
  )
  return { connectors: statuses }
}

/**
 * Sync one connector into the knowledge store. Config (owner/repo, subreddit)
 * is persisted per connector so future syncs reuse it. Honest results only —
 * failures return ok:false with the real reason.
 */
export async function syncConnector(
  id: string,
  config?: Record<string, unknown>
): Promise<ConnectorSyncResult> {
  const def = CONNECTOR_DEFS.find((d) => d.id === id)
  const now = new Date().toISOString()
  if (!def) {
    return { ok: false, id, ingested: 0, skipped: 0, note: `unknown connector: ${id}`, lastSyncAt: now }
  }
  const state = await loadState()
  const mergedConfig = { ...(state[id]?.config ?? {}), ...(config ?? {}) }
  if (config && Object.keys(config).length > 0) {
    await saveStateEntry(id, { config: mergedConfig })
  }
  const result = await def.sync(mergedConfig).catch((err: unknown) => ({
    ok: false,
    ingested: 0,
    skipped: 0,
    note: `sync crashed: ${err instanceof Error ? err.message : 'unknown error'}`,
  }))
  const note = result.note
  await saveStateEntry(id, { lastSyncAt: now, lastNote: note, lastSyncOk: result.ok })
  recordActivity('connector', `${id} sync ${result.ok ? 'ok' : 'failed'}: ${note}`)
  return { ...result, id, lastSyncAt: now }
}
