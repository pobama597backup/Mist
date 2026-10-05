// M.I.S.T. watchlist — the anti-rust system.
//
// MIST watches upstream projects it borrows ideas from (seeded with
// openclaw/openclaw + anthropics/skills) so it never "builds on rusty stuff".
//   • openclaw/openclaw → npm registry channel (CalVer releases) — a version
//     change also refreshes the evolution engine's OpenClaw digest.
//   • anthropics/skills → GitHub commits Atom feed (no API rate limits, no
//     tags on that repo — the latest commit sha + title is the version).
// Sweeps run every 6h (MIST_WATCHLIST_INTERVAL_H) + on demand via the
// check_updates chat tool or POST /api/mist/watchlist.
// FIRST SIGHTING IS SILENT: it only establishes the baseline — no alert spam.
// A real version change raises a 📦 Alert that the heartbeat delivers into
// the chat: "openclaw released X — want me to review the changelog and
// propose improvements to adopt?"
//
// State lives in db/watchlist.json (human-readable, git-friendly).

import fs from 'node:fs/promises'
import path from 'node:path'
import type { WatchlistEntry, WatchlistStatus } from '@/lib/types'
import { recordActivity } from './activity-service'

const WATCHLIST_FILE = path.join(process.cwd(), 'db', 'watchlist.json')
const DEFAULT_SWEEP_INTERVAL_H = 6
const MIN_SWEEP_GAP_MS = 10 * 60 * 1000 // rate-limit friendly: manual pings reuse the recent sweep

type Channel = WatchlistEntry['channel']

interface WatchlistState {
  entries: WatchlistEntry[]
  last_sweep_at: string | null
  alerts_raised: number
}

const SEED: Array<{ repo: string; channel: Channel; label: string; note: string }> = [
  {
    repo: 'openclaw/openclaw',
    channel: 'npm',
    label: 'OpenClaw',
    note: 'sovereign assistant — MIST borrows its patterns; releases feed the evolution engine',
  },
  {
    repo: 'anthropics/skills',
    channel: 'atom',
    label: 'Anthropic Skills',
    note: 'OpenClaw/Anthropic-style SKILL.md ecosystem — imported natively by the skills service',
  },
]

function emptyEntry(seed: (typeof SEED)[number]): WatchlistEntry {
  return {
    repo: seed.repo,
    channel: seed.channel,
    label: seed.label,
    version: null,
    version_label: null,
    updated_at: null,
    first_seen: true,
    checked_at: null,
    changed: false,
    last_change_at: null,
    error: null,
    note: seed.note,
  }
}

function emptyState(): WatchlistState {
  return { entries: SEED.map(emptyEntry), last_sweep_at: null, alerts_raised: 0 }
}

// ---------- persistence ----------

async function readState(): Promise<WatchlistState> {
  try {
    const raw = await fs.readFile(WATCHLIST_FILE, 'utf-8')
    const parsed = JSON.parse(raw) as WatchlistState
    if (!Array.isArray(parsed.entries)) return emptyState()
    // re-seed any entries missing from an older file (additive evolution)
    const repos = new Set(parsed.entries.map((e) => e.repo))
    const entries = [...parsed.entries]
    for (const seed of SEED) {
      if (!repos.has(seed.repo)) entries.push(emptyEntry(seed))
    }
    return { entries, last_sweep_at: parsed.last_sweep_at ?? null, alerts_raised: parsed.alerts_raised ?? 0 }
  } catch {
    return emptyState()
  }
}

async function writeState(state: WatchlistState): Promise<void> {
  await fs.mkdir(path.dirname(WATCHLIST_FILE), { recursive: true })
  await fs.writeFile(WATCHLIST_FILE, JSON.stringify(state, null, 2), 'utf-8')
}

