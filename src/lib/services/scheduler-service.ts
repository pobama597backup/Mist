// v5 SCHEDULER — Hermes-style scheduled automations, natural language in/out.
//
// ARCHITECTURE (implemented):
// - ensureSchedulerWatch(): globalThis-guarded 30s interval loop (unref'd),
//   bootstrapped from /api/mist/health (and /api/mist/cron). On first init it
//   SEEDS the default jobs (origin 'auto', enabled) exactly once if the
//   CronJob table is empty (guarded with a count query):
//   1. "Morning briefing" — cron 0 8 * * * (Africa/Lagos)
//   2. "Nightly self-review" — cron 0 22 * * * (Africa/Lagos)
// - Due jobs (enabled && nextRunAt <= now, not in-flight) run through
//   llm-service's unified() (mode 'chat', fresh history) with a 240s race
//   guard per job. Concurrent runs of the same job are prevented via an
//   in-flight Set on globalThis.
// - Result delivery: an Alert row (kind 'system', status 'pending',
//   title = job name, body = trimmed result ≤ 4000 chars) via the exact
//   heartbeat raiseSystemAlert pattern, so the existing alerts pipeline
//   lands it in the alerts thread + toasts; plus logAutonomyEvent('cron_run').
//   delivery 'silent' skips the Alert but still logs.
// - After a run: lastRunAt/nextRunAt/lastStatus/lastResult/runCount updated;
//   one_time jobs are disabled after firing.
// - Cron expression parser: correct 5-field parser (minute hour day-of-month
//   month day-of-week; supports * , - / and names mon-sun/jan-dec) with a
//   timezone-aware nextRunAt computer built on Intl APIs.
// - parseNaturalSchedule(): NO external deps; regex coverage for the common
//   Hermes-style phrases (see the matcher list below). Times interpreted in
//   the given timezone (default Africa/Lagos).
// - Never throws from the watch loop; every DB/LLM call wrapped.

import { db as sharedDb } from '@/lib/db'
import { unified } from './llm-service'
import { logAutonomyEvent } from './autonomy-service'
import { raiseSystemAlert } from './heartbeat-service'
import { recordActivity } from './activity-service'

const DEFAULT_TZ = 'Africa/Lagos'
const WATCH_INTERVAL_S = 30
const SCHEDULER_VERSION = 8 // bump to force an HMR takeover of the watch loop
const JOB_TIMEOUT_MS = 240_000 // 4 minutes per scheduled run
const MAX_RESULT_CHARS = 4000
const MAX_NAME_CHARS = 120
const MAX_PROMPT_CHARS = 4000

// ---------------------------------------------------------------------------
// dev-mode self-heal: the globalThis-cached PrismaClient singleton can
// predate the v5 schema push (CronJob/AutonomyEvent models) when the dev
// server has been running across a `db:push`, and the bundler keeps serving
// its cached (pre-v5) copy of @prisma/client to freshly compiled routes.
// Detect a client lacking the cronJob model and load the CURRENT generated
// client straight from disk via a runtime require (bypasses the bundler
// cache), then self-heal the shared singleton. No-op in a healthy process.
// ---------------------------------------------------------------------------
import { createRequire } from 'node:module'

function hasCronJob(client: unknown): boolean {
  return typeof (client as { cronJob?: unknown } | null)?.cronJob === 'object'
}

function schedulerDb(): typeof sharedDb {
  if (hasCronJob(sharedDb)) return sharedDb
  const g = globalThis as unknown as {
    __mistSchedulerPrisma?: typeof sharedDb
    prisma?: typeof sharedDb
  }
  if (g.__mistSchedulerPrisma && hasCronJob(g.__mistSchedulerPrisma)) {
    return g.__mistSchedulerPrisma
  }
  try {
    // runtime require of the generated client — NOT bundled, and loaded with a
    // cache-bust so a pre-regeneration copy sitting in Node's require cache
    // (from before the v5 db:push) is replaced by the current on-disk client
    const runtimeRequire = createRequire(`${process.cwd()}/package.json`)
    const resolved = runtimeRequire.resolve('.prisma/client')
    if (runtimeRequire.cache?.[resolved]) delete runtimeRequire.cache[resolved]
    const mod = runtimeRequire(resolved) as {
      PrismaClient?: new (opts?: { log?: string[] }) => unknown
    }
    const Ctor = mod?.PrismaClient
    if (typeof Ctor === 'function') {
      const fresh = new Ctor({ log: ['query'] })
      if (hasCronJob(fresh)) {
        g.__mistSchedulerPrisma = fresh as unknown as typeof sharedDb
        // self-heal the shared singleton so future module evaluations
        // (autonomy-service, heartbeat-service, …) pick up the current schema
        g.prisma = fresh as unknown as typeof sharedDb
        recordActivity('scheduler', 'rebuilt the shared PrismaClient (stale dev instance lacked the v5 CronJob model)')
        return g.__mistSchedulerPrisma
      }
    }
  } catch (err) {
    // fall through to the shared client — stash the reason for diagnosis
    ;(globalThis as unknown as { __mistSchedDbError?: string }).__mistSchedDbError =
      err instanceof Error ? `${err.message} (cwd=${process.cwd()})` : String(err)
  }
  return sharedDb
}

export interface CronJobSpec {
  name: string
  prompt: string
  kind: 'cron' | 'fixed_rate' | 'one_time'
  expr?: string // 5-field cron (kind=cron)
  intervalMin?: number // kind=fixed_rate
  runAt?: string // ISO instant (kind=one_time)
  timezone?: string
  delivery?: 'alert' | 'silent'
}

export interface ParsedSchedule {
  ok: boolean
  spec?: CronJobSpec
  explanation?: string
  error?: string
}

// ===========================================================================
// 1) TIMEZONE ENGINE (Intl-based, full ICU — no external deps)
// ===========================================================================

interface WallParts {
  year: number
  month: number // 1-12
  day: number // 1-31
  hour: number // 0-23
  minute: number // 0-59
  second: number // 0-59
  weekday: number // 0=Sunday … 6=Saturday
}

const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const WEEKDAY_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

const dtfCache = new Map<string, Intl.DateTimeFormat>()

