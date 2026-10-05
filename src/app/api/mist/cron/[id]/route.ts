// M.I.S.T. cron job API — per-job management.
//
// PATCH  /api/mist/cron/[id]   { enabled?: boolean, name?: string, prompt?: string }
//                              → 200 { ok: true, job } | 400/404 { ok?: false, error }
//                              (re-enabling recomputes nextRunAt from now)
// DELETE /api/mist/cron/[id]   → 200 { ok: true } | 404 { error }
import { NextRequest, NextResponse } from 'next/server'
import { updateCronJob, deleteCronJob } from '@/lib/services/scheduler-service'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function PATCH(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  let body: Record<string, unknown>
  try {
    body = (await request.json()) as Record<string, unknown>
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 })
  }

  const patch: { enabled?: boolean; name?: string; prompt?: string } = {}
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== 'boolean') {
      return NextResponse.json({ error: 'enabled must be a boolean' }, { status: 400 })
    }
    patch.enabled = body.enabled
  }
  if (body.name !== undefined) {
    if (typeof body.name !== 'string' || !body.name.trim()) {
      return NextResponse.json({ error: 'name must be a non-empty string' }, { status: 400 })
    }
    patch.name = body.name
  }
  if (body.prompt !== undefined) {
    if (typeof body.prompt !== 'string' || !body.prompt.trim()) {
      return NextResponse.json({ error: 'prompt must be a non-empty string' }, { status: 400 })
    }
    patch.prompt = body.prompt
  }
  if (!Object.keys(patch).length) {
    return NextResponse.json(
      { error: 'nothing to update — provide enabled, name and/or prompt' },
      { status: 400 }
    )
  }

  const res = await updateCronJob(id, patch)
  if (!res.ok || !res.job) {
    const status = res.error === 'job not found' ? 404 : 400
    return NextResponse.json({ ok: false, error: res.error ?? 'failed to update job' }, { status })
  }
  return NextResponse.json({ ok: true, job: res.job })
}

export async function DELETE(_request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  const res = await deleteCronJob(id)
  if (!res.ok) {
    return NextResponse.json({ ok: false, error: 'job not found' }, { status: 404 })
  }
  return NextResponse.json({ ok: true })
}
