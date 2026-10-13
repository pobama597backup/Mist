// M.I.S.T. in-service SSRF guard — shared by the browser pilot (Phase 2-d).
//
// A standalone PURE module (no imports outside node:dns) so the pilot imports
// it AND tests/security/pilot.test.ts exercises the exact same function. The
// mandate (Phase 2, pilot line): before any navigation/fetch —
//   1. scheme must be http/https (file:, chrome:, chrome-extension:, about:,
//      data:, javascript: are refused anywhere in a task)
//   2. resolve DNS ONCE (all addresses) → EVERY address must be public
//   3. the caller RE-VALIDATES immediately before the actual request: a
//      second resolution that answers private/link-local ABORTS (the
//      DNS-rebinding pin)
//
// Default policy refuses 127/8, 10/8, 172.16/12, 192.168/16, 169.254/16 (the
// cloud-metadata range — NEVER browsable), 0.0.0.0/8, ::1, fc00::/7, fe80::/10
// and IPv4-mapped variants of all of the above. MIST_LAN=1 allows the RFC1918
// private ranges + loopback + unique-local (an owner browsing their own LAN),
// but 169.254.169.254 stays refused — metadata is never browsable.
//
// Residual TOCTOU (honest): this module resolves via node:dns while Chromium
// resolves independently at connect time. The pilot's request-interception
// re-check happens at the LAST moment Playwright allows (before the request
// leaves the browser), shrinking the rebind window to the gap between the
// interceptor's lookup and Chromium's own connect — sub-second, but not zero.
// Owning the socket (a proxy) is the only way to close it fully; noted here
// so nobody mistakes validateUrl for a guarantee it cannot make.

import dns from 'node:dns/promises'

export interface UrlGuardOptions {
  /** MIST_LAN=1 — allow private/loopback/unique-local (metadata still refused). */
  mistLan?: boolean
  /** Injectable resolver (tests mock the DNS-rebinding flip). Must reject to
   *  simulate ENOTFOUND (fail-closed). */
  lookup?: (host: string) => Promise<string[]>
}

export interface UrlVerdict {
  ok: boolean
  /** refusal reason always starts with 'refused:' on ok:false. */
  reason?: string
  /** normalized absolute URL (ok only) */
  url?: string
  hostname?: string
  /** the validated address set (ok only) — the PIN the re-check compares against */
  addresses?: string[]
}

// ---------- IPv4 / IPv6 classification ----------

/** Strict dotted-quad parse (4 groups, 0-255). */
function parseIpv4(host: string): number[] | null {
  const parts = host.split('.')
  if (parts.length !== 4) return null
  const octets: number[] = []
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null
    const n = Number(p)
    if (n > 255) return null
    octets.push(n)
  }
  return octets
}

/** Cloud-metadata endpoints that are never browsable at ANY policy level. */
const METADATA_HOSTS = new Set(['169.254.169.254', 'metadata.google.internal', 'metadata.google.com', '100.100.100.200'])

/** Classify a dotted-quad. Returns the range name or null (public). */
function ipv4Range(o: number[]): string | null {
  const [a, b] = o
  if (a === 0) return 'this-network (0.0.0.0/8)'
  if (a === 10) return 'private (10.0.0.0/8)'
  if (a === 127) return 'loopback (127.0.0.0/8)'
  if (a === 169 && b === 254) return 'link-local/metadata (169.254.0.0/16)'
  if (a === 172 && b >= 16 && b <= 31) return 'private (172.16.0.0/12)'
  if (a === 192 && b === 168) return 'private (192.168.0.0/16)'
  if (a >= 224 && a <= 239) return 'multicast (224.0.0.0/4)'
  if (a === 255) return 'broadcast (255.255.255.255)'
  return null
}

/** Ranges allowed under MIST_LAN=1 (an owner browsing their own LAN). */
function ipv4LanAllowed(o: number[]): boolean {
  const [a, b] = o
  if (a === 10 || a === 127) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  return false
}

/** Classify an IPv6 literal (brackets stripped). IPv4-mapped forms — dotted
 *  (::ffff:127.0.0.1) AND hex (::ffff:7f00:1, the WHATWG URL canonical form)
 *  — delegate to the IPv4 policy so ::ffff:169.254.169.254 is metadata-
 *  refused too. */
function ipv6Range(host: string): string | null {
  const raw = host.replace(/^\[|\]$/g, '')
  const mapped = raw.match(/^(?:::ffff:|::)(\d{1,3}(?:\.\d{1,3}){3})$/i)
  if (mapped) {
    const quad = parseIpv4(mapped[1])
    if (quad) {
      if (METADATA_HOSTS.has(mapped[1])) return `cloud metadata (${mapped[1]})`
      return `IPv4-mapped ${ipv4Range(quad) ?? 'public'}`
    }
    if (/^::$/.test(raw)) return 'unspecified (::)'
  }
  // hex-encoded IPv4-mapped form: ::ffff:7f00:1 → 127.0.0.1 (the URL parser
  // canonicalizes dotted mapped literals into this shape)
  const mappedHex = raw.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i)
  if (mappedHex) {
    const hi = parseInt(mappedHex[1], 16)
    const lo = parseInt(mappedHex[2], 16)
    const dotted = `${(hi >> 8) & 255}.${hi & 255}.${(lo >> 8) & 255}.${lo & 255}`
    if (METADATA_HOSTS.has(dotted)) return `cloud metadata (${dotted} as ${raw})`
    return `IPv4-mapped ${ipv4Range([((hi >> 8) & 255), hi & 255, ((lo >> 8) & 255), lo & 255]) ?? 'public'} (${raw})`
  }
  if (raw === '::1') return 'loopback (::1)'
  if (/^f[cd]/i.test(raw)) return 'unique-local (fc00::/7)'
  if (/^fe[89ab]/i.test(raw)) return 'link-local (fe80::/10)'
  if (/^ff/i.test(raw)) return 'multicast (ff00::/8)'
  return null
}