function getTzFormatter(timeZone: string): Intl.DateTimeFormat | null {
  let f = dtfCache.get(timeZone)
  if (f) return f
  try {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      weekday: 'short',
    })
  } catch {
    return null
  }
  dtfCache.set(timeZone, f)
  return f
}

function isValidTimeZone(tz: string): boolean {
  return getTzFormatter(tz) !== null
}

/** Wall-clock parts of a UTC instant, as seen in `timeZone`. */
function wallParts(ms: number, timeZone: string): WallParts | null {
  const f = getTzFormatter(timeZone)
  if (!f) return null
  let parts: Intl.DateTimeFormatPart[]
  try {
    parts = f.formatToParts(new Date(ms))
  } catch {
    return null
  }
  const get = (t: string): string => parts.find((p) => p.type === t)?.value ?? ''
  const hourRaw = parseInt(get('hour'), 10)
  return {
    year: parseInt(get('year'), 10),
    month: parseInt(get('month'), 10),
    day: parseInt(get('day'), 10),
    hour: (isNaN(hourRaw) ? 0 : hourRaw) % 24, // guard "24:xx" hourCycle quirks
    minute: parseInt(get('minute'), 10),
    second: parseInt(get('second'), 10),
    weekday: Math.max(0, WEEKDAY_SHORT.indexOf(get('weekday'))),
  }
}

/** Offset (ms) such that utcInstant = wallClock − offset, at the given instant. */
function tzOffsetMs(ms: number, timeZone: string): number | null {
  const p = wallParts(ms, timeZone)
  if (!p) return null
  const trunc = Math.floor(ms / 1000) * 1000
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - trunc
}

/** Convert a wall-clock time in `timeZone` to a UTC instant (DST-tolerant). */
function zonedWallToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string
): number | null {
  const guess = Date.UTC(year, month - 1, day, hour, minute)
  const off1 = tzOffsetMs(guess, timeZone)
  if (off1 === null) return null
  let utc = guess - off1
  const off2 = tzOffsetMs(utc, timeZone)
  if (off2 === null) return null
  if (off2 !== off1) utc = guess - off2 // crossed a DST boundary — re-adjust once
  return utc
}

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

function hhmm(minOfDay: number): string {
  const h = Math.floor(minOfDay / 60) % 24
  const m = minOfDay % 60
  return `${pad2(h)}:${pad2(m)}`
}

/** "2026-08-01 10:00" style rendering of an instant in the given timezone. */
function formatInTz(ms: number, timeZone: string): string {
  const p = wallParts(ms, timeZone)
  if (!p) return new Date(ms).toISOString().replace('T', ' ').slice(0, 16)
  return `${p.year}-${pad2(p.month)}-${pad2(p.day)} ${pad2(p.hour)}:${pad2(p.minute)}`
}

// ===========================================================================
// 2) CRON EXPRESSION PARSER (5 fields: min hour dom month dow)
// ===========================================================================

const MONTH_NAMES: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
}
const DOW_NAMES: Record<string, number> = {
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
}

interface CronParsed {
  minutes: number[]
  hours: number[]
  doms: number[]
  months: number[]
  dows: number[]
  domRestricted: boolean
  dowRestricted: boolean
}

function parseCronValue(token: string, names?: Record<string, number>): number | null {
  if (/^\d+$/.test(token)) return parseInt(token, 10)
  if (names) {
    if (Object.prototype.hasOwnProperty.call(names, token)) return names[token]
    // accept full names too ("monday", "january") via 3-letter prefix
    for (const [nm, v] of Object.entries(names)) {
      if (token.length > 3 && token.startsWith(nm)) return v
    }
  }
  return null
}

function parseCronField(
  field: string,
  min: number,
  max: number,
  names?: Record<string, number>
): number[] | null {
  const values = new Set<number>()
  for (const part of field.split(',')) {
    const piece = part.trim().toLowerCase()
    if (!piece) return null
    let rangePart = piece
    let step = 1
    if (piece.includes('/')) {
      const slash = piece.indexOf('/')
      rangePart = piece.slice(0, slash)
      const stepTok = piece.slice(slash + 1)
      if (!/^\d+$/.test(stepTok)) return null
      step = parseInt(stepTok, 10)
      if (step < 1) return null
    }
    let start: number
    let end: number
    if (rangePart === '*') {
      start = min
      end = max
    } else if (rangePart.includes('-')) {
      const dash = rangePart.indexOf('-')
      const a = parseCronValue(rangePart.slice(0, dash), names)
      const b = parseCronValue(rangePart.slice(dash + 1), names)
      if (a === null || b === null) return null
      start = a
      end = b
    } else {
      const v = parseCronValue(rangePart, names)
      if (v === null) return null
      start = v
      // "5/15" in cron means "5..max step 15" (standard Vixie semantics)
      end = piece.includes('/') ? max : v
    }
    const hardMax = names === DOW_NAMES ? 7 : max // dow accepts 0-7 (7 = Sunday)
    if (start < min || end > hardMax || start > end) return null
    for (let v = start; v <= end; v += step) {
      values.add(v === 7 && names === DOW_NAMES ? 0 : v) // 7 → Sunday(0)
    }
  }
  if (!values.size) return null
  return [...values].sort((a, b) => a - b)
}

export function parseCronExpression(expr: string): CronParsed | null {
  const fields = expr.trim().toLowerCase().split(/\s+/)
  if (fields.length !== 5) return null
  const [fMin, fHour, fDom, fMonth, fDow] = fields
  const minutes = parseCronField(fMin, 0, 59)
  const hours = parseCronField(fHour, 0, 23)
  const doms = parseCronField(fDom, 1, 31)
  const months = parseCronField(fMonth, 1, 12, MONTH_NAMES)
  const dows = parseCronField(fDow, 0, 7, DOW_NAMES)
  if (!minutes || !hours || !doms || !months || !dows) return null
  return {
    minutes,
    hours,
    doms,
    months,
    dows,
    domRestricted: fDom !== '*',
    dowRestricted: fDow !== '*',
  }
}

/**
 * Timezone-aware next-run computation: finds the next wall-clock time (strictly
 * after `fromMs`, default now) that matches the cron expression in `timeZone`,
 * then converts it back to a UTC instant via Intl offset math.
 * (exported for the OpenJarvis oj layer — digest-service + operator-service
 * reuse the exact same cron math; no second parser.)
 */
