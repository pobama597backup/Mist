import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'

export async function GET(request: NextRequest) {
  try {
    // ?scope=runs — the human-in-the-loop feed: recent runs across ALL agents
    const scope = new URL(request.url).searchParams.get('scope')
    if (scope === 'runs') {
      const runs = await db.agentRun.findMany({
        orderBy: { createdAt: 'desc' },
        take: 30,
        include: { agent: { select: { name: true } } },
      })
      return NextResponse.json({ runs })
    }
    const agents = await db.subAgent.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        runs: {
          orderBy: { createdAt: 'desc' },
          take: 1,
        },
      },
    })
    return NextResponse.json(agents)
  } catch (error) {
    console.error('Subagents list error:', error)
    return NextResponse.json(
      { error: 'Failed to list sub-agents' },
      { status: 500 }
    )
  }
}

export async function POST(request: NextRequest) {
  try {
    const { name, role, description, systemPrompt } = await request.json()
    
    if (!name || !role) {
      return NextResponse.json(
        { error: 'Name and role are required' },
        { status: 400 }
      )
    }

    const agent = await db.subAgent.create({
      data: {
        name,
        role,
        description: description || '',
        systemPrompt: systemPrompt || '',
      },
    })

    return NextResponse.json(agent, { status: 201 })
  } catch (error) {
    console.error('Subagent creation error:', error)
    return NextResponse.json(
      { error: 'Failed to create sub-agent' },
      { status: 500 }
    )
  }
}