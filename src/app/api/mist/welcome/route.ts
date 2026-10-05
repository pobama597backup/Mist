// /api/mist/welcome — the welcome-back briefing (Mark-LV's morning-briefing
// pattern, our edition).
//
// GET  ?tz=... — decide whether she greets on this boot:
//       · never greeted before → greet
//       · gap since last seen > 20 min → greet (recap + live news + speech)
//       · server restarted < 5 min ago and gap > 2 min → "back online" greet
//       Otherwise: silently touch last-seen (quick refreshes never nag).
// POST { action:'seen'  } — the open app pings every 5 min so same-session
//                         reloads don't re-greet.
// POST { action:'brief', force? } — the "Brief me" button: compose + deliver
//                         a briefing NOW (no greet gate).
//
// Composition: recap of what actually happened since last seen (alerts,
// missions, autonomy events, teacher notices — DB-proven, never invented) +
// fresh news (web_search, 30-min cache) + time-of-day awareness, written in
// her voice through the LLM cascade. All lanes down → honest deterministic
// fallback with the raw bullets. News lane down → the briefing says so in
// one clause and moves on.

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { upsertFact } from '@/lib/services/memory-service'
import { recordActivity } from '@/lib/services/activity-service'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const KEY_LAST_SEEN = 'welcome:last_seen'
const KEY_LAST_GREET = 'welcome:last_greet'
const KEY_NEWS_CACHE = 'welcome:news_cache'

const GREET_AFTER_MS = 20 * 60_000 // away > 20 min → greet
const RESTART_GREET_AFTER_MS = 2 * 60_000 // server restarted + away > 2 min → greet
const NEWS_CACHE_MS = 30 * 60_000

interface NewsItem {
  title: string
  host: string
}

async function readMemory(key: string): Promise<string | null> {
  try {
    const row = await db.longtermMemory.findUnique({ where: { key } })
    return row?.value ?? null
  } catch {
    return null
  }
}

async function touchSeen(): Promise<void> {
  try {
    await upsertFact(KEY_LAST_SEEN, new Date().toISOString(), 'auto')
  } catch {
    /* best-effort */
  }
}

/** Fresh-ish news through the search lane, 30-min cached — never blocks. */
async function fetchNews(): Promise<{ items: NewsItem[]; fresh: boolean }> {
  const cachedRaw = await readMemory(KEY_NEWS_CACHE)
  if (cachedRaw) {
    try {
      const parsed = JSON.parse(cachedRaw) as { at: number; items: NewsItem[] }
      if (Date.now() - parsed.at < NEWS_CACHE_MS && Array.isArray(parsed.items)) {
        return { items: parsed.items.slice(0, 5), fresh: false }
      }
    } catch {
      /* corrupt cache → refetch */
    }
  }
  try {
    const ZAI = (await import('z-ai-web-dev-sdk')).default
    const zai = await ZAI.create()
    const dateStr = new Date().toISOString().slice(0, 10)
    const results = (await zai.functions.invoke('web_search', {
      query: `top technology news today ${dateStr}`,
      num: 6,
      recency_days: 2,
    })) as Array<{ name?: string; host_name?: string }>
    const items: NewsItem[] = (results ?? [])
      .filter((r) => typeof r.name === 'string' && r.name.length > 8)
      .slice(0, 5)
      .map((r) => ({ title: String(r.name).slice(0, 140), host: String(r.host_name ?? '') }))
    if (items.length > 0) {
      await upsertFact(
        KEY_NEWS_CACHE,
        JSON.stringify({ at: Date.now(), items }),
        'auto'
      ).catch(() => undefined)
    }
    return { items, fresh: true }
  } catch {
    return { items: [], fresh: false }
  }
}

