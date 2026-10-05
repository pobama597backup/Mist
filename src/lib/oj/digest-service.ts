// OpenJarvis digest port (oj-ops-3) — the morning-digest pipeline from
// openjarvis (digest_collect tool + MorningDigestAgent + DigestStore):
//
//   collectLatest()  → honest sections from her OWN sources (watchlist JSON read
//                      directly — no service import cycles; recent alerts; recent
//                      operator runs; learning activity; recent notes as the
//                      calendar substitute — no weather, no invented data)
//   generateDigest() → LLM (z-ai, backend-only) writes {headline, items[], tone};
//                      on LLM failure it degrades to an honest item list, never
//                      a fake narrative → Digest row
//   speakDigest       → TTS-ready text (no TTS call — the voice route exists)
//   scheduleDigest()  → CronJob row with origin 'digest', executed by
//                      digestDueCheck() (claim-guarded) — wired into BOTH the
//                      scheduler watch loop and the 60s heartbeat beat.

import fs from 'node:fs/promises'
import path from 'node:path'
import { db } from '@/lib/db'
import { getZai } from '@/lib/services/zai'
import { recordActivity } from '@/lib/services/activity-service'
import { logAutonomyEvent } from '@/lib/services/autonomy-service'
import { parseCronExpression, nextCronRunUtc } from '@/lib/services/scheduler-service'

const DEFAULT_TZ = 'Africa/Lagos'
const MAX_CONTENT_CHARS = 4000

export interface DigestSection {
  title: string
  content: string
  sources: string[]
}

export interface DigestSnapshot {
  collectedAt: string
  sections: Record<string, DigestSection>
}

export interface DigestBrief {
  headline: string
  items: string[]
  tone: string
  degraded: boolean // true when the LLM failed and an item list was used
}

export interface DigestOut {
  id: string
  kind: string
  headline: string
  items: string[]
  tone: string
  degraded: boolean
  content: string
  sections: Record<string, DigestSection>
  createdAt: string
  speakText?: string
}

// ---------- collection ----------

interface WatchlistFile {
  entries?: Array<{
    repo?: string
    label?: string
    version?: string | null
    version_label?: string | null
    updated_at?: string | null
    changed?: boolean
    last_change_at?: string | null
    error?: string | null
    note?: string
  }>
  last_sweep_at?: string | null
}

async function readWatchlist(): Promise<WatchlistFile | null> {
  try {
    const raw = await fs.readFile(path.join(process.cwd(), 'db', 'watchlist.json'), 'utf-8')
    return JSON.parse(raw) as WatchlistFile
  } catch {
    return null
  }
}

function fmtDate(value: string | null | undefined): string {
  if (!value) return '—'
  const t = Date.parse(value)
  if (!Number.isFinite(t)) return value
  return new Date(t).toISOString().replace('T', ' ').slice(0, 16) + ' UTC'
}

/** Honest fan-in of her own sources. Never invents data — an unavailable
 *  source becomes an explicit line saying so. */
