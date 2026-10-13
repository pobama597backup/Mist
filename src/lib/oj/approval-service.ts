// OpenJarvis proactive-approval port (oj-ops-3) — tiered approvals with
// remembered permission, the pattern from openjarvis/tools/proactive_tools.py
// + approval_store.py:
//
//   tier 'auto'        — read-only ops, never prompt (no Alert, auto-approved row)
//   tier 'standard'    — one-click approve/deny (pending row + chat Alert)
//   tier 'destructive' — type-to-confirm (pending row + chat Alert, tier badge)
//
// MEMORY: deciding with remember = 'always_approve' | 'always_deny' writes a
// PermissionMemory row keyed by the action fingerprint
// (sha256 of actionType + sorted payload keys) — consulted by checkPermission
// so she never asks twice for the same action shape. Pending approvals expire
// lazily after 24h.
//
// DELIVERY: mirrors heartbeat-service's raiseSystemAlert exactly (Alert row,
// status 'pending', kind 'approval', recordActivity) — the existing alerts
// poller lands it in the chat + toasts. This file deliberately imports NOTHING
// from the spine (parallel build) — db + types only.

import { createHash } from 'node:crypto'
import { db } from '@/lib/db'
import { recordActivity } from '@/lib/services/activity-service'

export type ApprovalTier = 'auto' | 'standard' | 'destructive' | 'low' | 'medium' | 'high'
export type ApprovalOrigin = 'mist' | 'operator' | 'mission' | 'subagent' | 'arbiter'
export type ApprovalStatus = 'pending' | 'approved' | 'denied' | 'expired' | 'consumed'

/** Pending approvals older than this are lazily expired. */
const APPROVAL_TTL_MS = 24 * 60 * 60_000

/** Read-only action shapes never prompt (OpenJarvis trivial tier). */
const AUTO_ACTION_TYPES = new Set([
  'tool_exec_read',
  'read_file',
  'list_items',
  'get_status',
  'digest_collect',
  'check_permission',
  'list_scheduled_tasks',
  'knowledge_search',
])

/** Action shapes that always demand type-to-confirm (OpenJarvis high tier). */
const DESTRUCTIVE_ACTION_TYPES = new Set([
  'file_write',
  'file_delete',
  'spend',
  'skill_install',
  'operator_enable',
  'skill_archive',
  'memory_trust_flip',
  'email_delete',
  'system_command',
])

export function resolveTier(actionType: string): ApprovalTier {
  const t = String(actionType ?? '').trim()
  if (AUTO_ACTION_TYPES.has(t)) return 'auto'
  if (DESTRUCTIVE_ACTION_TYPES.has(t)) return 'destructive'
  return 'standard'
}

/**
 * Fingerprint = sha256(actionType + ':' + sorted payload KEYS). Keyed on keys
 * (not values) so "always approve reading repo X" generalizes to any repo —
 * same shape as OpenJarvis's "{action}:{pattern}" permission keys.
 */
export function fingerprintOf(actionType: string, payload?: Record<string, unknown>): string {
  const keys = Object.keys(payload ?? {})
    .map((k) => k.toLowerCase())
    .sort()
    .join(',')
  return createHash('sha256').update(`${String(actionType ?? '')}:${keys}`).digest('hex').slice(0, 32)
}

export interface PermissionVerdict {
  allowed: boolean
  denied: boolean
  needsApproval: boolean
  tier: ApprovalTier
  fingerprint: string
  reason: string
}

/** Consult tier defaults + permission memory — no row is created. */
export async function checkPermission(
  actionType: string,
  payload?: Record<string, unknown>
): Promise<PermissionVerdict> {
  const tier = resolveTier(actionType)
  const fingerprint = fingerprintOf(actionType, payload)
  let remembered: { decision: string } | null = null
  try {
    remembered = await db.permissionMemory.findUnique({ where: { fingerprint } })
  } catch {
    remembered = null // honest: treat a DB hiccup as "no memory"
  }
  if (tier === 'auto') {
    return { allowed: true, denied: false, needsApproval: false, tier, fingerprint, reason: 'auto tier (read-only action)' }
  }
  if (remembered?.decision === 'always_approve') {
    return { allowed: true, denied: false, needsApproval: false, tier, fingerprint, reason: 'remembered: always_approve' }
  }
  if (remembered?.decision === 'always_deny') {
    return { allowed: false, denied: true, needsApproval: false, tier, fingerprint, reason: 'remembered: always_deny' }
  }
  return { allowed: false, denied: false, needsApproval: true, tier, fingerprint, reason: `needs ${tier} approval` }
}

