// M.I.S.T. research service v2 — observable, job-based deep research.
//
// Pipeline: plan queries (LLM) → multi-query web search → domain credibility
// scoring → read the best pages (page_reader) → synthesize with inline [n]
// citations (LLM) → persist db/notes/research/<yyyy-mm-dd>-<slug>.md.
//
// v2 wraps the pipeline in a detached BACKGROUND JOB (globalThis registry)
// with live phase tracking so the UI can poll progress:
//   planning → searching → reading → synthesizing → done|error
//
// COMPATIBILITY: tools-service imports `deepResearch(question, depth)` for the
// `deep_research` chat tool — that export is preserved as a thin wrapper that
// runs the same engine to completion and returns the classic ResearchReport.

import fs from 'node:fs/promises'
import path from 'node:path'
import type { Citation, ResearchReport } from '@/lib/types'
import { getZai } from './zai'
import { getCoreTextModelSelection, noteCoreReportedModel } from './core-models'
import { tokenize } from './vector-service'

// ---------- domain credibility ----------

const HIGH_QUALITY_DOMAINS = new Set([
  'arxiv.org', 'nature.com', 'science.org', 'ieee.org', 'acm.org', 'who.int', 'un.org',
  'nasa.gov', 'reuters.com', 'apnews.com', 'bbc.com', 'github.com', 'stackoverflow.com',
  'developer.mozilla.org', 'docs.python.org', 'wikipedia.org', 'nytimes.com', 'theguardian.com',
  'economist.com', 'ft.com', 'bloomberg.com', 'wsj.com', 'nih.gov', 'pubmed.ncbi.nlm.nih.gov',
])

const MEDIUM_QUALITY_DOMAINS = new Set([
  'theverge.com', 'techcrunch.com', 'wired.com', 'arstechnica.com', 'engadget.com',
  'zdnet.com', 'cnet.com', 'tomshardware.com', 'anandtech.com', 'xda-developers.com',
  'androidauthority.com', '9to5mac.com', '9to5google.com', 'macrumors.com',
  'cnn.com', 'foxnews.com', 'cnbc.com', 'forbes.com', 'time.com', 'newsweek.com',
  'reddit.com', 'news.ycombinator.com', 'stackexchange.com', 'superuser.com',
  'apple.com', 'microsoft.com', 'google.com', 'openai.com', 'anthropic.com', 'anthropic.com',
  'meta.com', 'nvidia.com', 'amd.com', 'intel.com', 'mozilla.org', 'linux.org', 'kernel.org',
])

const LOW_QUALITY_DOMAINS = new Set([
  'pinterest.com', 'quora.com', 'facebook.com', 'tiktok.com', 'buzzfeed.com',
  'dailymail.co.uk', 'thesun.co.uk', 'nypost.com', 'medium.com', 'substack.com',
  'wikihow.com', 'answers.com', 'ask.com', 'yahoo.com',
])

export function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase()
  } catch {
    return ''
  }
}

export function domainQuality(url: string): 'high' | 'medium' | 'low' {
  const d = domainOf(url)
  if (!d) return 'low'
  // high/medium sets include suffix matches (e.g. en.wikipedia.org → wikipedia.org)
  const parts = d.split('.')
  for (let i = 0; i < parts.length - 1; i++) {
    const suffix = parts.slice(i).join('.')
    if (HIGH_QUALITY_DOMAINS.has(suffix)) return 'high'
    if (MEDIUM_QUALITY_DOMAINS.has(suffix)) return 'medium'
  }
  if (LOW_QUALITY_DOMAINS.has(d)) return 'low'
  if (d.endsWith('.gov') || d.endsWith('.edu')) return 'high'
  if (d.startsWith('docs.') || d.startsWith('developer.')) return 'high'
  return 'medium'
}

// ---------- LLM helper (local core — no circular import with llm-service) ----------

async function coreComplete(system: string, user: string, timeoutMs = 60_000): Promise<string> {
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
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('research LLM timeout')), timeoutMs)),
  ])) as { model?: unknown; choices?: Array<{ message?: { content?: unknown } }> }
  noteCoreReportedModel('text', completion?.model)
  const text = completion?.choices?.[0]?.message?.content
  if (typeof text !== 'string' || !text.trim()) throw new Error('empty research completion')
  return text.trim()
}

// ---------- search + read ----------