export function nextCronRunUtc(expr: string, timeZone: string, fromMs?: number): Date | null {
  const parsed = parseCronExpression(expr)
  if (!parsed) return null
  const from = fromMs ?? Date.now()
  const now = wallParts(from, timeZone)
  if (!now) return null

  let y = now.year
  let mo = now.month
  let d = now.day
  let h = now.hour
  let mi = now.minute + 1
  if (mi > 59) {
    mi = 0
    h += 1
  }
  if (h > 23) {
    h = 0
    d += 1
  }

  // scan day-by-day for up to 4 years (covers Feb-29 crons), then hour/minute
  for (let dayStep = 0; dayStep < 1462; dayStep++) {
    // normalize the (possibly overflowed) calendar date via pure UTC arithmetic
    const norm = new Date(Date.UTC(y, mo - 1, d))
    const cy = norm.getUTCFullYear()
    const cm = norm.getUTCMonth() + 1
    const cd = norm.getUTCDate()
    const wd = norm.getUTCDay()

    const monthOk = parsed.months.includes(cm)
    const dayOk =
      monthOk &&
      (parsed.domRestricted && parsed.dowRestricted
        ? parsed.doms.includes(cd) || parsed.dows.includes(wd) // Vixie: EITHER
        : parsed.doms.includes(cd) && parsed.dows.includes(wd))

    if (dayOk) {
      for (const hh of parsed.hours) {
        if (hh < h) continue
        if (hh === h) {
          for (const mm of parsed.minutes) {
            if (mm >= mi) {
              const utc = zonedWallToUtc(cy, cm, cd, hh, mm, timeZone)
              return utc === null ? null : new Date(utc)
            }
          }
          continue // no minute left this hour → try a later hour
        }
        // hh > h → any listed minute works
        const utc = zonedWallToUtc(cy, cm, cd, hh, parsed.minutes[0], timeZone)
        return utc === null ? null : new Date(utc)
      }
    }
    // advance to the next day at 00:00 wall clock
    d = cd + 1
    mo = cm
    y = cy
    h = 0
    mi = 0
  }
  return null // expression never matches (e.g. "0 0 30 2 *")
}

// ===========================================================================
// 3) NATURAL LANGUAGE SCHEDULE PARSER (regex-based, zero deps)
// ===========================================================================

const PERIODS: Record<string, { pmHint: boolean; defaultMin: number; label: string }> = {
  morning: { pmHint: false, defaultMin: 8 * 60, label: 'morning' },
  afternoon: { pmHint: true, defaultMin: 15 * 60, label: 'afternoon' },
  evening: { pmHint: true, defaultMin: 19 * 60, label: 'evening' },
  night: { pmHint: true, defaultMin: 21 * 60, label: 'night' },
}

const DAY_PREFIXES: Array<[string, number]> = [
  ['sunday', 0], ['sun', 0],
  ['monday', 1], ['mon', 1],
  ['tuesday', 2], ['tues', 2], ['tue', 2],
  ['wednesday', 3], ['wed', 3],
  ['thursday', 4], ['thurs', 4], ['thu', 4],
  ['friday', 5], ['fri', 5],
  ['saturday', 6], ['sat', 6],
]

/** Match a weekday name at the start of `s` (longest first, plural + word-boundary safe). */
function matchDayAt(s: string): [number, number] | null {
  for (const [name, num] of DAY_PREFIXES) {
    if (!s.startsWith(name)) continue
    let after = s.slice(name.length)
    if (after.startsWith('s')) after = after.slice(1) // plural form ("mondays")
    if (after === '' || !/[a-z]/.test(after[0])) return [num, s.length - after.length]
  }
  return null
}

/** Extract a comma/slash/"and"-separated list of weekday names. */
function extractDayList(s: string): { days: number[]; rest: string } | null {
  const days: number[] = []
  let rest = s.trim()
  let matched = false
  for (;;) {
    rest = rest.replace(/^[\s,/]+/, '').replace(/^and\s+/, '')
    const m = matchDayAt(rest)
    if (!m) break
    days.push(m[0])
    rest = rest.slice(m[1])
    matched = true
  }
  if (!matched) return null
  return { days: [...new Set(days)].sort((a, b) => a - b), rest: rest.replace(/^[\s,/]+/, '').trim() }
}

/**
 * Parse a time-of-day phrase → minutes past midnight.
 * Accepts: "9", "9:30", "9pm", "9:30 pm", "21:00", "noon", "midnight".
 * Bare 1-12 hours are AM by default, PM when `pmHint` (tonight/evening/night…).
 */
function parseTimeToken(s: string, pmHint: boolean): number | null {
  const t = s.trim().toLowerCase().replace(/\s+/g, ' ')
  if (t === 'noon') return 12 * 60
  if (t === 'midnight') return 0
  const m = t.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/)
  if (!m) return null
  let h = parseInt(m[1], 10)
  const min = m[2] ? parseInt(m[2], 10) : 0
  if (min > 59) return null
  const mer = m[3]
  if (mer === 'am') {
    if (h < 1 || h > 12) return null
    if (h === 12) h = 0
  } else if (mer === 'pm') {
    if (h < 1 || h > 12) return null
    if (h !== 12) h += 12
  } else {
    if (h > 23) return null
    if (h >= 1 && h <= 11 && pmHint) h += 12
  }
  return h * 60 + min
}

/** Build a 5-field cron expression from positional fields (cron order). */
function cronFor(minute: number, hour: number, dom: string, month: string, dow: string): string {
  return `${Math.floor(minute)} ${Math.floor(hour)} ${dom} ${month} ${dow}`
}

/** daily at a given time → "M H * * *" */
function dailyCron(minOfDay: number): string {
  return cronFor(minOfDay % 60, Math.floor(minOfDay / 60), '*', '*', '*')
}

function dayListLabel(days: number[]): string {
  return days.map((d) => WEEKDAY_LONG[d]).join(' and ')
}

function oneTimeSpec(runAtMs: number, timezone: string): ParsedSchedule {
  return {
    ok: true,
    spec: { name: '', prompt: '', kind: 'one_time', runAt: new Date(runAtMs).toISOString(), timezone },
    explanation: `Runs once at ${formatInTz(runAtMs, timezone)} (${timezone})`,
  }
}