export async function collectLatest(): Promise<DigestSnapshot> {
  const collectedAt = new Date().toISOString()
  const sections: Record<string, DigestSection> = {}

  // 1) watchlist — read the JSON directly (deliberately no watchlist-service import)
  const wl = await readWatchlist()
  if (wl && Array.isArray(wl.entries) && wl.entries.length) {
    const lines = wl.entries.map((e) => {
      const v = e.version ?? '?'
      const moved = e.changed ? ' (moved since last check)' : ''
      const err = e.error ? ` — check error: ${e.error}` : ''
      return `- ${e.label ?? e.repo ?? 'repo'}: ${v}${e.version_label ? ` — ${String(e.version_label).slice(0, 90)}` : ''}${moved}${err} (checked ${fmtDate(e.updated_at ?? wl.last_sweep_at)})`
    })
    sections.watchlist = {
      title: 'Watchlist',
      content: [`${wl.entries.length} tracked repos (last sweep ${fmtDate(wl.last_sweep_at)})`, ...lines].join('\n'),
      sources: ['db/watchlist.json'],
    }
  } else {
    sections.watchlist = {
      title: 'Watchlist',
      content: 'watchlist unavailable (db/watchlist.json could not be read)',
      sources: ['db/watchlist.json'],
    }
  }

  // 2) recent alerts (last 24h)
  try {
    const alerts = await db.alert.findMany({
      where: { createdAt: { gte: new Date(Date.now() - 24 * 3600_000) } },
      orderBy: { createdAt: 'desc' },
      take: 20,
    })
    sections.alerts = alerts.length
      ? {
          title: 'Alerts (24h)',
          content: alerts
            .map((a) => `- ${fmtDate(a.createdAt.toISOString())} [${a.kind}] ${a.title.slice(0, 90)}`)
            .join('\n'),
          sources: ['prisma/alert'],
        }
      : {
          title: 'Alerts (24h)',
          content: 'no alerts in the last 24 hours — a quiet day',
          sources: ['prisma/alert'],
        }
  } catch {
    sections.alerts = { title: 'Alerts (24h)', content: 'alerts unavailable (database read failed)', sources: ['prisma/alert'] }
  }

  // 3) operator runs
  try {
    const ops = await db.operator.findMany({ orderBy: { lastRunAt: 'desc' }, take: 10 })
    sections.operators = ops.length
      ? {
          title: 'Operators',
          content: ops
            .map((o) => `- ${o.slug}: ${o.status}, ${o.runCount} runs, last ${fmtDate(o.lastRunAt?.toISOString() ?? null)} → ${o.lastStatus ?? 'never run'}`)
            .join('\n'),
          sources: ['prisma/operator'],
        }
      : { title: 'Operators', content: 'no operators registered yet', sources: ['prisma/operator'] }
  } catch {
    sections.operators = { title: 'Operators', content: 'operators unavailable (database read failed)', sources: ['prisma/operator'] }
  }

  // 4) learning activity — autonomy ledger + skill usage
  try {
    const events = await db.autonomyEvent.findMany({
      where: { createdAt: { gte: new Date(Date.now() - 24 * 3600_000) } },
      orderBy: { createdAt: 'desc' },
      take: 12,
    })
    const skillCount = await db.skill.count()
    const eventLines = events.map((e) => `- ${fmtDate(e.createdAt.toISOString())} ${e.type}: ${e.summary.slice(0, 100)}`)
    sections.learning = {
      title: 'Learning',
      content: [
        `${skillCount} skills known; ${events.length} autonomy events in 24h`,
        ...(eventLines.length ? eventLines : ['- no autonomous activity in the last 24 hours']),
      ].join('\n'),
      sources: ['prisma/autonomyEvent', 'prisma/skill'],
    }
  } catch {
    sections.learning = { title: 'Learning', content: 'learning activity unavailable (database read failed)', sources: ['prisma/autonomyEvent'] }
  }

  // 5) notes — the honest calendar substitute (no calendar connector configured)
  try {
    const notesDir = path.join(process.cwd(), 'db', 'notes')
    const files = await fs.readdir(notesDir).catch(() => [] as string[])
    const mdFiles = files.filter((f) => f.endsWith('.md'))
    const stated = await Promise.all(
      mdFiles.slice(0, 12).map(async (f) => {
        try {
          const st = await fs.stat(path.join(notesDir, f))
          return { f, mtime: st.mtimeMs }
        } catch {
          return { f, mtime: 0 }
        }
      })
    )
    stated.sort((a, b) => b.mtime - a.mtime)
    const recent = stated.slice(0, 5)
    sections.notes = recent.length
      ? {
          title: 'Notes (calendar substitute)',
          content: [
            'no calendar connector is configured — most recent notes stand in honestly:',
            ...recent.map((n) => `- ${n.f.replace(/\.md$/, '')} (updated ${fmtDate(new Date(n.mtime).toISOString())})`),
          ].join('\n'),
          sources: ['db/notes'],
        }
      : { title: 'Notes (calendar substitute)', content: 'no notes found — nothing calendar-like to report', sources: ['db/notes'] }
  } catch {
    sections.notes = { title: 'Notes (calendar substitute)', content: 'notes unavailable', sources: ['db/notes'] }
  }

  return { collectedAt, sections }
}

// ---------- generation ----------

function extractJson(text: string): unknown | null {
  const start = text.indexOf('{')
  if (start === -1) return null
  let depth = 0
  for (let i = start; i < text.length; i++) {
    if (text[i] === '{') depth++
    else if (text[i] === '}') {
      depth--
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1)) as unknown
        } catch {
          return null
        }
      }
    }
  }
  return null
}

