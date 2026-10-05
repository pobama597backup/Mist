// GET  /api/mist/oj/sync — full upstream-sync status + port-map summary
//                          (+ additive mark_lv field — the Mark-LV anti-rust watch, mlv-rust-3)
//                          (+ additive teacher_notices — Clare's notes + pending summary, w3-notify)
// POST /api/mist/oj/sync — { action: 'check', force? } force a sweep now ·
//                          { action: 'apply', proposal_id, develop? } gated apply ·
//                          { action: 'configure', interval_min?, auto_patch? } update config ·
//                          { action: 'mark_lv_check', force? } scan the Mark-LV repo now (mlv-rust-3) ·
//                          { action: 'mark_lv_status' } Mark-LV watch status (mlv-rust-3) ·
//                          { action: 'notice_decide', id, decision } answer Clare's note: wanted|dismissed (w3-notify) ·
//                          { action: 'notice_preview' } dry-run a notice from current repo state, never stored (w3-notify)
import { NextResponse } from 'next/server'
import {
  ensureOjSyncWatch,
  ensureMarkLvSyncWatch,
  getOjSyncStatus,
  getOjPortMapSummary,
  getMarkLvSyncStatus,
  getTeacherNotices,
  decideTeacherNotice,
  previewTeacherNotice,
  sweepOjSync,
  applyOjSyncProposal,
  configureOjSync,
  markLvSyncCheck,
} from '@/lib/oj/upstream-sync'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function GET() {
  ensureOjSyncWatch() // any API touch arms the guarded loop
  ensureMarkLvSyncWatch() // mlv-rust-3: same discipline for the Mark-LV watch
  try {
    const [status, mapping, markLv, teacherNotices] = await Promise.all([
      getOjSyncStatus(),
      getOjPortMapSummary(),
      getMarkLvSyncStatus(),
      getTeacherNotices(),
    ])
    return NextResponse.json({ status, mapping, mark_lv: markLv, teacher_notices: teacherNotices })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'failed to read oj-sync status' },
      { status: 500 }
    )
  }
}

export async function POST(request: Request) {
  ensureOjSyncWatch()
  ensureMarkLvSyncWatch() // mlv-rust-3
  let body: {
    action?: string
    force?: unknown
    proposal_id?: unknown
    develop?: unknown
    interval_min?: unknown
    auto_patch?: unknown
    id?: unknown
    decision?: unknown
  }
  try {
    body = (await request.json()) as typeof body
  } catch {
    return NextResponse.json({ error: 'invalid request body' }, { status: 400 })
  }

  if (body.action === 'check') {
    const force = body.force !== false // a POSTed check is a forced sweep by default
    const report = await sweepOjSync(force)
    return NextResponse.json(report)
  }

  if (body.action === 'apply') {
    const id = typeof body.proposal_id === 'string' ? body.proposal_id.trim() : ''
    if (!id) return NextResponse.json({ ok: false, message: 'proposal_id is required' }, { status: 400 })
    const res = await applyOjSyncProposal(id, body.develop === true)
    return NextResponse.json(res)
  }

  if (body.action === 'configure') {
    const res = await configureOjSync({ interval_min: body.interval_min, auto_patch: body.auto_patch })
    return NextResponse.json(res, { status: res.ok ? 200 : 400 })
  }

  // ---- mlv-rust-3: the Mark-LV (teacher's assistant) anti-rust watch ----
  if (body.action === 'mark_lv_check') {
    const force = body.force !== false // a POSTed check forces the scan by default
    const report = await markLvSyncCheck(force)
    return NextResponse.json(report)
  }

  if (body.action === 'mark_lv_status') {
    return NextResponse.json(await getMarkLvSyncStatus())
  }

  // ---- w3-notify: the teacher's notices — Clare's notes about Mark-LV updates ----
  if (body.action === 'notice_decide') {
    const id = typeof body.id === 'string' ? body.id.trim() : ''
    if (!id) return NextResponse.json({ ok: false, message: 'id is required' }, { status: 400 })
    if (body.decision !== 'wanted' && body.decision !== 'dismissed') {
      return NextResponse.json(
        { ok: false, message: "decision must be 'wanted' or 'dismissed'" },
        { status: 400 }
      )
    }
    const res = await decideTeacherNotice(id, body.decision)
    return NextResponse.json(res, { status: res.ok ? 200 : 400 })
  }

  if (body.action === 'notice_preview') {
    const res = await previewTeacherNotice()
    if (!('preview' in res)) return NextResponse.json(res, { status: 503 })
    return NextResponse.json(res)
  }

  return NextResponse.json(
    { error: 'unsupported action — use check | apply | configure | mark_lv_check | mark_lv_status | notice_decide | notice_preview' },
    { status: 400 }
  )
}