function ipv6LanAllowed(host: string): boolean {
  const raw = host.replace(/^\[|\]$/g, '')
  if (raw === '::1') return true
  if (/^f[cd]/i.test(raw)) return true // unique-local
  const mapped = raw.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i)
  if (mapped) {
    const quad = parseIpv4(mapped[1])
    return quad !== null && ipv4LanAllowed(quad)
  }
  const mappedHex = raw.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i)
  if (mappedHex) {
    const hi = parseInt(mappedHex[1], 16)
    const lo = parseInt(mappedHex[2], 16)
    return ipv4LanAllowed([((hi >> 8) & 255), hi & 255, ((lo >> 8) & 255), lo & 255])
  }
  return false
}

// ---------- the default resolver (30s TTL cache — subresource traffic) ----------

interface CacheEntry {
  at: number
  addresses: string[]
}
const resolveCache = new Map<string, CacheEntry>()
const RESOLVE_TTL_MS = 30_000
const RESOLVE_CACHE_MAX = 128

/** node:dns lookup {all:true} with a small TTL cache. ONLY the default path
 *  uses the cache — an injected lookup (tests) always sees fresh answers. */
async function defaultLookup(host: string): Promise<string[]> {
  const hit = resolveCache.get(host)
  if (hit && Date.now() - hit.at < RESOLVE_TTL_MS) return hit.addresses
  const records = await dns.lookup(host, { all: true, verbatim: true })
  const addresses = records.map((r) => r.address)
  if (addresses.length === 0) throw new Error(`host resolved to no addresses: ${host}`)
  if (resolveCache.size >= RESOLVE_CACHE_MAX) {
    const oldest = resolveCache.keys().next().value
    if (oldest) resolveCache.delete(oldest)
  }
  resolveCache.set(host, { at: Date.now(), addresses })
  return addresses
}

/** Drop the resolver cache (used by nothing in production — honest seam for
 *  operators/tests that need a clean slate). */
export function clearResolveCache(): void {
  resolveCache.clear()
}

// ---------- classification over one address ----------

function addressRefusal(ip: string, mistLan: boolean): string | null {
  const quad = parseIpv4(ip)
  if (quad) {
    if (METADATA_HOSTS.has(ip)) return `cloud metadata endpoint ${ip} — metadata is never browsable`
    const range = ipv4Range(quad)
    if (range === null) return null // public
    if (mistLan && ipv4LanAllowed(quad)) return null // LAN mode allows private
    return `IP ${ip} is ${range}`
  }
  if (ip.includes(':')) {
    const range = ipv6Range(ip)
    if (range === null) return null
    if (mistLan && ipv6LanAllowed(ip)) return null
    return `IPv6 ${ip} is ${range}`
  }
  return `unroutable address ${ip}`
}

// ---------- the validator ----------

/**
 * Validate a URL for browsing: scheme gate → literal-IP or DNS-set gate.
 * Never throws — every failure is an honest refused: reason.
 */
export async function validateUrl(raw: string, opts: UrlGuardOptions = {}): Promise<UrlVerdict> {
  const mistLan = opts.mistLan === true
  const value = typeof raw === 'string' ? raw.trim() : ''
  if (!value) return { ok: false, reason: 'refused: "url" is required' }

  let parsed: URL
  try {
    parsed = new URL(/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value) ? value : `https://${value}`)
  } catch {
    return { ok: false, reason: `refused: invalid URL: ${value.slice(0, 120)}` }
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return {
      ok: false,
      reason: `refused: scheme "${parsed.protocol}" is not browsable (http/https only — file:, chrome:, data:, javascript: are blocked everywhere, including clicks and subresources)`,
      hostname: parsed.hostname,
    }
  }

  const host = parsed.hostname.replace(/\.$/, '')
  if (METADATA_HOSTS.has(host.toLowerCase())) {
    return {
      ok: false,
      reason: `refused: cloud metadata endpoint ${host.toLowerCase()} — metadata is never browsable`,
      hostname: host,
    }
  }

  // literal IP → no DNS needed
  const quad = parseIpv4(host)
  if (quad) {
    const refusal = addressRefusal(host, mistLan)
    if (refusal) return { ok: false, reason: `refused: ${refusal}`, hostname: host }
    return { ok: true, url: parsed.toString(), hostname: host, addresses: [host] }
  }
  if (host.includes(':')) {
    const refusal = addressRefusal(host, mistLan)
    if (refusal) return { ok: false, reason: `refused: ${refusal}`, hostname: host }
    return { ok: true, url: parsed.toString(), hostname: host, addresses: [host] }
  }

  // resolve ONCE — EVERY address must pass (a hostname that answers even one
  // private address is refused: the whole name is untrustworthy)
  const lookup = opts.lookup ?? defaultLookup
  let addresses: string[]
  try {
    addresses = await lookup(host)
  } catch {
    return { ok: false, reason: `refused: could not resolve host (fail-closed): ${host}`, hostname: host }
  }
  if (!Array.isArray(addresses) || addresses.length === 0) {
    return { ok: false, reason: `refused: host resolved to no addresses (fail-closed): ${host}`, hostname: host }
  }
  for (const ip of addresses) {
    const refusal = addressRefusal(String(ip), mistLan)
    if (refusal) {
      return { ok: false, reason: `refused: ${host} resolves to ${refusal}`, hostname: host, addresses }
    }
  }
  return { ok: true, url: parsed.toString(), hostname: host, addresses }
}