export interface CreateApprovalInput {
  actionType: string
  title: string
  payload?: Record<string, unknown>
  /** Phase 2-b: the Arbiter passes its own fingerprint (tool + canonical
   *  args) so the re-execution verify matches the row it created. Absent →
   *  the legacy fingerprintOf shape. */
  tier?: ApprovalTier
  origin?: ApprovalOrigin
  fingerprint?: string
}

export interface CreateApprovalResult {
  ok: boolean
  approvalId?: string
  status?: ApprovalStatus
  tier: ApprovalTier
  fingerprint: string
  autoApproved: boolean
  deniedByMemory: boolean
  reason: string
}

/** Queue an action. auto tier + always_approve memory → approved on the spot;
 *  always_deny memory → nothing is queued (honest denial). Everything else
 *  creates a pending Approval row + an 'approval' Alert the chat poller picks
 *  up (exact raiseSystemAlert shape). */
export async function createApproval(input: CreateApprovalInput): Promise<CreateApprovalResult> {
  const actionType = String(input.actionType ?? '').trim().slice(0, 64)
  const title = String(input.title ?? '').trim().slice(0, 160) || actionType
  if (!actionType) {
    return { ok: false, tier: 'standard', fingerprint: '', autoApproved: false, deniedByMemory: false, reason: 'actionType is required' }
  }
  const payload = input.payload && typeof input.payload === 'object' ? input.payload : {}
  const tier: ApprovalTier =
    input.tier && ['auto', 'standard', 'destructive', 'low', 'medium', 'high'].includes(input.tier)
      ? input.tier
      : resolveTier(actionType)
  const origin: ApprovalOrigin =
    input.origin === 'operator' ||
    input.origin === 'mission' ||
    input.origin === 'subagent' ||
    input.origin === 'arbiter'
      ? input.origin
      : 'mist'
  const fingerprint = input.fingerprint && input.fingerprint.length > 0 ? input.fingerprint.slice(0, 200) : fingerprintOf(actionType, payload)
  const payloadJson = JSON.stringify(payload).slice(0, 8000)

  // remembered consent short-circuits the queue
  let remembered: { decision: string } | null = null
  try {
    remembered = await db.permissionMemory.findUnique({ where: { fingerprint } })
  } catch {
    remembered = null
  }
  if (remembered?.decision === 'always_deny') {
    return {
      ok: true,
      tier,
      fingerprint,
      autoApproved: false,
      deniedByMemory: true,
      reason: 'denied by remembered permission (always_deny) — nothing queued',
    }
  }
  const autoOk = tier === 'auto' || remembered?.decision === 'always_approve'

  try {
    const row = await db.approval.create({
      data: {
        actionType,
        fingerprint,
        title,
        payload: payloadJson,
        tier,
        origin,
        status: autoOk ? 'approved' : 'pending',
        decidedBy: autoOk ? (tier === 'auto' ? 'auto' : 'permission_memory') : null,
        decidedAt: autoOk ? new Date() : null,
      },
    })
    if (!autoOk) {
      // deliver through the alerts pipeline — exact raiseSystemAlert shape,
      // but kind 'approval' so the frontend can badge it by tier
      try {
        await db.alert.create({
          data: {
            kind: 'approval',
            title: `${tier === 'destructive' ? '🔐' : '❔'} Approval needed: ${title}`,
            body:
              `${actionType} (${tier} tier) is waiting for a decision.` +
              (Object.keys(payload).length ? `\n${JSON.stringify(payload, null, 2).slice(0, 1200)}` : '') +
              `\nApprove or deny it in the approvals panel (/api/mist/approvals).`,
            meta: JSON.stringify({ approval_id: row.id, kind: 'approval', tier, origin, action_type: actionType }),
          },
        })
      } catch {
        // alert delivery is best-effort — the Approval row is the source of truth
      }
    }
    recordActivity(
      'approvals',
      autoOk
        ? `auto-approved ${actionType}: ${title.slice(0, 60)} (${tier})`
        : `queued ${actionType} for approval: ${title.slice(0, 60)} (${tier})`
    )
    return {
      ok: true,
      approvalId: row.id,
      status: autoOk ? 'approved' : 'pending',
      tier,
      fingerprint,
      autoApproved: autoOk,
      deniedByMemory: false,
      reason: autoOk ? (tier === 'auto' ? 'auto tier — approved without prompting' : 'remembered always_approve') : `queued as ${tier}`,
    }
  } catch (err) {
    return {
      ok: false,
      tier,
      fingerprint,
      autoApproved: false,
      deniedByMemory: false,
      reason: err instanceof Error ? err.message : 'failed to create approval',
    }
  }
}

