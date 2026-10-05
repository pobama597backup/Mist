// M.I.S.T. memory service — long-term facts, memory queue, stats
// + OpenJarvis trust-tier quarantine (LongtermMemory.trust: auto | trusted |
//   untrusted — untrusted facts are stored for audit but BLOCKED from prompt
//   context; ports openjarvis/memory/store.py RECALLABLE_TRUST_TIERS).
import { db } from '@/lib/db'
import { indexText, similarity } from './vector-service'
import { recordActivity } from './activity-service'
import type { MemoryFact, MemoryQueueItem, MemoryStats } from '@/lib/types'

// ---------- OpenJarvis trust tiers (provenance on every fact) ----------

export type FactTrust = 'auto' | 'trusted' | 'untrusted'

export const RECALLABLE_TRUST_TIERS: ReadonlySet<string> = new Set(['auto', 'trusted'])

export interface FactWithTrust extends MemoryFact {
  trust: FactTrust
  quarantined: boolean
}

function toTrustTier(raw: string | null | undefined): FactTrust {
  const t = (raw ?? 'auto').trim().toLowerCase()
  return t === 'trusted' || t === 'untrusted' ? t : 'auto'
}

/**
 * Lexical-scoring hook for the OJ knowledge layer — one TF-cosine scorer for
 * the whole house (vector memory, knowledge store, retrieval all share it).
 */
export { similarity as lexicalSimilarity }

/**
 * Latest N facts (used by the context builder). Trust-aware since the
 * OpenJarvis integration: quarantined (untrusted) facts are excluded from
 * model-facing context, trusted facts sort ahead of auto ones.
 */
export async function latestFacts(take = 10): Promise<MemoryFact[]> {
  const rows = await db.longtermMemory.findMany({
    where: { trust: { not: 'untrusted' } },
    orderBy: [{ trust: 'desc' }, { createdAt: 'desc' }],
    take,
  })
  return rows.map((r) => ({ key: r.key, value: r.value, created_at: r.createdAt.toISOString() }))
}

export async function listFacts(): Promise<MemoryFact[]> {
  const rows = await db.longtermMemory.findMany({ orderBy: { createdAt: 'desc' } })
  return rows.map((r) => ({ key: r.key, value: r.value, created_at: r.createdAt.toISOString() }))
}

/** Full audit view — every fact with its trust tier and quarantine flag. */
export async function listFactsWithTrust(): Promise<FactWithTrust[]> {
  const rows = await db.longtermMemory.findMany({ orderBy: [{ trust: 'desc' }, { createdAt: 'desc' }] })
  const trust = (t: string) => toTrustTier(t)
  return rows.map((r) => ({
    key: r.key,
    value: r.value,
    created_at: r.createdAt.toISOString(),
    trust: trust(r.trust),
    quarantined: trust(r.trust) === 'untrusted',
  }))
}

/** Upsert a fact + best-effort vector index. New facts default to trust=auto. */
export async function upsertFact(key: string, value: string, trust: FactTrust = 'auto'): Promise<void> {
  await db.longtermMemory.upsert({
    where: { key },
    update: { value, trust },
    create: { key, value, trust },
  })
  recordActivity('memory', `long-term fact stored: ${key}${trust === 'untrusted' ? ' (quarantined)' : ''}`)
  if (trust === 'untrusted') return // quarantined facts are never vector-indexed into recall
  try {
    await indexText(`${key}: ${value}`, 'fact', { key })
  } catch {
    // best-effort vector index
  }
}

/**
 * Set a fact's trust tier (memory_manage trust action). Promote (→trusted) or
 * quarantine (→untrusted) — quarantine also removes the fact from the vector
 * recall index going forward. Returns the updated row or null if missing.
 */
export async function setFactTrust(key: string, tier: FactTrust): Promise<FactWithTrust | null> {
  const existing = await db.longtermMemory.findUnique({ where: { key } })
  if (!existing) return null
  const updated = await db.longtermMemory.update({ where: { key }, data: { trust: tier } })
  recordActivity('memory', `fact ${key} trust → ${tier}${tier === 'untrusted' ? ' (quarantined from prompts)' : ''}`)
  return {
    key: updated.key,
    value: updated.value,
    created_at: updated.createdAt.toISOString(),
    trust: toTrustTier(updated.trust),
    quarantined: toTrustTier(updated.trust) === 'untrusted',
  }
}

export async function getFact(key: string): Promise<MemoryFact | null> {
  const row = await db.longtermMemory.findUnique({ where: { key } })
  if (!row) return null
  return { key: row.key, value: row.value, created_at: row.createdAt.toISOString() }
}

export async function deleteFact(key: string): Promise<void> {
  try {
    await db.longtermMemory.delete({ where: { key } })
    recordActivity('memory', `long-term fact removed: ${key}`)
  } catch {
    // already gone — idempotent delete
  }
}

export async function listQueue(): Promise<MemoryQueueItem[]> {
  const rows = await db.memoryQueue.findMany({ orderBy: { createdAt: 'desc' }, take: 200 })
  return rows.map((r) => ({
    id: r.id,
    content: r.content,
    kind: r.kind,
    status: r.status,
    due_at: r.dueAt ? r.dueAt.toISOString() : null,
    fired_at: r.firedAt ? r.firedAt.toISOString() : null,
    created_at: r.createdAt.toISOString(),
  }))
}

export async function enqueue(content: string, kind: string, status = 'pending'): Promise<string> {
  const row = await db.memoryQueue.create({ data: { content, kind, status } })
  recordActivity('memory', `queued ${kind}: ${content.slice(0, 60)}`)
  return row.id
}

/**
 * Queue a REAL reminder: when dueAt is set, the 60s heartbeat fires it into
 * the chat as a ⏰ alert. Without a parseable due date it stays queued (honest).
 */
export async function enqueueReminder(
  content: string,
  whenText: string,
  dueAt: Date | null
): Promise<{ id: string; due_at: string | null; will_fire: boolean }> {
  const display = whenText.trim() ? `${content} (when: ${whenText.trim()})` : content
  const row = await db.memoryQueue.create({
    data: { content: display, kind: 'reminder', status: 'pending', dueAt },
  })
  recordActivity(
    'memory',
    `reminder queued${dueAt ? ` — fires ${dueAt.toISOString()}` : ' (no parseable due date — will NOT auto-fire)'}`
  )
  return { id: row.id, due_at: dueAt ? dueAt.toISOString() : null, will_fire: dueAt !== null }
}

export async function memoryStats(): Promise<MemoryStats> {
  const [longterm_count, queue_count, vector_count] = await Promise.all([
    db.longtermMemory.count(),
    db.memoryQueue.count(),
    db.vectorMemory.count(),
  ])
  return { longterm_count, queue_count, vector_count }
}
