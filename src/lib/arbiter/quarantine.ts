// M.I.S.T. Arbiter · the quarantine inbox (Phase 2-c, S11).
//
// The INTERNAL auto-write paths (llm-service fact extraction, the learning
// loop's skill saves, scheduler cron creation) do NOT pass through
// executeTool — the Arbiter never sees them, so taint could ride a turn's
// own output straight into long-term memory and come back EVERY future
// prompt. This module is the routing floor for exactly those paths:
//
//   tainted turn  → QuarantineItem (kind fact|skill|cron|persona) — the
//                   real table is never touched, recall never sees it, and
//                   the item waits in the memory drawer for the owner to
//                   accept / edit / drop. Nothing injects until accepted.
//   clean turn    → the write lands with trust 'derived' + provenance
//                   (source + createdByTurn) so future waves can audit
//                   exactly which turn produced every row.
//
// The tool paths (save_skill, cron_create, memory_set, …) do NOT route
// through here — the Arbiter already arbitrates them, and a tainted persist
// ASKS there, so an owner-approved tool write is already owner-reviewed;
// re-quarantining it would ping-pong the two inboxes. They only stamp
// provenance.
//
// Kind-specific writes in decideQuarantineItem use LAZY imports (house
// style) — this module sits under services that must not cycle back.

import { db } from '@/lib/db'
import { isTainted, turnHasTaintMarks } from './taint'
import { appendAuditEvent } from './audit'

export type QuarantineKind = 'fact' | 'skill' | 'cron' | 'persona'
export type QuarantineDecision = 'accept' | 'edit' | 'drop'

export interface QuarantineTaintCheck {
  hit: boolean
  reason: string
}

/** The shared taint verdict for internal auto-writes: a verbatim replay of
 *  untrusted content OR any taint mark on the turn at all — untrusted
 *  content touched the turn, so everything it produced waits for the owner. */
export function shouldQuarantine(
  turnId: string | null | undefined,
  content: Record<string, unknown>
): QuarantineTaintCheck {
  if (!turnId) return { hit: false, reason: '' }
  if (isTainted(turnId, content)) {
    return { hit: true, reason: 'tainted content — untrusted payload replayed into the write' }
  }
  if (turnHasTaintMarks(turnId)) {
    return { hit: true, reason: 'tainted turn — untrusted content touched this turn; everything it produced waits for review' }
  }
  return { hit: false, reason: '' }
}

export interface QuarantineWriteOpts {
  source?: string
  reason?: string
  turnId?: string | null
}

/** File one proposed write into the inbox. Never throws — the caller's
 *  honest not-written result is the gate; the row is the review surface. */
export async function quarantineWrite(
  kind: QuarantineKind,
  contentJson: string,
  opts: QuarantineWriteOpts = {}
): Promise<string> {
  const row = await db.quarantineItem.create({
    data: {
      kind,
      contentJson: contentJson.slice(0, 20_000),
      source: (opts.source ?? 'unknown').slice(0, 200),
      reason: (opts.reason ?? '').slice(0, 500),
      turnId: opts.turnId ?? null,
      status: 'pending',
    },
  })
  appendAuditEvent({
    tool: 'quarantine_write',
    argsJson: contentJson.slice(0, 2000),
    risk: 'persist',
    origin: 'memory',
    decision: 'deny',
    reason: `${kind} quarantined — ${row.reason}`,
    turnId: opts.turnId ?? null,
  }).catch(() => undefined)
  return row.id
}

// ---------- the llm-service remember seam ----------

/**
 * Route one auto-extracted durable fact (unifiedCore's `remember` envelope).
 * Tainted turn → quarantine inbox; clean turn → LongtermMemory with
 * trust 'derived', source 'auto-extraction' and the writing turn recorded.
 */
export async function rememberDurableFact(
  key: string,
  value: string,
  turnId: string | null
): Promise<{ quarantined: boolean; itemId?: string }> {
  const check = shouldQuarantine(turnId, { key, value })
  if (check.hit) {
    const itemId = await quarantineWrite('fact', JSON.stringify({ key, value }), {
      source: 'auto-extraction',
      reason: check.reason,
      turnId,
    })
    return { quarantined: true, itemId }
  }
  const { upsertFact } = await import('../services/memory-service')
  await upsertFact(key, value, 'derived', { source: 'auto-extraction', createdByTurn: turnId ?? undefined })
  return { quarantined: false }
}

// ---------- the owner's decision ----------

export interface QuarantineDecideResult {
  ok: boolean
  item?: {
    id: string
    kind: string
    status: string
  }
  error?: string
}

interface FactPayload {
  key: string
  value: string
}
interface SkillPayload {
  name: string
  trigger: string
  steps?: string
  tool_chain?: string[]
  notes?: string
}
interface CronPayload {
  spec: {
    name: string
    prompt: string
    kind: 'cron' | 'fixed_rate' | 'one_time'
    expr?: string
    intervalMin?: number
    runAt?: string
    timezone?: string
    delivery?: 'alert' | 'silent'
  }
  origin?: string
}

function parseContent<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

/** Perform the owner's decision on a pending quarantine item.
 *  accept → write the ORIGINAL content; edit → write the EDITED content the
 *  owner provided (same JSON shape per kind); drop → nothing written. Every
 *  performed write lands trust 'derived' with source `quarantine:<id>` —
 *  the owner's review is the provenance. */
