// M.I.S.T. bridge route — status, URL configuration, and the action proxy for
// the user's local Mist Bridge daemon (the zero-dependency Node script the
// OWNER downloads from /api/mist/bridge/download and runs on their machine).
//
// GET                          → {ok, status}          (fresh probe, never throws)
// POST {action:'set_url', url} → validate http(s) URL (≤200 chars), persist to
//                                .env + process.env, return the fresh status
// POST {action, args?}         → proxy an allowed bridge action to the daemon
//
// All errors are JSON bodies with a proper status code — this route never
// 500-crashes.
import { NextRequest, NextResponse } from 'next/server'
import { BRIDGE_ACTIONS, bridgeExec, getBridgeStatus, setBridgeUrl } from '@/lib/services/bridge-service'
import { setEnvVars } from '@/lib/services/config-service'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export const maxDuration = 60

function bad(error: string, status = 400) {
  return NextResponse.json({ ok: false, error }, { status })
}

export async function GET(): Promise<NextResponse> {
  try {
    const status = await getBridgeStatus(true)
    return NextResponse.json({ ok: true, status })
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : 'bridge status failed' },
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

  const action = typeof body.action === 'string' ? body.action.trim() : ''

  // --- configure the bridge URL (owner action from Settings → Local Bridge) ---
  if (action === 'set_url') {
    const url = typeof body.url === 'string' ? body.url.trim() : ''
    if (!url) return bad('url is required')
    if (url.length > 200) return bad('url must be at most 200 characters')
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      return bad('url must be a valid http(s) URL')
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return bad('url must start with http:// or https://')
    }
    // apply in-memory (globalThis override survives across requests — process.env
    // writes alone do NOT in Turbopack dev) + persist to .env for restarts
    setBridgeUrl(url)
    try {
      await setEnvVars({ MIST_BRIDGE_URL: url }, true)
    } catch {
      // .env persistence is best-effort — the in-memory route still applies now
    }
    const status = await getBridgeStatus(true)
    return NextResponse.json({ ok: true, status })
  }

  // --- proxy an allowed action to the daemon ---
  if ((BRIDGE_ACTIONS as readonly string[]).includes(action)) {
    const args =
      body.args && typeof body.args === 'object' && !Array.isArray(body.args)
        ? (body.args as Record<string, unknown>)
        : {}
    const result = await bridgeExec(action, args)
    return NextResponse.json({ ok: true, result })
  }

  return bad(
    `unknown action${action ? ` "${action}"` : ' (missing)'}. Allowed: set_url, ${BRIDGE_ACTIONS.join(', ')}`
  )
}
