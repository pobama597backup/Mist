// POST /api/mist/knowledge/ingest — port of the OpenJarvis upload-ingest route.
// Body: {source, title?, docType?, text} OR {source, files: [{name, base64}]}.
// Text files decode as UTF-8; binary files are skipped with an honest note.
// Response always carries the frozen {chunks: n} total.
import { NextRequest, NextResponse } from 'next/server'
import { ingestKnowledge } from '@/lib/oj/knowledge-service'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const MAX_BODY_BYTES = 8_000_000 // 8 MB total payload cap
const MAX_FILE_BYTES = 2_000_000 // 2 MB per decoded file

interface IncomingFile {
  name: string
  base64: string
}

function decodeBase64Text(base64: string): { text: string | null; note?: string } {
  try {
    const cleaned = base64.replace(/\s+/g, '')
    const buf = Buffer.from(cleaned, 'base64')
    if (buf.length === 0) return { text: null, note: 'empty file' }
    if (buf.length > MAX_FILE_BYTES) return { text: null, note: `too large (${buf.length} bytes > ${MAX_FILE_BYTES} cap)` }
    // binary sniff: NUL byte or >10% control chars in the first 4 KB
    const probe = buf.subarray(0, 4096)
    let control = 0
    for (const byte of probe) {
      if (byte === 0) return { text: null, note: 'binary file — skipped (text knowledge store only)' }
      if (byte < 9 || (byte > 13 && byte < 32)) control++
    }
    if (probe.length > 0 && control / probe.length > 0.1) {
      return { text: null, note: 'binary file — skipped (text knowledge store only)' }
    }
    return { text: buf.toString('utf-8') }
  } catch {
    return { text: null, note: 'invalid base64 payload' }
  }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const raw = await req.text()
    if (raw.length > MAX_BODY_BYTES) {
      return NextResponse.json({ ok: false, error: 'payload too large' }, { status: 413 })
    }
    let body: Record<string, unknown>
    try {
      body = JSON.parse(raw) as Record<string, unknown>
    } catch {
      return NextResponse.json({ ok: false, error: 'invalid JSON body' }, { status: 400 })
    }

    const source = typeof body.source === 'string' ? body.source.trim() : ''
    if (!source) {
      return NextResponse.json(
        { ok: false, error: 'source is required (e.g. "upload", "research", "connector:notes")' },
        { status: 400 }
      )
    }
    const title = typeof body.title === 'string' ? body.title.trim() : undefined
    const docType = typeof body.docType === 'string' ? body.docType.trim() : undefined

    // --- plain text path ---
    if (typeof body.text === 'string' && body.text.trim()) {
      const result = await ingestKnowledge({
        source,
        title,
        text: body.text,
        docType,
        sourceId: typeof body.sourceId === 'string' && body.sourceId.trim() ? body.sourceId.trim() : undefined,
      })
      return NextResponse.json({ ok: true, chunks: result.chunks })
    }

    // --- files path ---
    if (Array.isArray(body.files)) {
      const files = body.files.slice(0, 20) as IncomingFile[]
      if (files.length === 0) {
        return NextResponse.json({ ok: false, error: 'files array is empty' }, { status: 400 })
      }
      let totalChunks = 0
      const perFile: Array<{ name: string; chunks: number; skipped: boolean; note?: string }> = []
      for (const f of files) {
        if (!f || typeof f.name !== 'string' || typeof f.base64 !== 'string') {
          perFile.push({ name: '(malformed entry)', chunks: 0, skipped: true, note: 'malformed file entry' })
          continue
        }
        const decoded = decodeBase64Text(f.base64)
        if (decoded.text === null) {
          perFile.push({ name: f.name, chunks: 0, skipped: true, note: decoded.note ?? 'skipped' })
          continue
        }
        try {
          const result = await ingestKnowledge({
            source,
            title: title ?? f.name,
            text: decoded.text,
            docType,
            sourceId: `upload:${f.name}`,
            meta: { fileName: f.name },
          })
          totalChunks += result.chunks
          perFile.push({ name: f.name, chunks: result.chunks, skipped: false })
        } catch (err) {
          perFile.push({
            name: f.name,
            chunks: 0,
            skipped: true,
            note: err instanceof Error ? err.message : 'ingest failed',
          })
        }
      }
      return NextResponse.json({ ok: true, chunks: totalChunks, files: perFile })
    }

    return NextResponse.json(
      { ok: false, error: 'provide either "text" (string) or "files" ([{name, base64}])' },
      { status: 400 }
    )
  } catch (err) {
    const message = err instanceof Error ? err.message : 'ingest failed'
    return NextResponse.json({ ok: false, error: message }, { status: 500 })
  }
}
