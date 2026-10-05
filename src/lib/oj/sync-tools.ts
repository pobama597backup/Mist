// M.I.S.T. oj sync chat tools — Clare's self-update surface in the chat.
//
// Three tools riding the upstream-sync pipeline (src/lib/oj/upstream-sync.ts):
//   oj_sync_check  — sweep open-jarvis/OpenJarvis NOW: detect, fetch, map to
//                    ported modules, index knowledge deltas, draft gated
//                    adaptation proposals. Returns the honest report.
//   oj_sync_status — where we stand: tracked HEAD, sweep schedule, config,
//                    last 5 history entries, pending knowledge, developing
//                    proposals.
//   oj_sync_apply  — push an adaptation proposal through the evolution
//                    engine's gated apply path (staged verification, backups,
//                    lint/tsc, automatic rollback). NEVER bypasses gates.
//
// Plus one Mark-LV tool (mlv-rust-3) riding the same module's second watch:
//   mark_lv_sync_status — the anti-rust watch over the teacher FatihMakes'
//                    assistant repo (github.com/FatihMakes/Mark-LV): tracked
//                    HEAD, clone position, commits behind, last absorbed
//                    digest, update history. Knowledge-first — Mark-LV's
//                    Python desktop code is never auto-ported.
//
// Local structural tool type — deliberately NOT imported from
// services/tools-service (no compile-time race with other oj agents; the
// shapes are identical so the registry wiring accepts this array as-is).

import type { ToolInfo, ToolParam } from '@/lib/types'
import { sweepOjSync, getOjSyncStatus, applyOjSyncProposal, getMarkLvSyncStatus } from './upstream-sync'

export interface ToolDef {
  info: ToolInfo
  exec?: (args: Record<string, unknown>) => Promise<unknown> | unknown
}

function param(
  name: string,
  type: ToolParam['type'],
  required: boolean,
  description: string,
  def?: ToolParam['default']
): ToolParam {
  return { name, type, required, description, ...(def !== undefined ? { default: def } : {}) }
}

export const SYNC_TOOLS: ToolDef[] = [
  {
    info: {
      name: 'oj_sync_check',
      description:
        'Check the OpenJarvis upstream repository (open-jarvis/OpenJarvis) for new commits right now and run the full self-update pipeline: fetch the delta, map changed files to M.I.S.T.\u2019s ported modules, index knowledge-tier changes (docs/changelog) into the knowledge base with an LLM delta-brief, and draft gated adaptation proposals for structural changes. Returns the honest report: changed, commits, files, brief, proposals.',
      category: 'system',
      implemented: true,
      parameters: [
        param('forced', 'boolean', false, 'Bypass the 5-minute minimum gap between sweeps (default true)', true),
      ],
    },
    exec: (args) => {
      const forced = args.forced !== false // default: a manual check forces the sweep
      return sweepOjSync(forced)
    },
  },
  {
    info: {
      name: 'oj_sync_status',
      description:
        'Report the OpenJarvis upstream-sync status: tracked upstream HEAD, local clone position, last/next sweep times, interval, auto-patch config, the last 5 sync history entries, pending knowledge ingests, and proposals currently being developed.',
      category: 'system',
      implemented: true,
      parameters: [],
    },
    exec: () => getOjSyncStatus(),
  },
  {
    info: {
      name: 'oj_sync_apply',
      description:
        'Apply an OpenJarvis adaptation proposal through M.I.S.T.\u2019s gated self-modification pipeline (isolated staging, backups, type-check + import probe, lint, automatic rollback — the same gates the Diagnostics \u2192 Evolve tab uses; never bypassed). The proposal must be developed first: pass develop:true to generate the patch plan first when it is not.',
      category: 'system',
      implemented: true,
      parameters: [
        param('proposal_id', 'string', true, 'Evolution proposal id (from oj_sync_status history or a \U0001F6E0\uFE0F oj-sync alert)'),
        param('develop', 'boolean', false, 'Develop the proposal first if it has no patch plan yet (still gated)', false),
      ],
    },
    exec: (args) => {
      const id = typeof args.proposal_id === 'string' ? args.proposal_id : ''
      return applyOjSyncProposal(id, args.develop === true)
    },
  },
  // ---- mlv-rust-3: Mark-LV (the teacher's assistant) anti-rust watch ----
  {
    info: {
      name: 'mark_lv_sync_status',
      description:
        'Report the Mark-LV anti-rust watch status — the teacher FatihMakes\u2019 assistant repo (github.com/FatihMakes/Mark-LV) that M.I.S.T. watches forever: tracked upstream HEAD, local clone position, commits behind, watch status (watching/updated/diverged/error), last scan/update times, the last absorbed git digest, and recent update history. Mark-LV changes are absorbed as KNOWLEDGE (never auto-ported into M.I.S.T.\u2019s TypeScript body); to scan it right now use the oj sync route action mark_lv_check.',
      category: 'system',
      implemented: true,
      parameters: [],
    },
    exec: () => getMarkLvSyncStatus(),
  },
]
