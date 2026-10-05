import { NextResponse } from 'next/server'
import { listSkillExecutions } from '@/lib/services/skills-service'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url)
    const skillName = searchParams.get('skill') || undefined
    
    const executions = await listSkillExecutions(skillName)
    return NextResponse.json(executions)
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Failed to list skill executions' }, { status: 500 })
  }
}