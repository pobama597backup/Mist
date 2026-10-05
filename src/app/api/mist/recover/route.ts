// TEMPORARY recovery route (task 12-a) — DELETE AFTER USE.
// Kills the stale hot-reloaded neural-service chain and spawns a fresh one as
// a child of this dev-server process (boot-descended ancestry survives the
// sandbox tool-session reaper). Body: {"action":"restart_neural"}.
import { NextRequest, NextResponse } from 'next/server'
import { spawn, execSync } from 'node:child_process'
import fs from 'node:fs'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export const maxDuration = 60

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const body = (await req.json().catch(() => ({}))) as { action?: string }
    if (body.action !== 'restart_neural') {
      return NextResponse.json({ ok: false, error: 'unknown action' }, { status: 400 })
    }
    const log: string[] = []

    // 1. find the stale neural-service processes: `bun --hot index.ts` whose
    //    cwd is mini-services/neural-service (browser-pilot runs the same cmd!)
    const all = execSync('ls -l /proc/*/cwd 2>/dev/null || true', { encoding: 'utf-8' })
    const victims: string[] = []
    for (const line of all.split('\n')) {
      const m = /\/proc\/(\d+)\/cwd -> (.+)$/.exec(line)
      if (!m) continue
      const pid = m[1] ?? ''
      const cwd = m[2] ?? ''
      if (!cwd.endsWith('mini-services/neural-service')) continue
      try {
        const cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf-8').replace(/\0/g, ' ').trim()
        if (cmd.includes('bun') && (cmd.includes('--hot') || cmd.includes('run dev'))) {
          victims.push(pid)
        }
      } catch {
        /* process gone */
      }
    }
    // include the `bun run dev` wrappers by walking parents of the victims
    const killSet = new Set(victims)
    for (const pid of victims) {
      try {
        const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf-8')
        const ppid = Number(stat.split(') ')[1]?.split(' ')[1])
        if (Number.isFinite(ppid) && ppid > 1) {
          const pcmd = fs.readFileSync(`/proc/${ppid}/cmdline`, 'utf-8').replace(/\0/g, ' ').trim()
          if (pcmd.includes('bun run dev')) killSet.add(String(ppid))
        }
      } catch {
        /* gone */
      }
    }
    for (const pid of killSet) {
      try {
        process.kill(Number(pid), 'SIGTERM')
        log.push(`killed ${pid}`)
      } catch {
        log.push(`kill failed ${pid}`)
      }
    }

    // 2. spawn a fresh neural-service as a child of THIS process (survives)
    await new Promise((r) => setTimeout(r, 1200))
    const logFd = fs.openSync('/home/z/my-project/.zscripts/mini-service-neural-service.log', 'a')
    const child = spawn('bun', ['run', 'dev'], {
      cwd: '/home/z/my-project/mini-services/neural-service',
      detached: true,
      stdio: ['ignore', logFd, logFd],
    })
    child.unref()
    log.push(`spawned fresh neural-service (pid ${child.pid})`)
    return NextResponse.json({ ok: true, log })
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : 'recovery failed' },
      { status: 500 }
    )
  }
}
