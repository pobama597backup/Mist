// M.I.S.T. mesh service — the interop mesh (port 3004).
// Honest port of OpenJarvis's interop layer into a zero-dependency bun service:
//
//   src/openjarvis/mcp/server.py      → MCP server: JSON-RPC 2.0 at POST /mcp
//                                       (initialize / tools/list / tools/call,
//                                        MCP annotations, unknown → -32601)
//   src/openjarvis/a2a/{protocol,server}.py
//                                    → A2A agent card at GET / and
//                                       GET /.well-known/agent-card.json
//   src/openjarvis/security/ssrf.py   → SSRF guard for the http_check tool
//                                       (private IPs + cloud metadata +
//                                        disguised IPv4 + fail-closed DNS)
//
// Self-contained by design — mirrors neural-service: NO database access, NO
// z-ai-web-dev-sdk, NO external state. The 6 tools below are real and execute
// honestly; results are MCP-shaped ({content: [{type: 'text', text}]}).
//
// Browser reachability: this machine exposes a single gateway; browser-origin
// callers reach this service via /?XTransformPort=3004 (Caddy). Server-side
// callers may hit http://127.0.0.1:3004 directly.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { lookup } from 'node:dns/promises'
import { randomUUID } from 'node:crypto'

const PORT = 3004
const SERVER_NAME = 'mist-mesh'
const VERSION = '1.0.0'
// Protocol version pinned by OpenJarvis's MCP server (spec 2025-11-25).
const PROTOCOL_VERSION = '2025-11-25'

const STARTED_AT = Date.now()
let requestsServed = 0

// ---------------------------------------------------------------------------
// JSON-RPC 2.0 error codes (mirror openjarvis/mcp/protocol.py)
// ---------------------------------------------------------------------------
const PARSE_ERROR = -32700
const INVALID_REQUEST = -32600
const METHOD_NOT_FOUND = -32601
const INVALID_PARAMS = -32602
const INTERNAL_ERROR = -32603

interface JsonRpcError {
  code: number
  message: string
}

interface JsonRpcResponse {
  jsonrpc: '2.0'
  id: unknown
  result?: unknown
  error?: JsonRpcError
}

// ---------------------------------------------------------------------------
// SSRF guard — port of openjarvis/security/ssrf.py
// (private/reserved CIDRs, cloud metadata hosts, IPv4-mapped IPv6
//  normalization, disguised IPv4 forms, fail-closed DNS resolution)
// ---------------------------------------------------------------------------

const BLOCKED_HOSTS = new Set([
  '169.254.169.254', // AWS/GCP/Azure metadata
  'metadata.google.internal',
  'metadata.google.com',
  '100.100.100.200', // Alibaba Cloud metadata
])

/** Strict dotted-quad IPv4 → unsigned 32-bit number, else null. */
function parseIPv4Literal(host: string): number | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (!m) return null
  let n = 0
  for (let i = 1; i <= 4; i++) {
    const octet = Number(m[i])
    if (octet > 255) return null
    n = n * 256 + octet
  }
  return n
}

function ipv4ToString(n: number): string {
  return `${(n >>> 24) & 0xff}.${(n >>> 16) & 0xff}.${(n >>> 8) & 0xff}.${n & 0xff}`
}

/**
 * Tolerant inet_aton-style parse (decimal 2130706433, hex 0x7f000001, octal,
 * short-dotted 127.1). These forms are rejected by the strict parser but ARE
 * accepted by the C resolver the HTTP client ultimately uses, so they must be
 * classified here or they slip past to loopback/metadata. Returns null when
 * the text is already canonical dotted-quad (handled above) or not an IP.
 */
