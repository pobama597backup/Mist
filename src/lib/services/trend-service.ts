// v5 TRENDS + SELF-UPGRADE — "look at what's trending, what's new, what's
// happening", then let MIST upgrade herself in the most effective way.
//
// runTrendDigest(): watchlist topics (+ evergreen angles) → 4-8 recency-scoped
//   web searches → dedupe → ONE core-LLM synthesis → TrendDigest → persisted
//   to db/notes/trend-digests/<ISO>.md + globalThis cache + autonomy event.
//   NEVER throws — falls back to a deterministic digest built from raw hits.
// getLastDigest(): globalThis cache, else rebuild from the newest digest file
//   (sync fs — the frozen contract is a sync function).
// runSelfUpgradeCycle(): digest → capability surface (tools + skills) → ONE
//   core-LLM gap analysis → up to 5 EvolutionProposals (origin 'self-idea',
//   approval-gated, NEVER applied) + high-confidence auto skill ideas →
//   autonomy event + system Alert → SelfUpgradeResult.
//
// LLM budget: 1 call per digest, 1 per upgrade cycle (hard ceiling 3+2 with
// retries). All calls: 30s timeout, thinking disabled, system prompt as an
// assistant-role message (the established core-call pattern).

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { getZai } from './zai'
import { getCoreTextModelSelection, noteCoreReportedModel } from './core-models'
import { domainOf, domainQuality } from './research-service'
import { getWatchlistStatus } from './watchlist-service'
import { listTools } from './tools-service'
import { saveSkill } from './skills-service'
import { logAutonomyEvent } from './autonomy-service'
import { db } from '@/lib/db'

const TREND_DIR = path.join(process.cwd(), 'db', 'notes', 'trend-digests')
const EVERGREEN_ANGLES = [
  'AI agents news',
  'new AI model releases',
  'developer tools trending',
  'AI research breakthroughs',
]
const LLM_TIMEOUT_MS = 30_000

export interface TrendItem {
  title: string
  summary: string
  source: string
  url: string
  relevance: 'high' | 'medium' | 'low'
  actionable?: string
}

export interface TrendDigest {
  generatedAt: string
  headline: string
  items: TrendItem[]
  watchlist: { topic: string; note: string }[]
}

export interface UpgradeProposal {
  title: string
  kind: 'feature' | 'fix' | 'suggestion'
  rationale: string
  target: string
}

export interface SelfUpgradeResult {
  digest: TrendDigest
  proposals: UpgradeProposal[]
  skillsProposed: string[]
  summary: string
}

// ---------- globalThis cache ----------

interface TrendGlobal {
  __mistTrendLastDigest?: TrendDigest | null
}

function trendGlobal(): TrendGlobal {
  return globalThis as unknown as TrendGlobal
}

// ---------- core LLM helper (same pattern as research-service) ----------

async function coreComplete(system: string, user: string, timeoutMs = LLM_TIMEOUT_MS): Promise<string> {
  const zai = await getZai()
  const coreTextModel = getCoreTextModelSelection()
  const completion = (await Promise.race([
    zai.chat.completions.create({
      ...(coreTextModel ? { model: coreTextModel } : {}),
      messages: [
        { role: 'assistant', content: system },
        { role: 'user', content: user },
      ],
      thinking: { type: 'disabled' },
    }),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('trend LLM timeout')), timeoutMs)),
  ])) as { model?: unknown; choices?: Array<{ message?: { content?: unknown } }> }
  noteCoreReportedModel('text', completion?.model)
  const text = completion?.choices?.[0]?.message?.content
  if (typeof text !== 'string' || !text.trim()) throw new Error('empty trend completion')
  return text.trim()
}

/** Robust JSON extraction: fenced ```json block, else first { … last }. */
function extractJson(raw: string): unknown | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw)
  const candidate = fenced ? fenced[1] : raw
  const start = candidate.indexOf('{')
  const end = candidate.lastIndexOf('}')
  if (start === -1 || end <= start) return null
  try {
    return JSON.parse(candidate.slice(start, end + 1)) as unknown
  } catch {
    return null
  }
}

// ---------- watchlist topics ----------

interface WatchTopic {
  topic: string
  note: string
  query: string
}

