// M.I.S.T. settings service (Phase 4-b · R5) — owner-tunable runtime flags in
// a real Setting row (prisma Setting model), NOT env: the owner flips these
// from the UI while the app runs, and every surface that reports them reads
// the same row. First key: `outbound_watchers` (default FALSE — dormant means
// zero outbound watchers unless the owner opts in, with a visible indicator).
//
// Reads go through a tiny globalThis cache (2s TTL, invalidated on write) so
// the hot paths (watcher ticks, egress helper) never pay a query per call —
// while a flip becomes visible within ~2s everywhere.
import { db } from '@/lib/db'
import { recordActivity } from './activity-service'

export const SETTING_OUTBOUND_WATCHERS = 'outbound_watchers'

const CACHE_TTL_MS = 2_000

interface SettingsCacheEntry {
  at: number
  values: Map<string, string>
}

const g = globalThis as unknown as {
  __mistSettingsCache?: SettingsCacheEntry
}

function cache(): SettingsCacheEntry {
  const c = (g.__mistSettingsCache ??= { at: 0, values: new Map() })
  if (Date.now() - c.at > CACHE_TTL_MS) {
    c.values.clear()
    c.at = Date.now()
  }
  return c
}

/** Read one setting row (null when unset). Cached ~2s. Never throws. */
export async function getSetting(key: string): Promise<string | null> {
  const c = cache()
  if (c.values.has(key)) return c.values.get(key) ?? null
  try {
    const row = await db.setting.findUnique({ where: { key } })
    const value = row?.value ?? null
    // cache the miss too — an unset flag should not become a per-call query
    c.values.set(key, value ?? '')
    return value
  } catch {
    return null
  }
}

/** Write one setting row + invalidate the cache. Never throws (returns ok). */
export async function setSetting(key: string, value: string): Promise<{ ok: boolean }> {
  try {
    await db.setting.upsert({ where: { key }, update: { value }, create: { key, value } })
    cache().values.set(key, value)
    recordActivity('settings', `setting ${key} = ${value}`)
    return { ok: true }
  } catch {
    return { ok: false }
  }
}

/**
 * The outbound-watchers flag (R5). DEFAULT FALSE: dormant = 0 outbound —
 * the npmjs/github watchlist sweeps, the oj-sync + Mark-LV git watchers, the
 * OpenClaw digest sync and the auto evolution-suggest loop all idle (no
 * network egress) until the owner opts in. The welcome/heartbeat LLM lanes
 * are NOT affected — they are local lanes through the app, not watchers.
 */
export async function outboundWatchersEnabled(): Promise<boolean> {
  const raw = await getSetting(SETTING_OUTBOUND_WATCHERS)
  return raw === 'true' || raw === '1' || raw === 'on'
}

/** Flip the flag (owner UI / API). Returns the resulting state. */
export async function setOutboundWatchers(enabled: boolean): Promise<boolean> {
  const res = await setSetting(SETTING_OUTBOUND_WATCHERS, enabled ? 'true' : 'false')
  if (!res.ok) return outboundWatchersEnabled()
  recordActivity(
    'settings',
    enabled
      ? 'outbound watchers ENABLED — watchlist/oj-sync/mark-lv/openclaw/evolution-suggest may leave the machine'
      : 'outbound watchers DISABLED — dormant: zero outbound (watchers paused)'
  )
  return enabled
}
