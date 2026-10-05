// POST /api/mist/knowledge/search — hybrid BM25+vector retrieval over the
// knowledge store (frozen response shape):
//   {results: [{id, source, title, content, score, bm25, vector}]}
import { NextRequest, NextResponse } from 'next/server'
import { searchKnowledge } from '@/lib/oj/knowledge-service'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    let body: Record<string, unknown>
    try {
      body = JSON.parse(await req.text()) as Record<string, unknown>
    } catch {
      return NextResponse.json({ ok: false, error: 'invalid JSON body' }, { status: 400 })
    }

    const query = typeof body.query === 'string' ? body.query.trim() : ''
    if (!query) {
      return NextResponse.json({ ok: false, error: 'query is required' }, { status: 400 })
    }

    const filters: { source?: string; docType?: string } = {}
    if (body.filters && typeof body.filters === 'object' && !Array.isArray(body.filters)) {
      const f = body.filters as Record<string, unknown>
      if (typeof f.source === 'string' && f.source.trim()) filters.source = f.source.trim()
      if (typeof f.docType === 'string' && f.docType.trim()) filters.docType = f.docType.trim()
    }
    const topKRaw = Number(body.topK)
    const topK = Number.isFinite(topKRaw) && topKRaw > 0 ? Math.min(20, Math.floor(topKRaw)) : 5

    const { results } = await searchKnowledge({
      query,
      filters: Object.keys(filters).length > 0 ? filters : undefined,
      topK,
    })
    return NextResponse.json({
      results: results.map((r) => ({
        id: r.id,
        source: r.source,
        title: r.title,
        content: r.content,
        score: r.score,
        bm25: r.bm25,
        vector: r.vector,
      })),
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'search failed'
    return NextResponse.json({ ok: false, error: message }, { status: 500 })
  }
}