async function collectTopics(): Promise<WatchTopic[]> {
  const topics: WatchTopic[] = []
  try {
    const status = await getWatchlistStatus()
    for (const entry of status?.entries ?? []) {
      if (!entry?.repo) continue
      topics.push({
        topic: entry.repo,
        note: entry.note || `watched upstream project (${entry.label || entry.repo})`,
        query: `${entry.repo} latest release news`,
      })
    }
  } catch {
    // watchlist unreadable — evergreen angles below carry the digest
  }
  for (const angle of EVERGREEN_ANGLES) {
    topics.push({ topic: angle, note: 'evergreen trend angle', query: angle })
  }
  return topics.slice(0, 8) // 4-8 searches per digest
}

// ---------- search ----------

interface TrendHit {
  title: string
  url: string
  snippet: string
  host: string
  date: string | null
  quality: 'high' | 'medium' | 'low'
}

async function searchTrends(query: string): Promise<TrendHit[]> {
  const zai = await getZai()
  const results: unknown = await zai.functions.invoke('web_search', { query, num: 6, recency_days: 5 })
  if (!Array.isArray(results)) return []
  const hits: TrendHit[] = []
  for (const r of results.slice(0, 6)) {
    const rec = (r && typeof r === 'object' ? r : {}) as Record<string, unknown>
    const url = typeof rec.url === 'string' ? rec.url : ''
    if (!url.startsWith('http')) continue
    hits.push({
      title: typeof rec.name === 'string' ? rec.name : url,
      url,
      snippet: typeof rec.snippet === 'string' ? rec.snippet : '',
      host: typeof rec.host_name === 'string' ? rec.host_name : domainOf(url),
      date: typeof rec.date === 'string' ? rec.date : null,
      quality: domainQuality(url),
    })
  }
  return hits
}

function fallbackRelevance(hit: TrendHit): 'high' | 'medium' | 'low' {
  if (hit.quality === 'high' && hit.date) return 'high'
  if (hit.quality === 'high' || hit.quality === 'medium') return 'medium'
  return 'low'
}

function deterministicItems(hits: TrendHit[], max: number): TrendItem[] {
  const ranked = [...hits].sort((a, b) => {
    const qw = { high: 3, medium: 2, low: 1 } as const
    if (qw[b.quality] !== qw[a.quality]) return qw[b.quality] - qw[a.quality]
    return (b.date ? 1 : 0) - (a.date ? 1 : 0)
  })
  return ranked.slice(0, max).map((h) => ({
    title: h.title,
    summary: h.snippet || `(from ${h.host})`,
    source: h.host,
    url: h.url,
    relevance: fallbackRelevance(h),
  }))
}

// ---------- persistence ----------

function isoFileName(iso: string): string {
  return `${iso.replace(/[:.]/g, '-')}.md` // filesystem-safe ISO timestamp
}

function renderDigestMarkdown(digest: TrendDigest): string {
  const lines = [
    '---',
    `generatedAt: ${digest.generatedAt}`,
    `headline: ${digest.headline.replace(/\n/g, ' ')}`,
    `items: ${digest.items.length}`,
    '---',
    '',
    `# Trend Digest — ${digest.headline}`,
    '',
    `*Generated ${digest.generatedAt} · ${digest.items.length} items*`,
    '',
    '## Items',
    '',
    ...digest.items.flatMap((item, i) => [
      `${i + 1}. **${item.title}** — _${item.source}_ · relevance: ${item.relevance}`,
      `   ${item.summary}`,
      `   ${item.url}`,
      ...(item.actionable ? [`   ▸ actionable: ${item.actionable}`] : []),
      '',
    ]),
    '## Watchlist topics in this scan',
    '',
    ...(digest.watchlist.length > 0
      ? digest.watchlist.map((w) => `- **${w.topic}** — ${w.note}`)
      : ['- _(none — evergreen angles only)_']),
    '',
    '<!-- machine-readable digest for getLastDigest() rebuilds -->',
    '```json',
    JSON.stringify(digest, null, 2),
    '```',
    '',
  ]
  return lines.join('\n')
}

