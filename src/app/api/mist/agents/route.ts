// M.I.S.T. agent bridge routes — external CLI coding agents (Claude Code, Codex,
// Gemini CLI, Aider). GET probes what's installed; POST delegates a headless task.
import { NextRequest, NextResponse } from 'next/server'
import { probeAgents, delegateTask, invalidateAgentProbe } from '@/lib/services/agent-bridge-service'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function GET() {
  try {
    const agents = await probeAgents()
    return NextResponse.json({ agents })
  } catch (err) {
    return NextResponse.json(
      { agents: [], error: err instanceof Error ? err.message : 'agent probe failed' },
      { status: 200 }
    )
  }
}

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as { agent?: unknown; task?: unknown; timeout_ms?: unknown } | null
  const agent = typeof body?.agent === 'string' ? body.agent : ''
  const task = typeof body?.task === 'string' ? body.task : ''
  const timeoutMs =
    typeof body?.timeout_ms === 'number' ? Math.max(5_000, Math.min(300_000, body.timeout_ms)) : 120_000

  if (!agent.trim() || !task.trim()) {
    return NextResponse.json({ error: 'agent and task are required' }, { status: 400 })
  }

  try {
    invalidateAgentProbe()
    const result = await delegateTask(agent, task, timeoutMs)
    return NextResponse.json(result)
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'delegation failed' },
      { status: 500 }
    )
  }
}
