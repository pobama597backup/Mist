// v5 autonomy ledger — the single shared place where every autonomous action
// MIST takes on her own is recorded (skill auto-creation, skill refinement,
// memory curation, user-model rebuilds, self-reviews, trend digests, upgrade
// proposals, cron runs, vault events).
//
// This service is COMPLETE and shared — do not rewrite it; just import it.
import { db } from '@/lib/db'

export const AUTONOMY_TYPES = [
  'skill_created',
  'skill_refined',
  'memory_curated',
  'user_model_updated',
  'self_review',
  'trend_digest',
  'upgrade_proposed',
  'cron_run',
  'vault_event',
] as const

export type AutonomyType = (typeof AUTONOMY_TYPES)[number]

/** Fire-and-forget autonomy log entry. NEVER throws. */
export async function logAutonomyEvent(
  type: AutonomyType | string,
  summary: string,
  meta: Record<string, unknown> = {}
): Promise<void> {
  try {
    await db.autonomyEvent.create({
      data: {
        type: String(type).slice(0, 48),
        summary: String(summary).slice(0, 500),
        meta: JSON.stringify(meta ?? {}).slice(0, 8000),
      },
    })
  } catch {
    // autonomy logging must never break the caller
  }
}

export async function listAutonomyEvents(limit = 60, type?: string) {
  try {
    return await db.autonomyEvent.findMany({
      where: type ? { type } : undefined,
      orderBy: { createdAt: 'desc' },
      take: Math.min(Math.max(1, limit), 200),
    })
  } catch {
    return []
  }
}

export async function autonomyStats() {
  try {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000)
    const [total, last24, all] = await Promise.all([
      db.autonomyEvent.count(),
      db.autonomyEvent.count({ where: { createdAt: { gte: since } } }),
      db.autonomyEvent.findMany({ orderBy: { createdAt: 'desc' }, take: 400 }),
    ])
    const byType: Record<string, number> = {}
    for (const e of all) byType[e.type] = (byType[e.type] ?? 0) + 1
    const last = all[0]
    return {
      total,
      last24h: last24,
      byType,
      lastEventAt: last ? last.createdAt.toISOString() : null,
    }
  } catch {
    return { total: 0, last24h: 0, byType: {} as Record<string, number>, lastEventAt: null }
  }
}