function parseIPv4Disguised(host: string): number | null {
  if (!/^[0-9a-fx.]+$/i.test(host)) return null
  const parts = host.split('.')
  if (parts.length > 4) return null
  const octets: number[] = []
  for (const part of parts) {
    let v: number
    if (/^0[xX]/.test(part)) {
      v = parseInt(part.slice(2), 16)
    } else if (part.length > 1 && part[0] === '0') {
      v = parseInt(part.slice(1), 8)
    } else {
      v = parseInt(part, 10)
    }
    if (!Number.isInteger(v) || v < 0 || v > 255) return null
    octets.push(v)
  }
  // Short forms: last part covers the remaining bytes (inet_aton semantics).
  const n = octets.length
  let packed = 0
  for (let i = 0; i < 4; i++) {
    if (i < n - 1) {
      packed = packed * 256 + octets[i]
    } else {
      // remaining bytes all encoded in the final part
      let rest = octets[n - 1]
      const bytesLeft = 4 - (n - 1)
      const bytes: number[] = []
      for (let b = 0; b < bytesLeft; b++) {
        bytes.unshift(rest & 0xff)
        rest = Math.floor(rest / 256)
      }
      if (rest > 0) return null // value too large for remaining bytes
      packed = packed * 256 + bytes[0]
      if (bytesLeft > 1) packed = packed * 256 + bytes[1]
      if (bytesLeft > 2) packed = packed * 256 + bytes[2]
      break
    }
  }
  packed = packed >>> 0
  if (ipv4ToString(packed) === host) return null // canonical form — already handled
  return packed
}

function inCidr4(n: number, base: number, bits: number): boolean {
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0
  return ((n >>> 0) & mask) === ((base >>> 0) & mask)
}

/** Port of is_private_ip for IPv4 (unsigned 32-bit input). */
function isPrivateIPv4(n: number): boolean {
  return (
    inCidr4(n, 0x00000000, 8) || // 0.0.0.0/8 (routes to localhost on Linux)
    inCidr4(n, 0x0a000000, 8) || // 10.0.0.0/8
    inCidr4(n, 0xac100000, 12) || // 172.16.0.0/12
    inCidr4(n, 0xc0a80000, 16) || // 192.168.0.0/16
    inCidr4(n, 0x7f000000, 8) || // 127.0.0.0/8
    inCidr4(n, 0xa9fe0000, 16) || // 169.254.0.0/16 link-local
    inCidr4(n, 0xe0000000, 4) || // 224.0.0.0/4 multicast
    n === 0xffffffff // 255.255.255.255 broadcast
  )
}

/** Parse an IPv6 literal (no brackets) into 8 groups, else null. */
function parseIPv6Literal(host: string): number[] | null {
  if (!host.includes(':')) return null
  // Embedded IPv4 tail (e.g. ::ffff:127.0.0.1) — convert to pure hex groups.
  let text = host
  const v4 = parseIPv4Literal(host.split(':').pop() ?? '')
  if (host.includes('.') && v4 !== null) {
    text = host.slice(0, host.lastIndexOf(':')) + ':' + ((v4 >>> 16) & 0xffff).toString(16) + ':' + (v4 & 0xffff).toString(16)
  }
  const halves = text.split('::')
  if (halves.length > 2) return null
  const parseGroups = (s: string): number[] | null => {
    if (s === '') return []
    const groups: number[] = []
    for (const part of s.split(':')) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(part)) return null
      groups.push(parseInt(part, 16))
    }
    return groups
  }
  const head = parseGroups(halves[0])
  if (head === null) return null
  let tail: number[] = []
  if (halves.length === 2) {
    const t = parseGroups(halves[1])
    if (t === null) return null
    tail = t
  }
  const missing = 8 - head.length - tail.length
  if (halves.length === 2) {
    if (missing < 0) return null
    return [...head, ...new Array(missing).fill(0), ...tail]
  }
  if (head.length !== 8) return null
  return head
}

function ipv6ToBigInt(groups: number[]): bigint {
  let n = 0n
  for (const g of groups) n = (n << 16n) | BigInt(g)
  return n
}

