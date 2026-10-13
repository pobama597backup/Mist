// M.I.S.T. export route — "download her": the creator's full copy of Mist.
// Streams a tar.gz of the project — her source, skills, notes, bridge daemon,
// mini-services, configs — everything that IS her, minus build artifacts,
// runtime state, and EVERY secret.
//
// PHASE 1 (S3) HARDENING:
//   · POST is the real entry: requires a valid mist_session cookie (401) AND
//     a typed confirmation body {confirm:"EXPORT"} (400 otherwise). GET is
//     kept for compatibility but equally demands the session; it always
//     produces the SECRET-FREE export.
//   · NEVER ships by default: `.env`, `db/*.db*` (her brain DB), `db/backups/`,
//     `db/notes/` (runtime state), `db/provider-keys.json`, and any file whose
//     name contains token/secret. A redacted `.env.example` template (key
//     NAMES only, values stripped) travels instead.
//   · Optional include-keys mode (`?includeKeys=1` + confirm "EXPORT+KEYS" +
//     `passphrase` in the body): the secret material (.env secret values +
//     provider-keys.json) is sealed with AES-256-GCM (scrypt KDF) into
//     `secrets/mist-keys.enc` inside the tar. Without a passphrase → 400.
//     Plaintext secrets NEVER enter the tar — not even in include-keys mode.
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createCipheriv, randomBytes, scryptSync } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'
import { hasValidSessionCookie } from '@/lib/perimeter/shared'
import { checkRateLimit, rateLimitResponse } from '@/lib/perimeter/rate-limit'
import { projectRoot } from '@/lib/services/telemetry-service'
import { recordActivity } from '@/lib/services/activity-service'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export const maxDuration = 300

const INCLUDE_DIRS = ['src', 'prisma', 'db', 'mini-services', 'skills', 'examples', 'public']
const INCLUDE_FILES = [
  'package.json',
  'bun.lock',
  'tsconfig.json',
  'next.config.ts',
  'eslint.config.mjs',
  'components.json',
  'postcss.config.mjs',
  'tailwind.config.ts',
  'Caddyfile',
  'worklog.md',
  'README.md',
  'CAPABILITIES.md',
  'MIGRATION_STATE.md',
  'PC-SETUP.md',
  'run.bat',
  'stop.bat',
  'restart.bat',
]
// build artifacts, sandbox residue, and — Phase 1 — every secret-shaped thing
const EXCLUDES = [
  'node_modules',
  '.next',
  '.git',
  'research',
  'tool-results',
  '.turbo',
  'dev.log',
  'agent-ctx',
  // ---- Phase 1 secret exclusions (S3) — NEVER shipped in the default tar ----
  // NOTE: the generated template is named `env.example` (no dot) and the
  // sealed blob rides under `keys/` so neither is caught by these patterns.
  './.env',
  './.env.local',
  './.env.development',
  './.env.production',
  './db/*.db*',
  './db/backups',
  './db/provider-keys.json',
  './db/notes',
  '*token*',
  '*secret*',
]
/** Key lines whose VALUES are stripped from any shipped .env-like file. */
const SECRET_LINE = /^\s*(?:export\s+)?([A-Za-z0-9_]*(?:API_KEY|TOKEN|SECRET|PASSWORD)[A-Za-z0-9_]*)\s*=/

/** Build a redacted, portable `env.example` in a temp dir: the schema of the
 *  instance's real .env (DATABASE_URL normalized, her brain pick preserved)
 *  with every secret value replaced by a fill-me-in placeholder. The file is
 *  named WITHOUT a leading dot so it cannot collide with the .env excludes. */
