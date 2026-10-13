// M.I.S.T. perimeter helpers — mini-services copy (Phase 1).
//
// Mirror of src/lib/perimeter/shared.ts (kept in sync by hand — the
// mini-services are standalone bun/node projects that cannot import across
// the tree boundary). Same files, same semantics:
//   ~/.mist/mist.json  (0700/0600) — { sessionSecret, bridgeToken (mirror), … }
//   ~/.mist/bridge.json (0600)     — { token } — CANONICAL bridge token
//
// neural-service verifies mist_session cookies here (socket allowRequest);
// mesh-service + browser-pilot accept `Authorization: Bearer <sessionSecret>`
// or `x-mist-service: <sessionSecret>` for intra-machine service calls.

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const SESSION_COOKIE = 'mist_session'
export const SERVICE_HEADER = 'x-mist-service'

export interface MistSecrets {
  sessionSecret: string
  bridgeToken: string
}

const HEX64 = /^[a-f0-9]{64}$/

/** Home dir — MIST_HOME escape hatch exists so tests (and exotic setups) can
 *  point the perimeter at a scratch directory. Bun's os.homedir() ignores
 *  $HOME at runtime, hence the explicit override. */
function homeDir(): string {
  const override = process.env.MIST_HOME?.trim()
  return override && override.length > 0 ? override : os.homedir()
}

function mistDir(): string {
  return path.join(homeDir(), '.mist')
}

function readJson(file: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>
    return null
  } catch {
    return null
  }
}

function writeJson(file: string, obj: Record<string, unknown>): void {
  try {
    fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n', { mode: 0o600 })
  } catch {
    /* best effort */
  }
}

let cached: MistSecrets | null = null

/** Read-or-create the machine's shared secrets (cached per process). */
export function getMistSecrets(): MistSecrets {
  if (cached) return cached
  const dir = mistDir()
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    fs.chmodSync(dir, 0o700)
  } catch {
    /* best effort */
  }
  const mistPath = path.join(dir, 'mist.json')
  let mist = readJson(mistPath)
  if (!mist || typeof mist.sessionSecret !== 'string' || !HEX64.test(mist.sessionSecret)) {
    mist = {
      sessionSecret: randomBytes(32).toString('hex'),
      generatedAt: new Date().toISOString(),
    }
    try {
      const fd = fs.openSync(mistPath, 'wx', 0o600)
      try {
        fs.writeFileSync(fd, JSON.stringify(mist, null, 2) + '\n', 'utf-8')
      } finally {
        fs.closeSync(fd)
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code
      if (code === 'EEXIST') {
        const raced = readJson(mistPath)
        if (raced && typeof raced.sessionSecret === 'string' && HEX64.test(raced.sessionSecret)) mist = raced
      }
      // other errors: fall through with the in-memory secret (single machine,
      // single owner — the next process will re-create the file)
    }
  }
  // canonical bridge token: ~/.mist/bridge.json
  const bridgePath = path.join(dir, 'bridge.json')
  let token: string
  const bridge = readJson(bridgePath)
  if (bridge && typeof bridge.token === 'string' && HEX64.test(bridge.token)) {
    token = bridge.token
  } else if (typeof mist.bridgeToken === 'string' && HEX64.test(mist.bridgeToken)) {
    token = mist.bridgeToken
    writeJson(bridgePath, { token, tokenGeneratedAt: new Date().toISOString() })
  } else {
    token = randomBytes(32).toString('hex')
    writeJson(bridgePath, { token, tokenGeneratedAt: new Date().toISOString() })
    if (readJson(mistPath)) writeJson(mistPath, { ...(mist as Record<string, unknown>), bridgeToken: token })
  }
  cached = { sessionSecret: mist.sessionSecret as string, bridgeToken: token }
  return cached
}

export function hmacHex(secret: string, message: string): string {
  return createHmac('sha256', secret).update(message).digest('hex')
}

/** Verify a `mist_session` cookie value (timing-safe, expiry-checked). */
export function verifySession(value: string | undefined | null): boolean {
  if (!value) return false
  const dot = value.indexOf('.')
  if (dot <= 0) return false
  const expiryRaw = value.slice(0, dot)
  const mac = value.slice(dot + 1)
  if (!/^\d{1,15}$/.test(expiryRaw) || !/^[a-f0-9]{64}$/.test(mac)) return false
  const expiry = Number(expiryRaw)
  if (!Number.isFinite(expiry) || expiry < Date.now()) return false
  const expected = hmacHex(getMistSecrets().sessionSecret, expiryRaw)
  try {
    return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(mac, 'hex'))
  } catch {
    return false
  }
}

/** Pull the mist_session value out of a raw Cookie header. */
export function cookieValue(cookieHeader: string | undefined | null, name: string = SESSION_COOKIE): string | null {
  if (!cookieHeader) return null
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=')
    if (eq <= 0) continue
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim()
  }
  return null
}

/** True when the Cookie header carries a VALID mist_session. */
export function hasValidSessionCookie(cookieHeader: string | undefined | null): boolean {
  return verifySession(cookieValue(cookieHeader))
}

/** Is `host` a loopback hostname (127.x / ::1 / localhost, port optional)? */
export function isLoopbackHost(host: string | undefined | null): boolean {
  if (!host) return false
  const hostname = host.toLowerCase().replace(/^\[/, '').replace(/\].*$/, '').replace(/:\d+$/, '')
  return hostname === 'localhost' || hostname === '::1' || hostname === '127.0.0.1' || /^127\.\d+\.\d+\.\d+$/.test(hostname)
}

/** Hostname part of an Origin header value ("https://a.b:81" → "a.b:81"). */
export function originHost(origin: string | undefined | null): string | null {
  if (!origin) return null
  const m = /^https?:\/\/([^/]+)/i.exec(origin.trim())
  return m?.[1]?.toLowerCase() ?? null
}

/** Bare hostname of a Host/Origin value — port-stripped (IPv6-bracket aware,
 * single-colon only so bare '::1' survives). Used by the socket allowRequest
 * same-origin comparison: cookies are port-agnostic, so the HOSTNAME is the
 * identity (a different port on the same host is the same machine/owner). */
export function hostnameOf(raw: string | undefined | null): string {
  if (!raw) return ''
  let host = raw.trim().toLowerCase()
  if (host.startsWith('[')) {
    const end = host.indexOf(']')
    return end > 0 ? host.slice(1, end) : host.slice(1)
  }
  const first = host.indexOf(':')
  if (first >= 0 && host.indexOf(':', first + 1) === -1) host = host.slice(0, first)
  return host
}

/** True when a raw request carries the intra-machine service credential
 * (`x-mist-service: <sessionSecret>`) — timing-safe. */
export function isServiceToken(value: string | undefined | null): boolean {
  if (!value) return false
  const secret = getMistSecrets().sessionSecret
  try {
    const a = Buffer.from(value)
    const b = Buffer.from(secret)
    return a.length === b.length && timingSafeEqual(a, b)
  } catch {
    return false
  }
}
