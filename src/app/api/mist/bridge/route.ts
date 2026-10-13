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
import { isLoopbackUrl, setEnvVars } from '@/lib/services/config-service'
import { hasValidSessionCookie } from '@/lib/perimeter/shared'
import { checkRateLimit, rateLimitResponse } from '@/lib/perimeter/rate-limit'

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
    // Phase 1 · S6: set_url repoints every bridge call — owner session only
    // (the proxy.ts perimeter also gates this path; this is defense in depth).
    if (!hasValidSessionCookie(req.headers.get('cookie'))) {
      return NextResponse.json({ ok: false, error: 'session required' }, { status: 403 })
    }
    // Phase 1 · S12: set_url shares the config bucket (10/min) — repointing
    // the bridge is as sensitive as an env write.
    const rl = checkRateLimit('config', req)
    if (!rl.ok) return rateLimitResponse('config', rl.retryAfter ?? 1)
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
    // Phase 1 · S6: the bridge is the machine's hands — it must stay on this
    // machine unless the owner explicitly opted into a remote bridge
    // (MIST_ALLOW_REMOTE_BRIDGE=1, e.g. a dedicated home server on the LAN).
    if (!isLoopbackUrl(url) && process.env.MIST_ALLOW_REMOTE_BRIDGE !== '1') {
      return bad(
        'bridge url must point at this machine (127.0.0.1/localhost) — set MIST_ALLOW_REMOTE_BRIDGE=1 in .env to allow a remote bridge'
      )
    }
    // apply in-memory (globalThis override survives across requests — process.env
    // writes alone do NOT in Turbopack dev) + persist to .env for restarts
    setBridgeUrl(url)
    let diff: Record<string, { from: string; to: string }> | undefined
    try {
      const res = await setEnvVars({ MIST_BRIDGE_URL: url }, true)
      diff = res.diff
    } catch {
      // .env persistence is best-effort — the in-memory route still applies now
    }
    const status = await getBridgeStatus(true)
    return NextResponse.json({ ok: true, status, diff })
  }

  // --- proxy an allowed action to the daemon ---
  if ((BRIDGE_ACTIONS as readonly string[]).includes(action)) {
    const args =
      body.args && typeof body.args === 'object' && !Array.isArray(body.args)
        ? (body.args as Record<string, unknown>)
        : {}
    // Phase 2-b: the perimeter gated this route to the owner's session —
    // every proxied action is arbitrated as owner_chat. Actuator actions
    // (run_command, write_file, …) only reach the daemon with a one-time
    // Arbiter ticket; read-ish actions pass straight through.
    const result = await bridgeExec(action, args, { origin: 'owner_chat' })
    if (result.gated) {
      // honest pre-flight gate: 202 pending (the Approval row is in the bell),
      // 403 denied (the Arbiter's reason rides along verbatim)
      return NextResponse.json(
        {
          ok: false,
          gated: result.gated,
          ...(result.approvalId ? { approvalId: result.approvalId } : {}),
          error: result.error ?? 'gated by the Arbiter',
        },
        { status: result.gated === 'pending-approval' ? 202 : 403 }
      )
    }
    return NextResponse.json({ ok: true, result })
  }

  return bad(
    `unknown action${action ? ` "${action}"` : ' (missing)'}. Allowed: set_url, ${BRIDGE_ACTIONS.join(', ')}`
  )
}