function inCidr6(n: bigint, base: bigint, bits: number): boolean {
  const mask = bits === 0 ? 0n : ((1n << BigInt(bits)) - 1n) << BigInt(128 - bits)
  return (n & mask) === (base & mask)
}

/** IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible (::a.b.c.d) extraction. */
function ipv4MappedIPv6(groups: number[]): number | null {
  const first80Zero = groups.slice(0, 5).every((g) => g === 0)
  if (!first80Zero) return null
  const big = ipv6ToBigInt(groups)
  if (big === 0n || big === 1n) return null // :: and ::1 stay IPv6
  if (groups[5] === 0xffff) {
    // IPv4-mapped
    return ((groups[6] << 16) | groups[7]) >>> 0
  }
  if (groups[5] === 0) {
    // IPv4-compatible (deprecated) — first 96 bits zero
    return ((groups[6] << 16) | groups[7]) >>> 0
  }
  return null
}

function isPrivateIPv6(groups: number[]): boolean {
  const n = ipv6ToBigInt(groups)
  return (
    n === 0n || // :: unspecified
    n === 1n || // ::1 loopback
    inCidr6(n, 0xfc00n << 112n, 7) || // fc00::/7 unique local
    inCidr6(n, 0xfe80n << 112n, 10) || // fe80::/10 link-local
    inCidr6(n, 0xff00n << 112n, 8) // ff00::/8 multicast
  )
}

/**
 * Port of check_ssrf: null = safe, string = human-readable block reason.
 * Fail-closed on unresolvable names (mirrors the OpenJarvis default).
 */
