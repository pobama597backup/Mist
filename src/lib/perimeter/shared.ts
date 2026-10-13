// M.I.S.T. perimeter shared-secret infrastructure (Phase 1 · S1/S2/S3/S6).
//
// One machine, one owner. ~/.mist/mist.json (0700 dir / 0600 file) carries the
// per-machine session secret (HMAC key for mist_session cookies and the
// intra-machine `x-mist-service` header) plus a mirror of the bridge token.
// The CANONICAL bridge token lives in ~/.mist/bridge.json (0600) — the bridge
// daemon (plain Node, no imports from src/) reads-or-creates it on boot, and
// every same-machine process (Next, neural-service, bridge) converges on the
// same value regardless of who booted first.
//
// Session cookie model: `mist_session=<expiryMs>.<hmacSha256(sessionSecret,
// String(expiryMs))>` — HttpOnly, SameSite=Strict, Path=/, 30d. Verification
// is timing-safe and re-derives the MAC; the secret never leaves the machine.

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const SESSION_COOKIE = 'mist_session'
export const SERVICE_HEADER = 'x-mist-service'
export const SESSION_TTL_MS = 30 * 24 * 3600_000 // 30 days

export interface MistSecrets {
  sessionSecret: string
  /** Mirror of ~/.mist/bridge.json's token (canonical store for the token). */
  bridgeToken: string
  bridgeGeneratedAt: string
}

interface SecretsGlobal {
  __mistSecrets?: MistSecrets
}
const g = globalThis as unknown as SecretsGlobal

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
function mistJsonPath(): string {
  return path.join(mistDir(), 'mist.json')
}
function bridgeJsonPath(): string {
  return path.join(mistDir(), 'bridge.json')
}

function ensureDir(dir: string, mode: number): void {
  try {
    fs.mkdirSync(dir, { recursive: true, mode })
  } catch {
    /* exists, or a parallel creator already made it */
  }
  try {
    fs.chmodSync(dir, mode)
  } catch {
    /* best effort — never fatal */
  }
}

function readJson(file: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
    return null
  } catch {
    return null
  }
}

/** Read-or-create a JSON secrets file. The write is O_EXCL-atomic; on a race
 *  (another process created it between our read and write) we retry-read. */
function readOrCreateJson(file: string, dir: string, make: () => Record<string, unknown>): Record<string, unknown> {
  const existing = readJson(file)
  if (existing) return existing
  ensureDir(dir, 0o700)
  const fresh = make()
  const body = JSON.stringify(fresh, null, 2) + '\n'
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      // 'wx' = O_EXCL — fails with EEXIST if a parallel creator won the race
      const fd = fs.openSync(file, 'wx', 0o600)
      try {
        fs.writeFileSync(fd, body, 'utf-8')
      } finally {
        fs.closeSync(fd)
      }
      return fresh
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code
      if (code === 'EEXIST') {
        const raced = readJson(file)
        if (raced) return raced
        continue // EEXIST but unreadable — one more tick, then give up loudly
      }
      throw err
    }
  }
  throw new Error(`could not read-or-create ${file}`)
}

function writeJson(file: string, obj: Record<string, unknown>): void {
  try {
    fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n', { mode: 0o600 })
  } catch {
    /* best effort */
  }
}

/** The bridge token's canonical home is ~/.mist/bridge.json. Whoever needs it
 *  first creates it; the other processes read the same value. Never rotates
 *  in Phase 1 (regeneration is a Settings action for a later phase). */