/** Add N days to wall-clock (y,mo,d) and return normalized UTC-millis calendar date. */
function addWallDays(y: number, mo: number, d: number, n: number): { y: number; mo: number; d: number } {
  const norm = new Date(Date.UTC(y, mo - 1, d + n))
  return { y: norm.getUTCFullYear(), mo: norm.getUTCMonth() + 1, d: norm.getUTCDate() }
}

export function parseNaturalSchedule(input: string, timezone = DEFAULT_TZ): ParsedSchedule {
  const raw = (input ?? '').toString().trim()
  if (!raw) return { ok: false, error: 'empty schedule' }
  if (!isValidTimeZone(timezone)) {
    return { ok: false, error: `unknown timezone '${timezone}'` }
  }
  const text = raw.toLowerCase().replace(/\s+/g, ' ')
  const now = Date.now()

  // ---- 0) raw 5-field cron expression passthrough ----
  if (/^[\d*a-z,\-\/\s]+$/i.test(raw) && raw.trim().split(/\s+/).length === 5) {
    const parsedCron = parseCronExpression(raw)
    if (parsedCron) {
      const next = nextCronRunUtc(raw, timezone)
      if (next) {
        return {
          ok: true,
          spec: { name: '', prompt: '', kind: 'cron', expr: raw.trim(), timezone },
          explanation: `Runs on the cron schedule '${raw.trim()}' — next at ${formatInTz(next.getTime(), timezone)} (${timezone})`,
        }
      }
      return { ok: false, error: `the cron expression '${raw.trim()}' never matches a real date` }
    }
  }

  // ---- 1) absolute date / ISO timestamp ("at 2026-08-01 10:00", "2026-08-01T10:00:00Z") ----
  const absMatch = text
    .replace(/^(?:at|on)\s+/, '')
    .match(
      /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[t ]+(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.(\d{1,3}))?)?\s*(z|[+-]\d{1,2}:?\d{2})?$/
    )
  if (absMatch) {
    const [, ys, mos, ds, hs, mins, secs, mss, zone] = absMatch
    const y = parseInt(ys, 10)
    const mo = parseInt(mos, 10)
    const d = parseInt(ds, 10)
    const h = hs ? parseInt(hs, 10) : 0
    const mi = mins ? parseInt(mins, 10) : 0
    const s = secs ? parseInt(secs, 10) : 0
    const ms = mss ? parseInt(mss.padEnd(3, '0'), 10) : 0
    if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 59) {
      return { ok: false, error: `'${raw}' is not a valid date/time` }
    }
    if (new Date(Date.UTC(y, mo - 1, d)).getUTCDate() !== d) {
      return { ok: false, error: `'${raw}' is not a valid date (day ${d} doesn't exist in that month)` }
    }
    if (zone) {
      const iso = `${y}-${pad2(mo)}-${pad2(d)}T${pad2(h)}:${pad2(mi)}:${pad2(s)}.${String(ms).padStart(3, '0')}${
        zone === 'z' ? 'Z' : zone.replace(/(\d{2})(\d{2})$/, '$1:$2')
      }`
      const t = new Date(iso).getTime()
      if (isNaN(t)) return { ok: false, error: `'${raw}' is not a valid timestamp` }
      if (t <= now) return { ok: false, error: 'that timestamp is already in the past' }
      return {
        ok: true,
        spec: { name: '', prompt: '', kind: 'one_time', runAt: new Date(t).toISOString(), timezone },
        explanation: `Runs once at ${formatInTz(t, timezone)} (${timezone})`,
      }
    }
    const utc = zonedWallToUtc(y, mo, d, h, mi, timezone)
    if (utc === null) return { ok: false, error: `could not resolve ${raw} in timezone ${timezone}` }
    if (utc + 59_000 <= now) return { ok: false, error: 'that date/time is already in the past' }
    return oneTimeSpec(utc, timezone)
  }

  // ---- 2) relative: "in 45 minutes" / "in 2 hours" / "in 90 seconds" / "in 1 day" ----
  const rel = text.match(/^(?:in|after)\s+(\d+(?:\.\d+)?)\s*(seconds?|secs?|minutes?|mins?|hours?|hrs?|days?)$/)
  if (rel) {
    const n = parseFloat(rel[1])
    const unit = rel[2]
    const mult = /sec/.test(unit) ? 1000 : /min/.test(unit) ? 60_000 : /hr|hour/.test(unit) ? 3_600_000 : 86_400_000
    const runAt = now + n * mult
    if (/sec/.test(unit) && n * mult < 60_000) {
      return { ok: false, error: 'the minimum schedule is 1 minute — try "in 1 minute" or more' }
    }
    const unitLabel = /^1(\.0+)?$/.test(rel[1])
      ? unit.replace(/s$/, '')
      : /sec/.test(unit)
        ? 'seconds'
        : /min/.test(unit)
          ? 'minutes'
          : /hr|hour/.test(unit)
            ? 'hours'
            : 'days'
    return {
      ok: true,
      spec: { name: '', prompt: '', kind: 'one_time', runAt: new Date(runAt).toISOString(), timezone },
      explanation: `Runs once in ${rel[1]} ${unitLabel} (at ${formatInTz(runAt, timezone)}, ${timezone})`,
    }
  }

  // ---- 3) fixed rate: "every N minutes/hours", "every minute", "hourly" ----
  const rate = text.match(/^every\s+(\d+)\s*(minutes?|mins?|hours?|hrs?)$/)
  if (rate) {
    const n = parseInt(rate[1], 10)
    const isHour = /hr|hour/.test(rate[2])
    if (n < 1) return { ok: false, error: 'interval must be at least 1 minute' }
    const intervalMin = isHour ? n * 60 : n
    if (intervalMin > 43200) return { ok: false, error: 'interval is too large (max 30 days)' }
    return {
      ok: true,
      spec: { name: '', prompt: '', kind: 'fixed_rate', intervalMin, timezone },
      explanation: `Runs every ${n} ${isHour ? (n === 1 ? 'hour' : 'hours') : n === 1 ? 'minute' : 'minutes'}`,
    }
  }
  if (/^every\s+minutes?$/.test(text)) {
    return { ok: true, spec: { name: '', prompt: '', kind: 'fixed_rate', intervalMin: 1, timezone }, explanation: 'Runs every minute' }
  }
  if (/^every\s+hours?$/.test(text) || text === 'hourly') {
    return { ok: true, spec: { name: '', prompt: '', kind: 'fixed_rate', intervalMin: 60, timezone }, explanation: 'Runs hourly (every 60 minutes)' }
  }
  if (/^every\s+seconds?$/.test(text)) {
    return { ok: false, error: 'the minimum schedule is 1 minute — try "every 1 minute" or more' }
  }

  // ---- 4) "tonight at 8" / "tonight at 8:30" / "tonight" ----
  const tonight = text.match(/^tonight(?:\s+(?:at\s+)?(.+))?$/)
  if (tonight) {
    const t = tonight[1] ? parseTimeToken(tonight[1], true) : 20 * 60
    if (t === null) return { ok: false, error: `could not read the time in '${raw}' — try "tonight at 8" or "tonight at 8:30pm"` }
    const wp = wallParts(now, timezone)
    if (!wp) return { ok: false, error: `could not resolve timezone ${timezone}` }
    let utc = zonedWallToUtc(wp.year, wp.month, wp.day, Math.floor(t / 60), t % 60, timezone)
    let dayWord = 'tonight'
    if (utc !== null && utc <= now) {
      const tmr = addWallDays(wp.year, wp.month, wp.day, 1)
      utc = zonedWallToUtc(tmr.y, tmr.mo, tmr.d, Math.floor(t / 60), t % 60, timezone)
      dayWord = 'tomorrow night'
    }
    if (utc === null) return { ok: false, error: `could not resolve tonight's date in ${timezone}` }
    return {
      ok: true,
      spec: { name: '', prompt: '', kind: 'one_time', runAt: new Date(utc).toISOString(), timezone },
      explanation: `Runs once ${dayWord} at ${hhmm(t)} (${timezone})`,
    }
  }

  // ---- 5) "tomorrow at 9" / "tomorrow evening at 7" / "tomorrow" ----
  const tomorrow = text.match(/^tomorrow(?:\s+(morning|afternoon|evening|night))?(?:\s+(?:at\s+)?(.+))?$/)
  if (tomorrow) {
    const period = tomorrow[1] ? PERIODS[tomorrow[1]] : null
    const t = tomorrow[2]
      ? parseTimeToken(tomorrow[2], period?.pmHint ?? false)
      : (period?.defaultMin ?? 9 * 60)
    if (t === null) return { ok: false, error: `could not read the time in '${raw}' — try "tomorrow at 9" or "tomorrow at 9:30pm"` }
    const wp = wallParts(now, timezone)
    if (!wp) return { ok: false, error: `could not resolve timezone ${timezone}` }
    const tmr = addWallDays(wp.year, wp.month, wp.day, 1)
    const utc = zonedWallToUtc(tmr.y, tmr.mo, tmr.d, Math.floor(t / 60), t % 60, timezone)
    if (utc === null) return { ok: false, error: `could not resolve tomorrow's date in ${timezone}` }
    return {
      ok: true,
      spec: { name: '', prompt: '', kind: 'one_time', runAt: new Date(utc).toISOString(), timezone },
      explanation: `Runs once tomorrow at ${hhmm(t)} (${timezone})`,
    }
  }

  // ---- 6) "today at 3pm" / "today at 15:00" ----
  const today = text.match(/^today(?:\s+(morning|afternoon|evening|night))?(?:\s+(?:at\s+)?(.+))?$/)
  if (today) {
    const period = today[1] ? PERIODS[today[1]] : null
    const t = today[2]
      ? parseTimeToken(today[2], period?.pmHint ?? false)
      : (period?.defaultMin ?? 9 * 60)
    if (t === null) return { ok: false, error: `could not read the time in '${raw}' — try "today at 3pm"` }
    const wp = wallParts(now, timezone)
    if (!wp) return { ok: false, error: `could not resolve timezone ${timezone}` }
    let utc = zonedWallToUtc(wp.year, wp.month, wp.day, Math.floor(t / 60), t % 60, timezone)
    let dayWord = 'today'
    if (utc !== null && utc <= now) {
      const tmr = addWallDays(wp.year, wp.month, wp.day, 1)
      utc = zonedWallToUtc(tmr.y, tmr.mo, tmr.d, Math.floor(t / 60), t % 60, timezone)
      dayWord = 'tomorrow'
    }
    if (utc === null) return { ok: false, error: `could not resolve today's date in ${timezone}` }
    return {
      ok: true,
      spec: { name: '', prompt: '', kind: 'one_time', runAt: new Date(utc).toISOString(), timezone },
      explanation: `Runs once ${dayWord} at ${hhmm(t)} (${timezone})`,
    }
  }

  // ---- 7) "every N days at 8" / "every other day at 8" ----
  const everyNDays = text.match(/^every\s+(?:(\d+)\s+|other\s+)(?:days?)(?:\s+(?:at\s+)?(.+))?$/)
  if (everyNDays) {
    const n = everyNDays[1] ? parseInt(everyNDays[1], 10) : 2 // "every other day" → 2
    const t = everyNDays[2] ? parseTimeToken(everyNDays[2], false) : 9 * 60
    if (t === null) return { ok: false, error: `could not read the time in '${raw}' — try "every 2 days at 8"` }
    if (n < 2 || n > 30) return { ok: false, error: 'day interval must be between 2 and 30' }
    const expr = cronFor(t % 60, Math.floor(t / 60), `*/${n}`, '*', '*')
    const nLabel = n === 2 ? 'other day' : `${n} days`
    return {
      ok: true,
      spec: { name: '', prompt: '', kind: 'cron', expr, timezone },
      explanation: `Runs every ${nLabel} at ${hhmm(t)} (${timezone})`,
    }
  }

  // ---- 8) daily forms: "every day at 9", "daily at 9:30pm", "every morning at 8", "each day at 9" ----
  const daily = text.match(/^(?:every\s*day|everyday|daily|each\s*day)\s*(?:at\s+(.+))?$/)
  if (daily) {
    const t = daily[1] ? parseTimeToken(daily[1], false) : 9 * 60
    if (t === null) return { ok: false, error: `could not read the time in '${raw}' — try "daily at 9" or "every day at 9:30pm"` }
    return {
      ok: true,
      spec: { name: '', prompt: '', kind: 'cron', expr: dailyCron(t), timezone },
      explanation: `Runs daily at ${hhmm(t)} (${timezone})`,
    }
  }
  const periodDaily = text.match(/^(?:every|each)\s+(morning|afternoon|evening|night)\s*(?:at\s+)?(.+)?$/)
  if (periodDaily && !periodDaily[2]?.trim().match(/^(day|days)\b/)) {
    const period = PERIODS[periodDaily[1]]
    const t = periodDaily[2] ? parseTimeToken(periodDaily[2], period.pmHint) : period.defaultMin
    if (t === null) return { ok: false, error: `could not read the time in '${raw}' — try "every ${period.label} at 8"` }
    return {
      ok: true,
      spec: { name: '', prompt: '', kind: 'cron', expr: dailyCron(t), timezone },
      explanation: `Runs every ${period.label} at ${hhmm(t)} (${timezone})`,
    }
  }

  // ---- 9) "weekdays at 9" / "every weekdays at 9" / "weekends at 10" ----
  const weekdays = text.match(/^(?:every\s+|each\s+|on\s+)?week\s*days?\s*(?:at\s+)?(.+)?$/)
  if (weekdays) {
    const t = weekdays[1] ? parseTimeToken(weekdays[1], false) : 9 * 60
    if (t === null) return { ok: false, error: `could not read the time in '${raw}' — try "weekdays at 9"` }
    const expr = cronFor(t % 60, Math.floor(t / 60), '*', '*', '1-5')
    return {
      ok: true,
      spec: { name: '', prompt: '', kind: 'cron', expr, timezone },
      explanation: `Runs on weekdays (Mon–Fri) at ${hhmm(t)} (${timezone})`,
    }
  }
  const weekends = text.match(/^(?:every\s+|each\s+|on\s+)?week\s*ends?\s*(?:at\s+)?(.+)?$/)
  if (weekends) {
    const t = weekends[1] ? parseTimeToken(weekends[1], false) : 10 * 60
    if (t === null) return { ok: false, error: `could not read the time in '${raw}' — try "weekends at 10"` }
    const expr = cronFor(t % 60, Math.floor(t / 60), '*', '*', '0,6')
    return {
      ok: true,
      spec: { name: '', prompt: '', kind: 'cron', expr, timezone },
      explanation: `Runs on weekends (Sat–Sun) at ${hhmm(t)} (${timezone})`,
    }
  }

  // ---- 10) weekly: "weekly on monday 10am", "on mondays at 9", "every monday/friday at 9" ----
  const weeklyOn = text.match(/^(?:weekly|every|each|on)\s+(?:on\s+)?(.+)$/)
  if (weeklyOn) {
    const rest = weeklyOn[1]
    const dayList = extractDayList(rest)
    if (dayList) {
      const timePart = dayList.rest.replace(/^at\s+/, '').trim()
      const t = timePart ? parseTimeToken(timePart, false) : 9 * 60
      if (t === null) {
        return { ok: false, error: `could not read the time in '${raw}' — try "weekly on monday 10am" or "every monday at 9"` }
      }
      const expr = cronFor(t % 60, Math.floor(t / 60), '*', '*', dayList.days.join(','))
      const everyLabel = dayList.days.length === 1 ? `every ${dayListLabel(dayList.days)}` : `every ${dayListLabel(dayList.days)}`
      return {
        ok: true,
        spec: { name: '', prompt: '', kind: 'cron', expr, timezone },
        explanation: `Runs ${everyLabel} at ${hhmm(t)} (${timezone})`,
      }
    }
  }

  // ---- nothing matched ----
  return {
    ok: false,
    error:
      "I couldn't understand that schedule. Try: \"every 30 minutes\", \"hourly\", \"every day at 9\", \"daily at 9:30pm\", " +
      '"every 2 days at 8", "weekly on monday 10am", "every monday and friday at 9", "weekdays at 9", "in 45 minutes", ' +
      '"in 2 hours", "tonight at 8", "tomorrow at 9", "at 2026-08-01 10:00" — or a 5-field cron like "0 8 * * *".',
  }
}