function parseDigestFile(raw: string): TrendDigest | null {
  // prefer the embedded machine-readable block
  const json = extractJson(raw)
  if (json && typeof json === 'object') {
    const d = json as Record<string, unknown>
    if (typeof d.headline === 'string' && Array.isArray(d.items)) {
      const items = (d.items as unknown[]).flatMap((it) => {
        if (!it || typeof it !== 'object') return []
        const r = it as Record<string, unknown>
        if (typeof r.title !== 'string' || typeof r.url !== 'string') return []
        return [
          {
            title: r.title,
            summary: typeof r.summary === 'string' ? r.summary : '',
            source: typeof r.source === 'string' ? r.source : domainOf(r.url),
            url: r.url,
            relevance: r.relevance === 'high' || r.relevance === 'low' ? r.relevance : 'medium',
            ...(typeof r.actionable === 'string' && r.actionable ? { actionable: r.actionable } : {}),
          } satisfies TrendItem,
        ]
      })
      const watchlist = Array.isArray(d.watchlist)
        ? (d.watchlist as unknown[]).flatMap((w) => {
            if (!w || typeof w !== 'object') return []
            const r = w as Record<string, unknown>
            if (typeof r.topic !== 'string') return []
            return [{ topic: r.topic, note: typeof r.note === 'string' ? r.note : '' }]
          })
        : []
      return {
        generatedAt: typeof d.generatedAt === 'string' ? d.generatedAt : new Date().toISOString(),
        headline: d.headline,
        items,
        watchlist,
      }
    }
  }
  // minimal rebuild: first markdown heading + frontmatter date
  const headline = /^#\s+(.+)$/m.exec(raw)?.[1]?.replace(/^Trend Digest — /, '').trim()
  const generatedAt = /^generatedAt:\s*(.+)$/m.exec(raw)?.[1]?.trim()
  if (!headline) return null
  return {
    generatedAt: generatedAt ?? new Date().toISOString(),
    headline,
    items: [],
    watchlist: [],
  }
}

// ---------- public API ----------