/** What actually happened since `since` — DB-proven bullets, never invented. */
async function buildRecap(since: Date): Promise<string[]> {
  const lines: string[] = []
  try {
    const [alerts, missions, events, notices] = await Promise.all([
      db.alert.findMany({ where: { createdAt: { gte: since } }, orderBy: { createdAt: 'desc' }, take: 6 }),
      db.mission.findMany({
        where: { updatedAt: { gte: since }, status: { in: ['done', 'verified', 'failed', 'cancelled'] } },
        orderBy: { updatedAt: 'desc' },
        take: 4,
      }),
      db.autonomyEvent.findMany({ where: { createdAt: { gte: since } }, orderBy: { createdAt: 'desc' }, take: 5 }),
      db.teacherNotice.findMany({ where: { status: 'new' }, orderBy: { createdAt: 'desc' }, take: 2 }),
    ])
    for (const a of alerts) {
      lines.push(`Alert: ${a.title.slice(0, 110)}`)
    }
    for (const m of missions) {
      const title = (m.title || m.goal || 'mission').slice(0, 60)
      lines.push(`Mission ${m.status}: ${title}`)
    }
    for (const e of events) {
      if (e.summary) lines.push(`Autonomy: ${String(e.summary).slice(0, 100)}`)
    }
    for (const n of notices) {
      lines.push(`Teacher notice from Mark-LV study: ${n.head.slice(0, 8)} (${n.commits} commits) — awaiting your call`)
    }
  } catch {
    /* recap is best-effort */
  }
  return lines.slice(0, 10)
}

function periodForHour(hour: number): string {
  if (hour >= 5 && hour < 12) return 'morning'
  if (hour >= 12 && hour < 17) return 'afternoon'
  if (hour >= 17 && hour < 22) return 'evening'
  return 'late night'
}

function hourInTz(tz: string | null): { hour: number; label: string } {
  try {
    const fmt = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz ?? 'Africa/Lagos',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    })
    const parts = fmt.format(new Date())
    const hour = Number.parseInt(parts.slice(0, 2), 10)
    return { hour: Number.isFinite(hour) ? hour : 12, label: parts }
  } catch {
    const h = new Date().getHours()
    return { hour: h, label: `${String(h).padStart(2, '0')}:${String(new Date().getMinutes()).padStart(2, '0')}` }
  }
}

interface BriefingParts {
  period: string
  timeLabel: string
  awayHours: number | null
  restarted: boolean
  recap: string[]
  news: NewsItem[]
}

function fallbackBriefing(p: BriefingParts): string {
  const bits: string[] = []
  bits.push(`Good ${p.period}. Local time ${p.timeLabel}.`)
  if (p.restarted) bits.push('My server was restarted — I am back online and everything resumed cleanly.')
  if (p.recap.length > 0) {
    bits.push('While you were away: ' + p.recap.slice(0, 4).join(' · '))
  } else {
    bits.push('Nothing needed your attention while you were away — the machine stayed quiet.')
  }
  if (p.news.length > 0) bits.push(`In the news: ${p.news[0]?.title}.`)
  bits.push('What are we working on?')
  return bits.join(' ')
}

function composeInstruction(p: BriefingParts): string {
  const recapBlock =
    p.recap.length > 0 ? p.recap.map((r) => `- ${r}`).join('\n') : '- (nothing noteworthy happened — say so in one clause)'
  const newsBlock =
    p.news.length > 0
      ? p.news.slice(0, 3).map((n) => `- ${n.title} (${n.host})`).join('\n')
      : '- (news lane unreachable — skip news, one clause at most)'
  const away = p.awayHours !== null ? `The creator was away for about ${p.awayHours}h.` : ''
  const restart = p.restarted ? 'Your server was restarted since they last saw you — acknowledge being back online in passing.' : ''
  return `It is ${p.timeLabel} (${p.period}). ${away} ${restart}

Verified events since they were away (use ONLY these — never invent):
${recapBlock}

Fresh news headlines (mention at most two, with one short take each):
${newsBlock}

Write the welcome-back briefing in your own voice (Clare — dry, warm, sharp, sovereign; never gushing, never flattery, no emoji spam). 3 to 5 sentences max. Rules:
- Open with the time of day, naturally.
- Weave the 2-3 most IMPORTANT verified events in one or two sentences (skip trivia).
- At most two news items, each with a one-clause take.
- End with something useful: the natural next action from the recap, or a plain offer.
- If a section is empty, one short honest clause and move on — never pad.`
}

