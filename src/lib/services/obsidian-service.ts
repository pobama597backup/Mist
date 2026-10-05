// v5 OBSIDIAN INTEGRATION — expert-level vault management.
//
// OWNERSHIP: Agent 10-b fills this file in completely. Exported signatures
// below are the frozen contract.
//
// ARCHITECTURE (required):
// - Vault resolution order: (1) env MIST_OBSIDIAN_VAULT, (2) persisted config
//   db/obsidian-vaults/config.json { vaultPath }, (3) last successful
//   discovery cached in globalThis. A vault = a directory containing an
//   .obsidian subdirectory.
// - discoverVaults(): scan candidate roots — $HOME (depth 2), $HOME/Documents
//   (depth 2), $HOME/Obsidian, $HOME/vaults, $HOME/.vaults, <project>/db/
//   obsidian-vaults — for .obsidian dirs; count .md files per hit (cap scan
//   at ~500 entries/dir for speed); demoAvailable = demo vault exists or can
//   be created. Never throws; always returns a list (possibly empty).
// - setVaultPath(path | 'demo' | null): persist to config.json + globalThis
//   cache; 'demo' resolves to the demo vault (creating it first). Validate
//   the dir exists and contains .obsidian (or create .obsidian for a chosen
//   empty dir). null disconnects.
// - All note ops operate on RELATIVE paths inside the vault (jail: resolve +
//   prefix check — a path can never escape the vault; reject '..').
// - Markdown expertise required:
//   * frontmatter: parse/serialize YAML-ish (key: value lines, lists as
//     [a, b] or - item lines) between --- fences; preserve unknown keys and
//     original formatting on update as best effort.
//   * wikilinks: [[Note]], [[Note|alias]], [[Note#Heading]] — resolve to
//     vault note paths case-insensitively; also count standard [text](md)
//     relative links.
//   * tags: #inline and frontmatter tags; strip # from counts; ignore code
//     fences when scanning.
// - readNote returns frontmatter as a flat Record<string,string>, content
//   (without frontmatter), outgoingLinks (resolved paths), backlinks
//   (paths of notes linking here), tags.
// - getGraph: nodes = all notes (degree = in+out links), edges = resolved
//   wikilinks (deduped), orphans = zero-degree notes, hubs = top 5 by degree.
// - dailyNote(date? YYYY-MM-DD, default today in Africa/Lagos): path
//   <DailyNotes>/<date>.md (or root if no folder); template support via
//   <Templates>/Daily.md if present with {{date}} {{time}} {{title}}
//   substitution; returns created flag.
// - vaultQuery(q): dataview-lite — support at minimum:
//   LIST FROM #tag | LIST FROM "folder" | TABLE <props> FROM <source> |
//   TASK (gather "- [ ]" items vault-wide with their source paths).
//   Return { kind, rows, explanation } — rows are string records. Unknown
//   query → kind 'unsupported' with a helpful explanation (never throws).
// - ensureDemoVault(): create db/obsidian-vaults/Mist Demo Vault/.obsidian/
//   (app.json + appearance.json minimal) + ~8 interlinked notes covering:
//   a Projects MOC, AI Research notes, a Daily note, a note about M.I.S.T.
//   integration ideas, tags + frontmatter + wikilinks between them, an
//   orphan on purpose, a few unchecked tasks. Return the vault path.
// - Vault events (connected/created demo) → logAutonomyEvent('vault_event').
// - NEVER throw across the API boundary: catch → typed error result.

import fs from 'node:fs/promises'
import path from 'node:path'
import { logAutonomyEvent } from '@/lib/services/autonomy-service'

// ---------------------------------------------------------------------------
// Frozen public contracts
// ---------------------------------------------------------------------------

export interface VaultStatus {
  connected: boolean
  vaultPath: string | null
  noteCount: number
  folderCount: number
  tagCount: number
  linkCount: number
  orphanCount: number
  lastScanAt?: string
  demo?: boolean
}

export interface VaultNoteMeta {
  path: string
  title: string
  mtime: string
  size: number
  tags: string[]
  links: number
}

export interface VaultNote extends VaultNoteMeta {
  frontmatter: Record<string, string>
  content: string
  outgoingLinks: string[]
  backlinks: string[]
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TZ = 'Africa/Lagos'
const MAX_FILE_BYTES = 1_048_576 // skip notes > 1MB
const MAX_NOTES = 2000 // cap vault scan
const MAX_SCAN_DIRS = 800
const MAX_READDIR = 500 // cap entries read per directory
const SCAN_TTL_MS = 15_000
const DISCOVER_TTL_MS = 30_000
const VAULTS_DIR = path.resolve(process.cwd(), 'db', 'obsidian-vaults')
const CONFIG_PATH = path.join(VAULTS_DIR, 'config.json')
const DEMO_DIR = path.join(VAULTS_DIR, 'Mist Demo Vault')
const SKIP_DIR_NAMES = new Set(['node_modules', 'Library', 'AppData', 'Cache', '.cache', '.npm', '.venv', 'venv', '__pycache__'])
const DAILY_FOLDER_NAMES = new Set(['daily notes', 'dailynotes', 'daily-notes', 'daily', 'journal'])
const WIKILINK_RE = /\[\[([^\]#|]+)(?:#[^\]|]+)?(?:\|([^\]]+))?\]\]/g
const MDLINK_RE = /\[([^\]]*)\]\(([^)]+)\)/g
const TASK_RE = /^\s*(?:>\s*)*[-*+]\s+\[( |x|X)\]\s*(.*)$/
const INLINE_TAG_RE = /(^|\s)#([A-Za-z_][A-Za-z0-9_\-/]*)/g

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface RawLink {
  target: string
  line: string
  isMd: boolean
}

interface ParsedNote {
  path: string // vault-relative, forward slashes, with .md
  title: string
  mtime: string // ISO
  size: number
  fmRaw: string | null // verbatim frontmatter block (without --- fences)
  fm: Record<string, string> // flattened frontmatter
  fmMap: Map<string, string | string[]>
  content: string // body without frontmatter
  cleanText: string // body with code fences/inline code stripped
  cleanLines: string[]
  tags: string[] // frontmatter + inline, case-preserved, deduped
  aliases: string[]
  rawLinks: RawLink[]
  outgoing: string[] // resolved vault-relative targets (deduped, sorted)
  linkLines: Map<string, string> // resolved target → first line snippet
}

interface VaultScan {
  vaultPath: string
  at: number
  notes: ParsedNote[]
  byPath: Map<string, ParsedNote>
  byLower: Map<string, ParsedNote> // lowercase full path (no .md) → note
  byBase: Map<string, ParsedNote> // lowercase basename (no .md) → note
  byAlias: Map<string, ParsedNote> // lowercase alias → note
  folders: Set<string> // non-root dirs that directly contain .md notes
  allDirs: Set<string> // every non-hidden dir (relative)
  truncated: boolean
}

interface ObsidianStore {
  currentVault: string | null
  scan: { vaultPath: string; at: number; data: VaultScan } | null
  scanJob: { vaultPath: string; promise: Promise<VaultScan> } | null
  scanGen: number
  discovery: { at: number; found: { path: string; noteCount: number }[]; demoAvailable: boolean } | null
}

const g = globalThis as typeof globalThis & { __mistObsidianStore?: ObsidianStore }

function store(): ObsidianStore {
  if (!g.__mistObsidianStore) {
    g.__mistObsidianStore = { currentVault: null, scan: null, scanJob: null, scanGen: 0, discovery: null }
  }
  return g.__mistObsidianStore
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function errMsg(err: unknown, fallback: string): string {
  if (err instanceof Error && err.message) return err.message
  return fallback
}

function basenameNoExt(relPath: string): string {
  const base = relPath.split('/').pop() ?? relPath
  return base.replace(/\.(md|markdown)$/i, '')
}

function dirnameOf(relPath: string): string {
  const idx = relPath.lastIndexOf('/')
  return idx >= 0 ? relPath.slice(0, idx) : ''
}

/** Textually normalize a vault-relative path: resolve '.'/'..' segments, drop leading slashes. */
function normalizeRel(p: string): string {
  const parts = p.split('/')
  const out: string[] = []
  for (const part of parts) {
    if (!part || part === '.') continue
    if (part === '..') {
      out.pop()
      continue
    }
    out.push(part)
  }
  return out.join('/')
}

/** Path jail: convert a caller-supplied relative path into a safe vault-relative
 *  path, or null when it tries to escape (absolute, ~, drive letter, '..'). */
function jailRelative(vaultPath: string, rel: string): string | null {
  if (typeof rel !== 'string') return null
  const r = rel.trim().replace(/\\/g, '/')
  if (r === '') return ''
  if (r.startsWith('/') || r.startsWith('~')) return null
  if (/^[a-zA-Z]:/.test(r)) return null
  const parts = r.split('/').filter((p) => p !== '' && p !== '.')
  if (parts.some((p) => p === '..')) return null
  const joined = parts.join('/')
  // belt & suspenders: resolve and verify containment on the real filesystem
  const vaultAbs = path.resolve(vaultPath)
  const abs = path.resolve(vaultPath, joined)
  if (abs !== vaultAbs && !abs.startsWith(vaultAbs + path.sep)) return null
  return joined
}

function dedupeCI(items: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of items) {
    const t = raw.trim()
    if (!t) continue
    const k = t.toLowerCase()
    if (seen.has(k)) continue
    seen.add(k)
    out.push(t)
  }
  return out
}

function todayInLagos(): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
  } catch {
    return new Date().toISOString().slice(0, 10)
  }
}

