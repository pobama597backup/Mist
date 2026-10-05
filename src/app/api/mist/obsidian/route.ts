// M.I.S.T. Obsidian route — single action-based API over the vault service.
//
// GET  ?action=status|discover|list|read|search|tags|graph|backlinks|daily|query
// POST {action: set_path|create|update|daily_note|ensure_demo}
// All errors come back as {"ok":false,"error":string} with a proper status
// code — this route never crashes with a 500/HTML error page.
import { NextRequest, NextResponse } from 'next/server'
import {
  createNote,
  dailyNote,
  discoverVaults,
  ensureDemoVault,
  getBacklinks,
  getGraph,
  getTags,
  getVaultStatus,
  listNotes,
  readNote,
  searchVault,
  setVaultPath,
  updateNote,
  vaultQuery,
} from '@/lib/services/obsidian-service'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

// Next 15+/16: searchParams may arrive as a Promise in the route context.
// Route handlers may also simply expose it on req.nextUrl — support both.
type RouteCtx = {
  params?: unknown
  searchParams?: Promise<Record<string, string | string[] | undefined>>
}

async function resolveQuery(req: NextRequest, ctx?: RouteCtx): Promise<URLSearchParams> {
  const fromUrl = new URL(req.url).searchParams
  try {
    const sp = await ctx?.searchParams
    if (sp && typeof sp === 'object') {
      const merged = new URLSearchParams()
      for (const [k, v] of Object.entries(sp)) {
        if (typeof v === 'string') merged.set(k, v)
        else if (Array.isArray(v)) {
          for (const item of v) if (typeof item === 'string') merged.append(k, item)
        }
      }
      for (const key of Array.from(fromUrl.keys())) {
        if (!merged.has(key)) merged.set(key, fromUrl.get(key) ?? '')
      }
      return merged
    }
  } catch {
    // fall through to URL query params
  }
  return fromUrl
}

function bad(error: string, status = 400) {
  return NextResponse.json({ ok: false, error }, { status })
}

function errorStatus(error: string | undefined): number {
  const e = (error ?? '').toLowerCase()
  if (e.includes('not found')) return 404
  if (e.includes('already exists')) return 409
  return 400
}

/** Returns an error response when no vault is connected, else null. */
async function requireConnected(): Promise<NextResponse | null> {
  const status = await getVaultStatus()
  if (!status.connected) {
    return bad('no vault connected — POST {"action":"set_path","path":"demo"} to connect the demo vault')
  }
  return null
}

