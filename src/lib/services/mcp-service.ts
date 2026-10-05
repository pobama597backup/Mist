// M.I.S.T. MCP service — OmniRoute gateway integration (curated read tools, gated writes)
// Gateway is probed with a 2.5s timeout and the result is cached for 30s. Never retry-storms.
import type { ToolExecuteResult, ToolInfo, ToolParam } from '@/lib/types'

/** Gateway root = OMNIROUTE_BASE_URL minus a trailing /v1 (default local gateway). */
export function gatewayRoot(): string {
  const raw = process.env.OMNIROUTE_BASE_URL?.trim()
  const base = raw && raw.length > 0 ? raw : 'http://localhost:20128'
  return base.replace(/\/v1\/?$/i, '').replace(/\/+$/, '')
}

let probeCache: { at: number; available: boolean } | null = null

export async function probeGateway(): Promise<boolean> {
  if (probeCache && Date.now() - probeCache.at < 30_000) return probeCache.available
  let available = false
  try {
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), 2500)
    try {
      const res = await fetch(`${gatewayRoot()}/.well-known/agent.json`, {
        signal: ac.signal,
        cache: 'no-store',
      })
      available = res.ok
    } finally {
      clearTimeout(timer)
    }
  } catch {
    available = false
  }
  probeCache = { at: Date.now(), available }
  return available
}

function p(name: string, type: ToolParam['type'], required: boolean, description: string): ToolParam {
  return { name, type, required, description }
}

interface OmniToolDef {
  info: Omit<ToolInfo, 'available'>
  write: boolean
}

export const OMNI_TOOLS: OmniToolDef[] = [
  {
    info: {
      name: 'omni_gateway_health',
      description: 'Check OmniRoute gateway reachability and health.',
      category: 'omniroute',
      implemented: true,
      parameters: [],
    },
    write: false,
  },
  {
    info: {
      name: 'omni_list_models',
      description: 'List models served by the OmniRoute gateway.',
      category: 'omniroute',
      implemented: true,
      parameters: [],
    },
    write: false,
  },
  {
    info: {
      name: 'omni_provider_status',
      description: 'Report upstream provider routing status via OmniRoute.',
      category: 'omniroute',
      implemented: true,
      parameters: [],
    },
    write: false,
  },
  {
    info: {
      name: 'omni_usage_quota',
      description: 'Report usage quota information from the OmniRoute gateway.',
      category: 'omniroute',
      implemented: true,
      parameters: [],
    },
    write: false,
  },
  {
    info: {
      name: 'omni_current_route',
      description: 'Show the currently active OmniRoute routing target.',
      category: 'omniroute',
      implemented: true,
      parameters: [],
    },
    write: false,
  },
  {
    info: {
      name: 'omni_agent_card',
      description: 'Fetch the OmniRoute agent card (/.well-known/agent.json).',
      category: 'omniroute',
      implemented: true,
      parameters: [],
    },
    write: false,
  },
  {
    info: {
      name: 'omni_skills_catalog',
      description: 'Fetch the agent-skills catalog from the OmniRoute gateway.',
      category: 'omniroute',
      implemented: true,
      parameters: [],
    },
    write: false,
  },
  {
    info: {
      name: 'omni_switch_model',
      description: 'Switch the active model on the OmniRoute gateway (write — needs confirmation).',
      category: 'omniroute',
      implemented: true,
      parameters: [p('model', 'string', true, 'Model id to switch to'), p('provider', 'string', false, 'Optional upstream provider')],
    },
    write: true,
  },
  {
    info: {
      name: 'omni_set_default_provider',
      description: 'Set the default upstream provider on OmniRoute (write — needs confirmation).',
      category: 'omniroute',
      implemented: true,
      parameters: [p('provider', 'string', true, 'Provider id to make default')],
    },
    write: true,
  },
]

export function isOmniWriteTool(name: string): boolean {
  return OMNI_TOOLS.some((t) => t.info.name === name && t.write)
}