async function ssrfCheckReason(url: string): Promise<string | null> {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return 'invalid URL'
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return `blocked scheme: ${parsed.protocol} (only http/https allowed)`
  }
  const host = parsed.hostname.toLowerCase().replace(/^\[/, '').replace(/\]$/, '')
  if (!host) return 'no hostname in URL'
  if (BLOCKED_HOSTS.has(host)) return `blocked host: ${host} (cloud metadata endpoint)`

  // IPv6 literal (including IPv4-mapped forms)
  const v6 = parseIPv6Literal(host)
  if (v6 !== null) {
    const mapped = ipv4MappedIPv6(v6)
    if (mapped !== null) {
      const s = ipv4ToString(mapped)
      if (BLOCKED_HOSTS.has(s)) return `blocked host: ${s} (cloud metadata endpoint)`
      if (isPrivateIPv4(mapped)) return `URL resolves to private IP: ${s}`
      return null
    }
    if (isPrivateIPv6(v6)) return `URL resolves to private/reserved IPv6: ${host}`
    return null
  }

  // Strict IPv4 literal
  const v4 = parseIPv4Literal(host)
  if (v4 !== null) {
    if (isPrivateIPv4(v4)) return `URL resolves to private IP: ${host}`
    return null
  }

  // Disguised IPv4 (decimal / hex / octal / short-dotted)
  const disguised = parseIPv4Disguised(host)
  if (disguised !== null) {
    const s = ipv4ToString(disguised)
    if (BLOCKED_HOSTS.has(s)) return `blocked host: ${s} (cloud metadata endpoint)`
    if (isPrivateIPv4(disguised)) return `URL resolves to private IP: ${s} (disguised form)`
    return null
  }

  // DNS resolution — fail CLOSED
  let addrs: { address: string; family: number }[]
  try {
    addrs = await lookup(host, { all: true })
  } catch {
    return `could not resolve host (blocked, fail-closed): ${host}`
  }
  for (const a of addrs) {
    if (a.family === 6) {
      const g = parseIPv6Literal(a.address)
      if (g !== null) {
        const mapped = ipv4MappedIPv6(g)
        if (mapped !== null && isPrivateIPv4(mapped)) return `URL resolves to private IP: ${a.address}`
        if (isPrivateIPv6(g)) return `URL resolves to private/reserved IPv6: ${a.address}`
      }
    } else {
      const n = parseIPv4Literal(a.address)
      if (n !== null && isPrivateIPv4(n)) return `URL resolves to private IP: ${a.address}`
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// Tools — 6 real, self-contained tools served by the mesh itself
// ---------------------------------------------------------------------------

interface MeshTool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  /** MCP spec 2025-11-25 annotation hints (mirror of OpenJarvis _TOOL_ANNOTATIONS). */
  annotations: Record<string, unknown>
  execute: (args: Record<string, unknown>) => Promise<unknown>
}

class ToolError extends Error {}

function expectString(args: Record<string, unknown>, name: string): string {
  const v = args[name]
  if (typeof v !== 'string' || v.length === 0) throw new ToolError(`missing required string parameter: ${name}`)
  return v
}

async function httpCheck(url: string): Promise<unknown> {
  const reason = await ssrfCheckReason(url)
  if (reason) throw new ToolError(`SSRF guard blocked: ${reason}`)

  // Follow redirects manually (max 3) so every hop is re-validated — an
  // auto-following fetch could be bounced onto a private address.
  let current = url
  for (let hop = 0; hop <= 3; hop++) {
    const t0 = Date.now()
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 6000)
    let res: Response
    try {
      res = await fetch(current, {
        method: 'HEAD',
        redirect: 'manual',
        signal: ctrl.signal,
        headers: { 'user-agent': 'mist-mesh-http-check/1.0' },
      })
    } catch (err) {
      throw new ToolError(`request failed: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      clearTimeout(timer)
    }
    const latencyMs = Date.now() - t0
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const loc = res.headers.get('location')
      if (!loc) {
        return { ok: false, url: current, status: res.status, statusText: res.statusText, latencyMs, note: 'redirect without Location header' }
      }
      let next: string
      try {
        next = new URL(loc, current).toString()
      } catch {
        throw new ToolError(`redirect target is not a valid URL: ${loc}`)
      }
      const hopReason = await ssrfCheckReason(next)
      if (hopReason) throw new ToolError(`SSRF guard blocked redirect → ${next}: ${hopReason}`)
      current = next
      continue
    }
    return {
      ok: res.ok,
      url: current,
      status: res.status,
      statusText: res.statusText,
      latencyMs,
      contentType: res.headers.get('content-type'),
      server: res.headers.get('server'),
      method: 'HEAD',
    }
  }
  throw new ToolError('too many redirects (>3) — aborting')
}

const TOOLS: MeshTool[] = [
  {
    name: 'ping',
    description: 'Latency probe for the mesh service. Returns a pong with server-side execution latency; clients can measure the full round trip on their side.',
    inputSchema: {
      type: 'object',
      properties: {
        label: { type: 'string', description: 'Optional label echoed back in the response' },
      },
    },
    annotations: { readOnlyHint: true, destructiveHint: false },
    execute: async (args) => {
      const t0 = performance.now()
      await new Promise((r) => setTimeout(r, 0))
      const label = typeof args.label === 'string' && args.label.length > 0 ? args.label : undefined
      return {
        pong: true,
        ...(label !== undefined ? { label } : {}),
        latencyMs: Math.round((performance.now() - t0) * 1000) / 1000,
        serverTimestamp: new Date().toISOString(),
        note: 'latencyMs is server-side execution latency; measure the JSON-RPC round trip client-side for full RTT',
      }
    },
  },
  {
    name: 'mesh_status',
    description: 'Health snapshot of the M.I.S.T. mesh service: uptime, which tools live here, protocol version, and requests served since boot.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true, destructiveHint: false },
    execute: async () => ({
      service: SERVER_NAME,
      version: VERSION,
      protocolVersion: PROTOCOL_VERSION,
      status: 'ok',
      uptimeMs: Date.now() - STARTED_AT,
      startedAt: new Date(STARTED_AT).toISOString(),
      tools: TOOLS.map((t) => t.name),
      requestsServed,
      endpoints: {
        mcp: '/mcp (POST, JSON-RPC 2.0)',
        a2aCard: '/.well-known/agent-card.json (GET)',
        health: '/health (GET)',
      },
    }),
  },
  {
    name: 'echo_json',
    description: 'Parse/validate helper: accepts a JSON string (or already-parsed object) and returns the canonical pretty-printed form plus type info. Invalid JSON is reported as an error, never guessed.',
    inputSchema: {
      type: 'object',
      properties: {
        payload: { type: ['string', 'object'], description: 'JSON text to parse and canonicalize, or an object to canonicalize' },
      },
      required: ['payload'],
    },
    annotations: { readOnlyHint: true, destructiveHint: false },
    execute: async (args) => {
      const raw = args.payload
      let parsed: unknown
      if (typeof raw === 'string') {
        try {
          parsed = JSON.parse(raw)
        } catch (err) {
          throw new ToolError(`payload is not valid JSON: ${err instanceof Error ? err.message : String(err)}`)
        }
      } else if (raw !== null && typeof raw === 'object') {
        parsed = raw
      } else {
        throw new ToolError('payload must be a JSON string or an object')
      }
      const canonical = JSON.stringify(parsed, null, 2)
      return {
        valid: true,
        type: Array.isArray(parsed) ? 'array' : parsed === null ? 'null' : typeof parsed,
        byteLength: Buffer.byteLength(canonical, 'utf8'),
        canonical,
      }
    },
  },
  {
    name: 'time_now',
    description: 'Current time on the mesh host: ISO timestamp, epoch milliseconds, timezone name, UTC offset and locale formatting info.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true, destructiveHint: false },
    execute: async () => {
      const now = new Date()
      const tz = Intl.DateTimeFormat().resolvedOptions()
      return {
        iso: now.toISOString(),
        epochMs: now.getTime(),
        timezone: tz.timeZone,
        locale: tz.locale,
        utcOffsetMinutes: -now.getTimezoneOffset(),
        utcOffsetLabel: `UTC${now.getTimezoneOffset() <= 0 ? '+' : '-'}${String(Math.floor(Math.abs(now.getTimezoneOffset()) / 60)).padStart(2, '0')}:${String(Math.abs(now.getTimezoneOffset()) % 60).padStart(2, '0')}`,
      }
    },
  },
  {
    name: 'http_check',
    description: 'HEAD a public URL and report status/latency/content-type. SSRF-guarded: private IPs, link-local, multicast, cloud metadata endpoints, disguised IPv4 forms and unresolvable hosts are blocked; redirects are followed manually (max 3) with every hop re-validated.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Absolute http(s) URL to check' },
      },
      required: ['url'],
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    execute: async (args) => {
      const url = expectString(args, 'url')
      return await httpCheck(url)
    },
  },
  {
    name: 'uuid_new',
    description: 'Generate cryptographically random RFC 4122 v4 UUID(s) via node:crypto.',
    inputSchema: {
      type: 'object',
      properties: {
        count: { type: 'number', description: 'How many UUIDs to return (1-16, default 1)' },
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
    execute: async (args) => {
      let count = 1
      if (args.count !== undefined) {
        const n = typeof args.count === 'number' ? args.count : Number(args.count)
        if (!Number.isInteger(n) || n < 1 || n > 16) throw new ToolError('count must be an integer between 1 and 16')
        count = n
      }
      const uuids = Array.from({ length: count }, () => randomUUID())
      return count === 1 ? { uuid: uuids[0], version: 'v4' } : { uuids, count, version: 'v4' }
    },
  },
]

// ---------------------------------------------------------------------------
// A2A agent card — port of openjarvis/a2a/protocol.py AgentCard
// (served at GET / and GET /.well-known/agent-card.json, the A2A discovery
//  convention; OpenJarvis used /.well-known/agent.json — both are honored
//  here for discovery compatibility)
// ---------------------------------------------------------------------------

function agentCard(): Record<string, unknown> {
  return {
    name: 'M.I.S.T. (Clare)',
    description:
      'Interop mesh of the M.I.S.T. AI console: a Model Context Protocol tool server (JSON-RPC 2.0 at POST /mcp) and A2A-discoverable agent card, ported from the OpenJarvis framework. Tools are self-contained diagnostics — the mesh holds no database access.',
    url: `http://127.0.0.1:${PORT}/`,
    version: VERSION,
    capabilities: {
      streaming: false,
      tools: true,
    },
    skills: TOOLS.map((t) => ({
      id: t.name,
      name: t.name,
      description: t.description,
    })),
    provider: {
      organization: 'M.I.S.T.',
      url: 'http://127.0.0.1:3000',
    },
    // extension fields (honest interop documentation)
    protocol: 'a2a+jsonrpc/2.0',
    mcp: {
      endpoint: '/mcp',
      protocolVersion: PROTOCOL_VERSION,
      serverInfo: SERVER_NAME,
    },
    gateway: {
      note: 'Browser-origin callers reach this service through the sandbox gateway with the XTransformPort query param; this route itself needs no CORS.',
      path: `/?XTransformPort=${PORT}`,
    },
  }
}

// ---------------------------------------------------------------------------
// MCP JSON-RPC dispatch — port of openjarvis/mcp/server.py MCPServer.handle
// ---------------------------------------------------------------------------

function rpcResult(id: unknown, result: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, result }
}

function rpcError(id: unknown, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message } }
}