export async function GET(req: NextRequest, ctx?: RouteCtx): Promise<NextResponse> {
  try {
    const params = await resolveQuery(req, ctx)
    const action = (params.get('action') ?? '').trim().toLowerCase()

    switch (action) {
      case 'status': {
        return NextResponse.json(await getVaultStatus())
      }
      case 'discover': {
        return NextResponse.json(await discoverVaults())
      }
      case 'list': {
        const err = await requireConnected()
        if (err) return err
        const folder = params.get('folder')
        const notes = await listNotes(folder && folder.trim() !== '' ? folder : undefined)
        return NextResponse.json({ notes })
      }
      case 'read': {
        const err = await requireConnected()
        if (err) return err
        const p = params.get('path')
        if (!p) return bad('path is required (vault-relative, e.g. "Projects MOC.md")')
        const result = await readNote(p)
        return result.ok ? NextResponse.json(result) : bad(result.error, errorStatus(result.error))
      }
      case 'search': {
        const err = await requireConnected()
        if (err) return err
        const q = params.get('q') ?? params.get('query')
        if (!q || !q.trim()) return bad('q is required')
        return NextResponse.json({ results: await searchVault(q) })
      }
      case 'tags': {
        const err = await requireConnected()
        if (err) return err
        return NextResponse.json({ tags: await getTags() })
      }
      case 'graph': {
        const err = await requireConnected()
        if (err) return err
        return NextResponse.json(await getGraph())
      }
      case 'backlinks': {
        const err = await requireConnected()
        if (err) return err
        const p = params.get('path')
        if (!p) return bad('path is required')
        return NextResponse.json({ backlinks: await getBacklinks(p) })
      }
      case 'daily': {
        const err = await requireConnected()
        if (err) return err
        const date = params.get('date') ?? undefined
        const result = await dailyNote(date && date.trim() !== '' ? date : undefined)
        return result.ok ? NextResponse.json(result) : bad(result.error ?? 'daily note failed', errorStatus(result.error))
      }
      case 'query': {
        const err = await requireConnected()
        if (err) return err
        const q = params.get('q') ?? params.get('query')
        if (!q || !q.trim()) return bad('q is required (e.g. "LIST FROM #research")')
        return NextResponse.json(await vaultQuery(q))
      }
      default:
        return bad(
          `unknown action${action ? ` "${action}"` : ' (missing)'}. Supported GET actions: status, discover, list, read, search, tags, graph, backlinks, daily, query`
        )
    }
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : 'obsidian GET failed' },
      { status: 500 }
    )
  }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: Record<string, unknown> | null = null
  try {
    body = (await req.json()) as Record<string, unknown> | null
  } catch {
    return bad('invalid JSON body')
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return bad('invalid JSON body')

  const action = typeof body.action === 'string' ? body.action.trim().toLowerCase() : ''

  try {
    switch (action) {
      case 'set_path': {
        if (!('path' in body)) return bad("path is required (absolute path, 'demo', or null)")
        const p = body.path
        if (p !== null && typeof p !== 'string') return bad('path must be a string or null')
        if (typeof p === 'string' && p.trim() === '') return bad("path must be a non-empty absolute path, 'demo', or null")
        const status = await setVaultPath(p as string | null)
        return NextResponse.json(status)
      }
      case 'create': {
        const err = await requireConnected()
        if (err) return err
        if (typeof body.path !== 'string' || !body.path.trim()) return bad('path is required (vault-relative)')
        if (body.content !== undefined && typeof body.content !== 'string') return bad('content must be a string')
        if (body.overwrite !== undefined && typeof body.overwrite !== 'boolean') return bad('overwrite must be a boolean')
        const content = typeof body.content === 'string' ? body.content : ''
        const result = await createNote(body.path, content, { overwrite: body.overwrite === true })
        return result.ok
          ? NextResponse.json(result)
          : bad(result.error ?? 'create failed', errorStatus(result.error))
      }
      case 'update': {
        const err = await requireConnected()
        if (err) return err
        if (typeof body.path !== 'string' || !body.path.trim()) return bad('path is required (vault-relative)')
        if (body.content !== undefined && typeof body.content !== 'string') return bad('content must be a string')
        if (body.mode !== undefined && body.mode !== 'replace' && body.mode !== 'append') {
          return bad('mode must be "replace" or "append"')
        }
        const content = typeof body.content === 'string' ? body.content : ''
        const result = await updateNote(body.path, content, body.mode === 'append' ? 'append' : 'replace')
        return result.ok
          ? NextResponse.json(result)
          : bad(result.error ?? 'update failed', errorStatus(result.error))
      }
      case 'daily_note': {
        const err = await requireConnected()
        if (err) return err
        if (body.date !== undefined && typeof body.date !== 'string') return bad('date must be a string (YYYY-MM-DD)')
        const result = await dailyNote(typeof body.date === 'string' && body.date.trim() !== '' ? body.date : undefined)
        return result.ok
          ? NextResponse.json(result)
          : bad(result.error ?? 'daily note failed', errorStatus(result.error))
      }
      case 'ensure_demo': {
        const vaultPath = await ensureDemoVault()
        return NextResponse.json({ ok: true, path: vaultPath })
      }
      default:
        return bad(
          `unknown action${action ? ` "${action}"` : ' (missing)'}. Supported POST actions: set_path, create, update, daily_note, ensure_demo`
        )
    }
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : 'obsidian POST failed' },
      { status: 500 }
    )
  }
}
