// M.I.S.T. export route — "download her": the creator's full copy of Mist.
// Streams a tar.gz of the complete project — her source, skills, notes,
// bridge daemon, mini-services, database (memories, dreams, missions,
// conversations) and configs — everything that IS her, minus build
// artifacts (node_modules, .next) and transient sandbox state.
//
// 2026-09-27 portability fix: the sandbox .env carries an ABSOLUTE
// DATABASE_URL (/home/z/...) that would break on any other machine, and the
// export previously omitted .env entirely — so her brain pick (and the
// creator's keys) never traveled with her. The export now generates a
// PORTABLE .env on the fly: DATABASE_URL rewritten to the schema-relative
// path, every other line (keys, her MIST_LLM_PROVIDER pick) passed through.
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { NextResponse } from 'next/server'
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
const EXCLUDES = ['node_modules', '.next', '.git', 'research', 'tool-results', '.turbo', 'dev.log', 'agent-ctx']

/** Build a PORTABLE .env in a temp dir: DATABASE_URL rewritten to the
 *  schema-relative path (Prisma resolves `file:` URLs against prisma/),
 *  every other line passed through verbatim (keys + her brain pick). */
async function buildPortableEnv(root: string): Promise<{ dir: string; lines: number }> {
  let lines: string[] = []
  try {
    lines = (await fs.readFile(path.join(root, '.env'), 'utf-8')).split('\n')
  } catch {
    // no .env in this instance — generate a minimal portable one
  }
  let sawDb = false
  lines = lines.map((l) => {
    if (/^\s*DATABASE_URL\s*=/.test(l)) {
      sawDb = true
      return 'DATABASE_URL=file:../db/custom.db'
    }
    return l
  })
  if (!sawDb) lines.unshift('DATABASE_URL=file:../db/custom.db')
  // her brain pick must travel even if it lives only in process.env
  if (!lines.some((l) => /^\s*MIST_LLM_PROVIDER\s*=/.test(l))) {
    const pick = process.env.MIST_LLM_PROVIDER?.trim()
    if (pick) lines.push(`MIST_LLM_PROVIDER=${pick}`)
  }
  const body = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n'
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mist-export-env-'))
  await fs.writeFile(path.join(dir, '.env'), body, 'utf-8')
  return { dir, lines: body.split('\n').filter((l) => l.trim() && !l.startsWith('#')).length }
}

export async function GET(): Promise<NextResponse> {
  const root = projectRoot()
  const includes = [
    ...INCLUDE_DIRS.filter((d) => existsSync(path.join(root, d))).map((d) => `./${d}`),
    ...INCLUDE_FILES.filter((f) => existsSync(path.join(root, f))).map((f) => `./${f}`),
  ]
  if (includes.length === 0) {
    return NextResponse.json({ ok: false, error: 'nothing found to export' }, { status: 500 })
  }
  let envDir: string | null = null
  let envLines = 0
  try {
    const portable = await buildPortableEnv(root)
    envDir = portable.dir
    envLines = portable.lines
  } catch {
    // .env generation failed — export without it rather than failing the download
  }
  // -C applies to everything after it, so the portable .env goes LAST
  const args = [
    ...EXCLUDES.flatMap((e) => ['--exclude', e]),
    '-czf',
    '-',
    ...includes,
    ...(envDir ? ['-C', envDir, './.env'] : []),
  ]

  return new Promise<NextResponse>((resolve) => {
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
      if (envDir) fs.rm(envDir, { recursive: true, force: true }).catch(() => {})
      resolve(NextResponse.json({ ok: false, error: `export failed: ${err.message}` }, { status: 500 }))
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      if (envDir) fs.rm(envDir, { recursive: true, force: true }).catch(() => {})
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
        `creator downloaded her full export (${(body.length / 1_048_576).toFixed(1)} MB tar.gz${
          envDir ? `, portable .env with ${envLines} settings incl. her brain pick` : ''
        })`
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
}
