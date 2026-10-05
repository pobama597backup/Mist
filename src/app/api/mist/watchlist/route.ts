// GET  /api/mist/watchlist — anti-rust watchlist status (openclaw, anthropics/skills, …)
// POST /api/mist/watchlist — { action: 'sync' } sweep now · { action: 'add', repo, channel } ·
//                            { action: 'remove', repo }
import { NextResponse } from 'next/server'
import {
  getWatchlistStatus,
  sweepWatchlist,
  addWatchEntry,
  removeWatchEntry,
} from '@/lib/services/watchlist-service'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function GET() {
  return NextResponse.json(await getWatchlistStatus())
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      action?: string
      repo?: unknown
      channel?: unknown
    }
    if (body.action === 'sync') {
      const sweep = await sweepWatchlist(true)
      return NextResponse.json({ ok: sweep.ok, sweep, watchlist: await getWatchlistStatus() })
    }
    if (body.action === 'add') {
      const repo = typeof body.repo === 'string' ? body.repo.trim() : ''
      const channel = body.channel === 'npm' ? 'npm' : 'atom'
      if (!repo) return NextResponse.json({ error: 'repo is required' }, { status: 400 })
      const result = await addWatchEntry(repo, channel)
      return NextResponse.json({ ...result, watchlist: await getWatchlistStatus() }, { status: result.ok ? 200 : 400 })
    }
    if (body.action === 'remove') {
      const repo = typeof body.repo === 'string' ? body.repo.trim() : ''
      if (!repo) return NextResponse.json({ error: 'repo is required' }, { status: 400 })
      const result = await removeWatchEntry(repo)
      return NextResponse.json({ ...result, watchlist: await getWatchlistStatus() }, { status: result.ok ? 200 : 400 })
    }
    return NextResponse.json({ error: 'unsupported action' }, { status: 400 })
  } catch {
    return NextResponse.json({ error: 'invalid request body' }, { status: 400 })
  }
}