interface SearchHit {
  name: string
  url: string
  snippet: string
  host_name: string
  date: string | null
  quality: 'high' | 'medium' | 'low'
  score: number
}

async function searchOnce(query: string, num: number): Promise<SearchHit[]> {
  const zai = await getZai()
  const results: unknown = await zai.functions.invoke('web_search', { query, num })
  if (!Array.isArray(results)) return []
  return results.slice(0, num).map((r) => {
    const rec = (r && typeof r === 'object' ? r : {}) as Record<string, unknown>
    const url = typeof rec.url === 'string' ? rec.url : ''
    const name = typeof rec.name === 'string' ? rec.name : ''
    const snippet = typeof rec.snippet === 'string' ? rec.snippet : ''
    return {
      name,
      url,
      snippet,
      host_name: typeof rec.host_name === 'string' ? rec.host_name : domainOf(url),
      date: typeof rec.date === 'string' ? rec.date : null,
      quality: domainQuality(url),
      score: 0,
    }
  })
}

interface ReadPage {
  url: string
  title: string
  domain: string
  quality: 'high' | 'medium' | 'low'
  excerpt: string
  read: boolean
}

async function readPageSafe(url: string, maxChars: number): Promise<ReadPage | null> {
  try {
    const zai = await getZai()
    const result = (await zai.functions.invoke('page_reader', { url })) as {
      data?: { title?: string; html?: string; url?: string }
    }
    const html = result?.data?.html ?? ''
    const text = html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]*>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/\s+/g, ' ')
      .trim()
    if (!text) return null
    return {
      url,
      title: result?.data?.title ?? url,
      domain: domainOf(url),
      quality: domainQuality(url),
      excerpt: text.slice(0, maxChars),
      read: true,
    }
  } catch {
    return null
  }
}

function relevance(hit: SearchHit, question: string): number {
  const qTokens = new Set(tokenize(question))
  if (qTokens.size === 0) return 0
  const text = `${hit.name} ${hit.snippet} ${hit.host_name}`.toLowerCase()
  const tTokens = tokenize(text)
  let overlap = 0
  for (const t of tTokens) if (qTokens.has(t)) overlap++
  return overlap / qTokens.size
}

// ---------- v2 job registry (globalThis — survives HMR, one map per server) ----------

export type ResearchJobStatus = 'running' | 'done' | 'error'
export type ResearchPhase = 'planning' | 'searching' | 'reading' | 'synthesizing'
export type ResearchPhaseStatus = 'pending' | 'active' | 'done' | 'error'

export interface ResearchJobSource {
  title: string
  url: string
  host: string
  credibility: 'high' | 'medium' | 'low'
  read: boolean
}

export interface ResearchJobPhase {
  name: ResearchPhase
  status: ResearchPhaseStatus
}

export interface ResearchJobCitation {
  title: string
  url: string
  verified: boolean
}

export interface ResearchJob {
  id: string
  query: string
  depth: number
  status: ResearchJobStatus
  phase: ResearchPhase
  phaseIndex: number
  phases: ResearchJobPhase[]
  queries: string[]
  sources: ResearchJobSource[]
  pagesRead: number
  startedAt: number
  elapsedMs: number
  report?: string
  citations?: ResearchJobCitation[]
  suggestions?: string[]
  savedTo?: string
  error?: string
}

const PHASE_ORDER: ResearchPhase[] = ['planning', 'searching', 'reading', 'synthesizing']
const JOB_TTL_MS = 30 * 60 * 1000 // drop jobs older than 30 min
const JOB_CAP = 20 // …or cap the map at 20, whichever hits first

interface ResearchJobGlobal {
  __mistResearchJobs?: Map<string, ResearchJob>
}

function jobRegistry(): Map<string, ResearchJob> {
  const g = globalThis as unknown as ResearchJobGlobal
  g.__mistResearchJobs ??= new Map<string, ResearchJob>()
  return g.__mistResearchJobs
}

/** Drop stale (>30 min) and overflow (>20) jobs. */
function gcJobs(): void {
  const reg = jobRegistry()
  const now = Date.now()
  for (const [id, job] of reg) {
    if (now - job.startedAt > JOB_TTL_MS) reg.delete(id)
  }
  while (reg.size > JOB_CAP) {
    let oldestId: string | null = null
    let oldest = Number.POSITIVE_INFINITY
    for (const [id, job] of reg) {
      if (job.startedAt < oldest) {
        oldest = job.startedAt
        oldestId = id
      }
    }
    if (!oldestId) break
    reg.delete(oldestId)
  }
}

