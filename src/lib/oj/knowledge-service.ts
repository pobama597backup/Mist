// OJ knowledge store (port of openjarvis/connectors: SemanticChunker + KnowledgeStore
// + HybridSearch, adapted to M.I.S.T.'s zero-dep stack).
//
// - chunkText(): heading-aware semantic chunker — markdown headings → paragraphs
//   → force-split, ~800-char cap with 100-char overlap between consecutive
//   chunks (ports openjarvis/connectors/chunker.py defaults for this corpus size).
// - ingestKnowledge(): text → KnowledgeChunk rows (source, sourceId, docType,
//   title, meta JSON). The lexical index is computed at search time (BM25 needs
//   corpus-level IDF, which changes as the store grows — caching it in a column
//   would go stale).
// - searchKnowledge(): hybrid retrieval — BM25-style lexical score + the
//   existing M.I.S.T. TF-cosine vector score (vector-service), fused with
//   Reciprocal Rank Fusion exactly like openjarvis HybridSearch (BM25 ~[0,20]
//   vs cosine ~[0,1.35] — RRF is robust to the scale mismatch).
//   Scan is capped at the most recent 1500 chunks (brute force is fine at this
//   corpus size; same pattern as vectorSearch).
// - knowledgeStatus() / listChunks(): honest counts + previews (scan_chunks tool).
//
// Everything degrades gracefully and never throws across the API boundary.
import { db } from '@/lib/db'
import { tokenize } from '@/lib/services/vector-service'
// Lexical-scoring hook exposed by memory-service (the single TF-cosine scorer
// the whole house shares — vector memory and the knowledge store score alike).
import { lexicalSimilarity as similarity } from '@/lib/services/memory-service'

// ---------------------------------------------------------------------------
// Types (frozen contract)
// ---------------------------------------------------------------------------

export interface KnowledgeIngestInput {
  source: string // e.g. "upload" | "connector:obsidian" | "research"
  title?: string
  text: string
  docType?: string // document | note | research | web | vault | story | post
  sourceId?: string // file path / url / repo — document identity within source
  meta?: Record<string, unknown>
}

export interface KnowledgeIngestResult {
  chunks: number
}

export interface KnowledgeSearchFilters {
  source?: string
  docType?: string
}

export interface KnowledgeSearchInput {
  query: string
  filters?: KnowledgeSearchFilters
  topK?: number
}

export interface KnowledgeSearchHit {
  id: string
  source: string
  title: string
  content: string
  score: number // RRF-fused, normalized 0..1
  bm25: number // normalized 0..1
  vector: number // raw TF-cosine similarity (+ bigram bonus)
}

export interface KnowledgeSearchResult {
  results: KnowledgeSearchHit[]
}

export interface KnowledgeChunkPreview {
  id: string
  source: string
  sourceId: string
  docType: string
  title: string
  chunkIdx: number
  preview: string
  createdAt: string
}

export interface KnowledgeStatus {
  chunks: number
  docs: number
  sources: Array<{ source: string; chunks: number; docs: number }>
  lastIngestAt: string | null
  scanned: number // rows covered by search (cap-honest)
}

// ---------------------------------------------------------------------------
// Chunker (port of openjarvis/connectors/chunker.py — heading-aware)
// ---------------------------------------------------------------------------

const CHUNK_MAX_CHARS = 800
const CHUNK_OVERLAP_CHARS = 100
const HEADING_RE = /^#{1,6}\s+.+$/

interface ChunkPiece {
  content: string
  section: string
}