// ===========================================================================
// 4) JOB CRUD
// ===========================================================================

export async function listCronJobs(): Promise<Array<Record<string, unknown>>> {
  try {
    const jobs = await schedulerDb().cronJob.findMany({ orderBy: { createdAt: 'desc' } })
    return jobs as unknown as Array<Record<string, unknown>>
  } catch {
    return []
  }
}

function nextRunFor(job: {
  kind: string
  expr: string
  intervalMin: number
  runAt: Date | null
  timezone: string
}): Date | null {
  if (job.kind === 'fixed_rate') {
    return new Date(Date.now() + Math.max(1, job.intervalMin) * 60_000)
  }
  if (job.kind === 'one_time') {
    return job.runAt // re-enabling a fired one_time runs it again on the next tick
  }
  return nextCronRunUtc(job.expr, job.timezone)
}

export async function createCronJob(
  spec: CronJobSpec,
  origin: 'user' | 'auto' | 'mist' | 'digest' = 'user'
): Promise<{ ok: boolean; job?: Record<string, unknown>; error?: string }> {
  try {
    const name = String(spec?.name ?? '').trim().slice(0, MAX_NAME_CHARS)
    const prompt = String(spec?.prompt ?? '').trim().slice(0, MAX_PROMPT_CHARS)
    if (!name) return { ok: false, error: 'name is required' }
    if (!prompt) return { ok: false, error: 'prompt is required' }
    const kind = spec?.kind
    if (kind !== 'cron' && kind !== 'fixed_rate' && kind !== 'one_time') {
      return { ok: false, error: `unknown kind '${String(kind)}' — expected cron | fixed_rate | one_time` }
    }
    const timezone = spec.timezone?.trim() || DEFAULT_TZ
    if (!isValidTimeZone(timezone)) return { ok: false, error: `unknown timezone '${timezone}'` }
    const delivery = spec.delivery === 'silent' ? 'silent' : 'alert'

    let expr = ''
    let intervalMin = 0
    let runAt: Date | null = null
    let nextRunAt: Date | null = null

    if (kind === 'cron') {
      expr = String(spec.expr ?? '').trim()
      if (!expr) return { ok: false, error: 'expr is required for kind=cron (5-field cron expression)' }
      if (!parseCronExpression(expr)) {
        return {
          ok: false,
          error: `invalid cron expression '${expr}' — expected 5 fields (minute hour day-of-month month day-of-week), e.g. "0 8 * * *", "*/15 * * * *", "30 9 * * mon-fri"`,
        }
      }
      nextRunAt = nextCronRunUtc(expr, timezone)
      if (!nextRunAt) return { ok: false, error: `the cron expression '${expr}' never matches a real date` }
    } else if (kind === 'fixed_rate') {
      const n = Number(spec.intervalMin)
      if (!Number.isFinite(n) || n < 1 || n > 43200) {
        return { ok: false, error: 'intervalMin must be a number between 1 and 43200 (minutes)' }
      }
      intervalMin = Math.round(n)
      nextRunAt = new Date(Date.now() + intervalMin * 60_000)
    } else {
      const t = new Date(String(spec.runAt ?? ''))
      if (isNaN(t.getTime())) return { ok: false, error: 'runAt must be a valid ISO timestamp' }
      if (t.getTime() <= Date.now()) {
        return { ok: false, error: 'runAt is in the past — one-time jobs must be scheduled in the future' }
      }
      runAt = t
      nextRunAt = t
    }

    const job = await schedulerDb().cronJob.create({
      data: { name, prompt, kind, expr, intervalMin, runAt, timezone, delivery, enabled: true, origin, nextRunAt },
    })
    recordActivity('scheduler', `job created: ${name} (${kind})`)
    return { ok: true, job: job as unknown as Record<string, unknown> }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'failed to create job' }
  }
}

