import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { indexText } from '@/lib/services/vector-service'
import type { ChatMessage } from '@/lib/types'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

type MessageRow = {
  id: string
  conversationId: string
  role: string
  content: string
  provider: string | null
  model: string | null
  fallback: boolean
  meta: string
  createdAt: Date
}

function toChatMessage(row: MessageRow): ChatMessage {
  const msg: ChatMessage = {
    id: row.id,
    conversation_id: row.conversationId,
    role: row.role as ChatMessage['role'],
    content: row.content,
    fallback: row.fallback,
    created_at: row.createdAt.toISOString(),
  }
  if (row.provider !== null) msg.provider = row.provider
  if (row.model !== null) msg.model = row.model
  try {
    const meta = JSON.parse(row.meta || '{}')
    if (meta && typeof meta === 'object' && Object.keys(meta).length > 0) {
      msg.meta = meta as Record<string, unknown>
    }
  } catch {
    // legacy / malformed meta — omit
  }
  return msg
}

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params
    const rows = await db.message.findMany({
      where: { conversationId: id },
      orderBy: { createdAt: 'asc' },
      take: 500,
    })
    return NextResponse.json(rows.map(toChatMessage))
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'failed to list messages' },
      { status: 500 }
    )
  }
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params
    const body = (await req.json().catch(() => null)) as {
      role?: unknown
      content?: unknown
      provider?: unknown
      model?: unknown
      fallback?: unknown
      meta?: unknown
    } | null
    const role = body?.role
    if (
      !body ||
      (role !== 'user' && role !== 'assistant' && role !== 'system') ||
      typeof body.content !== 'string' ||
      !body.content.trim()
    ) {
      return NextResponse.json({ error: 'role (user|assistant|system) and content are required' }, { status: 400 })
    }

    const exists = await db.conversation.findUnique({ where: { id }, select: { id: true } })
    if (!exists) {
      return NextResponse.json({ error: 'conversation not found' }, { status: 404 })
    }

    const metaJson =
      body?.meta && typeof body.meta === 'object' && !Array.isArray(body.meta)
        ? JSON.stringify(body.meta).slice(0, 20000)
        : '{}'

    const row = await db.message.create({
      data: {
        conversationId: id,
        role,
        content: body.content,
        provider: typeof body.provider === 'string' && body.provider ? body.provider : null,
        model: typeof body.model === 'string' && body.model ? body.model : null,
        fallback: body.fallback === true,
        meta: metaJson,
      },
    })

    // long assistant answers become vector memories (best-effort)
    if (role === 'assistant' && body.content.length >= 60) {
      try {
        await indexText(body.content, 'conversation', { conversation_id: id })
      } catch {
        // best-effort
      }
    }

    return NextResponse.json(toChatMessage(row))
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'failed to append message' },
      { status: 500 }
    )
  }
}