function splitSentences(text: string): string[] {
  const parts = text.split(/(?<=[.!?])\s+(?=[A-Z"'])/)
  return parts.map((p) => p.trim()).filter((p) => p.length > 0)
}

/** Force-split a single oversized run at sentence → word → hard boundaries. */
function forceSplit(text: string, maxChars: number): string[] {
  const out: string[] = []
  let rest = text.trim()
  while (rest.length > 0) {
    if (rest.length <= maxChars) {
      out.push(rest)
      break
    }
    const window = rest.slice(0, maxChars)
    let cut = -1
    // prefer the last sentence end in the window
    for (let i = window.length - 1; i >= 0; i--) {
      if (/[.!?]/.test(window[i]) && i + 1 < window.length && /\s/.test(window[i + 1])) {
        cut = i + 1
        break
      }
    }
    if (cut <= 0) {
      // fall back to the last word boundary
      const space = window.lastIndexOf(' ')
      cut = space > maxChars * 0.4 ? space + 1 : maxChars
    }
    const piece = rest.slice(0, cut).trim()
    if (piece.length === 0) {
      // pathological whitespace run — hard-advance to guarantee progress
      cut = Math.max(cut + 1, maxChars)
      out.push(rest.slice(0, cut).trim())
    } else {
      out.push(piece)
    }
    rest = rest.slice(cut).trim()
  }
  return out.filter((p) => p.length > 0)
}

/** Greedy-merge small segments (paragraphs/sentences) up to the char cap. */
function packSegments(segments: string[], maxChars: number): string[] {
  const chunks: string[] = []
  let current = ''
  for (const seg of segments) {
    if (seg.length > maxChars) {
      if (current) {
        chunks.push(current)
        current = ''
      }
      chunks.push(...forceSplit(seg, maxChars))
      continue
    }
    if (current && current.length + 1 + seg.length > maxChars) {
      chunks.push(current)
      current = seg
    } else {
      current = current ? `${current} ${seg}` : seg
    }
  }
  if (current) chunks.push(current)
  return chunks
}

/**
 * Heading-aware semantic chunking: split on markdown headings first (each
 * section rides along as chunk metadata), then paragraphs, then sentences,
 * then force-split — hard cap ~800 chars, 100-char overlap prepended from the
 * previous chunk's tail (taken from the ORIGINAL previous chunk so overlap
 * never compounds — same trick as the Python chunker).
 */
export function chunkText(
  text: string,
  opts?: { maxChars?: number; overlap?: number }
): Array<{ content: string; section: string }> {
  const maxChars = Math.max(200, opts?.maxChars ?? CHUNK_MAX_CHARS)
  const overlap = Math.min(Math.max(0, opts?.overlap ?? CHUNK_OVERLAP_CHARS), Math.floor(maxChars / 2))
  const trimmed = (text ?? '').trim()
  if (!trimmed) return []

  // --- split into heading sections (preamble included) ---
  const lines = trimmed.split('\n')
  const sections: Array<{ heading: string; body: string[] }> = []
  let currentHeading = ''
  let currentBody: string[] = []
  for (const line of lines) {
    if (HEADING_RE.test(line.trim())) {
      if (currentBody.join('\n').trim() || currentHeading) {
        sections.push({ heading: currentHeading, body: currentBody })
      }
      currentHeading = line.trim().replace(/^#+\s+/, '')
      currentBody = []
    } else {
      currentBody.push(line)
    }
  }
  sections.push({ heading: currentHeading, body: currentBody })

  // --- pack each section: paragraphs → sentences → force-split ---
  const pieces: ChunkPiece[] = []
  for (const section of sections) {
    const body = section.body.join('\n').trim()
    if (!body && !section.heading) continue
    const sectionTag = section.heading ? `§ ${section.heading}` : ''
    if (!body) {
      pieces.push({ content: section.heading, section: sectionTag })
      continue
    }
    const paragraphs = body
      .split(/\n\s*\n/)
      .map((p) => p.trim())
      .filter((p) => p.length > 0)
    const packed: string[] = []
    for (const para of paragraphs) {
      if (para.length <= maxChars) {
        packed.push(para)
      } else {
        packed.push(...packSegments(splitSentences(para), maxChars))
      }
    }
    for (const c of packed) pieces.push({ content: c, section: sectionTag })
  }

  // --- apply overlap from the ORIGINAL previous chunk (non-compounding) ---
  const result: Array<{ content: string; section: string }> = []
  for (let i = 0; i < pieces.length; i++) {
    let content = pieces[i].content
    if (i > 0 && overlap > 0) {
      const prev = pieces[i - 1].content
      if (prev.length > 0) {
        const tail = prev.slice(-overlap)
        content = `${tail} ${content}`.trim()
      }
    }
    result.push({ content, section: pieces[i].section })
  }
  return result
}

// ---------------------------------------------------------------------------
// Ingest
// ---------------------------------------------------------------------------

const MAX_TEXT_BYTES = 2_000_000 // 2 MB per document — honest cap

export async function ingestKnowledge(input: KnowledgeIngestInput): Promise<KnowledgeIngestResult> {
  const source = (input.source ?? '').trim()
  if (!source) throw new Error('source is required')
  const text = (input.text ?? '').slice(0, MAX_TEXT_BYTES)
  if (!text.trim()) return { chunks: 0 }

  const pieces = chunkText(text)
  if (pieces.length === 0) return { chunks: 0 }

  const meta: Record<string, unknown> = {
    ...(input.meta ?? {}),
    ingestedAt: new Date().toISOString(),
    ...(input.sourceId ? { path: input.sourceId } : {}),
  }

  // Chunks of one document share sourceId — delete previous chunks of the same
  // document so re-ingest replaces instead of duplicating (sync-friendly).
  if (input.sourceId) {
    try {
      await db.knowledgeChunk.deleteMany({ where: { source, sourceId: input.sourceId } })
    } catch {
      // best-effort dedupe — fresh ingest still lands
    }
  }

  await db.knowledgeChunk.createMany({
    data: pieces.map((p, idx) => ({
      source,
      sourceId: input.sourceId ?? '',
      docType: input.docType ?? 'document',
      title: input.title ?? '',
      chunkIdx: idx,
      content: p.content,
      meta: JSON.stringify({
        ...meta,
        ...(p.section ? { section: p.section } : {}),
        chunkCount: pieces.length,
      }),
    })),
  })

  return { chunks: pieces.length }
}

// ---------------------------------------------------------------------------
// Hybrid search — BM25 lexical + TF-cosine vector, fused with RRF
// ---------------------------------------------------------------------------

const SEARCH_SCAN_CAP = 1500
const BM25_K1 = 1.5
const BM25_B = 0.75
const RRF_K = 60

interface Bm25Row {
  id: string
  source: string
  sourceId: string
  docType: string
  title: string
  content: string
  tokens: string[]
  tf: Map<string, number>
  len: number
}

function termFrequency(tokens: string[]): Map<string, number> {
  const tf = new Map<string, number>()
  for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1)
  return tf
}

/**
 * BM25 lexical scoring over the candidate rows (IDF computed over the scanned
 * candidate set — the honest approximation FTS5 makes over the whole table,
 * bounded by the scan cap).
 */
function bm25Scores(queryTokens: string[], rows: Bm25Row[]): Map<string, number> {
  const scores = new Map<string, number>()
  if (queryTokens.length === 0 || rows.length === 0) return scores
  const N = rows.length
  const avgLen = rows.reduce((sum, r) => sum + r.len, 0) / N
  // document frequency per query term
  const df = new Map<string, number>()
  for (const t of new Set(queryTokens)) {
    let count = 0
    for (const r of rows) if (r.tf.has(t)) count++
    df.set(t, count)
  }
  for (const r of rows) {
    let score = 0
    for (const t of new Set(queryTokens)) {
      const tf = r.tf.get(t)
      if (!tf) continue
      const d = df.get(t) ?? 0
      const idf = Math.log(1 + (N - d + 0.5) / (d + 0.5))
      const denom = tf + BM25_K1 * (1 - BM25_B + BM25_B * (r.len / (avgLen || 1)))
      score += idf * (tf * (BM25_K1 + 1)) / denom
    }
    if (score > 0) scores.set(r.id, score)
  }
  return scores
}

function rankOrder(scores: Map<string, number>): string[] {
  return Array.from(scores.entries())
    .filter(([, s]) => s > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([id]) => id)
}

export async function searchKnowledge(input: KnowledgeSearchInput): Promise<KnowledgeSearchResult> {
  const query = (input.query ?? '').trim()
  const topK = Math.max(1, Math.min(20, input.topK ?? 5))
  if (!query) return { results: [] }

  try {
    const where: { source?: string; docType?: string } = {}
    if (input.filters?.source) where.source = input.filters.source
    if (input.filters?.docType) where.docType = input.filters.docType

    const rowsRaw = await db.knowledgeChunk.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: SEARCH_SCAN_CAP,
      select: {
        id: true,
        source: true,
        title: true,
        content: true,
      },
    })
    if (rowsRaw.length === 0) return { results: [] }

    // --- lexical side (BM25) ---
    const queryTokens = tokenize(query)
    const rows: Bm25Row[] = rowsRaw.map((r) => {
      const tokens = tokenize(`${r.title} ${r.content}`)
      return {
        id: r.id,
        source: r.source,
        sourceId: '',
        docType: '',
        title: r.title,
        content: r.content,
        tokens,
        tf: termFrequency(tokens),
        len: tokens.length,
      }
    })

    const bm25 = bm25Scores(queryTokens, rows)
    const bm25Order = rankOrder(bm25)

    // --- vector side (M.I.S.T. TF-cosine + bigram bonus — the existing
    //     lexical engine reused for the dense-equivalent signal) ---
    const vector = new Map<string, number>()
    for (const r of rows) {
      const s = similarity(query, `${r.title ? r.title + '\n' : ''}${r.content}`)
      if (s > 0) vector.set(r.id, s)
    }
    const vectorOrder = rankOrder(vector)

    // --- RRF fusion (ports openjarvis HybridSearch: robust to the very
    //     different score scales the two signals produce) ---
    const rrf = new Map<string, number>()
    bm25Order.forEach((id, rank) => {
      rrf.set(id, (rrf.get(id) ?? 0) + 1 / (RRF_K + rank + 1))
    })
    vectorOrder.forEach((id, rank) => {
      rrf.set(id, (rrf.get(id) ?? 0) + 1 / (RRF_K + rank + 1))
    })
    if (rrf.size === 0) return { results: [] }

    const maxBm25 = Math.max(...bm25.values())
    const maxRrf = Math.max(...rrf.values())
    const byId = new Map(rowsRaw.map((r) => [r.id, r]))

    const hits: KnowledgeSearchHit[] = Array.from(rrf.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, topK)
      .map(([id, fused]) => {
        const row = byId.get(id)
        return {
          id,
          source: row?.source ?? '',
          title: row?.title ?? '',
          content: row?.content ?? '',
          score: Number((fused / (maxRrf || 1)).toFixed(4)),
          bm25: Number(((bm25.get(id) ?? 0) / (maxBm25 || 1)).toFixed(4)),
          vector: Number((vector.get(id) ?? 0).toFixed(4)),
        }
      })

    return { results: hits }
  } catch {
    return { results: [] }
  }
}

// ---------------------------------------------------------------------------
// Previews + status
// ---------------------------------------------------------------------------

export async function listChunks(opts?: {
  source?: string
  limit?: number
}): Promise<KnowledgeChunkPreview[]> {
  try {
    const limit = Math.max(1, Math.min(100, opts?.limit ?? 20))
    const rows = await db.knowledgeChunk.findMany({
      where: opts?.source ? { source: opts.source } : undefined,
      orderBy: [{ createdAt: 'desc' }, { chunkIdx: 'asc' }],
      take: limit,
    })
    return rows.map((r) => ({
      id: r.id,
      source: r.source,
      sourceId: r.sourceId,
      docType: r.docType,
      title: r.title,
      chunkIdx: r.chunkIdx,
      preview: r.content.slice(0, 220),
      createdAt: r.createdAt.toISOString(),
    }))
  } catch {
    return []
  }
}

interface SourceCountRow {
  source: string
  chunks: number | bigint
  docs: number | bigint
}

export async function knowledgeStatus(): Promise<KnowledgeStatus> {
  try {
    const [total, perSource, last] = await Promise.all([
      db.knowledgeChunk.count(),
      db.$queryRaw<SourceCountRow[]>`
        SELECT source,
               COUNT(*) AS chunks,
               COUNT(DISTINCT CASE WHEN sourceId != '' THEN sourceId ELSE id END) AS docs
        FROM KnowledgeChunk
        GROUP BY source
        ORDER BY chunks DESC`,
      db.knowledgeChunk.findFirst({ orderBy: { createdAt: 'desc' }, select: { createdAt: true } }),
    ])
    const sources = perSource.map((r) => ({
      source: r.source,
      chunks: Number(r.chunks),
      docs: Number(r.docs),
    }))
    const docs = sources.reduce((sum, s) => sum + s.docs, 0)
    return {
      chunks: total,
      docs,
      sources,
      lastIngestAt: last ? last.createdAt.toISOString() : null,
      scanned: Math.min(total, SEARCH_SCAN_CAP),
    }
  } catch {
    return { chunks: 0, docs: 0, sources: [], lastIngestAt: null, scanned: 0 }
  }
}
