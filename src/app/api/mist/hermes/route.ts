// /api/mist/hermes — the Hermes command surface.
//
// The creator's business runs on their local Hermes agent (NousResearch/
// hermes-agent, via the Mist Bridge). This route exposes exactly what her
// own tools use (hermes_status / hermes_ask / hermes_skills / hermes_cron)
// to the Diagnostics command panel, with a short cache so hammering the
// panel never hammers the bridge.
//
// GET                → cached status (60s) — installed?, version, gateway
//                      health, skills count, memory files, repo path.
// POST {action}      → 'status'  force a fresh probe
//                    → 'delegate' {prompt, resume?} run a task through
//                      Hermes (hermes_ask) — the business-control path
//                    → 'skills'   list Hermes' installed skills
//                    → 'cron'     list Hermes' scheduled jobs
//
// Honest by design: bridge disconnected → {ok:false, error:'bridge-disconnected'}
// with the connect hint; nothing is faked.

import { NextRequest, NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

interface Cached<T> {
  at: number
  data: T
}

const g = globalThis as unknown as {
  __mistHermesCache?: Map<string, Cached<unknown>>
}
const cache: Map<string, Cached<unknown>> = (g.__mistHermesCache ??= new Map())
const CACHE_MS = 60_000

async function hermesAction(action: string, args: Record<string, unknown> = {}): Promise<unknown> {
  const { bridgeExec } = await import('@/lib/services/bridge-service')
  return bridgeExec(action, args)
}

async function cached(action: string, maxAgeMs = CACHE_MS): Promise<{ data: unknown; cached: boolean }> {
  const hit = cache.get(action)
  if (hit && Date.now() - hit.at < maxAgeMs) return { data: hit.data, cached: true }
  const data = await hermesAction(action)
  cache.set(action, { at: Date.now(), data })
  return { data, cached: false }
}

function offlinePayload() {
  return {
    ok: false,
    error: 'bridge-disconnected',
    hint: 'Start the Mist Bridge on your PC (it connects this console to your machine, incl. Hermes).',
  }
}

export async function GET() {
  try {
    const { data, cached: isCached } = await cached('hermes_status')
    const res = data as { bridgeConnected?: boolean }
    if (res && res.bridgeConnected === false) {
      return NextResponse.json({ ...offlinePayload(), cached: isCached })
    }
    return NextResponse.json({ ...res, cached: isCached })
  } catch {
    return NextResponse.json(offlinePayload(), { status: 200 })
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => ({}))) as {
      action?: string
      prompt?: string
      resume?: string
    }
    if (body.action === 'status') {
      cache.delete('hermes_status')
      const data = await hermesAction('hermes_status')
      const res = data as { bridgeConnected?: boolean }
      if (res && res.bridgeConnected === false) return NextResponse.json(offlinePayload())
      return NextResponse.json(res)
    }
    if (body.action === 'delegate') {
      const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : ''
      if (!prompt) return NextResponse.json({ error: 'prompt is required' }, { status: 400 })
      const args: Record<string, unknown> = { prompt }
      if (typeof body.resume === 'string' && body.resume) args.resume = body.resume
      const data = await hermesAction('hermes_ask', args)
      const res = data as { bridgeConnected?: boolean }
      if (res && res.bridgeConnected === false) return NextResponse.json(offlinePayload())
      return NextResponse.json(res)
    }
    if (body.action === 'skills') {
      const data = await hermesAction('hermes_skills', { action: 'list' })
      const res = data as { bridgeConnected?: boolean }
      if (res && res.bridgeConnected === false) return NextResponse.json(offlinePayload())
      return NextResponse.json(res)
    }
    if (body.action === 'cron') {
      const data = await hermesAction('hermes_cron', { action: 'list' })
      const res = data as { bridgeConnected?: boolean }
      if (res && res.bridgeConnected === false) return NextResponse.json(offlinePayload())
      return NextResponse.json(res)
    }
    return NextResponse.json({ error: 'unsupported action — use status | delegate | skills | cron' }, { status: 400 })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'hermes action failed' },
      { status: 500 }
    )
  }
}
