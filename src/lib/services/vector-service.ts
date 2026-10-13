// M.I.S.T. vector memory — NAMING HONESTY (Phase 4-b · P6): despite the
// historical `vector*` names (kept for API/type compatibility — renaming the
// exports would churn every caller for zero behavior change), this engine is
// purely LEXICAL: TF-cosine + bigram overlap over token bags. There are NO
// embeddings here — an embedding model is not installed. Tokenization uses
// Intl.Segmenter('en', {granularity:'word'}) where the runtime provides it
// (proper word boundaries for CJK/punctuation-adjacent words) and falls back
// to the historical [a-z0-9] regex split elsewhere. Everything degrades
// gracefully: empty/missing data returns [].
import { db } from '@/lib/db'
import type { VectorSearchResult } from '@/lib/types'

/** Lazily-created word segmenter (null on runtimes without Intl.Segmenter). */
const wordSegmenter: Intl.Segmenter | null =
  typeof Intl !== 'undefined' && typeof (Intl as { Segmenter?: unknown }).Segmenter === 'function'
    ? new Intl.Segmenter('en', { granularity: 'word' })
    : null

/** Fast string hash (FNV-1a, 32-bit) — the dedupe key for token sets. */
function hashToken(t: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < t.length; i++) {
    h ^= t.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'if', 'then', 'else', 'of', 'to', 'in', 'on', 'at', 'by',
  'for', 'with', 'about', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'it', 'its', 'this',
  'that', 'these', 'those', 'am', 'i', 'you', 'he', 'she', 'we', 'they', 'me', 'him', 'her', 'them',
  'my', 'your', 'our', 'their', 'as', 'not', 'no', 'nor', 'so', 'too', 'very', 'just', 'than',
  'do', 'does', 'did', 'doing', 'have', 'has', 'had', 'having', 'will', 'would', 'can', 'could',
  'should', 'shall', 'may', 'might', 'must', 'from', 'into', 'out', 'up', 'down', 'over', 'under',
  'again', 'what', 'which', 'who', 'whom', 'when', 'where', 'why', 'how', 'all', 'any', 'both',
  'each', 'few', 'more', 'most', 'other', 'some', 'such', 'only', 'own', 'same', 'there', 'here',
])

/** Tokenize: lowercase, word-segment (Intl.Segmenter when available, else the
 *  historical [a-z0-9] regex fallback), drop <2 chars and stopwords. Keeps
 *  DUPLICATES — term frequency needs counts. */
export function tokenize(text: string): string[] {
  const lower = text.toLowerCase()
  let raw: string[]
  if (wordSegmenter) {
    raw = []
    for (const seg of wordSegmenter.segment(lower)) {
      if (seg.isWordLike) raw.push(seg.segment)
    }
  } else {
    raw = lower.split(/[^a-z0-9]+/)
  }
  return raw.filter((t) => t.length >= 2 && !STOPWORDS.has(t))
}

/** Hash-dedupe a token list (order-preserving first-seen wins). Membership
 *  consumers (skill-trigger matching, capability_check, top-k tool scoring)
 *  never need counts — deduping shrinks the Set they build anyway. */
export function dedupeTokens(tokens: string[]): string[] {
  const seen = new Set<number>()
  const out: string[] = []
  for (const t of tokens) {
    const h = hashToken(t)
    if (seen.has(h)) continue
    seen.add(h)
    out.push(t)
  }
  return out
}

/** Tokenize + hash-dedupe in one step — the membership-shape of tokenize. */
export function tokenSet(text: string): string[] {
  return dedupeTokens(tokenize(text))
}

function termFrequency(tokens: string[]): Map<string, number> {
  const tf = new Map<string, number>()
  for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1)
  return tf
}

function bigramSet(tokens: string[]): Set<string> {
  const set = new Set<string>()
  for (let i = 0; i < tokens.length - 1; i++) set.add(`${tokens[i]} ${tokens[i + 1]}`)
  return set
}

function cosineSimilarity(a: Map<string, number>, b: Map<string, number>): number {
  if (a.size === 0 || b.size === 0) return 0
  let dot = 0
  let normA = 0
  let normB = 0
  for (const [, v] of a) normA += v * v
  for (const [k, v] of b) {
    normB += v * v
    const av = a.get(k)
    if (av !== undefined) dot += av * v
  }
  if (normA === 0 || normB === 0) return 0
  return dot / (Math.sqrt(normA) * Math.sqrt(normB))
}

/** score = cosine(tf) + 0.35 × bigram-overlap bonus */
export function similarity(query: string, document: string): number {
  const qTokens = tokenize(query)
  const dTokens = tokenize(document)
  if (qTokens.length === 0 || dTokens.length === 0) return 0
  const cos = cosineSimilarity(termFrequency(qTokens), termFrequency(dTokens))
  const qBigrams = bigramSet(qTokens)
  const dBigrams = bigramSet(dTokens)
  let shared = 0
  for (const bg of qBigrams) if (dBigrams.has(bg)) shared++
  const overlap = qBigrams.size > 0 ? shared / qBigrams.size : 0
  return cos + 0.35 * overlap
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n))
}

function safeParseMetadata(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
    return {}
  } catch {
    return {}
  }
}

/** Lexical (NOT embedding) search over VectorMemory (scan capped at 500 most
 *  recent rows). Kept the historical name — see the module header. */
export async function vectorSearch(query: string, n: number): Promise<VectorSearchResult[]> {
  try {
    if (!query.trim()) return []
    const rows = await db.vectorMemory.findMany({ orderBy: { createdAt: 'desc' }, take: 500 })
    if (rows.length === 0) return []
    const scored = rows
      .map((row) => ({ row, score: similarity(query, row.text) }))
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.max(1, n))
    return scored.map((s) => ({
      text: s.row.text,
      metadata: safeParseMetadata(s.row.metadata),
      distance: clamp(1 - s.score, 0, 1),
    }))
  } catch {
    return []
  }
}

/** Best-effort index of a text into VectorMemory (never throws). */
export async function indexText(
  text: string,
  source: string,
  metadata: Record<string, unknown> = {}
): Promise<void> {
  try {
    if (!text.trim()) return
    await db.vectorMemory.create({
      data: { text: text.slice(0, 4000), source, metadata: JSON.stringify(metadata) },
    })
  } catch {
    // best-effort only
  }
}