export async function decideQuarantineItem(
  id: string,
  decision: QuarantineDecision,
  editedContent?: string
): Promise<QuarantineDecideResult> {
  const item = await db.quarantineItem.findUnique({ where: { id } })
  if (!item) return { ok: false, error: 'quarantine item not found' }
  if (item.status !== 'pending') {
    return { ok: false, error: `item is already ${item.status} — only pending items can be decided` }
  }

  if (decision === 'drop') {
    const dropped = await db.quarantineItem.update({
      where: { id },
      data: { status: 'dropped', decidedAt: new Date() },
    })
    await auditDecision(item.id, item.kind, 'dropped — nothing written')
    return { ok: true, item: { id: dropped.id, kind: dropped.kind, status: dropped.status } }
  }

  const contentJson = decision === 'edit' ? (editedContent ?? '') : item.contentJson
  if (decision === 'edit' && !contentJson.trim()) {
    return { ok: false, error: 'edit requires the edited content (JSON, same shape as the item)' }
  }
  const provenance = { source: `quarantine:${id}`, turnId: item.turnId ?? undefined }

  if (item.kind === 'fact') {
    const payload = parseContent<FactPayload>(contentJson)
    if (!payload || typeof payload.key !== 'string' || typeof payload.value !== 'string' || !payload.key.trim() || !payload.value.trim()) {
      return { ok: false, error: 'fact payload must be {"key": string, "value": string}' }
    }
    const { upsertFact } = await import('../services/memory-service')
    await upsertFact(payload.key.trim().slice(0, 60), payload.value.trim().slice(0, 500), 'derived', provenance)
  } else if (item.kind === 'skill') {
    const payload = parseContent<SkillPayload>(contentJson)
    if (!payload || typeof payload.name !== 'string' || typeof payload.trigger !== 'string' || !payload.name.trim() || !payload.trigger.trim()) {
      return { ok: false, error: 'skill payload must be {"name": string, "trigger": string, …}' }
    }
    const { saveSkill } = await import('../services/skills-service')
    await saveSkill(payload, { ...provenance, trust: 'derived' })
  } else if (item.kind === 'cron') {
    const payload = parseContent<CronPayload>(contentJson)
    if (!payload || !payload.spec || typeof payload.spec.name !== 'string' || typeof payload.spec.prompt !== 'string') {
      return { ok: false, error: 'cron payload must be {"spec": {name, prompt, kind, …}, "origin": string}' }
    }
    const { createCronJob } = await import('../services/scheduler-service')
    const res = await createCronJob(payload.spec, (payload.origin ?? 'mist') as 'user' | 'auto' | 'mist' | 'digest', {
      ...provenance,
      trust: 'derived',
    })
    if (!res.ok) return { ok: false, error: `cron write rejected: ${res.error}` }
  } else {
    // persona: the persona files are protected paths — the inbox is a review
    // surface, not an apply lane. Honest refusal, drop still works above.
    return {
      ok: false,
      error: 'persona writes stay owner-UI only — drop this item, or propose the change through evolution (Diagnostics → Evolve)',
    }
  }

  const status = decision === 'edit' ? 'edited' : 'accepted'
  const updated = await db.quarantineItem.update({ where: { id }, data: { status, decidedAt: new Date() } })
  await auditDecision(item.id, item.kind, `${status} — written trust 'derived' via quarantine:${id}`)
  return { ok: true, item: { id: updated.id, kind: updated.kind, status: updated.status } }
}

async function auditDecision(itemId: string, kind: string, detail: string): Promise<void> {
  appendAuditEvent({
    tool: 'quarantine_decide',
    argsJson: JSON.stringify({ itemId, kind }),
    risk: 'persist',
    origin: 'owner_chat',
    decision: 'allow',
    reason: `owner decision — ${detail}`,
    turnId: null,
  }).catch(() => undefined)
}

// ---------- the list view (GET /api/mist/quarantine) ----------

export interface QuarantineItemView {
  id: string
  kind: string
  contentJson: string
  source: string
  reason: string
  turnId: string | null
  status: string
  createdAt: string
  decidedAt: string | null
}

function toView(row: {
  id: string
  kind: string
  contentJson: string
  source: string
  reason: string
  turnId: string | null
  status: string
  createdAt: Date
  decidedAt: Date | null
}): QuarantineItemView {
  return {
    id: row.id,
    kind: row.kind,
    contentJson: row.contentJson,
    source: row.source,
    reason: row.reason,
    turnId: row.turnId,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    decidedAt: row.decidedAt ? row.decidedAt.toISOString() : null,
  }
}

/** Pending items newest-first (capped) + lifetime counts by status. */
export async function listQuarantine(limit = 50): Promise<{
  pending: QuarantineItemView[]
  counts: { pending: number; accepted: number; edited: number; dropped: number }
}> {
  const [pending, pendingCount, acceptedCount, editedCount, droppedCount] = await Promise.all([
    db.quarantineItem.findMany({ where: { status: 'pending' }, orderBy: { createdAt: 'desc' }, take: Math.min(limit, 50) }),
    db.quarantineItem.count({ where: { status: 'pending' } }),
    db.quarantineItem.count({ where: { status: 'accepted' } }),
    db.quarantineItem.count({ where: { status: 'edited' } }),
    db.quarantineItem.count({ where: { status: 'dropped' } }),
  ])
  return {
    pending: pending.map(toView),
    counts: { pending: pendingCount, accepted: acceptedCount, edited: editedCount, dropped: droppedCount },
  }
}
