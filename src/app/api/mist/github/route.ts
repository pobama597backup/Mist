// M.I.S.T. GitHub self-management API (w8).
// GET  → status (token present/valid, repo, last commits, export state)
// POST → { action: 'save-token' | 'clear-token' | 'sync', token?, message? }
import { NextRequest, NextResponse } from 'next/server'
import { githubClearToken, githubSaveToken, githubStatus, githubSync } from '@/lib/services/github-service'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function GET() {
  try {
    const status = await githubStatus()
    return NextResponse.json(status)
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'github status failed' },
      { status: 500 }
    )
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => null)) as {
      action?: unknown
      token?: unknown
      message?: unknown
    } | null
    const action = typeof body?.action === 'string' ? body.action : ''
    if (action === 'save-token') {
      const res = await githubSaveToken(body?.token)
      return NextResponse.json(res, { status: res.ok ? 200 : 400 })
    }
    if (action === 'clear-token') {
      return NextResponse.json(await githubClearToken())
    }
    if (action === 'sync') {
      const res = await githubSync(body?.message)
      return NextResponse.json(res, { status: res.ok ? 200 : 400 })
    }
    return NextResponse.json({ error: 'unknown action' }, { status: 400 })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'github action failed' },
      { status: 500 }
    )
  }
}