async function gatewayFetchJson(pathname: string, timeoutMs = 10_000): Promise<unknown> {
  const root = gatewayRoot()
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  try {
    const headers: Record<string, string> = { Accept: 'application/json' }
    if (process.env.OMNIROUTE_API_KEY) {
      headers.Authorization = `Bearer ${process.env.OMNIROUTE_API_KEY}`
    }
    const res = await fetch(`${root}${pathname}`, { headers, signal: ac.signal, cache: 'no-store' })
    if (!res.ok) throw new Error(`gateway responded ${res.status}`)
    return (await res.json()) as unknown
  } finally {
    clearTimeout(timer)
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function extractModels(payload: unknown): Array<Record<string, unknown>> {
  const root = asRecord(payload)
  const list: unknown = root.data ?? root.models ?? root.results
  if (!Array.isArray(list)) return []
  return list.map((m) => asRecord(m))
}

/**
 * Execute a curated OmniRoute tool. Availability + confirmation gates first,
 * then best-effort reads against documented endpoints.
 */
export async function executeOmniTool(
  name: string,
  args: Record<string, unknown>,
  confirmed: boolean
): Promise<ToolExecuteResult & { available?: boolean }> {
  const root = gatewayRoot()

  if (isOmniWriteTool(name) && confirmed !== true) {
    return { success: false, output: null, error: 'requires confirmation', tool: name }
  }

  const available = await probeGateway()
  if (!available) {
    return {
      success: false,
      output: null,
      error: `OmniRoute gateway unreachable at ${root}`,
      tool: name,
      available: false,
    }
  }

  if (isOmniWriteTool(name)) {
    // No documented REST write path for this gateway generation — requires the MCP SSE session.
    return {
      success: false,
      output: null,
      error: 'write path requires the MCP gateway session (SSE) — not reachable in this mode',
      tool: name,
    }
  }

  try {
    switch (name) {
      case 'omni_gateway_health':
        return {
          success: true,
          output: { available: true, root, checked_at: new Date().toISOString() },
          error: null,
          tool: name,
        }
      case 'omni_agent_card': {
        const card = await gatewayFetchJson('/.well-known/agent.json')
        return { success: true, output: card, error: null, tool: name }
      }
      case 'omni_list_models': {
        const models = extractModels(await gatewayFetchJson('/v1/models'))
        return { success: true, output: { models, count: models.length }, error: null, tool: name }
      }
      case 'omni_provider_status': {
        const models = extractModels(await gatewayFetchJson('/v1/models'))
        const groups = new Map<string, string[]>()
        for (const m of models) {
          const id = typeof m.id === 'string' ? m.id : JSON.stringify(m)
          const provider = id.includes('/') ? id.split('/')[0] : 'builtin'
          const list = groups.get(provider) ?? []
          list.push(id)
          groups.set(provider, list)
        }
        return {
          success: true,
          output: {
            providers: Array.from(groups.entries()).map(([pname, mlist]) => ({
              name: pname,
              model_count: mlist.length,
              models: mlist,
            })),
          },
          error: null,
          tool: name,
        }
      }
      case 'omni_usage_quota': {
        const card = asRecord(await gatewayFetchJson('/.well-known/agent.json'))
        const usage = card.usage ?? card.quota ?? null
        return {
          success: true,
          output:
            usage !== null
              ? { usage }
              : { available: true, note: 'usage quota not exposed by this gateway' },
          error: null,
          tool: name,
        }
      }
      case 'omni_current_route': {
        const card = asRecord(await gatewayFetchJson('/.well-known/agent.json'))
        const route = card.route ?? card.current_route ?? card.default_route ?? null
        return {
          success: true,
          output:
            route !== null
              ? { route }
              : { available: true, note: 'current route not exposed; gateway default active' },
          error: null,
          tool: name,
        }
      }
      case 'omni_skills_catalog': {
        const catalog = await gatewayFetchJson('/api/agent-skills')
        return { success: true, output: catalog, error: null, tool: name }
      }
      default:
        return { success: false, output: null, error: `unknown omniroute tool: ${name}`, tool: name }
    }
  } catch (err) {
    return {
      success: false,
      output: null,
      error: err instanceof Error ? err.message : 'omniroute tool failed',
      tool: name,
      available: true,
    }
  }
}
