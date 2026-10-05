// GET  /api/mist/alerts — pending + recent proactive alerts (⏰ reminders, 📦 releases)
//                        + heartbeat status. Bootstraps the 60s heartbeat loop.
// POST /api/mist/alerts — { action: 'deliver', ids: string[], conversation_id?: string }
//                        marks alerts delivered after the client appended them to a thread.
import { NextResponse } from 'next/server'
import { listAlerts, markAlertsDelivered, getHeartbeatStatus, ensureHeartbeatWatch } from '@/lib/services/heartbeat-service'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function GET() {
  ensureHeartbeatWatch()
  const [alerts, heartbeat] = await Promise.all([listAlerts(), getHeartbeatStatus()])
  return NextResponse.json({ ...alerts, heartbeat })
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { action?: string; ids?: unknown; conversation_id?: unknown }
    if (body.action !== 'deliver') {
      return NextResponse.json({ error: 'unsupported action' }, { status: 400 })
    }
    const ids = Array.isArray(body.ids)
      ? body.ids.filter((i): i is string => typeof i === 'string').slice(0, 50)
      : []
    const conversationId = typeof body.conversation_id === 'string' && body.conversation_id ? body.conversation_id : null
    const delivered = await markAlertsDelivered(ids, conversationId)
    return NextResponse.json({ ok: true, delivered })
  } catch {
    return NextResponse.json({ error: 'invalid request body' }, { status: 400 })
  }
}
