// M.I.S.T. cron API — Hermes-style scheduled automations.
//
// GET  /api/mist/cron            → { jobs: CronJob[] }  (also bootstraps the
//                                  30s scheduler watch + one-time default seed)
// POST /api/mist/cron            → create a job.
//   Natural language:  { name, prompt, schedule: "every day at 9", timezone?, delivery? }
//   Structured:        { name, prompt, kind: "cron", expr: "0 8 * * *", timezone?, delivery? }
//                      { name, prompt, kind: "fixed_rate", intervalMin: 30, ... }
//                      { name, prompt, kind: "one_time", runAt: "2026-08-01T10:00:00Z", ... }
//   → 200 { ok: true, job, explanation? }  |  400 { error }
import { NextRequest, NextResponse } from 'next/server'
import {
  ensureSchedulerWatch,
  listCronJobs,
  createCronJob,
  parseNaturalSchedule,
  type CronJobSpec,
} from '@/lib/services/scheduler-service'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function GET() {
  ensureSchedulerWatch()
  try {
    const jobs = await listCronJobs()
    return NextResponse.json({ jobs })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'failed to list cron jobs' },
      { status: 500 }
    )
  }
}

export async function POST(request: NextRequest) {
  let body: Record<string, unknown>
  try {
    body = (await request.json()) as Record<string, unknown>
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 })
  }

  const name = typeof body.name === 'string' ? body.name.trim() : ''
  const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : ''
  if (!name) return NextResponse.json({ error: 'name is required' }, { status: 400 })
  if (!prompt) return NextResponse.json({ error: 'prompt is required' }, { status: 400 })
  const timezone =
    typeof body.timezone === 'string' && body.timezone.trim() ? body.timezone.trim() : 'Africa/Lagos'
  const delivery: 'alert' | 'silent' = body.delivery === 'silent' ? 'silent' : 'alert'

  try {
    let spec: CronJobSpec
    let explanation: string | undefined

    if (typeof body.schedule === 'string' && body.schedule.trim()) {
      // natural-language schedule
      const parsed = parseNaturalSchedule(body.schedule, timezone)
      if (!parsed.ok || !parsed.spec) {
        return NextResponse.json(
          { error: parsed.error ?? 'could not understand that schedule' },
          { status: 400 }
        )
      }
      spec = parsed.spec
      explanation = parsed.explanation
    } else if (typeof body.kind === 'string') {
      // structured schedule
      const kind = body.kind
      if (kind !== 'cron' && kind !== 'fixed_rate' && kind !== 'one_time') {
        return NextResponse.json(
          { error: `unknown kind '${kind}' — expected cron | fixed_rate | one_time` },
          { status: 400 }
        )
      }
      const intervalMin =
        typeof body.intervalMin === 'number'
          ? body.intervalMin
          : typeof body.intervalMin === 'string' && body.intervalMin.trim()
            ? Number(body.intervalMin)
            : undefined
      spec = {
        name,
        prompt,
        kind,
        expr: typeof body.expr === 'string' ? body.expr : undefined,
        intervalMin,
        runAt: typeof body.runAt === 'string' ? body.runAt : undefined,
        timezone,
        delivery,
      }
    } else {
      return NextResponse.json(
        {
          error:
            'provide either "schedule" (natural language, e.g. "every day at 9") or "kind" ("cron" | "fixed_rate" | "one_time") with its fields (expr / intervalMin / runAt)',
        },
        { status: 400 }
      )
    }

    spec.name = name
    spec.prompt = prompt
    spec.timezone = timezone
    spec.delivery = delivery

    const created = await createCronJob(spec, 'user')
    if (!created.ok || !created.job) {
      return NextResponse.json({ error: created.error ?? 'failed to create job' }, { status: 400 })
    }
    return NextResponse.json(
      explanation ? { ok: true, job: created.job, explanation } : { ok: true, job: created.job }
    )
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'failed to create cron job' },
      { status: 500 }
    )
  }
}