function newJob(query: string, depth: number): ResearchJob {
  return {
    id: crypto.randomUUID(),
    query,
    depth,
    status: 'running',
    phase: 'planning',
    phaseIndex: 0,
    phases: PHASE_ORDER.map((name) => ({ name, status: 'pending' as ResearchPhaseStatus })),
    queries: [],
    sources: [],
    pagesRead: 0,
    startedAt: Date.now(),
    elapsedMs: 0,
  }
}

function setPhase(job: ResearchJob, phase: ResearchPhase): void {
  const idx = PHASE_ORDER.indexOf(phase)
  job.phase = phase
  job.phaseIndex = idx
  job.phases.forEach((p, i) => {
    if (i < idx && p.status !== 'error') p.status = 'done'
    else if (i === idx) p.status = 'active'
  })
  job.elapsedMs = Date.now() - job.startedAt
}

function finishPhases(job: ResearchJob): void {
  for (const p of job.phases) if (p.status !== 'error') p.status = 'done'
}

function failJob(job: ResearchJob, message: string): void {
  job.status = 'error'
  job.error = message
  const cur = job.phases[job.phaseIndex]
  if (cur && cur.status === 'active') cur.status = 'error'
  job.elapsedMs = Date.now() - job.startedAt
}

/** Live view of a job (elapsedMs ticks while running). */
export function serializeResearchJob(job: ResearchJob): ResearchJob {
  return job.status === 'running'
    ? { ...job, elapsedMs: Date.now() - job.startedAt }
    : job
}

/** Kick off a DETACHED research job. Returns immediately with the job record. */
export function startResearchJob(query: string, depth = 1): ResearchJob {
  gcJobs()
  const job = newJob(query, Math.max(1, Math.min(2, Math.round(depth))))
  jobRegistry().set(job.id, job)
  // fire-and-forget: the pipeline never rejects (all failures land in job.error)
  void runResearchPipeline(job)
  return job
}

export function getResearchJob(id: string): ResearchJob | undefined {
  gcJobs()
  return jobRegistry().get(id)
}

export interface ResearchJobSummary {
  id: string
  query: string
  depth: number
  status: ResearchJobStatus
  phase: ResearchPhase | null
  startedAt: number
  elapsedMs: number
  sourcesFound: number
  pagesRead: number
  error?: string
}

/** Recent jobs (newest first), trimmed to the summary shape. */
export function listResearchJobs(limit = 15): ResearchJobSummary[] {
  gcJobs()
  const jobs = [...jobRegistry().values()].sort((a, b) => b.startedAt - a.startedAt)
  return jobs.slice(0, Math.max(1, limit)).map((j) => ({
    id: j.id,
    query: j.query,
    depth: j.depth,
    status: j.status,
    phase: j.status === 'running' ? j.phase : null,
    startedAt: j.startedAt,
    elapsedMs: j.status === 'running' ? Date.now() - j.startedAt : j.elapsedMs,
    sourcesFound: j.sources.length,
    pagesRead: j.pagesRead,
    ...(j.error ? { error: j.error } : {}),
  }))
}

// ---------- report persistence ----------

function slugifyQuery(query: string): string {
  return (
    query
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'research'
  )
}

async function persistReportFile(
  job: ResearchJob,
  citations: ResearchJobCitation[]
): Promise<string | null> {
  try {
    const dir = path.join(process.cwd(), 'db', 'notes', 'research')
    await fs.mkdir(dir, { recursive: true })
    const date = new Date().toISOString().slice(0, 10) // yyyy-mm-dd
    const slug = slugifyQuery(job.query)
    let file = path.join(dir, `${date}-${slug}.md`)
    try {
      await fs.access(file)
      // same query researched twice today — suffix with a short id
      file = path.join(dir, `${date}-${slug}-${job.id.slice(0, 8)}.md`)
    } catch {
      // not present — keep the clean name
    }
    const body = job.report ?? ''
    // the synthesis usually opens with its own "# question" heading — don't duplicate it
    const heading = /^#\s/.test(body) ? '' : `# ${job.query}\n\n`
    const lines = [
      '---',
      `query: ${job.query.replace(/\n/g, ' ')}`,
      `date: ${new Date(job.startedAt).toISOString()}`,
      `depth: ${job.depth}`,
      `sources_found: ${job.sources.length}`,
      `pages_read: ${job.pagesRead}`,
      `elapsed_ms: ${job.elapsedMs}`,
      '---',
      '',
      heading,
      body,
      '',
      '## Sources',
      ...job.sources.map(
        (s, i) => `${i + 1}. [${s.title || s.url}](${s.url}) — ${s.host} (${s.credibility} credibility${s.read ? ', read' : ''})`
      ),
      '',
      '## Verified citations',
      ...(citations.length > 0
        ? citations.map((c, i) => `${i + 1}. [${c.title || c.url}](${c.url})${c.verified ? ' (verified — page read)' : ' (unverified — snippet only)'}`)
        : ['_(none — the report relied on search snippets)_']),
      '',
      `*Queries used: ${job.queries.join(' · ')}*`,
      '',
    ]
    await fs.writeFile(file, lines.join('\n'), 'utf-8')
    return file
  } catch {
    return null // persistence is best-effort; the job still completes
  }
}