export async function setCronEnabled(_id: string, _enabled: boolean): Promise<{ ok: boolean }> {
  const res = await updateCronJob(_id, { enabled: _enabled })
  return { ok: res.ok }
}

/** Patch name/prompt/enabled; recomputes nextRunAt when a job is re-enabled. */
export async function updateCronJob(
  id: string,
  patch: { enabled?: boolean; name?: string; prompt?: string }
): Promise<{ ok: boolean; job?: Record<string, unknown>; error?: string }> {
  try {
    const job = await schedulerDb().cronJob.findUnique({ where: { id } })
    if (!job) return { ok: false, error: 'job not found' }

    const data: {
      enabled?: boolean
      name?: string
      prompt?: string
      nextRunAt?: Date | null
    } = {}
    if (typeof patch.enabled === 'boolean') data.enabled = patch.enabled
    if (typeof patch.name === 'string' && patch.name.trim()) data.name = patch.name.trim().slice(0, MAX_NAME_CHARS)
    if (typeof patch.prompt === 'string' && patch.prompt.trim()) data.prompt = patch.prompt.trim().slice(0, MAX_PROMPT_CHARS)
    if (!Object.keys(data).length) {
      return { ok: false, error: 'nothing to update — provide enabled, name and/or prompt' }
    }
    // re-enabling a paused job: recompute the next run from now
    if (data.enabled === true && !job.enabled) {
      data.nextRunAt = nextRunFor(job)
    }
    const updated = await schedulerDb().cronJob.update({ where: { id }, data })
    recordActivity('scheduler', `job updated: ${updated.name}${typeof patch.enabled === 'boolean' ? ` (enabled=${patch.enabled})` : ''}`)
    return { ok: true, job: updated as unknown as Record<string, unknown> }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'failed to update job' }
  }
}