/** Lazy expiry — pending approvals older than 24h become 'expired'. */
export async function expireStaleApprovals(): Promise<number> {
  try {
    const res = await db.approval.updateMany({
      where: { status: 'pending', createdAt: { lt: new Date(Date.now() - APPROVAL_TTL_MS) } },
      data: { status: 'expired', decidedAt: new Date() },
    })
    return res.count
  } catch {
    return 0
  }
}

export interface DecideInput {
  decision: 'approve' | 'deny'
  remember?: 'always_approve' | 'always_deny'
}

export interface DecideResult {
  ok: boolean
  status?: ApprovalStatus
  error?: string
  remembered?: boolean
}

/** Decide a pending approval; remember writes PermissionMemory for the fingerprint.
 *  Phase 2-b: an approved tool_exec row is EXECUTED ONCE right here — the
 *  re-run carries approvalRef so the Arbiter's one-time owner approval
 *  softens its ask, and the outcome is appended into the row's payload. */
export async function decide(id: string, input: DecideInput): Promise<DecideResult> {
  if (input.decision !== 'approve' && input.decision !== 'deny') {
    return { ok: false, error: 'decision must be "approve" or "deny"' }
  }
  if (input.remember && input.remember !== 'always_approve' && input.remember !== 'always_deny') {
    return { ok: false, error: 'remember must be "always_approve" or "always_deny"' }
  }
  await expireStaleApprovals()
  try {
    const row = await db.approval.findUnique({ where: { id } })
    if (!row) return { ok: false, error: 'approval not found' }
    if (row.status !== 'pending') {
      return { ok: false, error: `approval already ${row.status}`, status: row.status as ApprovalStatus }
    }
    const status: ApprovalStatus = input.decision === 'approve' ? 'approved' : 'denied'
    // Phase 3-a · R9: the decision write + the remember-write are ONE
    // transaction — a crash between them must never leave the UI saying
    // "decided" while the PermissionMemory row (the thing that stops her
    // asking twice) never landed. Same-model-family group, kept minimal.
    let remembered = false
    await db.$transaction(async (tx) => {
      await tx.approval.update({
        where: { id },
        data: { status, decidedAt: new Date(), decidedBy: 'creator' },
      })
      if (input.remember) {
        try {
          await tx.permissionMemory.upsert({
            where: { fingerprint: row.fingerprint },
            create: { fingerprint: row.fingerprint, decision: input.remember },
            update: { decision: input.remember },
          })
          remembered = true
        } catch {
          remembered = false // memory write is best-effort; the decision still stands
        }
      }
    })
    // ---- Phase 2-b: execute an approved tool call exactly once ----
    if (status === 'approved' && row.actionType === 'tool_exec') {
      await executeApprovedTool(row)
    }
    recordActivity('approvals', `${status} ${row.actionType}: ${row.title.slice(0, 60)}${remembered ? ` (remembered ${input.remember})` : ''}`)
    return { ok: true, status, remembered }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'failed to decide approval' }
  }
}

/** One-shot re-execution of an approved tool_exec row. The dynamic import
 *  keeps this module free of a static spine dependency (parallel build);
 *  the Arbiter consumes the row (status → 'consumed') after the attempt. */