/** Degrade to an honest item list when the LLM fails — never a fake narrative. */
function degradedBrief(snap: DigestSnapshot): DigestBrief {
  const items: string[] = []
  for (const [key, sec] of Object.entries(snap.sections)) {
    const first = sec.content.split('\n').find((l) => l.trim()) ?? key
    items.push(`• ${sec.title}: ${first.slice(0, 110)}`)
  }
  return {
    headline: 'Briefing from collected sections (LLM synthesis unavailable)',
    items,
    tone: 'plain',
    degraded: true,
  }
}

async function synthesizeBrief(snap: DigestSnapshot, systemPrompt?: string): Promise<DigestBrief> {
  const sectionText = Object.entries(snap.sections)
    .map(([key, sec]) => `## ${key} — ${sec.title}\n${sec.content}`)
    .join('\n\n')
  try {
    const zai = await getZai()
    const completion = await zai.chat.completions.create({
      messages: [
        {
          role: 'assistant',
          content:
            systemPrompt?.trim()
              ? `${systemPrompt.trim()}\n\nAdditionally: output STRICT JSON only, no prose around it: {"headline": string (under 90 chars), "items": string[] (3 to 6 one-line items, each starting with an emoji), "tone": string (one word)}`
              : 'You are MIST writing her daily digest. Use ONLY the provided sections — never invent news, weather or calendar events; an empty or unavailable source gets one honest clause. Output STRICT JSON only, no prose around it: {"headline": string (under 90 chars), "items": string[] (3 to 6 one-line items, each starting with an emoji), "tone": string (one word)}',
        },
        { role: 'user', content: `Collected at ${snap.collectedAt}:\n\n${sectionText}` },
      ],
      max_tokens: 700,
      thinking: { type: 'disabled' },
    })
    const text = completion.choices[0]?.message?.content ?? ''
    const parsed = extractJson(String(text)) as { headline?: unknown; items?: unknown; tone?: unknown } | null
    if (
      parsed &&
      typeof parsed.headline === 'string' && parsed.headline.trim() &&
      Array.isArray(parsed.items) && parsed.items.length >= 1 &&
      parsed.items.every((it) => typeof it === 'string') &&
      typeof parsed.tone === 'string' && parsed.tone.trim()
    ) {
      return {
        headline: parsed.headline.trim().slice(0, 120),
        items: (parsed.items as string[]).slice(0, 8).map((it) => it.trim().slice(0, 160)),
        tone: parsed.tone.trim().slice(0, 24),
        degraded: false,
      }
    }
    return degradedBrief(snap)
  } catch {
    return degradedBrief(snap)
  }
}

function buildMarkdown(brief: DigestBrief, snap: DigestSnapshot): string {
  const head = `# ${brief.headline}\n\n_${brief.tone} — collected ${fmtDate(snap.collectedAt)}_\n\n${brief.items.map((i) => `- ${i}`).join('\n')}`
  const body = Object.entries(snap.sections)
    .map(([key, sec]) => `\n## ${sec.title}\n\n${sec.content}\n\n_sources: ${sec.sources.join(', ')}_`)
    .join('')
  return `${head}\n${body}`.slice(0, 12000)
}