function handleInitialize(id: unknown): JsonRpcResponse {
  return rpcResult(id, {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {
      tools: { listChanged: true },
    },
    serverInfo: {
      name: SERVER_NAME,
      version: VERSION,
      title: 'M.I.S.T. Mesh Server',
    },
  })
}

function handleToolsList(id: unknown): JsonRpcResponse {
  return rpcResult(id, {
    tools: TOOLS.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
      annotations: t.annotations,
    })),
  })
}

async function handleToolsCall(id: unknown, params: Record<string, unknown>): Promise<JsonRpcResponse> {
  const name = params.name
  if (typeof name !== 'string' || name.length === 0) {
    return rpcError(id, INVALID_PARAMS, 'Missing required parameter: name')
  }
  const tool = TOOLS.find((t) => t.name === name)
  if (!tool) {
    return rpcError(id, INVALID_PARAMS, `Unknown tool: ${name}`)
  }
  const args =
    params.arguments && typeof params.arguments === 'object' && !Array.isArray(params.arguments)
      ? (params.arguments as Record<string, unknown>)
      : {}
  try {
    const result = await tool.execute(args)
    // MCP tool result shape: content blocks + isError flag.
    return rpcResult(id, {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      isError: false,
    })
  } catch (err) {
    if (err instanceof ToolError) {
      return rpcResult(id, {
        content: [{ type: 'text', text: err.message }],
        isError: true,
      })
    }
    return rpcError(id, INTERNAL_ERROR, `Tool execution error: ${err instanceof Error ? err.message : String(err)}`)
  }
}