async function buildEnvTemplate(root: string): Promise<{ dir: string; redacted: number; kept: number }> {
  const lines = await fs
    .readFile(path.join(root, '.env'), 'utf-8')
    .then((t) => t.split('\n'))
    .catch(() => [] as string[])
  let sawDb = false
  let redacted = 0
  const out: string[] = [
    '# M.I.S.T. portable environment template (secrets redacted by export — Phase 1)',
    '# Paste your own values for the REDACTED lines, then rename this file to .env',
  ]
  for (const l of lines) {
    if (SECRET_LINE.test(l)) {
      const name = SECRET_LINE.exec(l)?.[1] ?? 'SECRET'
      out.push(`# ${name} was set on the source machine (value redacted)`)
      out.push(`${name}=`)
      redacted++
      continue
    }
    if (/^\s*DATABASE_URL\s*=/.test(l)) {
      sawDb = true
      out.push('DATABASE_URL=file:../db/custom.db')
      continue
    }
    out.push(l)
  }
  if (!sawDb) out.push('DATABASE_URL=file:../db/custom.db')
  // her brain pick travels — it is a model name, not a credential
  if (!out.some((l) => /^\s*MIST_LLM_PROVIDER\s*=/.test(l))) {
    const pick = process.env.MIST_LLM_PROVIDER?.trim()
    if (pick) out.push(`MIST_LLM_PROVIDER=${pick}`)
  }
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mist-export-env-'))
  await fs.writeFile(path.join(dir, 'env.example'), out.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n', 'utf-8')
  const kept = out.filter((l) => l && !l.startsWith('#') && !SECRET_LINE.test(l) && !/DATABASE_URL|MIST_LLM_PROVIDER/.test(l)).length
  return { dir, redacted, kept }
}

/** AES-256-GCM-seal the secret material (scrypt KDF). Format:
 *  "MISTENC1" || salt(16) || iv(12) || ciphertext+tag — binary. */
function sealSecrets(passphrase: string, payload: unknown): Buffer {
  const salt = randomBytes(16)
  const iv = randomBytes(12)
  const key = scryptSync(passphrase, salt, 32, { N: 16384, r: 8, p: 1 })
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const data = Buffer.concat([
    cipher.update(JSON.stringify(payload, null, 2), 'utf-8'),
    cipher.final(),
  ])
  return Buffer.concat([Buffer.from('MISTENC1', 'utf-8'), salt, iv, data, cipher.getAuthTag()])
}

/** Collect every secret the owner asked to travel: the real .env secret
 *  values + db/provider-keys.json. Sealed into one encrypted blob. */
function collectSecrets(root: string): Record<string, unknown> {
  const env: Record<string, string> = {}
  try {
    for (const l of readFileSync(path.join(root, '.env'), 'utf-8').split('\n')) {
      const m = SECRET_LINE.exec(l)
      if (m) {
        const name = m[1] ?? ''
        const value = l.slice(l.indexOf('=') + 1).trim()
        if (name && value) env[name] = value
      }
    }
  } catch {
    /* no .env */
  }
  let providerKeys: unknown = null
  try {
    providerKeys = JSON.parse(readFileSync(path.join(root, 'db', 'provider-keys.json'), 'utf-8'))
  } catch {
    /* none */
  }
  return { env, providerKeys }
}

async function buildExport(includeKeys: boolean, passphrase?: string): Promise<NextResponse> {
  const root = projectRoot()
  const includes = [
    ...INCLUDE_DIRS.filter((d) => existsSync(path.join(root, d))).map((d) => `./${d}`),
    ...INCLUDE_FILES.filter((f) => existsSync(path.join(root, f))).map((f) => `./${f}`),
  ]
  if (includes.length === 0) {
    return NextResponse.json({ ok: false, error: 'nothing found to export' }, { status: 500 })
  }
  const tmpDirs: string[] = []
  let envLines = { redacted: 0, kept: 0 }
  let secretsDir: string | null = null
  try {
    const template = await buildEnvTemplate(root)
    tmpDirs.push(template.dir)
    envLines = { redacted: template.redacted, kept: template.kept }
    if (includeKeys) {
      if (!passphrase || passphrase.length < 8) {
        return NextResponse.json(
          { ok: false, error: 'includeKeys requires a passphrase of at least 8 characters to seal the keys blob' },
          { status: 400 }
        )
      }
      // keys/mist-keys.enc: AES-256-GCM blob — the ONLY form in which
      // key material travels, even in include-keys mode (dir name "keys"
      // deliberately dodges the *secret*/*token* exclusion patterns)
      const encDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mist-export-keys-'))
      tmpDirs.push(encDir)
      secretsDir = encDir
      await fs.mkdir(path.join(encDir, 'keys'), { recursive: true })
      const sealedBlob = sealSecrets(passphrase, collectSecrets(root))
      await fs.writeFile(path.join(encDir, 'keys', 'mist-keys.enc'), sealedBlob)
      await fs.writeFile(
        path.join(encDir, 'keys', 'README.txt'),
        [
          'mist-keys.enc — your sealed keys (Phase 1 export)',
          '',
          'It contains the .env secret values + db/provider-keys.json from the',
          'source machine, encrypted with AES-256-GCM (scrypt KDF) using the',
          'passphrase you typed at export time. Plaintext keys are NEVER packed.',
          '',
          'To open it on the machine you restore her on:',
          '  bun scripts/decrypt-export.ts keys/mist-keys.enc',
          '(or any aes-256-gcm + scrypt(N:16384,r:8,p:1) tool — blob format:',
          ' "MISTENC1" || salt(16) || iv(12) || ciphertext || tag(16))',
        ].join('\n'),
        'utf-8'
      )
    }
    const args = [
      ...EXCLUDES.flatMap((e) => ['--exclude', e]),
      '-czf',
      '-',
      ...includes,
      // -C applies to everything after it, so the generated files go LAST
      ...(secretsDir ? ['-C', secretsDir, './keys'] : []),
      '-C', template.dir, './env.example',
    ]

    return await new Promise<NextResponse>((resolve) => {
      const child = spawn('tar', args, { cwd: root, shell: false })
      let stderr = Buffer.alloc(0)
      let size = 0
      let settled = false
      const chunks: Buffer[] = []

      child.stdout.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > 400 * 1024 * 1024) {
          child.kill('SIGKILL')
          return
        }
        chunks.push(chunk)
      })
      child.stderr.on('data', (chunk: Buffer) => {
        stderr = Buffer.concat([stderr, chunk])
      })
      child.on('error', (err) => {
        if (settled) return
        settled = true
        resolve(NextResponse.json({ ok: false, error: `export failed: ${err.message}` }, { status: 500 }))
      })
      child.on('close', (code) => {
        if (settled) return
        settled = true
        if (code !== 0) {
          resolve(
            NextResponse.json(
              { ok: false, error: `tar exited ${code}: ${stderr.toString('utf-8').slice(0, 300)}` },
              { status: 500 }
            )
          )
          return
        }
        const body = Buffer.concat(chunks)
        recordActivity(
          'config',
          `creator downloaded her export (${(body.length / 1_048_576).toFixed(1)} MB tar.gz, keys ${
            secretsDir ? 'sealed (encrypted blob)' : 'excluded'
          }${envLines.redacted > 0 ? `, env.example with ${envLines.redacted} redacted key lines` : ''})`
        )
        resolve(
          new NextResponse(new Uint8Array(body), {
            status: 200,
            headers: {
              'Content-Type': 'application/gzip',
              'Content-Disposition': 'attachment; filename="mist-complete.tar.gz"',
              'Cache-Control': 'no-store',
            },
          })
        )
      })
    })
  } finally {
    for (const d of tmpDirs) fs.rm(d, { recursive: true, force: true }).catch(() => {})
  }
}

