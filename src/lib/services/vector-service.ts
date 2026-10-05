// M.I.S.T. vector memory — local lexical engine (TF-cosine + bigram overlap), zero deps.
// Everything degrades gracefully: empty/missing data returns [].
import { db } from '@/lib/db'
import type { VectorSearchResult } from '@/lib/types'

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

/** Tokenize: lowercase, split on non-alphanumerics, drop <2 chars and stopwords. */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t))
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

/** Lexical search over VectorMemory (scan capped at 500 most recent rows). */
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