export async function runTrendDigest(): Promise<TrendDigest> {
  const startedNote = 'Trend scan running'
  try {
    const topics = await collectTopics()
    const watchlistNotes = topics
      .filter((t) => !EVERGREEN_ANGLES.includes(t.topic))
      .map((t) => ({ topic: t.topic, note: t.note }))
    const watchlistField =
      watchlistNotes.length > 0
        ? watchlistNotes
        : [{ topic: 'evergreen angles', note: 'no watchlist topics found — default angles used' }]

    // 4-8 recency-scoped searches, deduped by URL
    const byUrl = new Map<string, TrendHit>()
    for (const t of topics) {
      try {
        for (const hit of await searchTrends(t.query)) {
          if (!byUrl.has(hit.url)) byUrl.set(hit.url, hit)
        }
      } catch {
        // per-search best effort
      }
    }
    const hits = [...byUrl.values()]

    // ONE LLM synthesis (budget: max ~3 calls — this is call #1)
    let digest: TrendDigest | null = null
    if (hits.length > 0) {
      try {
        const hitBlock = hits
          .slice(0, 18)
          .map((h, i) => `(${i + 1}) ${h.title} | src: ${h.host} | date: ${h.date ?? 'unknown'} | ${h.url}\n    ${h.snippet.slice(0, 260)}`)
          .join('\n')
        const raw = await coreComplete(
          'You are MIST\u2019s trend analyst. From the web-search results below, pick the 5-10 most significant, ' +
            'interesting or actionable developments and synthesize a trend digest. ' +
            'RULES: Copy URLs EXACTLY as given — never invent or modify a URL. Each summary is 1-2 factual sentences ' +
            'grounded in the result text. relevance is high/medium/low vs MIST (an AI companion with 46+ tools, skills, ' +
            'memory and a self-evolution engine). Add "actionable" ONLY when MIST could concretely act on it ' +
            '(a tool to add, a skill to learn, a technique to adopt). The headline is one punchy sentence (max 14 words). ' +
            'Reply with STRICT JSON only, no prose:\n' +
            '{"headline": "...", "items": [{"title": "...", "summary": "...", "source": "hostname", "url": "...", ' +
            '"relevance": "high|medium|low", "actionable": "optional short note"}]}',
          `TODAY: ${new Date().toISOString().slice(0, 10)}\nWATCHED TOPICS: ${topics.map((t) => t.topic).join(', ')}\n\nSEARCH RESULTS:\n${hitBlock}`
        )
        const parsed = extractJson(raw)
        if (parsed && typeof parsed === 'object') {
          const p = parsed as Record<string, unknown>
          const urlSet = new Set(hits.map((h) => h.url))
          const items = (Array.isArray(p.items) ? p.items : []).flatMap((it): TrendItem[] => {
            if (!it || typeof it !== 'object') return []
            const r = it as Record<string, unknown>
            if (typeof r.title !== 'string' || typeof r.url !== 'string' || !urlSet.has(r.url)) return []
            const host = domainOf(r.url)
            return [
              {
                title: r.title.slice(0, 220),
                summary: typeof r.summary === 'string' ? r.summary.slice(0, 420) : '',
                source: typeof r.source === 'string' && r.source ? r.source : host,
                url: r.url,
                relevance: r.relevance === 'high' || r.relevance === 'low' ? r.relevance : 'medium',
                ...(typeof r.actionable === 'string' && r.actionable.trim()
                  ? { actionable: r.actionable.trim().slice(0, 240) }
                  : {}),
              },
            ]
          })
          if (items.length >= 3) {
            digest = {
              generatedAt: new Date().toISOString(),
              headline:
                typeof p.headline === 'string' && p.headline.trim()
                  ? p.headline.trim().slice(0, 160)
                  : `Tech pulse: ${items[0].title}`,
              items: items.slice(0, 10),
              watchlist: watchlistField,
            }
          }
        }
      } catch {
        // LLM synthesis failed → deterministic digest below
      }
    }

    // deterministic fallback (also covers <3 LLM-picked items)
    if (!digest) {
      if (hits.length === 0) {
        const empty: TrendDigest = {
          generatedAt: new Date().toISOString(),
          headline: `No fresh trend data available — searches returned nothing (${startedNote.toLowerCase()} failed)`,
          items: [],
          watchlist: watchlistField,
        }
        trendGlobal().__mistTrendLastDigest = empty
        return empty
      }
      const items = deterministicItems(hits, 10)
      digest = {
        generatedAt: new Date().toISOString(),
        headline: `Tech pulse: ${items[0]?.title ?? 'latest AI and developer developments'}`,
        items,
        watchlist: watchlistField,
      }
    }

    // persist + cache + autonomy event (all best-effort, never fatal)
    try {
      await fsp.mkdir(TREND_DIR, { recursive: true })
      await fsp.writeFile(path.join(TREND_DIR, isoFileName(digest.generatedAt)), renderDigestMarkdown(digest), 'utf-8')
    } catch {
      // persistence is best-effort — the digest is still returned + cached
    }
    trendGlobal().__mistTrendLastDigest = digest
    await logAutonomyEvent('trend_digest', digest.headline, {
      items: digest.items.length,
      watchlist: digest.watchlist.length,
      generatedAt: digest.generatedAt,
    })
    return digest
  } catch (err) {
    // absolute never-throw guarantee
    const digest: TrendDigest = {
      generatedAt: new Date().toISOString(),
      headline: 'Trend digest incomplete — an unexpected error occurred during the scan',
      items: [],
      watchlist: [],
    }
    trendGlobal().__mistTrendLastDigest = digest
    await logAutonomyEvent('trend_digest', digest.headline, {
      error: err instanceof Error ? err.message : 'unknown',
    }).catch(() => undefined)
    return digest
  }
}

export function getLastDigest(): TrendDigest | null {
  const g = trendGlobal()
  if (g.__mistTrendLastDigest) return g.__mistTrendLastDigest
  try {
    const files = fs
      .readdirSync(TREND_DIR)
      .filter((f) => f.endsWith('.md'))
      .sort()
      .reverse() // ISO names sort chronologically
    if (files.length === 0) return null
    const raw = fs.readFileSync(path.join(TREND_DIR, files[0]), 'utf-8')
    const digest = parseDigestFile(raw)
    if (digest) {
      g.__mistTrendLastDigest = digest
      return digest
    }
    return null
  } catch {
    return null
  }
}