function syncBridgeToken(): { token: string; generatedAt: string } {
  const bridgeFile = bridgeJsonPath()
  const bridge = readJson(bridgeFile)
  const fromBridge = bridge && typeof bridge.token === 'string' && HEX64.test(bridge.token) ? bridge.token : null

  const mist = readJson(mistJsonPath())
  const fromMist = mist && typeof mist.bridgeToken === 'string' && HEX64.test(mist.bridgeToken) ? mist.bridgeToken : null

  let token: string
  let generatedAt: string
  if (fromBridge) {
    token = fromBridge
    generatedAt =
      bridge && typeof bridge.tokenGeneratedAt === 'string' ? (bridge.tokenGeneratedAt as string) : new Date().toISOString()
    // mirror into mist.json if it is missing/stale there
    if (mist && fromMist !== fromBridge) {
      writeJson(mistJsonPath(), { ...mist, bridgeToken: token, bridgeGeneratedAt: generatedAt })
    }
  } else if (fromMist) {
    token = fromMist
    generatedAt =
      mist && typeof mist.bridgeGeneratedAt === 'string' ? (mist.bridgeGeneratedAt as string) : new Date().toISOString()
    ensureDir(mistDir(), 0o700)
    writeJson(bridgeFile, { token, tokenGeneratedAt: generatedAt })
    try {
      fs.chmodSync(bridgeFile, 0o600)
    } catch {
      /* best effort */
    }
  } else {
    token = randomBytes(32).toString('hex')
    generatedAt = new Date().toISOString()
    ensureDir(mistDir(), 0o700)
    writeJson(bridgeFile, { token, tokenGeneratedAt: generatedAt })
    try {
      fs.chmodSync(bridgeFile, 0o600)
    } catch {
      /* best effort */
    }
    if (mist) {
      writeJson(mistJsonPath(), { ...mist, bridgeToken: token, bridgeGeneratedAt: generatedAt })
    }
  }
  return { token, generatedAt }
}

/** Read-or-create the machine's secrets (cached per process). */
export function getMistSecrets(): MistSecrets {
  if (g.__mistSecrets) return g.__mistSecrets
  const dir = mistDir()
  ensureDir(dir, 0o700)
  const mist = readOrCreateJson(mistJsonPath(), dir, () => ({
    sessionSecret: randomBytes(32).toString('hex'),
    generatedAt: new Date().toISOString(),
  }))
  if (typeof mist.sessionSecret !== 'string' || !HEX64.test(mist.sessionSecret)) {
    // corrupt/partial file — regenerate the session secret in place (rare)
    mist.sessionSecret = randomBytes(32).toString('hex')
    writeJson(mistJsonPath(), mist)
  }
  const bridge = syncBridgeToken()
  const secrets: MistSecrets = {
    sessionSecret: mist.sessionSecret as string,
    bridgeToken: bridge.token,
    bridgeGeneratedAt: bridge.generatedAt,
  }
  g.__mistSecrets = secrets
  return secrets
}

/** HMAC helper — hex output. */
export function hmacHex(secret: string, message: string): string {
  return createHmac('sha256', secret).update(message).digest('hex')
}

/** The pair code printed by run.bat / derivable on the PC: a deterministic
 *  token the owner can paste into /api/mist/pair?code= to mint a session
 *  cookie from another context (terminal, README link). */
export function pairCode(): string {
  return hmacHex(getMistSecrets().sessionSecret, 'pair')
}

/** Mint a session cookie value: `<expiryMs>.<hmac(expiryMs)>`. */
export function issueSession(expiresInMs: number = SESSION_TTL_MS): string {
  const expiry = Date.now() + expiresInMs
  return `${expiry}.${hmacHex(getMistSecrets().sessionSecret, String(expiry))}`
}

/** Timing-safe session-cookie verification (expiry + MAC). */
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

/** True when a raw Cookie header carries a valid mist_session. */
export function hasValidSessionCookie(cookieHeader: string | undefined | null): boolean {
  if (!cookieHeader) return false
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=')
    if (eq <= 0) continue
    if (part.slice(0, eq).trim() === SESSION_COOKIE) {
      return verifySession(part.slice(eq + 1).trim())
    }
  }
  return false
}

/** Extract the mist_session cookie value (verified or not) — used for
 *  rate-limit bucket keys. */
export function sessionBucketKey(cookieHeader: string | undefined | null): string | null {
  if (!cookieHeader) return null
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=')
    if (eq <= 0) continue
    if (part.slice(0, eq).trim() === SESSION_COOKIE) return part.slice(eq + 1).trim()
  }
  return null
}