export async function deleteCronJob(_id: string): Promise<{ ok: boolean }> {
  try {
    await schedulerDb().cronJob.delete({ where: { id: _id } })
    recordActivity('scheduler', 'job deleted')
    return { ok: true }
  } catch {
    return { ok: false }
  }
}

// ===========================================================================
// 5) EXECUTION (shared by the watch loop and "run now")
// ===========================================================================

interface CronJobRow {
  id: string
  name: string
  prompt: string
  kind: string
  expr: string
  intervalMin: number
  runAt: Date | null
  timezone: string
  delivery: string
  enabled: boolean
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`)), ms)
    p.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      (e) => {
        clearTimeout(timer)
        reject(e)
      }
    )
  })
}

/** Run one job through the unified LLM loop, deliver the result, update the row. */
async function executeJob(job: CronJobRow): Promise<{ ok: boolean; result: string; status: 'ok' | 'error' }> {
  const startedAt = Date.now()
  let text = ''
  let status: 'ok' | 'error' = 'ok'
  try {
    const res = await withTimeout(
      unified({ message: job.prompt, mode: 'chat', history: [] }),
      JOB_TIMEOUT_MS,
      `scheduled run '${job.name}'`
    )
    text = (res.text ?? '').trim()
    if (!text) text = '(empty response)'
  } catch (err) {
    status = 'error'
    text = err instanceof Error ? err.message : 'execution failed'
  }
  const trimmed = text.slice(0, MAX_RESULT_CHARS)

  // deliver as a pending system Alert → the alerts pipeline lands it in the chat
  if (job.delivery !== 'silent') {
    try {
      await raiseSystemAlert(
        job.name,
        status === 'ok' ? trimmed : `⚠️ The scheduled run "${job.name}" failed: ${trimmed}`,
        { cron_job_id: job.id, kind: 'cron', status }
      )
    } catch {
      // alert delivery is best-effort — the autonomy ledger still records the run
    }
  }

  // autonomy ledger (always, even for silent deliveries)
  await logAutonomyEvent(
    'cron_run',
    `cron "${job.name}" ${status === 'ok' ? 'ran' : 'failed'} (${((Date.now() - startedAt) / 1000).toFixed(1)}s): ${trimmed.slice(0, 160)}`,
    {
      job_id: job.id,
      job: job.name,
      status,
      delivery: job.delivery,
      duration_ms: Date.now() - startedAt,
      result_chars: trimmed.length,
    }
  )

  // post-run bookkeeping (never fatal)
  try {
    const data: {
      lastRunAt: Date
      lastStatus: string
      lastResult: string
      runCount: { increment: number }
      nextRunAt?: Date | null
      enabled?: boolean
    } = {
      lastRunAt: new Date(),
      lastStatus: status,
      lastResult: trimmed,
      runCount: { increment: 1 },
    }
    if (job.kind === 'one_time') {
      data.enabled = false // one_time jobs disable after firing
      data.nextRunAt = null
    } else if (job.kind === 'fixed_rate') {
      data.nextRunAt = new Date(Date.now() + Math.max(1, job.intervalMin) * 60_000)
    } else {
      // cron: schedule the next occurrence (fallback retry in 1h if unresolvable)
      data.nextRunAt = nextCronRunUtc(job.expr, job.timezone) ?? new Date(Date.now() + 3_600_000)
    }
    await schedulerDb().cronJob.update({ where: { id: job.id }, data })
  } catch {
    // bookkeeping failure must not break the loop
  }
  recordActivity('scheduler', `"${job.name}" ${status === 'ok' ? 'ran' : 'failed'} in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`)
  return { ok: status === 'ok', result: trimmed, status }
}

export async function runCronJobNow(
  _id: string
): Promise<{ ok: boolean; result?: string; error?: string }> {
  const g = schedulerGlobal()
  if (g.inFlight.has(_id)) return { ok: false, error: 'job is already running' }
  let job: CronJobRow | null = null
  try {
    job = (await schedulerDb().cronJob.findUnique({ where: { id: _id } })) as CronJobRow | null
  } catch {
    job = null
  }
  if (!job) return { ok: false, error: 'job not found' }
  g.inFlight.add(_id)
  try {
    const res = await executeJob(job)
    if (!res.ok) return { ok: false, error: res.result || 'run failed' }
    return { ok: true, result: res.result }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'failed to run job' }
  } finally {
    g.inFlight.delete(_id)
  }
}

// ===========================================================================
// 6) GUARDED WATCH LOOP + SEEDING (globalThis pattern per heartbeat-service)
// ===========================================================================

interface SchedulerGlobal {
  started: boolean
  version?: number // loop-takeover marker: a newer module compile replaces an older running loop (HMR)
  seeded: boolean
  seedPromise: Promise<void> | null
  timer?: ReturnType<typeof setInterval>
  inFlight: Set<string>
}

function schedulerGlobal(): SchedulerGlobal {
  const g = globalThis as unknown as { __mistSchedulerWatch?: SchedulerGlobal }
  return (g.__mistSchedulerWatch ??= { started: false, seeded: false, seedPromise: null, inFlight: new Set<string>() })
}

async function schedulerTick(): Promise<void> {
  try {
    const g = schedulerGlobal()
    // seed-retry: the initial seed can race a transient DB failure or a
    // table that only became empty later during boot — retry until it sticks
    if (!g.seeded) {
      const done = await seedDefaultJobs()
      if (done) g.seeded = true
    }
    // digest-origin schedules (origin 'digest') execute through the oj digest
    // service — claim-guarded there, shared with the heartbeat path, so they
    // NEVER run through the generic prompt executor below. Best-effort: a
    // failure here must not stop the regular cron jobs from firing.
    try {
      const { digestDueCheck } = await import('@/lib/oj/digest-service')
      await digestDueCheck()
    } catch {
      // digest execution is never fatal to the scheduler tick
    }
    const due = await schedulerDb().cronJob.findMany({
      where: { enabled: true, nextRunAt: { lte: new Date() } },
      orderBy: { nextRunAt: 'asc' },
      take: 20,
    })
    for (const job of due as CronJobRow[]) {
      if (g.inFlight.has(job.id)) continue
      if ((job as { origin?: string }).origin === 'digest') continue // handled above
      g.inFlight.add(job.id)
      void executeJob(job)
        .catch(() => undefined)
        .finally(() => {
          g.inFlight.delete(job.id)
        })
    }
  } catch {
    // the watch loop must NEVER throw
  }
}

/** Seed MIST's own default automations exactly once (when the table is empty). Returns true when done (seeded or already non-empty). */
async function seedDefaultJobs(): Promise<boolean> {
  try {
    const count = await schedulerDb().cronJob.count()
    if (count > 0) return true
    await createCronJob(
      {
        name: 'Morning briefing',
        prompt:
          "Run a trend scan across my watchlist topics and the wider AI world — what's trending, what's new, what's happening. Brief me concisely with sources.",
        kind: 'cron',
        expr: '0 8 * * *',
        timezone: DEFAULT_TZ,
        delivery: 'alert',
      },
      'auto'
    )
    await createCronJob(
      {
        name: 'Nightly self-review',
        prompt:
          'Run a self-review: summarize your evolution proposals, skill usage stats, memory stats and recent autonomy actions into a short self-report. Note anything that needs my attention.',
        kind: 'cron',
        expr: '0 22 * * *',
        timezone: DEFAULT_TZ,
        delivery: 'alert',
      },
      'auto'
    )
    await logAutonomyEvent('cron_run', 'scheduler seeded the default automations: "Morning briefing" (daily 08:00) and "Nightly self-review" (daily 22:00)', {
      seeded: ['Morning briefing', 'Nightly self-review'],
      timezone: DEFAULT_TZ,
    })
    recordActivity('scheduler', 'seeded default automations (morning briefing + nightly self-review)')
    return true
  } catch {
    // seeding is best-effort; the watch loop retries on a later tick
    return false
  }
}

export function ensureSchedulerWatch(): void {
  const g = schedulerGlobal()
  // HMR takeover: if the running loop belongs to an older compile of this
  // module (dev hot reload), replace it with this module's tick function.
  if (g.started && g.version === SCHEDULER_VERSION) return
  if (g.timer) clearInterval(g.timer)
  g.started = true
  g.version = SCHEDULER_VERSION

  // one-time init: seed (if the table is empty) then an immediate first tick
  // (re-run on takeover — seeding is idempotent via the DB count check)
  g.seedPromise = (async () => {
    const done = await seedDefaultJobs()
    g.seeded = done
    await schedulerTick()
  })().catch(() => undefined)

  g.timer = setInterval(() => {
    void schedulerTick()
  }, WATCH_INTERVAL_S * 1000)
  g.timer.unref?.()
  recordActivity('scheduler', `cron scheduler armed (${WATCH_INTERVAL_S}s watch, loop v${SCHEDULER_VERSION})`)
}