/** POST — the real export entry (Phase 1). Session + typed confirmation. */
export async function POST(req: NextRequest): Promise<NextResponse> {
  if (!hasValidSessionCookie(req.headers.get('cookie'))) {
    return NextResponse.json({ ok: false, error: 'session required' }, { status: 401 })
  }
  // Phase 1 · S12: the export runs tar + (keys mode) scrypt — 5/min.
  const rl = checkRateLimit('export', req)
  if (!rl.ok) return rateLimitResponse('export', rl.retryAfter ?? 1)
  const body = (await req.json().catch(() => null)) as { confirm?: unknown; passphrase?: unknown } | null
  const confirm = typeof body?.confirm === 'string' ? body.confirm : ''
  const includeKeys = req.nextUrl.searchParams.get('includeKeys') === '1'
  if (includeKeys) {
    if (confirm !== 'EXPORT+KEYS') {
      return NextResponse.json(
        { ok: false, error: 'typed confirmation required: {"confirm":"EXPORT+KEYS"} for a keys-included export' },
        { status: 400 }
      )
    }
    const passphrase = typeof body?.passphrase === 'string' ? body.passphrase : ''
    return buildExport(true, passphrase)
  }
  if (confirm !== 'EXPORT') {
    return NextResponse.json(
      { ok: false, error: 'typed confirmation required: {"confirm":"EXPORT"}' },
      { status: 400 }
    )
  }
  return buildExport(false)
}

/** GET — compatibility entry (Phase 1): session required; always the
 *  secret-free export (no confirmation can ride a GET body). */
export async function GET(req: NextRequest): Promise<NextResponse> {
  if (!hasValidSessionCookie(req.headers.get('cookie'))) {
    return NextResponse.json({ ok: false, error: 'session required' }, { status: 401 })
  }
  const rl = checkRateLimit('export', req)
  if (!rl.ok) return rateLimitResponse('export', rl.retryAfter ?? 1)
  return buildExport(false)
}