async function dispatchRpc(body: unknown): Promise<JsonRpcResponse | JsonRpcResponse[] | null> {
  // Batch support (JSON-RPC 2.0 spec)
  if (Array.isArray(body)) {
    if (body.length === 0) return rpcError(null, INVALID_REQUEST, 'empty batch')
    const out: JsonRpcResponse[] = []
    for (const one of body) {
      const r = await dispatchRpc(one)
      if (r !== null && !Array.isArray(r)) out.push(r)
    }
    return out
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return rpcError(null, INVALID_REQUEST, 'request must be a JSON-RPC 2.0 object')
  }
  const req = body as { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown }
  if (req.jsonrpc !== '2.0' || typeof req.method !== 'string' || req.method.length === 0) {
    return rpcError(req.id ?? null, INVALID_REQUEST, 'invalid JSON-RPC 2.0 request (jsonrpc must be "2.0" and method a string)')
  }
  const isNotification = req.id === undefined
  const params = req.params && typeof req.params === 'object' && !Array.isArray(req.params) ? (req.params as Record<string, unknown>) : {}

  switch (req.method) {
    case 'initialize':
      return handleInitialize(req.id)
    case 'tools/list':
      return handleToolsList(req.id)
    case 'tools/call':
      return await handleToolsCall(req.id, params)
    case 'ping':
      // MCP protocol-level ping → empty result
      return isNotification ? null : rpcResult(req.id, {})
    case 'notifications/initialized':
    case 'notifications/cancelled':
    case 'notifications/roots/list_changed':
      // spec notifications — no response
      return null
    default:
      if (isNotification) return null
      return rpcError(req.id, METHOD_NOT_FOUND, `Unknown method: ${req.method}`)
  }
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

const MAX_BODY_BYTES = 1_000_000

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body too large (max 1 MB)'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  const started = Date.now()
  requestsServed++
  const method = req.method ?? 'GET'
  let pathname = '/'
  try {
    pathname = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`).pathname
  } catch {
    /* keep '/' */
  }

  const finish = (status: number, payload: unknown): void => {
    const body = JSON.stringify(payload)
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(body)
    console.log(`${new Date().toISOString()} ${method} ${pathname} → ${status} (${Date.now() - started}ms)`)
  }

  // GET / → A2A agent card
  if (method === 'GET' && (pathname === '/' || pathname === '')) {
    finish(200, agentCard())
    return
  }

  // GET /.well-known/agent-card.json (A2A discovery) — agent.json alias honored
  if (method === 'GET' && (pathname === '/.well-known/agent-card.json' || pathname === '/.well-known/agent.json')) {
    finish(200, agentCard())
    return
  }

  // GET /health
  if (method === 'GET' && pathname === '/health') {
    finish(200, {
      ok: true,
      service: SERVER_NAME,
      version: VERSION,
      uptimeMs: Date.now() - STARTED_AT,
      startedAt: new Date(STARTED_AT).toISOString(),
      tools: TOOLS.length,
      requestsServed,
    })
    return
  }

  // POST /mcp — MCP over HTTP (JSON-RPC 2.0)
  if (method === 'POST' && pathname === '/mcp') {
    void (async () => {
      try {
        const raw = await readBody(req)
        let parsed: unknown
        try {
          parsed = JSON.parse(raw)
        } catch {
          finish(200, rpcError(null, PARSE_ERROR, 'parse error: body is not valid JSON'))
          return
        }
        const out = await dispatchRpc(parsed)
        if (out === null) {
          // notification — no response body (JSON-RPC 2.0)
          res.writeHead(204)
          res.end()
          console.log(`${new Date().toISOString()} ${method} ${pathname} → 204 (notification)`)
          return
        }
        finish(200, out)
      } catch (err) {
        finish(200, rpcError(null, INTERNAL_ERROR, err instanceof Error ? err.message : 'internal error'))
      }
    })()
    return
  }

  // clean 404 everywhere else
  finish(404, {
    error: 'not found',
    hint: `M.I.S.T. mesh serves: GET / (A2A agent card), GET /.well-known/agent-card.json, GET /health, POST /mcp (MCP JSON-RPC 2.0)`,
  })
})

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[mist-mesh] MCP server + A2A agent card on :${PORT}`)
  console.log(`[mist-mesh] tools: ${TOOLS.map((t) => t.name).join(', ')}`)
  console.log(`[mist-mesh] browser origin reaches this service via /?XTransformPort=${PORT}`)
})

process.on('SIGTERM', () => {
  server.close(() => process.exit(0))
})
process.on('SIGINT', () => {
  server.close(() => process.exit(0))
})
