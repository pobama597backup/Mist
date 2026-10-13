// M.I.S.T. Arbiter · frozen tool risk table (Phase 2-a, Sovereign Hardening).
//
// Transcribed one-line-per-tool from docs/audit/phase0-tools-risk.md (the
// 116-row register — the live BASE_TOOLS list is pinned by the test to match
// it exactly). TOOL_RISK holds each tool's BASE class; classifyRisk layers
// the register's arg-aware escalations on top. I keep unknown tools
// (skill:*, omni_*, future names) at 'write' — the conservative middle:
// not so paranoid that every novel read asks, not so trusting that a novel
// side effect rides through. isKnownTool lets callers distinguish.
//
// Register stats note: the register's own tally (persist 18 / destructive 1)
// double-counted slash rows; the faithful per-row split here is persist 17 /
// destructive 2 (cron_delete is honestly destructive — a deleted job
// definition is gone). 116 total either way.

export type RiskClass =
  | 'read'
  | 'sensitive-read'
  | 'write'
  | 'network'
  | 'exec'
  | 'destructive'
  | 'persist'
  | 'egress'
  | 'self-modify'

export const RISK_CLASSES: readonly RiskClass[] = [
  'read',
  'sensitive-read',
  'write',
  'network',
  'exec',
  'destructive',
  'persist',
  'egress',
  'self-modify',
]

export const TOOL_RISK: Record<string, RiskClass> = {
  web_search: 'network',
  get_weather: 'network',
  translate: 'network',
  check_internet: 'network',
  read_file: 'read',
  write_file: 'write',
  list_files: 'read',
  create_note: 'write',
  system_info: 'read',
  github_status: 'network',
  github_sync: 'egress',
  take_screenshot: 'sensitive-read',
  bridge_status: 'read',
  subagents_list: 'read',
  subagent_run: 'exec',
  subagent_status: 'read',
  list_apps: 'sensitive-read',
  open_app: 'exec',
  open_url: 'network',
  run_command: 'exec',
  owner_files: 'destructive',
  bridge_system_info: 'sensitive-read',
  hermes_status: 'read',
  hermes_delegate: 'exec',
  hermes_memory: 'persist',
  hermes_skills: 'write',
  hermes_cron: 'persist',
  companions: 'sensitive-read',
  local_voice_status: 'read',
  local_voice_setup: 'exec',
  system_watch: 'sensitive-read',
  run_in_background: 'exec',
  task_status: 'read',
  mission_start: 'exec',
  mission_status: 'read',
  mission_control: 'write',
  ui_automate: 'exec',
  run_python: 'exec',
  calculate: 'read',
  clipboard_read: 'sensitive-read',
  clipboard_write: 'write',
  memory_set: 'persist',
  memory_get: 'read',
  memory_all: 'read',
  dream_recall: 'read',
  dream_compose: 'persist',
  generate_image_prompt: 'network',
  set_reminder: 'persist',
  read_page: 'network',
  deep_research: 'network',
  browser_navigate: 'network',
  browser_elements: 'read',
  browser_click: 'network',
  browser_type: 'network',
  browser_key: 'network',
  browser_scroll: 'read',
  browser_screenshot: 'read',
  browser_extract: 'read',
  browser_reset: 'read',
  delegate_task: 'exec',
  list_agents: 'read',
  llm_pools: 'network',
  mist_self_check: 'read',
  mist_deep_selfcheck: 'read',
  evolution_scan: 'read',
  evolution_suggest: 'persist',
  evolution_list: 'read',
  evolution_detail: 'read',
  evolution_status: 'read',
  mist_self_status: 'read',
  mist_self_read: 'read',
  mist_self_patch: 'self-modify',
  mist_self_write: 'self-modify',
  mist_self_build: 'exec',
  mist_self_update: 'read',
  mist_backlog: 'persist',
  check_updates: 'network',
  capability_check: 'read',
  cron_list: 'read',
  cron_create: 'persist',
  cron_toggle: 'persist',
  cron_run_now: 'exec',
  cron_delete: 'destructive',
  autonomy_log: 'read',
  trend_scan: 'network',
  self_upgrade_scan: 'persist',
  obsidian_status: 'read',
  obsidian_discover: 'read',
  obsidian_list_notes: 'sensitive-read',
  obsidian_read_note: 'sensitive-read',
  obsidian_search: 'sensitive-read',
  obsidian_tags: 'sensitive-read',
  obsidian_graph: 'read',
  obsidian_backlinks: 'sensitive-read',
  obsidian_create_note: 'write',
  obsidian_update_note: 'write',
  obsidian_daily_note: 'write',
  obsidian_query: 'read',
  search_sessions: 'sensitive-read',
  learning_status: 'sensitive-read',
  knowledge_search: 'read',
  scan_chunks: 'read',
  memory_manage: 'persist',
  user_profile_manage: 'persist',
  check_permission: 'read',
  queue_action: 'persist',
  get_pending_actions: 'read',
  record_decision: 'persist',
  schedule_task: 'persist',
  list_scheduled_tasks: 'read',
  digest_collect: 'persist',
  skill_manage: 'persist',
  oj_sync_check: 'network',
  oj_sync_status: 'read',
  oj_sync_apply: 'self-modify',
  mark_lv_sync_status: 'read',
}