/** Digest archive index (newest first) — powers GET /api/mist/trends history. */
export async function listDigestHistory(limit = 20): Promise<Array<{ generatedAt: string; headline: string }>> {
  try {
    const files = (await fsp.readdir(TREND_DIR)).filter((f) => f.endsWith('.md')).sort().reverse()
    const history: Array<{ generatedAt: string; headline: string }> = []
    for (const file of files.slice(0, Math.max(1, limit))) {
      try {
        const raw = await fsp.readFile(path.join(TREND_DIR, file), 'utf-8')
        const digest = parseDigestFile(raw)
        if (digest) history.push({ generatedAt: digest.generatedAt, headline: digest.headline })
      } catch {
        // unreadable file — skip it
      }
    }
    return history
  } catch {
    return []
  }
}

// ---------- self-upgrade cycle ----------

interface LlmUpgradeProposal {
  title: string
  kind: 'feature' | 'fix' | 'suggestion'
  target: string
  summary: string
  rationale: string
  changes: Array<{ path: string; kind: 'create' | 'edit'; description: string }>
  skill: {
    name: string
    trigger: string
    steps: string
    toolChain: string[]
    confidence: number
  } | null
}

// conservative safety net for auto-proposed skill tool chains — nothing that
// writes, deletes, shells out or otherwise mutates the system
const UNSAFE_TOOL_RE = /write|delete|remove|drop|patch|exec|shell|command|terminal|install|deploy|reset|reboot/i

function safeToolChain(chain: unknown, implementedTools: Set<string>): chain is string[] {
  if (!Array.isArray(chain) || chain.length === 0 || chain.length > 5) return false
  return chain.every(
    (t) => typeof t === 'string' && implementedTools.has(t) && !UNSAFE_TOOL_RE.test(t) && !t.startsWith('skill:')
  )
}

/**
 * Mark a skill as MIST's own idea (origin 'auto' + LLM confidence).
 * saveSkill() upserts with the default origin 'user', so we patch it here.
 * Falls back to parameterized raw SQL: a long-running dev server can hold
 * a pre-v5 generated Prisma client that rejects the origin/confidence fields
 * even though the SQLite schema already has the columns. Best-effort either way.
 */
async function markSkillAuto(name: string, confidence: number): Promise<void> {
  try {
    await db.skill.update({ where: { name }, data: { origin: 'auto', confidence } })
    return
  } catch {
    // fall through to the raw fallback
  }
  try {
    await db.$executeRaw`UPDATE Skill SET origin = 'auto', confidence = ${confidence} WHERE name = ${name}`
  } catch {
    // best-effort — the skill is still saved, only the origin tag is missed
  }
}

/**
 * Existing skill origin, or null when the name is free. 'unknown' when the DB
 * cannot answer (both the typed and raw paths failed). Uses raw SQL fallback
 * for the same stale-client reason as markSkillAuto.
 */
async function skillOriginOf(name: string): Promise<string | null | 'unknown'> {
  try {
    const row = await db.skill.findUnique({ where: { name }, select: { origin: true } })
    return row?.origin ?? null
  } catch {
    // stale pre-v5 client — raw fallback
  }
  try {
    const rows = await db.$queryRaw<Array<{ origin: string }>>`SELECT origin FROM Skill WHERE name = ${name}`
    return rows.length > 0 ? rows[0].origin : null
  } catch {
    return 'unknown'
  }
}

