// M.I.S.T. browser command route — proxies cockpit actions to the Browser Pilot,
// and serves reader-mode page extraction via the SDK page_reader.
import { NextRequest, NextResponse } from 'next/server'
import {
  pilotNavigate,
  pilotClick,
  pilotType,
  pilotKey,
  pilotScroll,
  pilotScreenshot,
  pilotElements,
  pilotExtract,
  pilotReset,
} from '@/lib/services/browser-service'
import { getZai } from '@/lib/services/zai'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

type Action =
  | 'navigate'
  | 'click'
  | 'type'
  | 'key'
  | 'scroll'
  | 'screenshot'
  | 'elements'
  | 'extract'
  | 'reset'
  | 'read'

const ACTIONS = new Set<Action>([
  'navigate', 'click', 'type', 'key', 'scroll', 'screenshot', 'elements', 'extract', 'reset', 'read',
])

/** Reader-mode: extract clean article text from any URL (SDK page_reader). */
async function readPage(
  url: string
): Promise<{ ok: true; title: string; url: string; text: string; published_time: string | null } | { ok: false; error: string }> {
  try {
    if (!/^https?:\/\//i.test(url)) return { ok: false, error: 'url must start with http:// or https://' }
    const zai = await getZai()
    const result = (await zai.functions.invoke('page_reader', { url })) as {
      data?: { title?: string; html?: string; url?: string; publishedTime?: string }
    }
    const text = (result?.data?.html ?? '')
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>/gi, '\n\n')
      .replace(/<[^>]*>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
      .slice(0, 20000)
    if (!text) return { ok: false, error: 'page returned no readable content' }
    return {
      ok: true,
      title: result?.data?.title ?? url,
      url: result?.data?.url ?? url,
      text,
      published_time: result?.data?.publishedTime ?? null,
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'page read failed' }
  }
}

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as { action?: unknown; args?: unknown } | null
  const action = typeof body?.action === 'string' ? (body.action as Action) : null
  const args =
    body?.args && typeof body.args === 'object' && !Array.isArray(body.args)
      ? (body.args as Record<string, unknown>)
      : {}

  if (!action || !ACTIONS.has(action)) {
    return NextResponse.json({ error: `action must be one of: ${[...ACTIONS].join(', ')}` }, { status: 400 })
  }

  try {
    switch (action) {
      case 'read':
        return NextResponse.json(await readPage(String(args.url ?? '')))
      case 'navigate': {
        const res = await pilotNavigate(String(args.url ?? ''))
        return NextResponse.json(res.ok ? res.data : res)
      }
      case 'click': {
        const clickArgs: { ref?: number; x?: number; y?: number; selector?: string } = {}
        if (args.ref !== undefined && args.ref !== null) clickArgs.ref = Number(args.ref)
        if (args.x !== undefined && args.y !== undefined) {
          clickArgs.x = Number(args.x)
          clickArgs.y = Number(args.y)
        }
        if (typeof args.selector === 'string' && args.selector) clickArgs.selector = args.selector
        const res = await pilotClick(clickArgs)
        return NextResponse.json(res.ok ? res.data : res)
      }
      case 'type': {
        const res = await pilotType({
          text: String(args.text ?? ''),
          ...(args.ref !== undefined && args.ref !== null ? { ref: Number(args.ref) } : {}),
          ...(typeof args.selector === 'string' && args.selector ? { selector: args.selector } : {}),
          ...(args.submit === true ? { submit: true } : {}),
        })
        return NextResponse.json(res.ok ? res.data : res)
      }
      case 'key': {
        const res = await pilotKey(String(args.key ?? ''))
        return NextResponse.json(res.ok ? res.data : res)
      }
      case 'scroll': {
        const dir = String(args.direction ?? 'down') === 'up' ? 'up' : 'down'
        const res = await pilotScroll(dir, args.amount === undefined ? undefined : Number(args.amount))
        return NextResponse.json(res.ok ? res.data : res)
      }
      case 'screenshot': {
        const res = await pilotScreenshot()
        return NextResponse.json(res.ok ? res.data : res)
      }
      case 'elements': {
        const res = await pilotElements()
        return NextResponse.json(res.ok ? res.data : res)
      }
      case 'extract': {
        const res = await pilotExtract()
        return NextResponse.json(res.ok ? res.data : res)
      }
      case 'reset': {
        const res = await pilotReset()
        return NextResponse.json(res.ok ? res.data : res)
      }
      default:
        return NextResponse.json({ error: 'unhandled action' }, { status: 400 })
    }
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : 'browser command failed' },
      { status: 200 }
    )
  }
}