async function composeBriefing(p: BriefingParts): Promise<{ text: string; provider: string }> {
  try {
    const m = await import('@/lib/services/llm-service')
    if (typeof m.unified !== 'function') throw new Error('no llm lane')
    const res = await m.unified({ message: composeInstruction(p), mode: 'consciousness' })
    const text = res.fallback || res.salvaged ? '' : (res.text ?? '').trim().slice(0, 900)
    if (!text) throw new Error('degraded')
    return { text, provider: String(res.provider) }
  } catch {
    return { text: fallbackBriefing(p), provider: 'fallback' }
  }
}

async function buildParts(tz: string | null, since: Date | null): Promise<BriefingParts> {
  const { hour, label } = hourInTz(tz)
  const [recapResult, news] = await Promise.all([since ? buildRecap(since) : Promise.resolve([]), fetchNews()])
  const awayHours =
    since !== null ? Math.max(0, Math.round(((Date.now() - since.getTime()) / 3600_000) * 10) / 10) : null
  return {
    period: periodForHour(hour),
    timeLabel: label,
    awayHours,
    restarted: process.uptime() < 5 * 60,
    recap: recapResult,
    news: news.items,
  }
}

async function greetNow(parts: BriefingParts): Promise<NextResponse> {
  const composed = await composeBriefing(parts)
  const now = new Date().toISOString()
  await upsertFact(KEY_LAST_GREET, now, 'auto').catch(() => undefined)
  await upsertFact(KEY_LAST_SEEN, now, 'auto').catch(() => undefined)
  recordActivity('heartbeat', `welcome-back briefing delivered (${composed.provider})`)
  return NextResponse.json({
    greet: true,
    text: composed.text,
    provider: composed.provider,
    recap: parts.recap,
    news: parts.news.map((n) => n.title),
  })
}

export async function GET(req: NextRequest) {
  try {
    const tz = req.nextUrl.searchParams.get('tz')
    const lastSeenRaw = await readMemory(KEY_LAST_SEEN)
    const lastGreetRaw = await readMemory(KEY_LAST_GREET)
    const lastSeen = lastSeenRaw ? new Date(lastSeenRaw) : null
    const lastGreet = lastGreetRaw ? new Date(lastGreetRaw) : null
    const gap = lastSeen !== null && Number.isFinite(lastSeen.getTime()) ? Date.now() - lastSeen.getTime() : null

    const never = lastGreet === null || !Number.isFinite(lastGreet.getTime())
    const away = gap !== null && gap > GREET_AFTER_MS
    const restartCase =
      process.uptime() < 5 * 60 && gap !== null && gap > RESTART_GREET_AFTER_MS

    if (never || away || restartCase) {
      const since =
        lastSeen !== null && Number.isFinite(lastSeen.getTime())
          ? lastSeen
          : new Date(Date.now() - 24 * 3600_000)
      const parts = await buildParts(tz, since)
      return await greetNow(parts)
    }
    await touchSeen()
    return NextResponse.json({ greet: false })
  } catch (err) {
    return NextResponse.json(
      { greet: false, error: err instanceof Error ? err.message : 'welcome check failed' },
      { status: 200 } // a failed greeting must never break the boot
    )
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => ({}))) as { action?: string; tz?: string }
    if (body.action === 'seen') {
      await touchSeen()
      return NextResponse.json({ ok: true })
    }
    if (body.action === 'brief') {
      const tz = typeof body.tz === 'string' ? body.tz : null
      const lastSeenRaw = await readMemory(KEY_LAST_SEEN)
      const since = lastSeenRaw ? new Date(lastSeenRaw) : new Date(Date.now() - 24 * 3600_000)
      const parts = await buildParts(tz, Number.isFinite(since.getTime()) ? since : null)
      return await greetNow(parts)
    }
    return NextResponse.json({ error: 'unsupported action — use seen | brief' }, { status: 400 })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'welcome action failed' },
      { status: 500 }
    )
  }
}
