import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { SubAgent } from '@prisma/client'
import { SubAgentsService } from '@/lib/services/subagents-service'
import { listTools } from '@/lib/services/tools-service'

export async function GET(
  _request: NextRequest,
  ctx: { params: Promise<{ id: string }> }
) {
  const { id } = await ctx.params
  try {
    const agent = await db.subAgent.findUnique({
      where: { id },
      include: {
        runs: {
          orderBy: { createdAt: 'desc' },
          take: 10,
        },
      },
    })

    if (!agent) {
      return NextResponse.json(
        { error: 'Sub-agent not found' },
        { status: 404 }
      )
    }

    return NextResponse.json(agent)
  } catch (error) {
    console.error('Subagent details error:', error)
    return NextResponse.json(
      { error: 'Failed to get sub-agent details' },
      { status: 500 }
    )
  }
}

export async function PUT(
  request: NextRequest,
  ctx: { params: Promise<{ id: string }> }
) {
  const { id } = await ctx.params
  try {
    const { name, role, description, systemPrompt, status } = await request.json()
    
    const updateData: Partial<SubAgent> = {}
    if (name !== undefined) updateData.name = name
    if (role !== undefined) updateData.role = role
    if (description !== undefined) updateData.description = description
    if (systemPrompt !== undefined) updateData.systemPrompt = systemPrompt
    if (status !== undefined) updateData.status = status

    const agent = await db.subAgent.update({
      where: { id },
      data: updateData,
    })

    return NextResponse.json(agent)
  } catch (error) {
    console.error('Subagent update error:', error)
    return NextResponse.json(
      { error: 'Failed to update sub-agent' },
      { status: 500 }
    )
  }
}


// Execute a task with this sub-agent — every run is recorded (human in the loop)
export async function POST(
  request: NextRequest,
  ctx: { params: Promise<{ id: string }> }
) {
  const { id } = await ctx.params
  try {
    const body = (await request.json().catch(() => null)) as {
      goal?: unknown
      triggeredBy?: unknown
    } | null
    const goal = typeof body?.goal === 'string' ? body.goal.trim() : ''
    if (!goal) {
      return NextResponse.json({ error: 'goal is required' }, { status: 400 })
    }
    const triggeredBy =
      body?.triggeredBy === 'mist' || body?.triggeredBy === 'scheduler' ? body.triggeredBy : 'user'
    const tools = await listTools()
    const result = await SubAgentsService.executeAgent(id, goal, tools, triggeredBy)
    return NextResponse.json(result, { status: result.success ? 200 : 500 })
  } catch (error) {
    console.error('Subagent execution error:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to execute sub-agent' },
      { status: 500 }
    )
  }
}

export async function DELETE(
  _request: NextRequest,
  ctx: { params: Promise<{ id: string }> }
) {
  const { id } = await ctx.params
  try {
    await db.subAgent.delete({
      where: { id },
    })

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('Subagent deletion error:', error)
    return NextResponse.json(
      { error: 'Failed to delete sub-agent' },
      { status: 500 }
    )
  }
}