function parseUpgradeProposals(raw: string): LlmUpgradeProposal[] {
  const parsed = extractJson(raw)
  if (!parsed || typeof parsed !== 'object') return []
  const p = parsed as Record<string, unknown>
  if (!Array.isArray(p.proposals)) return []
  const out: LlmUpgradeProposal[] = []
  for (const item of p.proposals) {
    if (!item || typeof item !== 'object') continue
    const r = item as Record<string, unknown>
    const title = typeof r.title === 'string' ? r.title.trim().slice(0, 120) : ''
    if (!title) continue
    const kind = r.kind === 'feature' || r.kind === 'fix' ? r.kind : 'suggestion'
    const changes = (Array.isArray(r.changes) ? r.changes : []).flatMap((c): LlmUpgradeProposal['changes'] => {
      if (!c || typeof c !== 'object') return []
      const cr = c as Record<string, unknown>
      if (typeof cr.path !== 'string' || typeof cr.description !== 'string') return []
      return [
        {
          path: cr.path.slice(0, 200),
          kind: cr.kind === 'create' ? 'create' : 'edit',
          description: cr.description.slice(0, 500),
        },
      ]
    })
    let skill: LlmUpgradeProposal['skill'] = null
    if (r.skill && typeof r.skill === 'object') {
      const s = r.skill as Record<string, unknown>
      if (typeof s.name === 'string' && typeof s.trigger === 'string') {
        skill = {
          name: s.name.trim().slice(0, 80),
          trigger: s.trigger.trim().slice(0, 300),
          steps: typeof s.steps === 'string' ? s.steps.slice(0, 4000) : '',
          toolChain: Array.isArray(s.toolChain)
            ? s.toolChain.filter((t): t is string => typeof t === 'string')
            : [],
          confidence: Number(s.confidence) || 0,
        }
      }
    }
    out.push({
      title,
      kind,
      target: typeof r.target === 'string' ? r.target.slice(0, 60) : 'behavior',
      summary: typeof r.summary === 'string' ? r.summary.slice(0, 600) : title,
      rationale: typeof r.rationale === 'string' ? r.rationale.slice(0, 1500) : '',
      changes: changes.slice(0, 6),
      skill,
    })
  }
  return out.slice(0, 5)
}