export function watchlistIntervalHours(): number {
  const raw = Number(process.env.MIST_WATCHLIST_INTERVAL_H ?? '')
  return Number.isFinite(raw) && raw >= 1 ? raw : DEFAULT_SWEEP_INTERVAL_H
}

export function watchlistAutoUpdate(): boolean {
  return (process.env.MIST_OPENCLAW_AUTO_UPDATE ?? '').trim().toLowerCase() !== 'off'
}

// ---------- upstream checkers (never throw — errors are recorded per entry) ----------

async function fetchText(url: string, timeoutMs = 20_000): Promise<string | null> {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  try {
    const res = await fetch(url, { signal: ac.signal, cache: 'no-store', headers: { 'User-Agent': 'mist-watchlist' } })
    if (!res.ok) return null
    return await res.text()
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

interface UpstreamVersion {
  version: string
  label: string
  updated_at: string | null
}

async function checkNpm(repo: string): Promise<UpstreamVersion | null> {
  const pkg = repo.split('/')[1]
  if (!pkg) return null
  const raw = await fetchText(`https://registry.npmjs.org/${pkg}/latest`)
  if (!raw) return null
  try {
    const manifest = JSON.parse(raw) as { version?: unknown }
    if (typeof manifest.version === 'string' && manifest.version.trim()) {
      return { version: manifest.version.trim(), label: `v${manifest.version.trim()}`, updated_at: null }
    }
  } catch {
    // fall through
  }
  return null
}

async function checkAtom(repo: string): Promise<UpstreamVersion | null> {
  const raw = await fetchText(`https://github.com/${repo}/commits/main.atom`)
  if (!raw) return null
  // first <entry> = latest commit on main
  const sha = /Grit::Commit\/([0-9a-f]{7,40})/.exec(raw)?.[1] ?? null
  const title =
    /<entry>[\s\S]*?<title>\s*([\s\S]*?)\s*<\/title>/.exec(raw)?.[1]?.replace(/\s+/g, ' ').trim() ?? null
  const updated = /<entry>[\s\S]*?<updated>\s*([\s\S]*?)\s*<\/updated>/.exec(raw)?.[1] ?? null
  if (!sha) return null
  return {
    version: sha.slice(0, 12),
    label: title ? `${sha.slice(0, 7)} — ${title.slice(0, 90)}` : sha.slice(0, 7),
    updated_at: updated ?? null,
  }
}

async function checkUpstream(entry: WatchlistEntry): Promise<UpstreamVersion | null> {
  return entry.channel === 'npm' ? checkNpm(entry.repo) : checkAtom(entry.repo)
}

// ---------- sweep ----------

export interface SweepResult {
  ok: boolean
  changed: WatchlistEntry[]
  checked: number
  message: string
}

/**
 * Sweep every watchlist entry. Called by the 6h heartbeat schedule and on
 * demand (check_updates tool / POST /watchlist). A version change:
 *   1. records the new baseline,
 *   2. raises a 📦 Alert (delivered into chat by the client poller),
 *   3. for openclaw, also triggers the digest sync the evolution engine reads.
 */
export async function sweepWatchlist(force = false): Promise<SweepResult> {
  const state = await readState()
  const now = Date.now()
  if (
    !force &&
    state.last_sweep_at &&
    now - new Date(state.last_sweep_at).getTime() < MIN_SWEEP_GAP_MS
  ) {
    return {
      ok: true,
      changed: [],
      checked: state.entries.length,
      message: `swept recently — next scheduled sweep in ~${Math.max(
        0,
        Math.ceil((new Date(state.last_sweep_at).getTime() + watchlistIntervalHours() * 3600_000 - now) / 60000)
      )} min`,
    }
  }

  // lazily import to avoid a service-cycle (openclaw-service does not import us)
  const { syncOpenClaw } = await import('./openclaw-service')
  const { raiseReleaseAlert } = await import('./heartbeat-service')

  const changed: WatchlistEntry[] = []
  const checkedAt = new Date().toISOString()
  const entries = await Promise.all(
    state.entries.map(async (entry): Promise<WatchlistEntry> => {
      const upstream = await checkUpstream(entry)
      if (!upstream) {
        return { ...entry, checked_at: checkedAt, error: 'upstream unreachable' }
      }
      const prev = entry.version
      const changedNow = prev !== null && prev !== upstream.version
      const next: WatchlistEntry = {
        ...entry,
        version: upstream.version,
        version_label: upstream.label,
        updated_at: upstream.updated_at,
        checked_at: checkedAt,
        error: null,
        first_seen: prev === null,
        changed: changedNow,
        last_change_at: changedNow || prev === null ? checkedAt : entry.last_change_at,
      }
      if (changedNow) {
        changed.push(next)
        recordActivity('watchlist', `${entry.repo} moved ${prev} → ${upstream.version}`)
        await raiseReleaseAlert(
          entry,
          prev,
          upstream.version,
          upstream.label,
          upstream.updated_at
        ).catch(() => undefined)
        if (entry.channel === 'npm') {
          // refresh the evolution engine's digest so ideas track the new release
          await syncOpenClaw(true).catch(() => undefined)
        }
      } else if (prev === null) {
        // first sighting — silent baseline, no alert spam
        recordActivity('watchlist', `baseline established: ${entry.repo} @ ${upstream.version}`)
      }
      return next
    })
  )

  const alertsRaised = state.alerts_raised + changed.length
  await writeState({ entries, last_sweep_at: checkedAt, alerts_raised: alertsRaised })

  return {
    ok: true,
    changed,
    checked: entries.length,
    message:
      changed.length > 0
        ? `${changed.length} release change(s) detected: ${changed.map((c) => `${c.repo} → ${c.version_label ?? c.version}`).join('; ')}`
        : `all ${entries.length} watchlist entries current`,
  }
}

// ---------- status ----------

export async function getWatchlistStatus(): Promise<WatchlistStatus> {
  const state = await readState()
  const last = state.last_sweep_at ? new Date(state.last_sweep_at).getTime() : null
  const next = last ? new Date(last + watchlistIntervalHours() * 3600_000).toISOString() : null
  return {
    entries: state.entries,
    last_sweep_at: state.last_sweep_at,
    next_sweep_at: next,
    sweep_interval_hours: watchlistIntervalHours(),
    auto_update: watchlistAutoUpdate(),
    alerts_raised: state.alerts_raised,
  }
}

/** Add a repo to the watchlist (used by the chat tools / future UI). */
export async function addWatchEntry(
  repo: string,
  channel: Channel = 'atom'
): Promise<{ ok: boolean; message: string }> {
  const state = await readState()
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
    return { ok: false, message: 'repo must look like "owner/name"' }
  }
  if (state.entries.some((e) => e.repo.toLowerCase() === repo.toLowerCase())) {
    return { ok: false, message: `${repo} is already on the watchlist` }
  }
  if (state.entries.length >= 12) {
    return { ok: false, message: 'watchlist is full (12) — remove an entry first' }
  }
  state.entries.push({
    ...emptyEntry({ repo, channel, label: repo, note: 'added at runtime' }),
    channel,
  })
  await writeState(state)
  recordActivity('watchlist', `now watching ${repo} (${channel})`)
  return { ok: true, message: `watching ${repo} (${channel}) — first sweep establishes the baseline silently` }
}

export async function removeWatchEntry(repo: string): Promise<{ ok: boolean; message: string }> {
  const state = await readState()
  const before = state.entries.length
  const entries = state.entries.filter((e) => e.repo.toLowerCase() !== repo.toLowerCase())
  if (entries.length === before) return { ok: false, message: `${repo} is not on the watchlist` }
  await writeState({ ...state, entries })
  recordActivity('watchlist', `stopped watching ${repo}`)
  return { ok: true, message: `removed ${repo} from the watchlist` }
}