function timeInLagos(): string {
  try {
    return new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit' }).format(new Date())
  } catch {
    return new Date().toISOString().slice(11, 16)
  }
}

function isDemoPath(p: string): boolean {
  try {
    return path.resolve(p) === DEMO_DIR
  } catch {
    return false
  }
}

/** Canonical lowercase index key for a vault-relative path (extension stripped). */
function lowerKey(relPath: string): string {
  return relPath.toLowerCase().replace(/\.(md|markdown)$/i, '')
}

function disconnectedStatus(): VaultStatus {
  return {
    connected: false,
    vaultPath: null,
    noteCount: 0,
    folderCount: 0,
    tagCount: 0,
    linkCount: 0,
    orphanCount: 0,
  }
}

// ---------------------------------------------------------------------------
// Frontmatter (YAML-ish) parsing
// ---------------------------------------------------------------------------

/** Split a raw file into its verbatim frontmatter block (no fences) and body. */
function splitFrontmatter(raw: string): { fmRaw: string | null; body: string } {
  let text = raw
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
  if (!text.startsWith('---')) return { fmRaw: null, body: text }
  const lines = text.split('\n')
  if (lines[0].trim() !== '---') return { fmRaw: null, body: text }
  for (let i = 1; i < lines.length; i++) {
    const t = lines[i].trim()
    if (t === '---' || t === '...') {
      const fmRaw = i > 1 ? lines.slice(1, i).join('\n') + '\n' : ''
      return { fmRaw, body: lines.slice(i + 1).join('\n') }
    }
  }
  return { fmRaw: null, body: text }
}

