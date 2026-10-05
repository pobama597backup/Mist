// OpenJarvis ops tools (oj-ops-3) — the proactive-approval + scheduler +
// digest + skill-management tool surface ported from openjarvis
// (proactive_tools.py's five approval tools, scheduler tools, digest_collect,
// skill_manage). Exported as OPS_TOOLS for the lead's registry wiring
// (tools-service consumes this array; BaseToolDef is the shared contract).

import type { BaseToolDef } from '@/lib/services/tools-service'
import type { ToolParam } from '@/lib/types'
import { checkPermission, createApproval, decide, listApprovals, type ApprovalTier } from './approval-service'
import { collectLatest, generateDigest } from './digest-service'
import {
  parseNaturalSchedule,
  createCronJob,
  listCronJobs,
  type CronJobSpec,
} from '@/lib/services/scheduler-service'
import { listSkills } from '@/lib/services/skills-service'

function param(
  name: string,
  type: ToolParam['type'],
  required: boolean,
  description: string,
  def?: string | number | boolean
): ToolParam {
  const p: ToolParam = { name, type, required, description }
  if (def !== undefined) p.default = def
  return p
}

export const OPS_TOOLS: BaseToolDef[] = [
  {
    info: {
      name: 'check_permission',
      description:
        'Check whether an action is allowed before doing it. Consults the approval tier (auto/standard/destructive) and remembered permission ("always_approve"/"always_deny" per action fingerprint). Returns allowed / denied / needsApproval.',
      category: 'system',
      implemented: true,
      parameters: [
        param('action_type', 'string', true, 'Action shape, e.g. "file_write", "read_file", "skill_archive"'),
        param('payload', 'array', false, 'Optional key/value pairs describing the action (used for the permission fingerprint)'),
      ],
    },
    exec: async (args) => {
      const actionType = String(args.action_type ?? '').trim()
      if (!actionType) throw new Error('action_type is required')
      const payload = (args.payload && typeof args.payload === 'object' ? args.payload : {}) as Record<string, unknown>
      return checkPermission(actionType, payload)
    },
  },
  {
    info: {
      name: 'queue_action',
      description:
        'Queue an action for the creator\'s approval (the OpenJarvis proactive-approval port). Auto-tier/read-only actions approve instantly; remembered "always_approve" short-circuits; everything else creates a pending approval that lands in the chat. NEVER performs the action itself — it only queues the decision.',
      category: 'system',
      implemented: true,
      parameters: [
        param('action_type', 'string', true, 'Action shape, e.g. "file_write", "skill_archive", "spend"'),
        param('title', 'string', true, 'Short human label for the approval card'),
        param('payload', 'array', false, 'Key/value pairs describing exactly what would happen'),
        param('tier', 'string', false, 'Force a tier: "auto" | "standard" | "destructive" (default: derived from action_type)'),
      ],
    },
    exec: async (args) => {
      const actionType = String(args.action_type ?? '').trim()
      const title = String(args.title ?? '').trim()
      if (!actionType) throw new Error('action_type is required')
      if (!title) throw new Error('title is required')
      const tier = args.tier === 'auto' || args.tier === 'standard' || args.tier === 'destructive' ? (args.tier as ApprovalTier) : undefined
      return createApproval({
        actionType,
        title,
        payload: (args.payload && typeof args.payload === 'object' ? args.payload : {}) as Record<string, unknown>,
        tier,
        origin: 'mist',
      })
    },
  },
  {
    info: {
      name: 'get_pending_actions',
      description: 'List approvals awaiting the creator\'s decision (pending first, most recent first).',
      category: 'system',
      implemented: true,
      parameters: [],
    },
    exec: async () => {
      const approvals = await listApprovals({ status: 'pending', limit: 20 })
      return { pending: approvals.length, approvals }
    },
  },
  {
    info: {
      name: 'record_decision',
      description:
        'Record the creator\'s decision on a pending approval. Use after the creator answers an approval request in chat. decision: "approve" | "deny"; remember: "always_approve" | "always_deny" to store the choice for this action fingerprint so she never asks twice.',
      category: 'system',
      implemented: true,
      parameters: [
        param('approval_id', 'string', true, 'The approval id from queue_action / get_pending_actions'),
        param('decision', 'string', true, '"approve" or "deny"'),
        param('remember', 'string', false, '"always_approve" or "always_deny" to remember this choice for the action fingerprint'),
      ],
    },
    exec: async (args) => {
      const approvalId = String(args.approval_id ?? '').trim()
      const decision = args.decision === 'approve' ? 'approve' : args.decision === 'deny' ? 'deny' : undefined
      if (!approvalId) throw new Error('approval_id is required')
      if (!decision) throw new Error('decision must be "approve" or "deny"')
      const remember =
        args.remember === 'always_approve' || args.remember === 'always_deny' ? args.remember : undefined
      const res = await decide(approvalId, { decision, remember })
      if (!res.ok) throw new Error(res.error ?? 'failed to record decision')
      return res
    },
  },
  {
    info: {
      name: 'schedule_task',
      description:
        'Schedule a recurring or one-time automation. `when` accepts natural language ("every day at 9", "in 2 hours", "weekly on monday 10am", "tonight at 8") or a 5-field cron expression ("0 8 * * *").',
      category: 'system',
      implemented: true,
      parameters: [
        param('description', 'string', true, 'What should happen when it fires (natural language prompt)'),
        param('when', 'string', true, 'When/how often it should run (natural language or cron)'),
      ],
    },
    exec: async (args) => {
      const description = String(args.description ?? '').trim()
      const when = String(args.when ?? '').trim()
      if (!description) throw new Error('description is required')
      if (!when) throw new Error('when is required')
      const parsed = parseNaturalSchedule(when)
      if (!parsed.ok || !parsed.spec) {
        throw new Error(`could not understand the schedule "${when}": ${parsed.error ?? 'unknown error'}`)
      }
      const spec: CronJobSpec = {
        ...parsed.spec,
        name: description.slice(0, 80),
        prompt: description,
      }
      const res = await createCronJob(spec, 'mist')
      if (!res.ok) throw new Error(res.error ?? 'failed to schedule the task')
      return {
        ok: true,
        explanation: parsed.explanation ?? null,
        job: res.job ?? null,
        note: 'scheduled through the cron scheduler — results land as chat alerts when it fires',
      }
    },
  },
  {
    info: {
      name: 'list_scheduled_tasks',
      description: 'List all scheduled automations (cron jobs) with their schedules, next runs and last results.',
      category: 'system',
      implemented: true,
      parameters: [],
    },
    exec: async () => {
      const jobs = await listCronJobs()
      return { count: jobs.length, jobs }
    },
  },
  {
    info: {
      name: 'digest_collect',
      description:
        'Collect the latest digest sections from her own sources (watchlist, recent alerts, operator runs, learning activity, notes) and generate a fresh digest. Returns the collected sections and the digest summary; the full digest lands in the chat as an alert.',
      category: 'system',
      implemented: true,
      parameters: [],
    },
    exec: async () => {
      const snapshot = await collectLatest()
      try {
        const digest = await generateDigest('on_demand')
        return {
          ok: true,
          degraded: digest.degraded,
          headline: digest.headline,
          items: digest.items,
          tone: digest.tone,
          digest_id: digest.id,
          sections: Object.keys(snapshot.sections),
          collected_at: snapshot.collectedAt,
        }
      } catch (err) {
        // honest degradation: the collection stands, the synthesis does not
        return {
          ok: true,
          degraded: true,
          headline: null,
          digest_id: null,
          sections: Object.keys(snapshot.sections),
          collected_at: snapshot.collectedAt,
          note: `digest synthesis failed (${err instanceof Error ? err.message : 'unknown error'}) — sections were collected honestly; try again shortly`,
        }
      }
    },
  },
  {
    info: {
      name: 'skill_manage',
      description:
        'Manage the skill catalog. action "list" returns all skills with usage stats. action "disable" queues an archive approval for a skill (the creator decides — skills are never deleted without consent). action "enable" is an honest no-op: skills have no runtime off-switch, so there is nothing to re-enable.',
      category: 'skill',
      implemented: true,
      parameters: [
        param('action', 'string', true, '"list" | "disable" | "enable"'),
        param('skill_id', 'string', false, 'Skill name (required for disable)'),
      ],
    },
    exec: async (args) => {
      const action = String(args.action ?? 'list').trim().toLowerCase()
      const skills = await listSkills()
      if (action === 'list') {
        return { action, count: skills.length, skills }
      }
      if (action === 'disable') {
        const skillId = String(args.skill_id ?? '').trim()
        if (!skillId) throw new Error('skill_id is required to disable a skill')
        const known = skills.find((s) => s.name === skillId)
        if (!known) throw new Error(`skill "${skillId}" does not exist`)
        const res = await createApproval({
          actionType: 'skill_archive',
          title: `Archive skill "${skillId}"`,
          payload: { skill: skillId, uses: known.uses },
          origin: 'mist',
        })
        return {
          action,
          skill: skillId,
          queued: res.ok && !res.deniedByMemory,
          approval_id: res.approvalId ?? null,
          note: res.deniedByMemory
            ? 'the creator previously remembered always_deny for skill archives — nothing queued'
            : 'archive decision queued for the creator (skills are never deleted without consent)',
        }
      }
      if (action === 'enable') {
        return {
          action,
          count: skills.length,
          note: 'skills have no runtime off-switch — everything in the catalog is already enabled; nothing to do',
        }
      }
      throw new Error(`unknown action "${action}" — expected list | disable | enable`)
    },
  },
]
