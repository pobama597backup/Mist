// M.I.S.T. mesh route — interop mesh status (frozen oj-master-plan contract):
//   GET /api/mist/mesh → { mcp: {url, tools, status}, a2a: {cardUrl, status}, channels: [...] }
//
// Probes the mesh-service mini-service on :3004 server-side (127.0.0.1 direct
// fetches are internal-only; the gateway exists for the browser origin). The
// health check is fresh per request (2s timeout, honest down status when the
// service is gone); the tools/list count is cached for 30s — the same probing
// pattern as mcp-service.probeGateway. Honest degradation: never fakes "up".
//
// Browser note (documented per plan): the UI does NOT need direct mesh access
// — this route proxies status itself. Direct browser-origin calls to the mesh
// would go through the Caddy gateway: /?XTransformPort=3004/...
import { NextResponse } from 'next/server'
import { listChannels } from '@/lib/oj/channels'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const MESH_BASE = 'http://127.0.0.1:3004'

/** Browser-usable gateway path for the MCP endpoint (relative, per platform rules). */
const MCP_BROWSER_URL = '/?XTransformPort=3004/mcp'
/** Browser-usable gateway path for the A2A discovery card (relative). */
const A2A_BROWSER_CARD_URL = '/?XTransformPort=3004/.well-known/agent-card.json'

interface MeshHealth {
  ok: boolean
  uptimeMs?: number
  tools?: number
  version?: string
}

interface ToolsCache {
  at: number
  count: number | null
}

let toolsCache: ToolsCache | null = null
const TOOLS_CACHE_TTL_MS = 30_000

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  try {
    return await fetch(url, { ...init, signal: ac.signal, cache: 'no-store' })
  } finally {
    clearTimeout(timer)
  }
}

/** Fresh honest health probe of the mesh service (2s timeout). */
async function meshHealth(): Promise<MeshHealth> {
  try {
    const res = await fetchWithTimeout(`${MESH_BASE}/health`, { method: 'GET' }, 2_000)
    if (!res.ok) return { ok: false }
    const body = (await res.json()) as { ok?: boolean; uptimeMs?: number; tools?: number; version?: string }
    return {
      ok: body.ok === true,
      ...(typeof body.uptimeMs === 'number' ? { uptimeMs: body.uptimeMs } : {}),
      ...(typeof body.tools === 'number' ? { tools: body.tools } : {}),
      ...(typeof body.version === 'string' ? { version: body.version } : {}),
    }
  } catch {
    return { ok: false }
  }
}

/** tools/list count via JSON-RPC (2.5s timeout, cached 30s — mcp-service pattern). */
async function meshToolCount(): Promise<number | null> {
  if (toolsCache && Date.now() - toolsCache.at < TOOLS_CACHE_TTL_MS) return toolsCache.count
  let count: number | null = null
  try {
    const res = await fetchWithTimeout(
      `${MESH_BASE}/mcp`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      },
      2_500
    )
    if (res.ok) {
      const body = (await res.json()) as {
        result?: { tools?: Array<{ name?: string }> }
        error?: { message?: string }
      }
      if (body.result && Array.isArray(body.result.tools)) {
        count = body.result.tools.filter((t) => typeof t?.name === 'string').length
      }
    }
  } catch {
    count = null
  }
  toolsCache = { at: Date.now(), count }
  return count
}

export async function GET() {
  const [health, toolCount] = await Promise.all([meshHealth(), meshToolCount()])
  const status: 'up' | 'down' = health.ok ? 'up' : 'down'
  const channels = listChannels()

  return NextResponse.json({
    mcp: {
      url: MCP_BROWSER_URL,
      internalUrl: `${MESH_BASE}/mcp`,
      method: 'POST (JSON-RPC 2.0)',
      tools: toolCount ?? 0,
      toolsKnown: toolCount === null,
      status,
      ...(health.version !== undefined ? { version: health.version } : {}),
    },
    a2a: {
      cardUrl: A2A_BROWSER_CARD_URL,
      internalUrl: `${MESH_BASE}/.well-known/agent-card.json`,
      status,
      note: 'A2A discovery convention; the same card is served at GET / on the mesh service',
    },
    channels,
    summary: {
      total: channels.length,
      live: channels.filter((c) => c.live && c.connected).length,
      connected: channels.filter((c) => c.connected).length,
    },
    gateway: {
      note: 'This route proxies mesh status server-side; the UI needs no direct mesh access. Direct browser-origin calls would go through the Caddy gateway with ?XTransformPort=3004.',
      port: 3004,
    },
    ...(health.uptimeMs !== undefined ? { meshUptimeMs: health.uptimeMs } : {}),
    checkedAt: new Date().toISOString(),
  })
}