function parseScalar(s: string): string {
  let v = s.trim()
  const quoted = v.match(/^(['"])([\s\S]*)\1$/)
  if (quoted) {
    v = quoted[2]
  } else {
    v = v.replace(/\s+#.*$/, '') // strip trailing YAML comment
  }
  return v.trim()
}

function parseInlineList(s: string): string[] {
  return s
    .split(',')
    .map((x) => parseScalar(x))
    .filter((x) => x !== '')
}

/** Parse a YAML-ish frontmatter block: `key: value`, `key: [a, b]`, and
 *  `key:` followed by `- item` lines. Unknown keys are preserved in order. */
function parseFmBlock(fmRaw: string | null): { map: Map<string, string | string[]>; order: string[] } {
  const map = new Map<string, string | string[]>()
  const order: string[] = []
  if (!fmRaw) return { map, order }
  let lastKey: string | null = null
  for (const line of fmRaw.split('\n')) {
    if (!line.trim()) continue
    const listItem = line.match(/^\s*-\s+(.*)$/)
    if (listItem && lastKey) {
      const val = parseScalar(listItem[1])
      if (val === '' && lastKey) continue
      const cur = map.get(lastKey)
      if (Array.isArray(cur)) cur.push(val)
      else if (cur === undefined || cur === '') map.set(lastKey, [val])
      else map.set(lastKey, [cur, val])
      continue
    }
    const kv = line.match(/^([A-Za-z0-9_.\- ]+?)\s*:\s*(.*)$/)
    if (kv) {
      const key = kv[1].trim()
      const value = kv[2].trim()
      lastKey = key
      if (!order.includes(key)) order.push(key)
      if (value === '') map.set(key, '')
      else if (value.startsWith('[') && value.endsWith(']')) map.set(key, parseInlineList(value.slice(1, -1)))
      else map.set(key, parseScalar(value))
    } else {
      lastKey = null
    }
  }
  return { map, order }
}

/** Flatten frontmatter values into the string record exposed by the API. */
function flattenFm(map: Map<string, string | string[]>, order: string[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const key of order) {
    const v = map.get(key)
    if (v === undefined) continue
    out[key] = Array.isArray(v) ? v.join(', ') : v
  }
  return out
}

/** Extract a list-valued frontmatter key (tags / aliases / …). */
function fmArray(map: Map<string, string | string[]>, keys: string[]): string[] {
  for (const key of keys) {
    const v = map.get(key)
    if (v === undefined || v === '') continue
    const items = Array.isArray(v) ? v : typeof v === 'string' && v.includes(',') ? v.split(',') : [v]
    const cleaned = items.map((x) => x.trim().replace(/^#/, '')).filter((x) => x !== '')
    if (cleaned.length) return cleaned
  }
  return []
}

// ---------------------------------------------------------------------------
// Markdown scanning (code-fence aware)
// ---------------------------------------------------------------------------

/** Remove fenced code blocks and inline code spans so link/tag scans never
 *  trip over documentation examples. */
function stripForScan(body: string): string {
  const out: string[] = []
  let inFence = false
  for (const line of body.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    out.push(line.replace(/`[^`]*`/g, ' '))
  }
  return out.join('\n')
}

function scanInlineTags(cleaned: string): string[] {
  const out: string[] = []
  let m: RegExpExecArray | null
  INLINE_TAG_RE.lastIndex = 0
  while ((m = INLINE_TAG_RE.exec(cleaned)) !== null) {
    const tag = m[2]
    if (/^\d+$/.test(tag)) continue // pure numbers are not tags
    out.push(tag)
  }
  return out
}

/** Phase 1 parse of a single note: frontmatter, tags, and RAW link targets
 *  (resolution happens later, once the whole-vault index exists). */
function parseNoteText(relPath: string, raw: string, size: number, mtimeMs: number): ParsedNote {
  const { fmRaw, body } = splitFrontmatter(raw)
  const { map, order } = parseFmBlock(fmRaw)
  const fm = flattenFm(map, order)
  const fmTags = fmArray(map, ['tags', 'tag'])
  const aliases = fmArray(map, ['alias', 'aliases'])
  const fmTitle = typeof map.get('title') === 'string' ? String(map.get('title')).trim() : ''
  const title = fmTitle || basenameNoExt(relPath)
  const cleanText = stripForScan(body)
  const cleanLines = cleanText.split('\n')
  const tags = dedupeCI([...fmTags, ...scanInlineTags(cleanText)])

  const rawLinks: RawLink[] = []
  for (const line of cleanLines) {
    const trimmed = line.trim()
    let m: RegExpExecArray | null
    WIKILINK_RE.lastIndex = 0
    while ((m = WIKILINK_RE.exec(line)) !== null) {
      const target = m[1]?.trim() ?? ''
      if (target) rawLinks.push({ target, line: trimmed, isMd: false })
    }
    MDLINK_RE.lastIndex = 0
    while ((m = MDLINK_RE.exec(line)) !== null) {
      // skip image embeds (![alt](…)) and non-markdown targets
      const before = line[m.index - 1]
      if (before === '!') continue
      let target = m[2].trim()
      if (target.startsWith('<') && target.endsWith('>')) target = target.slice(1, -1)
      if (!/\.(md|markdown)(#.*)?$/i.test(target)) continue
      if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(target)) continue
      if (target) rawLinks.push({ target, line: trimmed, isMd: true })
    }
  }

  return {
    path: relPath,
    title,
    mtime: new Date(mtimeMs).toISOString(),
    size,
    fmRaw,
    fm,
    fmMap: map,
    content: body,
    cleanText,
    cleanLines,
    tags,
    aliases,
    rawLinks,
    outgoing: [],
    linkLines: new Map(),
  }
}

/** Phase 2: resolve raw link targets against the vault index
 *  (case-insensitive: full path → note-relative → basename → frontmatter alias). */
function resolveLink(rawTarget: string, fromDir: string, isMd: boolean, scan: VaultScan): string | null {
  let t = rawTarget.trim().replace(/\\/g, '/')
  if (!t || t.startsWith('#')) return null
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(t)) return null // http:, mailto:, …
  try {
    const decoded = decodeURIComponent(t)
    if (decoded) t = decoded
  } catch {
    // malformed % sequence — keep raw target
  }
  const anchorIdx = t.indexOf('#')
  if (anchorIdx === 0) return null
  if (anchorIdx > 0) t = t.slice(0, anchorIdx)
  t = normalizeRel(t)
  if (!t) return null
  const key = t.toLowerCase().replace(/\.(md|markdown)$/i, '')
  const fromKey = fromDir ? normalizeRel(fromDir + '/' + t).toLowerCase().replace(/\.(md|markdown)$/i, '') : key
  const direct = isMd ? scan.byLower.get(fromKey) ?? scan.byLower.get(key) : scan.byLower.get(key) ?? scan.byLower.get(fromKey)
  if (direct) return direct.path
  const base = key.split('/').pop() ?? key
  const byBase = scan.byBase.get(base)
  if (byBase) return byBase.path
  const byAlias = scan.byAlias.get(base)
  if (byAlias) return byAlias.path
  return null
}

function resolveAllLinks(scan: VaultScan): void {
  for (const note of scan.notes) {
    const fromDir = dirnameOf(note.path)
    const seen = new Set<string>()
    for (const raw of note.rawLinks) {
      const resolved = resolveLink(raw.target, fromDir, raw.isMd, scan)
      if (!resolved) continue
      if (!seen.has(resolved)) {
        seen.add(resolved)
        note.outgoing.push(resolved)
        if (!note.linkLines.has(resolved)) note.linkLines.set(resolved, raw.line)
      }
    }
    note.outgoing.sort()
    note.rawLinks = []
  }
}

function buildMaps(scan: VaultScan): void {
  scan.notes.sort((a, b) => a.path.localeCompare(b.path))
  for (const note of scan.notes) {
    scan.byPath.set(note.path, note)
    scan.byLower.set(lowerKey(note.path), note)
    const base = basenameNoExt(note.path).toLowerCase()
    if (!scan.byBase.has(base)) scan.byBase.set(base, note)
    for (const alias of note.aliases) {
      const k = alias.toLowerCase()
      if (!scan.byAlias.has(k)) scan.byAlias.set(k, note)
    }
  }
}

// ---------------------------------------------------------------------------
// Vault scanning
// ---------------------------------------------------------------------------

async function walkVault(vaultPath: string): Promise<VaultScan> {
  const scan: VaultScan = {
    vaultPath,
    at: Date.now(),
    notes: [],
    byPath: new Map(),
    byLower: new Map(),
    byBase: new Map(),
    byAlias: new Map(),
    folders: new Set(),
    allDirs: new Set(),
    truncated: false,
  }
  try {
    const queue: { dir: string; rel: string }[] = [{ dir: vaultPath, rel: '' }]
    let dirsSeen = 0
    while (queue.length > 0 && scan.notes.length < MAX_NOTES && dirsSeen < MAX_SCAN_DIRS) {
      const { dir, rel } = queue.shift()!
      dirsSeen++
      let entries: import('node:fs').Dirent[]
      try {
        entries = await fs.readdir(dir, { withFileTypes: true })
      } catch {
        continue
      }
      entries.sort((a, b) => a.name.localeCompare(b.name))
      if (entries.length > MAX_READDIR) {
        entries = entries.slice(0, MAX_READDIR)
        scan.truncated = true
      }
      for (const e of entries) {
        if (e.name.startsWith('.')) continue
        if (e.isDirectory()) {
          if (SKIP_DIR_NAMES.has(e.name)) continue
          const childRel = rel ? rel + '/' + e.name : e.name
          scan.allDirs.add(childRel)
          if (scan.notes.length < MAX_NOTES && dirsSeen + queue.length < MAX_SCAN_DIRS) {
            queue.push({ dir: path.join(dir, e.name), rel: childRel })
          }
        } else if (e.isFile() && /\.(md|markdown)$/i.test(e.name)) {
          if (scan.notes.length >= MAX_NOTES) {
            scan.truncated = true
            break
          }
          const noteRel = rel ? rel + '/' + e.name : e.name
          if (rel) scan.folders.add(rel)
          try {
            const st = await fs.stat(path.join(dir, e.name))
            if (!st.isFile() || st.size > MAX_FILE_BYTES) continue
            const raw = await fs.readFile(path.join(dir, e.name), 'utf8')
            scan.notes.push(parseNoteText(noteRel, raw, st.size, st.mtimeMs))
          } catch {
            // unreadable note — skip
          }
        }
      }
    }
    buildMaps(scan)
    resolveAllLinks(scan)
  } catch {
    // scanning must never throw
  }
  return scan
}

async function getScan(vaultPath?: string | null): Promise<VaultScan | null> {
  const s = store()
  let vp: string | null
  if (typeof vaultPath === 'string' && vaultPath.trim() !== '') {
    vp = vaultPath
  } else {
    vp = await resolveVaultPath()
  }
  if (!vp) return null
  if (s.scan && s.scan.vaultPath === vp && Date.now() - s.scan.at < SCAN_TTL_MS) return s.scan.data
  if (s.scanJob && s.scanJob.vaultPath === vp) return s.scanJob.promise
  const gen = s.scanGen
  const job = (async () => {
    const data = await walkVault(vp!)
    if (store().scanGen === gen) store().scan = { vaultPath: vp!, at: Date.now(), data }
    return data
  })()
  s.scanJob = { vaultPath: vp, promise: job }
  try {
    return await job
  } finally {
    if (s.scanJob && s.scanJob.vaultPath === vp) s.scanJob = null
  }
}

function invalidateScan(): void {
  const s = store()
  s.scanGen++
  s.scan = null
}

// ---------------------------------------------------------------------------
// Vault resolution (env > persisted config > globalThis)
// ---------------------------------------------------------------------------

async function readConfig(): Promise<{ vaultPath: string | null } | null> {
  try {
    const raw = await fs.readFile(CONFIG_PATH, 'utf8')
    const parsed = JSON.parse(raw) as { vaultPath?: unknown }
    return { vaultPath: typeof parsed?.vaultPath === 'string' ? parsed.vaultPath : null }
  } catch {
    return null
  }
}

async function writeConfig(vaultPath: string | null): Promise<void> {
  try {
    await fs.mkdir(VAULTS_DIR, { recursive: true })
    await fs.writeFile(CONFIG_PATH, JSON.stringify({ vaultPath, savedAt: new Date().toISOString() }, null, 2) + '\n', 'utf8')
  } catch {
    // best effort persistence
  }
}

async function isVaultDir(dirPath: string): Promise<boolean> {
  try {
    const st = await fs.stat(path.join(dirPath, '.obsidian'))
    return st.isDirectory()
  } catch {
    return false
  }
}

async function resolveVaultPath(): Promise<string | null> {
  try {
    const envPath = process.env.MIST_OBSIDIAN_VAULT?.trim()
    if (envPath && (await isVaultDir(envPath))) return path.resolve(envPath)
    const cfg = await readConfig()
    if (cfg?.vaultPath && (await isVaultDir(cfg.vaultPath))) return path.resolve(cfg.vaultPath)
    const cached = store().currentVault
    if (cached && (await isVaultDir(cached))) return path.resolve(cached)
    return null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Link/degree analytics (shared by status + graph)
// ---------------------------------------------------------------------------

interface EdgeInfo {
  edges: { source: string; target: string }[]
  degree: Map<string, number>
  orphanCount: number
}

function computeEdges(scan: VaultScan): EdgeInfo {
  const seen = new Set<string>()
  const edges: { source: string; target: string }[] = []
  const degree = new Map<string, number>()
  for (const note of scan.notes) {
    for (const target of note.outgoing) {
      if (target === note.path) continue
      const key = note.path.toLowerCase() + '\u0000' + target.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      edges.push({ source: note.path, target })
      degree.set(note.path, (degree.get(note.path) ?? 0) + 1)
      degree.set(target, (degree.get(target) ?? 0) + 1)
    }
  }
  let orphanCount = 0
  for (const note of scan.notes) if (!((degree.get(note.path) ?? 0) > 0)) orphanCount++
  return { edges, degree, orphanCount }
}

// ---------------------------------------------------------------------------
// Demo vault
// ---------------------------------------------------------------------------

async function writeIfMissing(abs: string, data: string): Promise<boolean> {
  try {
    await fs.mkdir(path.dirname(abs), { recursive: true })
  } catch {
    // ignore — may already exist
  }
  try {
    await fs.writeFile(abs, data, { flag: 'wx' })
    return true
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code
    if (code === 'EEXIST') return false
    return false
  }
}

const DEMO_NOTES: Record<string, string> = {
  'Projects MOC.md': `---
title: Projects MOC
type: moc
tags: [moc, index]
created: 2026-01-10
updated: 2026-01-15
---

# Projects MOC

Map of Content for everything actively tracked. #moc

## Active Projects

- [[AI Research/Agentic Interfaces|Agentic Interfaces]] — how agents expose themselves to users
- [[AI Research/Hermes Agent|Hermes Agent]] — Nous Research's self-improving agent
- [[AI Research/M.I.S.T. Evolution]] — the M.I.S.T. roadmap
- [[AI Research/Memory Architectures]] — long-term memory designs worth stealing
- [[M.I.S.T. Integration Ideas]] — what to absorb from Hermes into M.I.S.T.

## Reading

- [[Reading List]] — papers and articles queue

## Journals

- [[Daily Notes/2026-01-15]] — latest daily note
`,
  'AI Research/Agentic Interfaces.md': `---
title: Agentic Interfaces
status: active
tags: [research, agents, ux]
created: 2026-01-11
priority: high
---

# Agentic Interfaces

Research thread on how autonomous agents present themselves: voice, ambient orbs, dashboards, chat. #agents #ux

Related: [[Projects MOC]] · See [[AI Research/Hermes Agent#Architecture|Hermes architecture]] for the strongest current example. Also worth reading [Hermes Agent](Hermes%20Agent.md) as a plain relative link.

## Design Principles

1. Zero-install beats install.
2. State should be visible — consciousness states, working indicators.
3. Memory must be felt: recall of past sessions builds trust.

## Open Questions

- [ ] Compare voice-first vs dashboard-first agent UX
- [ ] Collect 5 examples of "thinking" indicators done well
`,
  'AI Research/Hermes Agent.md': `---
title: Hermes Agent
status: researching
tags: [research, hermes, agents]
aliases: [Nous Hermes]
created: 2026-01-12
source: https://github.com/NousResearch/hermes-agent
stars: 214000
---

# Hermes Agent

Nous Research's self-improving agent, MIT licensed. #research

The learning loop is the moat: auto skill creation, skill refinement in use, memory nudges, user modeling. See [[Agentic Interfaces]] for the UX angle and [[M.I.S.T. Integration Ideas]] for what MIST should absorb.

Architecture notes: [[AI Research/M.I.S.T. Evolution#Phase 5|evolution phase 5]] overlaps with their mixture-of-agents layer.

## Strengths

- Closed learning loop
- Messaging gateway (Telegram, Discord, Slack, WhatsApp)
- Bounded, curated memory files

## Weaknesses

- FTS5 keyword recall only
- No visual interface
`,
  'AI Research/M.I.S.T. Evolution.md': `---
title: M.I.S.T. Evolution
status: in-progress
tags: [mist, roadmap, research]
created: 2026-01-10
updated: 2026-01-15
version: v5
---

# M.I.S.T. Evolution

From v1 chat orb to v5 autonomous OS. #mist

- v1: voice orb + chat
- v2: tools + memory
- v3: multi-model (Qwen tier) + self-evolution
- v4: heartbeat, watchlist, self tools
- v5: Hermes absorption — scheduler, learning loop, [[M.I.S.T. integration ideas]], Obsidian vault

The vault layer connects MIST to my notes: [[Projects MOC]] is the entry point, and the memory designs feed [[AI Research/Memory Architectures]].
`,
  'AI Research/Memory Architectures.md': `---
title: Memory Architectures
status: active
tags: [research, memory]
created: 2026-01-13
---

# Memory Architectures

How agents remember. #memory #research

- Longterm key-value facts
- Vector embeddings for semantic recall
- Curated MEMORY.md / USER.md (Hermes style) — see [[AI Research/Hermes Agent|Hermes]]
- Session search over past conversations

Feeds directly into [[AI Research/M.I.S.T. Evolution]]. Index: [[Projects MOC]].
`,
  'M.I.S.T. Integration Ideas.md': `---
title: M.I.S.T. Integration Ideas
status: brainstorm
tags: [mist, ideas, hermes]
created: 2026-01-14
---

# M.I.S.T. Integration Ideas

What to absorb from Hermes (the repo folks also call it [[Nous Hermes]]). #ideas

- [ ] P0: learning loop (auto skill creation on success)
- [ ] P1: natural-language cron scheduler
- [x] P1: Obsidian vault integration (this file lives inside it)
- [ ] P2: messaging gateway

Hub: [[Projects MOC]]. Deep dives: [[AI Research/Hermes Agent]] and [M.I.S.T. Evolution](AI%20Research/M.I.S.T.%20Evolution.md).

#mist #hermes
`,
  'Reading List.md': `---
title: Reading List
type: list
tags:
  - reading
  - inbox
updated: 2026-01-15
---

# Reading List

## Papers

- [ ] MoA: Mixture of Agents — read the ablations
- [ ] Honcho user modeling — skim the README
- [[AI Research/Hermes Agent|Hermes Agent repo]] README + docs

## Books

- [ ] Thinking, Fast and Slow (re-skim ch. 9)

## Articles

- [ ] "The agent that grows with you" launch post
- Agentic UX survey → ties into [[AI Research/Agentic Interfaces]]

#reading
`,
  'Daily Notes/2026-01-15.md': `---
date: 2026-01-15
type: daily
tags: [daily]
---

# 2026-01-15

## Focus

- Obsidian integration day

## Notes

- Connected the vault to M.I.S.T. — status looks good.
- Walked the [[Projects MOC]] and queued reading from [[Reading List]].
- The Hermes comparison details live in [[AI Research/Hermes Agent]].

## Tasks

- [ ] Wire vault tools into the agent loop
- [ ] Test daily note creation end to end
- [x] Ship the demo vault

## Log

- 09:00 — coffee, review [[M.I.S.T. Integration Ideas]]
`,
  'Scratchpad.md': `---
title: Scratchpad
tags: [scratch]
---

# Scratchpad

Unsorted thoughts. Nothing links here on purpose — a good orphan-detector test.

- what if the orb pulsed with the heartbeat interval?
- grocery: oat milk, beans
- remember to archive this someday #scratch

Example links that must NOT count (inside a code fence):

\`\`\`
[[Fake Note That Does Not Exist]]
#faketag
\`\`\`

And an inline one: \`[[Also Fake]]\`
`,
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function discoverVaults(): Promise<{
  found: { path: string; noteCount: number }[]
  demoAvailable: boolean
}> {
  const s = store()
  if (s.discovery && Date.now() - s.discovery.at < DISCOVER_TTL_MS) {
    return { found: s.discovery.found, demoAvailable: s.discovery.demoAvailable }
  }
  const found = new Map<string, { path: string; noteCount: number }>()
  const budget = { dirs: 700 }
  try {
    const home = process.env.HOME ?? ''
    const roots = [
      home,
      home ? path.join(home, 'Documents') : '',
      home ? path.join(home, 'Obsidian') : '',
      home ? path.join(home, 'vaults') : '',
      home ? path.join(home, '.vaults') : '',
      VAULTS_DIR,
    ].filter((r): r is string => r !== '')
    for (const root of roots) {
      await findVaultsUnder(root, 2, found, budget)
    }
  } catch {
    // discovery never throws
  }
  let demoAvailable = false
  try {
    await fs.mkdir(VAULTS_DIR, { recursive: true })
    demoAvailable = true
  } catch {
    try {
      const st = await fs.stat(DEMO_DIR)
      demoAvailable = st.isDirectory()
    } catch {
      demoAvailable = false
    }
  }
  const list = [...found.values()].sort((a, b) => a.path.localeCompare(b.path))
  s.discovery = { at: Date.now(), found: list, demoAvailable }
  return { found: list, demoAvailable }
}

async function findVaultsUnder(
  root: string,
  maxDepth: number,
  out: Map<string, { path: string; noteCount: number }>,
  budget: { dirs: number }
): Promise<void> {
  const queue: { dir: string; depth: number }[] = [{ dir: root, depth: 0 }]
  while (queue.length > 0 && budget.dirs > 0) {
    const { dir, depth } = queue.shift()!
    budget.dirs--
    let entries: import('node:fs').Dirent[]
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    if (entries.length > MAX_READDIR) entries = entries.slice(0, MAX_READDIR)
    const hasObsidian = entries.some((e) => e.name === '.obsidian' && e.isDirectory())
    if (hasObsidian) {
      const resolved = path.resolve(dir)
      if (!out.has(resolved)) out.set(resolved, { path: resolved, noteCount: await countMarkdown(resolved) })
      continue // do not descend into a vault looking for nested vaults
    }
    if (depth >= maxDepth) continue
    for (const e of entries) {
      if (!e.isDirectory()) continue
      if (e.name.startsWith('.') || SKIP_DIR_NAMES.has(e.name)) continue
      if (budget.dirs - queue.length <= 0) break
      queue.push({ dir: path.join(dir, e.name), depth: depth + 1 })
    }
  }
}

async function countMarkdown(dir: string): Promise<number> {
  const budget = { dirs: 250, files: 2500 }
  let count = 0
  const queue = [dir]
  while (queue.length > 0 && budget.dirs > 0 && budget.files > 0) {
    const d = queue.shift()!
    budget.dirs--
    let entries: import('node:fs').Dirent[]
    try {
      entries = await fs.readdir(d, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue
      if (e.isDirectory()) {
        if (budget.dirs > 0) queue.push(path.join(d, e.name))
      } else if (e.isFile() && /\.md$/i.test(e.name)) {
        count++
        budget.files--
        if (budget.files <= 0) break
      }
    }
  }
  return count
}

export async function setVaultPath(_path: string | 'demo' | null): Promise<VaultStatus> {
  const s = store()
  try {
    if (_path === null) {
      s.currentVault = null
      invalidateScan()
      await writeConfig(null)
      await logAutonomyEvent('vault_event', 'Vault disconnected')
      return disconnectedStatus()
    }
    if (typeof _path !== 'string' || _path.trim() === '') return disconnectedStatus()
    let target: string
    if (_path.trim().toLowerCase() === 'demo') {
      target = await ensureDemoVault()
    } else {
      target = path.resolve(_path.trim())
      try {
        const st = await fs.stat(target)
        if (!st.isDirectory()) return disconnectedStatus()
      } catch {
        return disconnectedStatus()
      }
      if (!(await isVaultDir(target))) {
        // chosen dir exists but is not yet a vault → make it one
        try {
          await fs.mkdir(path.join(target, '.obsidian'), { recursive: true })
        } catch {
          return disconnectedStatus()
        }
      }
    }
    if (!(await isVaultDir(target))) return disconnectedStatus()
    s.currentVault = target
    invalidateScan()
    await writeConfig(target)
    await logAutonomyEvent('vault_event', `Vault connected: ${path.basename(target)}`, {
      vaultPath: target,
      demo: isDemoPath(target),
    })
    return await getVaultStatus()
  } catch {
    return disconnectedStatus()
  }
}

export async function getVaultStatus(): Promise<VaultStatus> {
  try {
    const vault = await resolveVaultPath()
    if (!vault) return disconnectedStatus()
    const scan = await getScan(vault)
    if (!scan) return disconnectedStatus()
    const tagSet = new Set<string>()
    for (const note of scan.notes) for (const t of note.tags) tagSet.add(t.toLowerCase())
    const { edges, orphanCount } = computeEdges(scan)
    let folderCount = 0
    for (const f of scan.folders) if (f !== '') folderCount++
    return {
      connected: true,
      vaultPath: vault,
      noteCount: scan.notes.length,
      folderCount,
      tagCount: tagSet.size,
      linkCount: edges.length,
      orphanCount,
      lastScanAt: new Date(scan.at).toISOString(),
      demo: isDemoPath(vault),
    }
  } catch {
    return disconnectedStatus()
  }
}

export async function listNotes(_folder?: string): Promise<VaultNoteMeta[]> {
  try {
    const scan = await getScan()
    if (!scan) return []
    let filter: string | null = null
    if (typeof _folder === 'string' && _folder.trim() !== '' && _folder.trim() !== '.') {
      const jailed = jailRelative(scan.vaultPath, _folder)
      if (!jailed) return []
      filter = jailed.toLowerCase()
    }
    const out: VaultNoteMeta[] = []
    for (const note of scan.notes) {
      if (filter && !note.path.toLowerCase().startsWith(filter + '/')) continue
      out.push({
        path: note.path,
        title: note.title,
        mtime: note.mtime,
        size: note.size,
        tags: note.tags,
        links: note.outgoing.length,
      })
    }
    return out.sort((a, b) => a.path.localeCompare(b.path))
  } catch {
    return []
  }
}

function lookupNote(scan: VaultScan, rel: string): ParsedNote | null {
  const jailed = jailRelative(scan.vaultPath, rel)
  if (jailed === null) return null
  if (!jailed) return null
  const note = scan.byLower.get(lowerKey(jailed)) ?? scan.byPath.get(jailed)
  return note ?? null
}

export async function readNote(_path: string): Promise<
  { ok: true; note: VaultNote } | { ok: false; error: string }
> {
  try {
    const scan = await getScan()
    if (!scan) return { ok: false, error: 'no vault connected' }
    const jailed = jailRelative(scan.vaultPath, _path ?? '')
    if (jailed === null) return { ok: false, error: 'invalid path: note paths must stay inside the vault' }
    const note = lookupNote(scan, _path)
    if (!note) return { ok: false, error: `note not found: ${jailed}` }
    const backlinks: string[] = []
    for (const other of scan.notes) {
      if (other === note) continue
      if (other.outgoing.includes(note.path)) backlinks.push(other.path)
    }
    backlinks.sort()
    return {
      ok: true,
      note: {
        path: note.path,
        title: note.title,
        mtime: note.mtime,
        size: note.size,
        tags: note.tags,
        links: note.outgoing.length,
        frontmatter: note.fm,
        content: note.content,
        outgoingLinks: note.outgoing,
        backlinks,
      },
    }
  } catch (err) {
    return { ok: false, error: errMsg(err, 'failed to read note') }
  }
}

export async function createNote(
  _path: string,
  _content: string,
  _opts?: { overwrite?: boolean }
): Promise<{ ok: boolean; path?: string; error?: string }> {
  try {
    const vault = await resolveVaultPath()
    if (!vault) return { ok: false, error: 'no vault connected' }
    const jailed = jailRelative(vault, _path ?? '')
    if (!jailed) return { ok: false, error: 'invalid path: note paths must stay inside the vault' }
    let rel = jailed
    if (!/\.[A-Za-z0-9]+$/.test(rel)) rel = rel + '.md' // force a note extension
    // case-insensitive existence check (prevent duplicate notes differing only by case)
    const scan = await getScan(vault)
    const existing = scan ? scan.byLower.get(lowerKey(rel)) : undefined
    if (existing && !_opts?.overwrite) {
      return { ok: false, error: `note already exists: ${existing.path} (pass overwrite: true to replace)` }
    }
    const abs = path.resolve(vault, existing ? existing.path : rel)
    const vaultAbs = path.resolve(vault)
    if (abs !== vaultAbs && !abs.startsWith(vaultAbs + path.sep)) {
      return { ok: false, error: 'invalid path: note paths must stay inside the vault' }
    }
    if (!existing) {
      try {
        await fs.access(abs)
        if (!_opts?.overwrite) return { ok: false, error: `note already exists: ${rel} (pass overwrite: true to replace)` }
      } catch {
        // does not exist — good
      }
    }
    await fs.mkdir(path.dirname(abs), { recursive: true })
    await fs.writeFile(abs, _content ?? '', 'utf8')
    invalidateScan()
    return { ok: true, path: existing ? existing.path : rel }
  } catch (err) {
    return { ok: false, error: errMsg(err, 'failed to create note') }
  }
}

export async function updateNote(
  _path: string,
  _content: string,
  _mode?: 'replace' | 'append'
): Promise<{ ok: boolean; path?: string; error?: string }> {
  try {
    const vault = await resolveVaultPath()
    if (!vault) return { ok: false, error: 'no vault connected' }
    const jailed = jailRelative(vault, _path ?? '')
    if (!jailed) return { ok: false, error: 'invalid path: note paths must stay inside the vault' }
    const scan = await getScan(vault)
    const existing = scan ? lookupNote(scan, _path) : null
    const rel = existing ? existing.path : jailed
    const abs = path.resolve(vault, rel)
    const vaultAbs = path.resolve(vault)
    if (abs !== vaultAbs && !abs.startsWith(vaultAbs + path.sep)) {
      return { ok: false, error: 'invalid path: note paths must stay inside the vault' }
    }
    let current: string
    try {
      current = await fs.readFile(abs, 'utf8')
    } catch {
      return { ok: false, error: `note not found: ${rel}` }
    }
    const incoming = _content ?? ''
    let next: string
    if (_mode === 'append') {
      next = current === '' || current.endsWith('\n') ? current + incoming : current + '\n' + incoming
    } else {
      // replace: preserve the original frontmatter block when the incoming
      // content has none of its own (unknown keys + formatting kept verbatim)
      if (splitFrontmatter(incoming).fmRaw !== null) {
        next = incoming
      } else {
        const { fmRaw } = splitFrontmatter(current)
        next = fmRaw !== null ? '---\n' + fmRaw + '---\n' + incoming.replace(/^\n+/, '') : incoming
      }
    }
    await fs.writeFile(abs, next, 'utf8')
    invalidateScan()
    return { ok: true, path: rel }
  } catch (err) {
    return { ok: false, error: errMsg(err, 'failed to update note') }
  }
}

function makeSnippet(text: string, query: string, len = 160): string {
  const collapse = (s: string) => s.replace(/\s+/g, ' ').trim()
  const q = query.trim().toLowerCase()
  if (!q) return collapse(text.slice(0, len))
  const idx = text.toLowerCase().indexOf(q)
  if (idx < 0) return collapse(text.slice(0, len)) + (text.length > len ? '…' : '')
  const start = Math.max(0, idx - 64)
  const raw = (start > 0 ? '…' : '') + text.slice(start, start + len) + (start + len < text.length ? '…' : '')
  return collapse(raw)
}

export async function searchVault(
  _query: string
): Promise<{ path: string; title: string; snippet: string; score: number }[]> {
  try {
    const scan = await getScan()
    if (!scan) return []
    const q = (_query ?? '').trim().toLowerCase().replace(/^#/, '')
    if (!q) return []
    const results: { path: string; title: string; snippet: string; score: number }[] = []
    for (const note of scan.notes) {
      const title = note.title.toLowerCase()
      const pathL = note.path.toLowerCase()
      const fmText = Object.values(note.fm).join(' ').toLowerCase()
      let score = 0
      if (title === q) score += 100
      else if (title.startsWith(q)) score += 70
      else if (title.includes(q)) score += 50
      if (note.tags.some((t) => t.toLowerCase() === q)) score += 40
      if (pathL.includes(q)) score += 15
      const body = (note.cleanText + '\n' + fmText).toLowerCase()
      let idx = body.indexOf(q)
      let hits = 0
      while (idx >= 0 && hits < 10) {
        hits++
        idx = body.indexOf(q, idx + q.length)
      }
      score += hits * 8
      if (score <= 0) continue
      results.push({ path: note.path, title: note.title, snippet: makeSnippet(note.cleanText, q), score })
    }
    results.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    return results.slice(0, 50)
  } catch {
    return []
  }
}

export async function getTags(): Promise<{ tag: string; count: number; notes: string[] }[]> {
  try {
    const scan = await getScan()
    if (!scan) return []
    const map = new Map<string, { tag: string; count: number; notes: string[] }>()
    for (const note of scan.notes) {
      for (const t of note.tags) {
        const key = t.toLowerCase()
        let cur = map.get(key)
        if (!cur) {
          cur = { tag: t, count: 0, notes: [] }
          map.set(key, cur)
        }
        cur.count++
        cur.notes.push(note.path)
      }
    }
    return [...map.values()]
      .map((v) => ({ tag: v.tag, count: v.count, notes: v.notes.sort() }))
      .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag))
  } catch {
    return []
  }
}

export async function getGraph(): Promise<{
  nodes: { id: string; title: string; degree: number }[]
  edges: { source: string; target: string }[]
  orphans: string[]
  hubs: string[]
}> {
  try {
    const scan = await getScan()
    if (!scan) return { nodes: [], edges: [], orphans: [], hubs: [] }
    const { edges, degree } = computeEdges(scan)
    const nodes = scan.notes
      .map((n) => ({ id: n.path, title: n.title, degree: degree.get(n.path) ?? 0 }))
      .sort((a, b) => b.degree - a.degree || a.id.localeCompare(b.id))
    const orphans = nodes.filter((n) => n.degree === 0).map((n) => n.id)
    const hubs = nodes.filter((n) => n.degree > 0).slice(0, 5).map((n) => n.id)
    return { nodes, edges, orphans, hubs }
  } catch {
    return { nodes: [], edges: [], orphans: [], hubs: [] }
  }
}

export async function getBacklinks(
  _path: string
): Promise<{ from: string; snippet: string }[]> {
  try {
    const scan = await getScan()
    if (!scan) return []
    const jailed = jailRelative(scan.vaultPath, _path ?? '')
    if (jailed === null) return []
    const target = lookupNote(scan, _path)
    if (!target) return []
    const out: { from: string; snippet: string }[] = []
    for (const note of scan.notes) {
      if (note === target) continue
      if (note.outgoing.includes(target.path)) {
        const line = note.linkLines.get(target.path) ?? ''
        out.push({ from: note.path, snippet: line.slice(0, 200) })
      }
    }
    return out.sort((a, b) => a.from.localeCompare(b.from))
  } catch {
    return []
  }
}

function findDailyFolder(scan: VaultScan): string | null {
  for (const dir of scan.allDirs) {
    if (DAILY_FOLDER_NAMES.has(dir.toLowerCase())) return dir
  }
  return null
}

function findDailyTemplate(scan: VaultScan): ParsedNote | null {
  return scan.byLower.get('templates/daily') ?? scan.byLower.get('templates/daily note') ?? null
}

function applyTemplate(tpl: string, date: string): string {
  return tpl
    .replace(/\{\{\s*date\s*\}\}/gi, date)
    .replace(/\{\{\s*title\s*\}\}/gi, date)
    .replace(/\{\{\s*time\s*\}\}/gi, timeInLagos())
}

function defaultDailyTemplate(date: string): string {
  return `---
date: ${date}
type: daily
tags: [daily]
---

# ${date}

## Tasks

- [ ] 

## Notes

- 

## Journal

- 
`
}

export async function dailyNote(
  _date?: string
): Promise<{ ok: boolean; path?: string; content?: string; created?: boolean; error?: string }> {
  try {
    const vault = await resolveVaultPath()
    if (!vault) return { ok: false, error: 'no vault connected' }
    const date = typeof _date === 'string' && _date.trim() !== '' ? _date.trim() : todayInLagos()
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return { ok: false, error: `invalid date: ${date} (expected YYYY-MM-DD)` }
    }
    const scan = await getScan(vault)
    let folder = scan ? findDailyFolder(scan) : null
    if (folder === null) {
      if (isDemoPath(vault)) {
        // demo vault: create the Daily Notes folder on demand
        folder = 'Daily Notes'
        await fs.mkdir(path.join(vault, folder), { recursive: true }).catch(() => {})
      } else {
        folder = '' // vault root
      }
    }
    const rel = folder ? `${folder}/${date}.md` : `${date}.md`
    const abs = path.resolve(vault, rel)
    const vaultAbs = path.resolve(vault)
    if (abs !== vaultAbs && !abs.startsWith(vaultAbs + path.sep)) {
      return { ok: false, error: 'invalid path' }
    }
    try {
      const existing = await fs.readFile(abs, 'utf8')
      return { ok: true, path: rel, content: existing, created: false }
    } catch {
      // create below
    }
    let content: string
    const tpl = scan ? findDailyTemplate(scan) : null
    if (tpl) {
      content = applyTemplate(tpl.content, date)
    } else {
      content = defaultDailyTemplate(date)
    }
    await fs.mkdir(path.dirname(abs), { recursive: true })
    await fs.writeFile(abs, content, 'utf8')
    invalidateScan()
    await logAutonomyEvent('vault_event', `Daily note created: ${date}`, { path: rel, vaultPath: vault })
    return { ok: true, path: rel, content, created: true }
  } catch (err) {
    return { ok: false, error: errMsg(err, 'failed to create daily note') }
  }
}

// ---------------------------------------------------------------------------
// Dataview-lite query engine
// ---------------------------------------------------------------------------

type QuerySource = { kind: 'tag' | 'folder' | 'link'; value: string } | null

function parseSource(s: string): QuerySource {
  const t = s.trim()
  if (!t) return null
  if (t.startsWith('#')) {
    const v = t.slice(1).trim()
    return v ? { kind: 'tag', value: v } : null
  }
  const quoted = t.match(/^"(.*)"$/)
  if (quoted) return { kind: 'folder', value: quoted[1].replace(/\/+$/, '') }
  const wikilink = t.match(/^\[\[(.+)\]\]$/)
  if (wikilink) return { kind: 'link', value: wikilink[1].split('#')[0].trim() }
  return { kind: 'folder', value: t.replace(/\/+$/, '') }
}

function sourceDesc(source: QuerySource): string {
  if (!source) return 'across the vault'
  if (source.kind === 'tag') return `tagged #${source.value}`
  if (source.kind === 'folder') return `in folder "${source.value}"`
  return `linking to [[${source.value}]]`
}

function filterNotes(scan: VaultScan, source: QuerySource): ParsedNote[] {
  if (!source) return scan.notes
  if (source.kind === 'tag') {
    const tag = source.value.toLowerCase()
    return scan.notes.filter((n) => n.tags.some((t) => t.toLowerCase() === tag))
  }
  if (source.kind === 'folder') {
    const parts = source.value.split('/').filter((p) => p !== '' && p !== '.')
    if (parts.some((p) => p === '..')) return []
    const prefix = parts.join('/').toLowerCase()
    if (!prefix) return scan.notes
    return scan.notes.filter((n) => n.path.toLowerCase().startsWith(prefix + '/'))
  }
  // link source: notes that link TO the resolved note
  const target = resolveLink(source.value, '', false, scan)
  if (!target) return []
  return scan.notes.filter((n) => n !== scan.byPath.get(target) && n.outgoing.includes(target))
}

export async function vaultQuery(
  _q: string
): Promise<{ kind: string; rows: Record<string, string>[]; explanation: string }> {
  const unsupported = (why: string) => ({
    kind: 'unsupported',
    rows: [] as Record<string, string>[],
    explanation: why,
  })
  try {
    const raw = typeof _q === 'string' ? _q.trim().replace(/\s+/g, ' ') : ''
    if (!raw) {
      return unsupported('Unrecognized query. Supported: LIST FROM #tag · LIST FROM "folder" · TABLE prop, prop FROM source · TASK [FROM source]')
    }
    const scan = await getScan()
    if (!scan) return unsupported('no vault connected')

    // TASK [FROM source]
    let m = raw.match(/^TASK(?:\s+FROM\s+(.+))?$/i)
    if (m) {
      const source = m[1] ? parseSource(m[1]) : null
      const notes = filterNotes(scan, source)
      const rows: Record<string, string>[] = []
      for (const note of notes) {
        for (const line of note.cleanLines) {
          const tm = line.match(TASK_RE)
          if (tm && tm[1] === ' ') {
            rows.push({ path: note.path, note: note.title, task: (tm[2] ?? '').trim() })
          }
        }
      }
      return { kind: 'task', rows, explanation: `${rows.length} open task(s) ${sourceDesc(source)}` }
    }

    // LIST [FROM source]
    m = raw.match(/^LIST(?:\s+FROM\s+(.+))?$/i)
    if (m) {
      const source = m[1] ? parseSource(m[1]) : null
      const notes = filterNotes(scan, source)
      const rows = notes
        .slice()
        .sort((a, b) => a.path.localeCompare(b.path))
        .map((n) => ({ path: n.path, title: n.title }))
      return { kind: 'list', rows, explanation: `Listing ${rows.length} note(s) ${sourceDesc(source)}` }
    }

    // TABLE prop, prop, … FROM source
    m = raw.match(/^TABLE\s+(.+?)\s+FROM\s+(.+)$/i)
    if (m) {
      const props = m[1]
        .split(',')
        .map((p) => p.trim())
        .filter((p) => /^[A-Za-z0-9_.\-]+$/.test(p))
        .slice(0, 8)
      if (props.length === 0) {
        return unsupported('TABLE requires at least one frontmatter property, e.g. TABLE status, priority FROM "AI Research"')
      }
      const source = parseSource(m[2])
      const notes = filterNotes(scan, source)
      const rows = notes
        .slice()
        .sort((a, b) => a.path.localeCompare(b.path))
        .map((n) => {
          const row: Record<string, string> = { path: n.path, title: n.title }
          for (const p of props) row[p] = n.fm[p] ?? '—'
          return row
        })
      return { kind: 'table', rows, explanation: `Showing ${props.join(', ')} for ${rows.length} note(s) ${sourceDesc(source)}` }
    }

    return unsupported(
      `Unrecognized query "${raw}". Supported: LIST FROM #tag · LIST FROM "folder" · TABLE prop, prop FROM source · TASK [FROM source]`
    )
  } catch (err) {
    return unsupported(`query failed: ${errMsg(err, 'unknown error')}`)
  }
}

// ---------------------------------------------------------------------------
// Demo vault provisioning (idempotent)
// ---------------------------------------------------------------------------

export async function ensureDemoVault(): Promise<string> {
  try {
    const marker = path.join(DEMO_DIR, 'Projects MOC.md')
    let existedBefore = false
    try {
      await fs.access(marker)
      existedBefore = true
    } catch {
      existedBefore = false
    }
    await fs.mkdir(path.join(DEMO_DIR, '.obsidian'), { recursive: true })
    await writeIfMissing(
      path.join(DEMO_DIR, '.obsidian', 'app.json'),
      JSON.stringify(
        {
          alwaysUpdateLinks: true,
          newFileFolderPath: 'Daily Notes',
          attachmentFolderPath: './attachments',
          showUnsupportedFiles: false,
          useMarkdownLinks: false,
        },
        null,
        2
      ) + '\n'
    )
    await writeIfMissing(
      path.join(DEMO_DIR, '.obsidian', 'appearance.json'),
      JSON.stringify({ baseFontSize: 16, theme: 'moonstone', cssTheme: '', enabledCssSnippets: [] }, null, 2) + '\n'
    )
    let createdCount = 0
    for (const [rel, content] of Object.entries(DEMO_NOTES)) {
      const abs = path.join(DEMO_DIR, rel)
      if (await writeIfMissing(abs, content)) createdCount++
    }
    if (!existedBefore || createdCount > 0) {
      invalidateScan()
      await logAutonomyEvent('vault_event', 'Demo vault provisioned', {
        path: DEMO_DIR,
        notesCreated: createdCount,
        totalNotes: Object.keys(DEMO_NOTES).length,
      })
    }
    return DEMO_DIR
  } catch {
    return DEMO_DIR
  }
}