async function executeApprovedTool(row: { id: string; payload: string }): Promise<void> {
  let payload: Record<string, unknown> = {}
  try {
    const parsed = JSON.parse(row.payload || '{}') as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) payload = parsed as Record<string, unknown>
  } catch {
    payload = {}
  }
  const tool = typeof payload.tool === 'string' ? payload.tool : ''
  if (!tool) return
  const args =
    payload.args && typeof payload.args === 'object' && !Array.isArray(payload.args)
      ? (payload.args as Record<string, unknown>)
      : {}
  const origin = payload.origin === 'owner_voice' ? 'owner_voice' : 'owner_chat'
  const turnId = typeof payload.turnId === 'string' ? payload.turnId : undefined
  try {
    const { executeTool } = await import('@/lib/services/tools-service')
    const result = await executeTool(tool, args, false, { origin, turnId, interactive: true, approvalRef: row.id })
    const out = result.output as Record<string, unknown> | null
    const requeued =
      result.success === true &&
      out !== null &&
      typeof out === 'object' &&
      (out.status === 'pending-approval' || out.status === 'queued-owner-review')
    const summary = requeued
      ? { executed: false, requeued: true, output: out } // the Arbiter asked again (e.g. tainted args) — nothing ran
      : result.success === true
        ? { executed: true, ok: true, output: out }
        : { executed: true, ok: false, error: result.error ?? 'tool reported failure' }
    await appendExecutionOutcome(row.id, summary)
  } catch (err) {
    await appendExecutionOutcome(row.id, {
      executed: true,
      ok: false,
      error: err instanceof Error ? err.message : 're-execution crashed',
    })
  }
}

/** Fold the one-shot execution outcome into the row's payload JSON. Any
 *  outcome still consumes the approval — single-use means single-ATTEMPT.
 *  Phase 3-a · R9: read-modify-write of the payload in ONE transaction. */
async function appendExecutionOutcome(id: string, summary: Record<string, unknown>): Promise<void> {
  try {
    await db.$transaction(async (tx) => {
      const row = await tx.approval.findUnique({ where: { id } })
      if (!row) return
      let payload: Record<string, unknown> = {}
      try {
        const parsed = JSON.parse(row.payload || '{}') as unknown
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) payload = parsed as Record<string, unknown>
      } catch {
        payload = {}
      }
      payload.execution = summary
      await tx.approval.update({
        where: { id },
        data: { payload: JSON.stringify(payload).slice(0, 8000), status: 'consumed' },
      })
    })
  } catch {
    // outcome bookkeeping is best-effort — the decision itself already stands
  }
}

export interface ApprovalRowOut {
  id: string
  actionType: string
  fingerprint: string
  title: string
  tier: string
  status: string
  origin: string
  payload: Record<string, unknown>
  createdAt: string
  decidedAt: string | null
  decidedBy: string | null
}

function toRowOut(row: {
  id: string
  actionType: string
  fingerprint: string
  title: string
  tier: string
  status: string
  origin: string
  payload: string
  createdAt: Date
  decidedAt: Date | null
  decidedBy: string | null
}): ApprovalRowOut {
  let payload: Record<string, unknown> = {}
  try {
    const parsed = JSON.parse(row.payload || '{}') as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) payload = parsed as Record<string, unknown>
  } catch {
    payload = { raw: row.payload }
  }
  return {
    id: row.id,
    actionType: row.actionType,
    fingerprint: row.fingerprint,
    title: row.title,
    tier: row.tier,
    status: row.status,
    origin: row.origin,
    payload,
    createdAt: row.createdAt.toISOString(),
    decidedAt: row.decidedAt ? row.decidedAt.toISOString() : null,
    decidedBy: row.decidedBy,
  }
}

/** List approvals (pending first by default). Lazily expires stale rows. */
export async function listApprovals(opts?: { status?: ApprovalStatus | 'all'; limit?: number }): Promise<ApprovalRowOut[]> {
  await expireStaleApprovals()
  const status = opts?.status && opts.status !== 'all' ? opts.status : undefined
  const limit = Math.max(1, Math.min(100, opts?.limit ?? 50))
  try {
    const rows = await db.approval.findMany({
      where: status ? { status } : undefined,
      orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
      take: limit,
    })
    return rows.map(toRowOut)
  } catch {
    return []
  }
}

export async function getApproval(id: string): Promise<ApprovalRowOut | null> {
  try {
    const row = await db.approval.findUnique({ where: { id } })
    return row ? toRowOut(row) : null
  } catch {
    return null
  }
}
