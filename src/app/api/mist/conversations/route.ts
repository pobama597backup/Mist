import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import type { Conversation } from '@/lib/types'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

function toConversation(row: { id: string; title: string; createdAt: Date }): Conversation {
  return { id: row.id, title: row.title, created_at: row.createdAt.toISOString() }
}

export async function GET() {
  try {
    const rows = await db.conversation.findMany({ orderBy: { createdAt: 'desc' }, take: 100 })
    return NextResponse.json(rows.map(toConversation))
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'failed to list conversations' },
      { status: 500 }
    )
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => ({}))) as { title?: unknown }
    const title =
      typeof body?.title === 'string' && body.title.trim().length > 0
        ? body.title.trim().slice(0, 200)
        : 'New thread'
    const row = await db.conversation.create({ data: { title } })
    return NextResponse.json(toConversation(row))
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'failed to create conversation' },
      { status: 500 }
    )
  }
}