export async function runSelfUpgradeCycle(): Promise<SelfUpgradeResult> {
  // 1 — fresh digest first (never throws)
  const digest = await runTrendDigest()

  const proposalsOut: UpgradeProposal[] = []
  const skillsProposed: string[] = []

  try {
    // 2 — capability surface (read-only imports: tools-service + db)
    const [tools, skills] = await Promise.all([
      listTools().catch(() => []),
      db.skill.findMany({ select: { name: true, trigger: true } }).catch(() => []),
    ])
    const implementedTools = new Set(tools.filter((t) => t.implemented).map((t) => t.name))

    // 3 — ONE LLM gap analysis (budget: max ~2 calls per cycle — this is call #1)
    let llmProposals: LlmUpgradeProposal[] = []
    if (digest.items.length > 0) {
      try {
        const trendBlock = digest.items
          .map((i) => `- ${i.title} (${i.source}): ${i.summary} ${i.actionable ? `[actionable: ${i.actionable}]` : ''} ${i.url}`)
          .join('\n')
        const capabilityBlock =
          `TOOLS (${tools.length}): ${tools.map((t) => t.name).join(', ')}\n` +
          `SKILLS (${skills.length}): ${skills.map((s) => s.name).join(', ') || 'none yet'}`
        const raw = await coreComplete(
          'You are MIST\u2019s self-improvement analyst. MIST is a local-first AI companion (Next.js app) with a ' +
            'tool registry, learned skills, long-term/vector memory, a heartbeat scheduler and an approval-gated ' +
            'self-evolution engine that can propose code changes. Compare the CURRENT TRENDS against MIST\u2019s ' +
            'CAPABILITIES and propose up to 5 concrete, high-value upgrades. RULES: every proposal must be justified ' +
            'by at least one trend (cite its title/URL in the rationale); be specific (what to add/improve and how); ' +
            'target is one of tool|skill|behavior|ui. If a proposal is a learnable procedure with a clear, SAFE tool ' +
            'chain (read-only tools like web_search, page_reader, memory search), include a "skill" object with a ' +
            'kebab-case name and confidence 0-1; omit "skill" (null) otherwise. Proposals are approval-gated — ' +
            'they are never auto-applied. Reply with STRICT JSON only:\n' +
            '{"proposals": [{"title": "...", "kind": "feature|fix|suggestion", "target": "tool|skill|behavior|ui", ' +
            '"summary": "2-3 sentences", "rationale": "why now, citing trend titles/URLs", ' +
            '"changes": [{"path": "src/...", "kind": "create|edit", "description": "..."}], ' +
            '"skill": {"name": "kebab-case", "trigger": "when to use it", "steps": "numbered steps", ' +
            '"toolChain": ["tool names"], "confidence": 0.85}}]}',
          `TREND DIGEST — ${digest.headline} (${digest.generatedAt}):\n${trendBlock}\n\nMIST CAPABILITIES:\n${capabilityBlock}`
        )
        llmProposals = parseUpgradeProposals(raw)
      } catch {
        // no proposals without the LLM — honest empty cycle
      }
    }

    // 4 — persist proposals (approval-gated — NEVER applied) + auto skills
    if (llmProposals.length > 0) {
      const recent = await db.evolutionProposal
        .findMany({ select: { title: true }, orderBy: { createdAt: 'desc' }, take: 60 })
        .catch(() => [])
      const seen = new Set(recent.map((r) => r.title.toLowerCase()))
      for (const p of llmProposals) {
        if (seen.has(p.title.toLowerCase())) continue // no duplicate proposals across cycles
        seen.add(p.title.toLowerCase())
        try {
          await db.evolutionProposal.create({
            data: {
              kind: 'suggestion',
              title: p.title,
              summary: p.summary,
              rationale: p.rationale,
              origin: 'self-idea',
              status: 'pending',
              targetFiles: '[]',
              changes: JSON.stringify(p.changes),
            },
          })
        } catch {
          continue // DB hiccup on one row must not kill the cycle
        }
        proposalsOut.push({ title: p.title, kind: p.kind, rationale: p.rationale, target: p.target })

        // high-confidence skill ideas with a safe, existing tool chain → save
        if (
          skillsProposed.length < 3 &&
          p.skill &&
          p.skill.confidence >= 0.7 &&
          safeToolChain(p.skill.toolChain, implementedTools)
        ) {
          try {
            // provenance guard: never overwrite or re-tag a user-created skill —
            // if the name already exists as the user's, the gap is already covered
            const existingOrigin = await skillOriginOf(p.skill.name)
            if (existingOrigin === null) {
              await saveSkill({
                name: p.skill.name,
                trigger: p.skill.trigger,
                steps: p.skill.steps,
                tool_chain: p.skill.toolChain,
                notes: `auto-proposed by the self-upgrade cycle — trend: ${digest.headline}`,
              })
              await markSkillAuto(p.skill.name, p.skill.confidence)
              skillsProposed.push(p.skill.name)
            } else if (existingOrigin === 'auto') {
              // MIST's own skill — refine it in place, keep the auto provenance
              await saveSkill({
                name: p.skill.name,
                trigger: p.skill.trigger,
                steps: p.skill.steps,
                tool_chain: p.skill.toolChain,
                notes: `refined by the self-upgrade cycle — trend: ${digest.headline}`,
              })
              await markSkillAuto(p.skill.name, p.skill.confidence)
              skillsProposed.push(p.skill.name)
            }
          } catch {
            // best-effort skill save
          }
        }
      }
    }
  } catch {
    // capability loading or persistence failed — return what we have honestly
  }

  // 5 — autonomy event + system alert (the heartbeat delivers it into chat)
  const summary =
    `Self-upgrade scan complete — digest "${digest.headline}" → ${proposalsOut.length} upgrade proposal(s), ` +
    `${skillsProposed.length} auto skill idea(s).`
  await logAutonomyEvent('upgrade_proposed', summary, {
    headline: digest.headline,
    proposals: proposalsOut.length,
    skills: skillsProposed.length,
    titles: proposalsOut.map((p) => p.title),
  })
  try {
    const body =
      `${digest.headline}\n\n` +
      `Upgrade proposals: ${proposalsOut.length}` +
      (proposalsOut.length > 0 ? `\n${proposalsOut.map((p) => `• ${p.title} (${p.target})`).join('\n')}` : '') +
      `\n\nAuto skill ideas: ${skillsProposed.length}` +
      (skillsProposed.length > 0 ? `\n${skillsProposed.map((s) => `• ${s}`).join('\n')}` : '') +
      `\n\nAll proposals are pending approval — nothing has been applied.`
    await db.alert.create({
      data: {
        kind: 'system',
        status: 'pending',
        title: 'Self-upgrade scan',
        body: body.slice(0, 4000),
      },
    })
  } catch {
    // alert is best-effort
  }

  return { digest, proposals: proposalsOut, skillsProposed, summary }
}