// ---------- the v2 pipeline (updates the job record at EVERY phase transition) ----------

async function runResearchPipeline(job: ResearchJob): Promise<void> {
  const d = job.depth
  try {
    // 1 — plan queries (fallback: the question itself)
    setPhase(job, 'planning')
    let queries: string[] = []
    try {
      const plan = await coreComplete(
        'You are a research planner. Given a question, output 2-3 short, diverse web-search queries ' +
          '(different angles: the thing itself, comparisons/reviews, latest news). ' +
          'Reply with ONLY the queries, one per line, no numbering, no quotes.',
        job.query,
        20_000
      )
      queries = plan
        .split('\n')
        .map((l) => l.replace(/^[-*\d.\s]+/, '').trim())
        .filter((l) => l.length > 2)
        .slice(0, 3)
    } catch {
      /* fall through to the question itself */
    }
    if (queries.length === 0) queries = [job.query]
    job.queries = queries

    // 2 — search every query; sources accumulate live for polling
    setPhase(job, 'searching')
    const hitMap = new Map<string, SearchHit>()
    const numPerQuery = d >= 2 ? 6 : 5
    for (const q of queries) {
      try {
        const hits = await searchOnce(q, numPerQuery)
        for (const hit of hits) {
          if (!hit.url.startsWith('http')) continue
          if (domainQuality(hit.url) === 'low') continue // never cite junk
          if (!hitMap.has(hit.url)) hitMap.set(hit.url, hit)
          job.sources = [...hitMap.values()].map((h) => ({
            title: h.name || h.url,
            url: h.url,
            host: h.host_name || domainOf(h.url),
            credibility: h.quality,
            read: false,
          }))
        }
      } catch {
        /* search best-effort per query */
      }
    }
    if (hitMap.size === 0) {
      throw new Error('No usable sources were found for this question — try rephrasing it.')
    }

    // 3 — rank: quality first, then relevance
    const ranked = [...hitMap.values()]
      .map((h) => ({ ...h, score: relevance(h, job.query) }))
      .sort((a, b) => {
        const qw = { high: 3, medium: 2, low: 1 } as const
        if (qw[b.quality] !== qw[a.quality]) return qw[b.quality] - qw[a.quality]
        return b.score - a.score
      })
      .slice(0, 6)

    // 4 — read the top pages (2 at depth 1, 4 at depth 2)
    setPhase(job, 'reading')
    const readCount = d >= 2 ? 4 : 2
    const pages: ReadPage[] = []
    for (const hit of ranked.slice(0, readCount)) {
      const page = await readPageSafe(hit.url, 3200)
      if (page) {
        pages.push(page)
        job.pagesRead = pages.length
        const src = job.sources.find((s) => s.url === hit.url)
        if (src) src.read = true
        job.elapsedMs = Date.now() - job.startedAt
      }
    }

    // 5 — synthesize with citations (+ follow-up suggestions parsed out of the report)
    setPhase(job, 'synthesizing')
    const sourcesBlock =
      pages.length > 0
        ? pages
            .map((p, i) => `SOURCE [${i + 1}] (${p.quality} credibility · ${p.domain})\nTitle: ${p.title}\nURL: ${p.url}\nContent: ${p.excerpt}`)
            .join('\n\n---\n\n')
        : 'NO PAGES COULD BE READ — rely on search snippets below only, and say so honestly.\n' +
          ranked.map((h, i) => `SNIPPET [${i + 1}] ${h.name} (${h.host_name}): ${h.snippet}`).join('\n')

    const rawReport = await coreComplete(
      'You are MIST\u2019s research analyst. Write a detailed, well-structured markdown research brief answering the user\u2019s question. ' +
        'RULES: Lead with the direct answer, then detail (context, specifics, numbers, dates). ' +
        'Cite sources inline as [1], [2] matching the SOURCE/SNIPPET numbers — cite only what the sources actually support. ' +
        'Use ONLY source-supported facts plus clearly-reasoned analysis; never invent URLs, numbers, or quotes. ' +
        'If sources conflict, say so explicitly. Note the publication recency when relevant. ' +
        'End with a "## Key takeaways" section of 3-5 bullets, then a final line exactly formatted ' +
        '"SUGGESTIONS: <follow-up question> | <follow-up question>" with 2-3 short follow-up research questions. ' +
        'Length: thorough but focused (~250-450 words).',
      `QUESTION: ${job.query}\n\n${sourcesBlock}`,
      75_000
    )

    // peel the SUGGESTIONS line out of the report (it is metadata, not prose)
    let report = rawReport
    const suggestions: string[] = []
    const sugMatch = /SUGGESTIONS:\s*(.+)$/im.exec(report)
    if (sugMatch) {
      suggestions.push(
        ...sugMatch[1]
          .split('|')
          .map((s) => s.replace(/^[-*\d.\s]+/, '').trim())
          .filter((s) => s.length > 4 && s.length < 220)
          .slice(0, 3)
      )
      report = report.slice(0, sugMatch.index).trimEnd()
    }
    job.report = report
    job.suggestions = suggestions

    // 6 — build the citation list from the [n] markers actually used
    const used = new Set<number>()
    for (const m of report.matchAll(/\[(\d{1,2})\]/g)) used.add(Number(m[1]))
    const citations: Citation[] = []
    const pool: Array<ReadPage | SearchHit> = pages.length > 0 ? pages : ranked
    pool.forEach((p, i) => {
      const n = i + 1
      if (!used.has(n)) return
      citations.push({
        n,
        url: p.url,
        title: 'title' in p && p.title ? p.title : p.url,
        domain: 'domain' in p ? p.domain : p.host_name,
        quality: p.quality,
        verified: pages.length > 0 ? pages.some((pg) => pg.url === p.url) : false,
      })
    })
    if (citations.length === 0 && pool.length > 0) {
      // model forgot markers — still surface the top sources honestly
      pool.slice(0, Math.min(3, pool.length)).forEach((p, i) => {
        citations.push({
          n: i + 1,
          url: p.url,
          title: 'title' in p && p.title ? p.title : p.url,
          domain: 'domain' in p ? p.domain : p.host_name,
          quality: p.quality,
          verified: pages.length > 0 ? pages.some((pg) => pg.url === p.url) : false,
        })
      })
    }
    job.citations = citations.map((c) => ({ title: c.title, url: c.url, verified: c.verified }))

    // 7 — persist the report file, then close the job out
    const savedTo = await persistReportFile(job, job.citations)
    if (savedTo) job.savedTo = savedTo
    finishPhases(job)
    job.status = 'done'
    job.elapsedMs = Date.now() - job.startedAt
  } catch (err) {
    failJob(job, err instanceof Error ? err.message : 'research failed unexpectedly')
  }
}

// ---------- compatibility export (tools-service `deep_research` tool) ----------
//
// Runs the same v2 engine to completion (off the job registry — chat-tool calls
// are already awaited by the agent loop) and returns the classic ResearchReport.
// Throws on failure exactly like the v1 pipeline did.

export async function deepResearch(question: string, depth = 1): Promise<ResearchReport> {
  const startedAt = Date.now()
  const job = newJob(question, Math.max(1, Math.min(2, Math.round(depth))))
  await runResearchPipeline(job)
  if (job.status === 'error') throw new Error(job.error ?? 'research failed')
  return {
    question,
    report: job.report ?? '',
    citations: (job.citations ?? []).map((c, i) => {
      const src = job.sources.find((s) => s.url === c.url)
      return {
        n: i + 1,
        url: c.url,
        title: c.title,
        domain: src?.host ?? domainOf(c.url),
        quality: src?.credibility ?? 'medium',
        verified: c.verified,
      }
    }),
    sources_read: job.pagesRead,
    queries_used: job.queries,
    elapsed_ms: Date.now() - startedAt,
  }
}