function rowToOut(row: {
  id: string
  kind: string
  sections: string
  content: string
  createdAt: Date
}): DigestOut {
  let sections: Record<string, DigestSection> = {}
  let brief: { headline?: string; items?: string[]; tone?: string; degraded?: boolean } = {}
  try {
    const parsed = JSON.parse(row.sections || '{}') as Record<string, unknown>
    for (const [k, v] of Object.entries(parsed)) {
      if (k === '_brief') {
        brief = (v ?? {}) as typeof brief
      } else if (v && typeof v === 'object' && 'title' in (v as Record<string, unknown>)) {
        const s = v as Record<string, unknown>
        sections[k] = {
          title: String(s.title ?? k),
          content: String(s.content ?? ''),
          sources: Array.isArray(s.sources) ? (s.sources as unknown[]).map(String) : [],
        }
      }
    }
  } catch {
    // keep empty sections
  }
  return {
    id: row.id,
    kind: row.kind,
    headline: brief.headline ?? row.content.split('\n')[0]?.replace(/^#\s*/, '') ?? 'digest',
    items: brief.items ?? [],
    tone: brief.tone ?? 'plain',
    degraded: brief.degraded ?? false,
    content: row.content,
    sections,
    createdAt: row.createdAt.toISOString(),
  }
}

/** Generate + persist one digest. raiseAlert lands it in the chat pipeline.
 *  systemPrompt lets an operator (morning-brief) own the synthesis voice. */
export async function generateDigest(
  kind: 'daily' | 'on_demand' = 'on_demand',
  opts: { raiseAlert?: boolean; systemPrompt?: string } = {}
): Promise<DigestOut> {
  const snap = await collectLatest()
  const brief = await synthesizeBrief(snap, opts.systemPrompt)
  const content = buildMarkdown(brief, snap)
  const sectionsJson = JSON.stringify({ ...snap.sections, _brief: { headline: brief.headline, items: brief.items, tone: brief.tone, degraded: brief.degraded } })

  const row = await db.digest.create({ data: { kind, sections: sectionsJson, content } })
  const out = rowToOut(row)

  if (opts.raiseAlert !== false) {
    try {
      await db.alert.create({
        data: {
          kind: 'system',
          title: `🗞️ Digest: ${brief.headline}`,
          body: brief.degraded
            ? `${content.slice(0, MAX_CONTENT_CHARS)}\n\n(note: LLM synthesis was unavailable — this is the honest collected item list)`
            : content.slice(0, MAX_CONTENT_CHARS),
          meta: JSON.stringify({ digest_id: row.id, kind: 'digest', degraded: brief.degraded, tone: brief.tone }),
        },
      })
    } catch {
      // alert delivery is best-effort
    }
  }
  recordActivity('digest', `digest generated (${kind}${brief.degraded ? ', degraded item list' : ''}): ${brief.headline.slice(0, 70)}`)
  await logAutonomyEvent('trend_digest', `digest generated (${kind}${brief.degraded ? ' degraded' : ''}): ${brief.headline}`, {
    digest_id: row.id,
    degraded: brief.degraded,
    tone: brief.tone,
    sections: Object.keys(snap.sections),
  })
  return out
}

/** TTS-ready text for a digest — strips markdown, keeps it speakable. No TTS call. */
export function speakableDigest(d: DigestOut): string {
  const items = d.items.length ? d.items : Object.values(d.sections).map((s) => `${s.title}. ${s.content.split('\n')[0] ?? ''}`)
  return [d.headline, ...items.map((i) => i.replace(/^[•\-]\s*/, ''))]
    .join('. ')
    .replace(/[#*_`>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 1500)
}

export async function listDigests(limit = 10): Promise<DigestOut[]> {
  try {
    const rows = await db.digest.findMany({ orderBy: { createdAt: 'desc' }, take: Math.max(1, Math.min(50, limit)) })
    return rows.map(rowToOut)
  } catch {
    return []
  }
}

export async function getLatestDigest(): Promise<DigestOut | null> {
  const rows = await listDigests(1)
  return rows[0] ?? null
}

// ---------- scheduling (CronJob rows with origin 'digest') ----------

const DIGEST_JOB_NAME = 'Daily digest'
const DIGEST_JOB_PROMPT =
  '[digest] Generate the daily digest from her own sources (watchlist, alerts, operators, learning, notes) and deliver it as an alert.'

export interface DigestScheduleStatus {
  jobId: string | null
  enabled: boolean
  cron: string | null
  nextRunAt: string | null
  lastRunAt: string | null
  lastStatus: string | null
}

export async function digestScheduleStatus(): Promise<DigestScheduleStatus> {
  try {
    const job = await db.cronJob.findFirst({ where: { origin: 'digest' }, orderBy: { createdAt: 'desc' } })
    if (!job) {
      return { jobId: null, enabled: false, cron: null, nextRunAt: null, lastRunAt: null, lastStatus: null }
    }
    return {
      jobId: job.id,
      enabled: job.enabled,
      cron: job.expr || null,
      nextRunAt: job.nextRunAt ? job.nextRunAt.toISOString() : null,
      lastRunAt: job.lastRunAt ? job.lastRunAt.toISOString() : null,
      lastStatus: job.lastStatus ?? null,
    }
  } catch {
    return { jobId: null, enabled: false, cron: null, nextRunAt: null, lastRunAt: null, lastStatus: null }
  }
}

/** Create/update/disable the digest schedule (a CronJob row with origin 'digest'). */
export async function scheduleDigest(enabled: boolean, cron?: string): Promise<{ ok: boolean; error?: string; nextRunAt?: string }> {
  try {
    const existing = await db.cronJob.findFirst({ where: { origin: 'digest' }, orderBy: { createdAt: 'desc' } })
    if (!enabled) {
      if (!existing) return { ok: true } // nothing to disable — honest no-op
      await db.cronJob.update({ where: { id: existing.id }, data: { enabled: false, nextRunAt: null } })
      recordActivity('digest', 'digest schedule disabled')
      return { ok: true }
    }
    const expr = String(cron ?? '').trim()
    if (!parseCronExpression(expr)) {
      return { ok: false, error: `invalid cron expression '${expr}' — expected 5 fields, e.g. "0 8 * * *"` }
    }
    const next = nextCronRunUtc(expr, existing?.timezone || DEFAULT_TZ)
    if (!next) return { ok: false, error: `the cron expression '${expr}' never matches a real date` }
    if (existing) {
      await db.cronJob.update({
        where: { id: existing.id },
        data: { enabled: true, expr, kind: 'cron', nextRunAt: next },
      })
    } else {
      await db.cronJob.create({
        data: {
          name: DIGEST_JOB_NAME,
          prompt: DIGEST_JOB_PROMPT,
          kind: 'cron',
          expr,
          timezone: DEFAULT_TZ,
          delivery: 'silent', // digest-service raises its own richer alert
          enabled: true,
          origin: 'digest',
          nextRunAt: next,
        },
      })
    }
    recordActivity('digest', `digest schedule ${existing ? 'updated' : 'created'}: ${expr} (next ${next.toISOString()})`)
    return { ok: true, nextRunAt: next.toISOString() }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'failed to schedule digest' }
  }
}

// ---------- due execution (claim-guarded; called from scheduler + heartbeat) ----------

interface DigestGlobal {
  inFlight: Set<string>
  lastDueCheck?: number
}
function digestGlobal(): DigestGlobal {
  const g = globalThis as unknown as { __mistDigestWatch?: DigestGlobal }
  return (g.__mistDigestWatch ??= { inFlight: new Set<string>() })
}

/** Run every due digest job once. Claim-guarded so the scheduler loop and the
 *  heartbeat beat can both call it without double-generating. NEVER throws. */
export async function digestDueCheck(): Promise<number> {
  const g = digestGlobal()
  let ran = 0
  try {
    const due = await db.cronJob.findMany({
      where: { origin: 'digest', enabled: true, nextRunAt: { lte: new Date() } },
      take: 5,
    })
    for (const job of due) {
      if (g.inFlight.has(job.id)) continue
      g.inFlight.add(job.id)
      try {
        // claim: only the caller that moves nextRunAt forward runs the job
        const next = nextCronRunUtc(job.expr, job.timezone || DEFAULT_TZ) ?? new Date(Date.now() + 3_600_000)
        const claimed = await db.cronJob.updateMany({
          where: { id: job.id, nextRunAt: job.nextRunAt, enabled: true },
          data: { nextRunAt: next, lastRunAt: new Date(), runCount: { increment: 1 } },
        })
        if (claimed.count === 0) continue // another loop claimed it first
        let status = 'ok'
        try {
          const digest = await generateDigest('daily')
          if (digest.degraded) status = 'degraded'
        } catch (err) {
          status = 'error'
          try {
            await db.alert.create({
              data: {
                kind: 'system',
                title: '⚠️ Daily digest failed',
                body: err instanceof Error ? err.message : 'digest generation failed',
                meta: JSON.stringify({ kind: 'digest', status: 'error', job_id: job.id }),
              },
            })
          } catch {
            // best-effort
          }
        }
        await db.cronJob
          .update({ where: { id: job.id }, data: { lastStatus: status, lastResult: status === 'ok' ? 'digest generated' : status } })
          .catch(() => undefined)
        ran++
      } finally {
        g.inFlight.delete(job.id)
      }
    }
  } catch {
    // the due check must never throw to its host loop
  }
  return ran
}