/** True when the tool is one of the 116 frozen register entries. */
export function isKnownTool(tool: string): boolean {
  return Object.prototype.hasOwnProperty.call(TOOL_RISK, tool)
}

/** Normalize a path for prefix matching: backslashes → '/', absolute →
 *  project-relative, './' stripped, lowercased (case-insensitive compare). */
export function normalizeProjectPath(p: string): string {
  let s = p.replace(/\\/g, '/').trim()
  const cwd = process.cwd()
  if (cwd && s.toLowerCase().startsWith(cwd.toLowerCase())) s = s.slice(cwd.length)
  s = s.replace(/^\/+/, '')
  while (s.startsWith('./')) s = s.slice(2)
  return s.toLowerCase()
}

/** The frozen protected-path list (arbiter floor 1). Writes targeting any of
 *  these deny at EVERY scope — changes here are owner-via-evolution only.
 *  'src/app/api/mist/approvals' + 'src/lib/oj/approval-service' resolve the
 *  mandate's conditional (the approval spine lives in the oj layer here). */
export const PROTECTED_PATHS: readonly string[] = [
  'src/lib/arbiter/', // the Arbiter itself
  'src/proxy.ts', // the perimeter
  'src/app/api/mist/approvals', // approval spine (route layer)
  'src/lib/oj/approval-service', // approval spine (service layer)
  'src/lib/audit', // audit wiring paths (file or folder shape)
  'db/bridge/mist-bridge.js', // auth section — whole file
  'scripts/secret-scan.ts',
  'hooks/pre-commit',
  '.env', // prefix match also covers .env.local and friends
  'prisma/',
  'db/persona/SOUL.md',
  'src/lib/services/context-builder.ts', // trust block
  'src/lib/services/evolution-service.ts', // the evolution gate
]

export function isProtectedPath(p: string): boolean {
  const n = normalizeProjectPath(p)
  if (!n) return false
  return PROTECTED_PATHS.some((prefix) => n.startsWith(prefix.toLowerCase()))
}

/** Arg-aware risk resolution (register escalations). Falls back to the frozen
 *  table entry, then to 'write' for unknown tools — see the header comment. */
export function classifyRisk(tool: string, args: Record<string, unknown>): RiskClass {
  const a = args ?? {}
  const rel = typeof a.path === 'string' ? normalizeProjectPath(a.path) : ''
  const base = rel.split('/').pop() ?? ''

  // named future-tool shapes the mandate called out explicitly
  if (tool === 'save_skill' || tool === 'skill_save' || tool === 'write_persona') return 'persist'
  if (tool === 'mist_self_write') return rel.startsWith('db/persona/') ? 'persist' : 'self-modify'

  switch (tool) {
    case 'owner_files': {
      const op = String(a.op ?? '')
      if (op === 'delete') return 'destructive'
      if (op === 'read') return 'sensitive-read'
      return 'write' // op=list lands here too — conservative on purpose (spec-literal)
    }
    case 'write_file':
      if (
        rel.startsWith('src/') ||
        rel.startsWith('prisma/') ||
        rel.startsWith('package.json') ||
        base === 'package.json' ||
        base.startsWith('.env')
      ) {
        return 'self-modify'
      }
      return 'write'
    case 'read_file':
      if (rel.startsWith('.env') || base.startsWith('.env') || rel.startsWith('db/provider-keys') || /key|token|secret/.test(rel)) {
        return 'sensitive-read'
      }
      return 'read'
    case 'hermes_memory':
      return String(a.action ?? '') === 'read' ? 'sensitive-read' : 'persist'
    case 'hermes_cron':
      return String(a.action ?? '') === 'run' ? 'exec' : 'persist'
    case 'ui_automate': {
      const c = String(a.command ?? '')
      return c === 'inspect' || c === 'find' ? 'sensitive-read' : 'exec'
    }
    case 'llm_pools':
      return String(a.action ?? '') === 'pick' ? 'self-modify' : 'network'
    case 'mist_deep_selfcheck':
      // repair defaults to true in the tool schema — an absent flag still auto-applies
      return a.repair === undefined || a.repair === true ? 'self-modify' : 'read'
    case 'mist_backlog':
      return String(a.action ?? 'list') === 'remove' ? 'destructive' : 'persist'
    case 'memory_manage':
      return String(a.action ?? '') === 'delete' ? 'destructive' : 'persist'
    case 'user_profile_manage':
      return String(a.action ?? '') === 'get' ? 'sensitive-read' : 'persist'
    case 'obsidian_create_note':
      return a.overwrite === true ? 'destructive' : 'write'
    case 'browser_type':
      return a.submit === true ? 'egress' : 'network'
    case 'browser_click':
      // heuristic from the register: submit/buy/login-shaped clicks leave the site
      return /submit|login|sign.?in|buy|checkout|password/i.test(String(a.selector ?? '')) ? 'egress' : 'network'
    default: {
      const known = TOOL_RISK[tool]
      if (known) return known
      return 'write'
    }
  }
}
