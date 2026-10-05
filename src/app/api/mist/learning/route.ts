// v5 LEARNING LOOP API — status + manual triggers.
//
// GET  /api/mist/learning
//      → {"status":{"autoSkills":N,"lastCuration":iso|null,"lastUserModel":iso|null,
//                    "userModelPreview":string,"learningActive":true}}
//
// POST /api/mist/learning
//      {"action":"curate_memory"}                     → {"action":..., "result":{factsLearned,notes}}
//      {"action":"rebuild_user_model"}                → {"action":..., "result":"<distillation>"}
//      {"action":"reflect","threadId":"","userText":"","replyText":"",
//       "toolsUsed":["a","b"],"success":true}          → {"action":..., "result":{considered,created,reason,proposal,skillName}}
//        — runs the same reflection as onTurnComplete synchronously (manual:
//          skips the 1/hour limiter so the lead can test; keeps the max-12
//          auto-skill cap and every validation gate).
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import {
  curateMemory,
  rebuildUserModel,
  reflectOnTurn,
  getUserModel,
  ensureLearningWatch,
  countAutoSkills,
} from '@/lib/services/learning-service'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

function isoOrNull(value: string | undefined | null): string | null {
  if (!value) return null
  const t = new Date(value).getTime()
  return Number.isNaN(t) ? null : value
}

export async function GET() {
  try {
    ensureLearningWatch() // idempotent — /health also bootstraps this
    const [autoSkills, lastCuration, lastUserModel] = await Promise.all([
      countAutoSkills(),
      db.longtermMemory.findUnique({ where: { key: 'mist:last_curation' } }),
      db.longtermMemory.findUnique({ where: { key: 'mist:last_user_model' } }),
    ])
    const userModel = getUserModel() ?? ''
    return NextResponse.json({
      status: {
        autoSkills,
        lastCuration: isoOrNull(lastCuration?.value),
        lastUserModel: isoOrNull(lastUserModel?.value),
        userModelPreview: userModel.slice(0, 240),
        learningActive: true,
      },
    })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'learning status failed' },
      { status: 500 }
    )
  }
}

export async function POST(req: NextRequest) {
  try {
    ensureLearningWatch() // idempotent
    const body = (await req.json().catch(() => null)) as {
      action?: unknown
      threadId?: unknown
      userText?: unknown
      replyText?: unknown
      toolsUsed?: unknown
      success?: unknown
    } | null

    const action = typeof body?.action === 'string' ? body.action.trim() : ''

    if (action === 'curate_memory') {
      const result = await curateMemory()
      return NextResponse.json({ action, result })
    }

    if (action === 'rebuild_user_model') {
      const distillation = await rebuildUserModel()
      return NextResponse.json({ action, result: distillation })
    }

    if (action === 'reflect') {
      if (typeof body?.userText !== 'string' || !body.userText.trim()) {
        return NextResponse.json({ error: 'userText is required for reflect' }, { status: 400 })
      }
      const toolsUsed = Array.isArray(body?.toolsUsed)
        ? body.toolsUsed.filter((t): t is string => typeof t === 'string')
        : []
      const result = await reflectOnTurn(
        {
          threadId: typeof body?.threadId === 'string' ? body.threadId : '',
          userText: body.userText,
          replyText: typeof body?.replyText === 'string' ? body.replyText : '',
          toolsUsed,
          success: body?.success !== false,
        },
        { manual: true }
      )
      return NextResponse.json({ action, result })
    }

    return NextResponse.json(
      { error: 'unknown action — use "curate_memory" | "rebuild_user_model" | "reflect"' },
      { status: 400 }
    )
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'learning action failed' },
      { status: 500 }
    )
  }
}
