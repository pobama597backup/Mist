'use client'

// M.I.S.T. OpenJarvis lab client — the typed bridge the diagnostics drawer
// tabs (traces · efficiency · knowledge · operators · upstream) use to talk
// to the wave-1 backend. Relative paths only, honest typed errors: every
// failure surfaces as an OjApiError carrying the server's own message (or a
// plain network note) so the UI can toast exactly what happened.

// ---------- shared error ----------

export class OjApiError extends Error {
  readonly status: number
  constructor(message: string, status: number) {
    super(message)
    this.name = 'OjApiError'
    this.status = status
  }
}

async function ojJson<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response
  try {
    res = await fetch(path, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
      cache: 'no-store',
    })
  } catch (err) {
    throw new OjApiError(
      err instanceof Error ? `network unreachable (${err.message})` : 'network unreachable',
      0
    )
  }
  if (!res.ok) {
    let detail = res.statusText || `HTTP ${res.status}`
    try {
      const body = (await res.json()) as { error?: unknown; message?: unknown }
      if (typeof body?.error === 'string' && body.error) detail = body.error
      else if (typeof body?.message === 'string' && body.message) detail = body.message
      else detail = JSON.stringify(body)
    } catch {
      /* non-JSON body — keep statusText */
    }
    throw new OjApiError(detail, res.status)
  }
  return (await res.json()) as T
}

// ---------- traces (oj-spine-1) ----------

export type TraceOutcome = 'success' | 'degraded' | 'failure' | 'blocked' | 'running'

export interface TraceSummary {
  id: string
  query: string
  agent: string
  model: string
  provider: string
  outcome: TraceOutcome | string
  tier: string
  complexity: number
  tokensIn: number
  tokensOut: number
  latencyMs: number
  steps: number
  createdAt: string
}

export interface TraceStep {
  idx: number
  type: string
  name: string
  ok: boolean
  durationMs: number | null
  tokens: number | null
  input: string | null
  output: string | null
  meta?: string | null
  createdAt?: string
}

export interface TraceDetail extends Omit<TraceSummary, 'steps'> {
  result?: string | null
  feedback?: string | null
  costUsd?: number | null
  tokenBudget?: number | null
  meta?: Record<string, unknown> | null
  startedAt?: string | null
  endedAt?: string | null
  steps: TraceStep[]
}

export interface TracesListResponse {
  traces: TraceSummary[]
}

export interface TraceDetailResponse {
  trace: TraceDetail
}

export interface TracesListParams {
  agent?: string
  outcome?: string
  limit?: number
}

// ---------- efficiency (oj-spine-1) ----------

export interface EfficiencyTotals {
  requests: number
  tokensIn: number
  tokensOut: number
  avgLatencyMs: number
  costUsd: number
}

export interface EfficiencySlice {
  provider?: string
  agent?: string
  requests: number
  tokensIn: number
  tokensOut: number
  avgLatencyMs: number
  costUsd: number
}

export interface EfficiencyDay {
  day: string
  requests: number
  tokens: number
}

export interface EfficiencyResponse {
  totals: EfficiencyTotals
  perProvider: EfficiencySlice[]
  perAgent: EfficiencySlice[]
  perDay: EfficiencyDay[]
}

// ---------- knowledge (oj-mind-2) ----------

export interface KnowledgeSearchResult {
  id: string
  source: string
  title: string
  content: string
  score: number
  bm25: number
  vector: number
}

export interface KnowledgeSearchResponse {
  results: KnowledgeSearchResult[]
}

export interface KnowledgeIngestResponse {
  chunks: number
}

export interface ConnectorInfo {
  id: string
  name: string
  kind: string
  connected: boolean
  available: boolean
  items: number
  lastSyncAt: string | null
  note: string
}

export interface ConnectorsListResponse {
  connectors: ConnectorInfo[]
}

export interface ConnectorSyncResponse {
  ok: boolean
  result?: {
    ok: boolean
    ingested?: number
    skipped?: number
    note?: string
    lastSyncAt?: string
  }
  connector: ConnectorInfo
}

// ---------- operators + digest (oj-ops-3) ----------

export interface OperatorInfo {
  slug: string
  name: string
  description: string
  status: string
  schedule: { type: string; value: number | string }
  humanSchedule: string
  lastRunAt: string | null
  lastStatus: string | null
  runCount: number
  nextRunAt: string | null
  budget?: { maxActionsPerRun?: number; maxTokens?: number } | null
  tools?: string[]
  enabled?: boolean
}

export interface OperatorsListResponse {
  operators: OperatorInfo[]
}

export interface OperatorActionResponse {
  ok: boolean
  status?: string
  result?: unknown
  error?: unknown
}

export interface DigestInfo {
  id: string
  kind: string
  headline: string
  items: string[]
  tone: string
  degraded: boolean
  content: string
  sections?: unknown
  createdAt: string
}

export interface DigestScheduleInfo {
  jobId: string
  enabled: boolean
  cron: string
  nextRunAt: string | null
  lastRunAt: string | null
  lastStatus: string | null
}

export interface DigestListResponse {
  digests: DigestInfo[]
  latest?: DigestInfo
  schedule: DigestScheduleInfo
}

export interface DigestGenerateResponse {
  digest: DigestInfo
}

export interface DigestScheduleSetResponse {
  ok: boolean
  nextRunAt?: string
  error?: string
}

// ---------- upstream self-update (oj-sync-7) ----------

export interface OjSyncTiers {
  structural: number
  knowledge: number
  excluded: number
  unknown: number
}

export interface OjSyncHistoryEntry {
  at: string
  old_head: string
  new_head: string
  commits: number
  files: number
  brief?: string
  proposals: string[]
  tiers?: OjSyncTiers
  merged?: boolean
  pending_knowledge?: boolean
  error?: string
}

export interface OjSyncStatus {
  repo: string
  watching: boolean
  head: string | null
  local_head: string | null
  merge_pending: boolean
  last_head_at: string | null
  last_sweep_at: string | null
  next_sweep_at: string | null
  interval_min: number
  auto_patch: boolean
  sweeps: number
  error: string | null
  pending_knowledge: { new_head: string; since: string; has_brief: boolean; commits: number } | null
  developing: string[]
  history: OjSyncHistoryEntry[]
}

export interface OjPortMapModule {
  module: string
  tier: 'structural' | 'knowledge' | 'excluded' | string
  prefixes: string[]
  targets: number
}

export interface OjPortMapSummary {
  repo: string
  branch: string
  entries: number
  modules: OjPortMapModule[]
}

export interface OjSyncStatusResponse {
  status: OjSyncStatus
  mapping: OjPortMapSummary
  /** mlv-rust-3 additive: the Mark-LV anti-rust watch rides the same route */
  mark_lv?: MarkLvSyncStatus
  /** w3-notify additive: Clare's teacher notices + pending summary */
  teacher_notices?: TeacherNoticesResponse
}

export interface OjSyncCheckResponse {
  ok: boolean
  changed: boolean
  head: string | null
  old_head?: string | null
  baseline?: boolean
  busy?: boolean
  commits?: { total: number; listed: number; sample: Array<{ sha: string; date: string; title: string }>; truncated: boolean }
  files?: { total: number; list: Array<{ status: string; path: string }>; truncated: boolean }
  tiers?: OjSyncTiers
  brief?: string
  proposals?: Array<{ id: string; module: string; title: string; developing: boolean }>
  merged?: boolean
  pending_knowledge?: boolean
  error?: string
  message: string
}

export interface OjSyncApplyResponse {
  ok: boolean
  message: string
  proposal?: { id: string; title: string; status: string; steps: number }
}

export interface OjSyncConfigureResponse {
  ok: boolean
  message: string
  config: { interval_min: number; auto_patch: boolean }
}

// ---------- mlv-rust-3: Mark-LV (the teacher's assistant) anti-rust watch ----------

export interface MarkLvSyncHistoryEntry {
  head: string
  at: string
  filesChanged: number
  commits: number
}

export interface MarkLvSyncStatus {
  id: string
  name: string
  repo: string
  url: string
  branch: string
  watching: boolean
  status: 'watching' | 'updated' | 'diverged' | 'error'
  head: string | null
  local_head: string | null
  commits_behind: number | null
  last_scan_at: string | null
  last_update_at: string | null
  next_scan_at: string | null
  interval_min: number
  sweeps: number
  knowledge_pending: boolean
  last_digest: string | null
  error: string | null
  history: MarkLvSyncHistoryEntry[]
}

export interface MarkLvSyncCheckResponse {
  ok: boolean
  changed: boolean
  head: string | null
  old_head?: string | null
  baseline?: boolean
  busy?: boolean
  diverged?: boolean
  status?: string
  commits?: { total: number; listed: number; sample: Array<{ sha: string; date: string; title: string }>; truncated: boolean }
  files?: { total: number; list: Array<{ status: string; path: string }>; truncated: boolean }
  digest?: string
  knowledge_ingested?: boolean
  error?: string
  message: string
}

// ---------- w3-notify: teacher notices (Clare's notes about Mark-LV updates) ----------

export interface TeacherNoticeInfo {
  id: string
  head: string
  commits: number
  /** JSON string: [{sha, subject, files[], files_total}] */
  digest: string
  /** Clare's words to the creator (what changed + the ask) */
  message: string
  /** her honest take on usefulness for M.I.S.T. ('' when the lanes were down) */
  opinion: string
  status: 'new' | 'wanted' | 'dismissed' | string
  seen_at: string | null
  created_at: string
}

export interface TeacherNoticesResponse {
  notices: TeacherNoticeInfo[]
  summary: { pending: number }
}

export interface TeacherNoticeDecideResponse {
  ok: boolean
  message: string
  notice?: TeacherNoticeInfo
}

export interface TeacherNoticePreviewResponse {
  preview: boolean
  degraded: boolean
  message: string
  opinion: string
  head: string | null
  commits: number
  source: 'last_absorbed' | 'current_head' | string
  digest: string
  provider: string
  model: string
}

// ---------- the client ----------

function buildQuery(params?: Record<string, string | number | undefined>): string {
  if (!params) return ''
  const q = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== '' && v !== null) q.set(k, String(v))
  }
  const s = q.toString()
  return s ? `?${s}` : ''
}

export const ojApi = {
  // ---- traces ----
  traces: {
    list: (params?: TracesListParams) =>
      ojJson<TracesListResponse>(`/api/mist/traces${buildQuery(params as Record<string, string | number | undefined>)}`),
    detail: (id: string) => ojJson<TraceDetailResponse>(`/api/mist/traces/${encodeURIComponent(id)}`),
  },

  // ---- efficiency ----
  efficiency: () => ojJson<EfficiencyResponse>('/api/mist/analytics/efficiency'),

  // ---- knowledge ----
  knowledge: {
    search: (query: string, opts?: { topK?: number }) =>
      ojJson<KnowledgeSearchResponse>('/api/mist/knowledge/search', {
        method: 'POST',
        body: JSON.stringify({ query, ...(opts?.topK !== undefined ? { topK: opts.topK } : {}) }),
      }),
    ingest: (payload: { source: string; title?: string; text: string }) =>
      ojJson<KnowledgeIngestResponse>('/api/mist/knowledge/ingest', {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
  },

  // ---- connectors ----
  connectors: {
    list: () => ojJson<ConnectorsListResponse>('/api/mist/connectors'),
    sync: (id: string) =>
      ojJson<ConnectorSyncResponse>('/api/mist/connectors', {
        method: 'POST',
        body: JSON.stringify({ id, action: 'sync' }),
      }),
  },

  // ---- operators ----
  operators: {
    list: () => ojJson<OperatorsListResponse>('/api/mist/operators'),
    action: (id: string, action: 'run' | 'pause' | 'resume') =>
      ojJson<OperatorActionResponse>(`/api/mist/operators/${encodeURIComponent(id)}`, {
        method: 'POST',
        body: JSON.stringify({ action }),
      }),
  },

  // ---- digest ----
  digest: {
    list: () => ojJson<DigestListResponse>('/api/mist/digest'),
    generate: (speak = false) =>
      ojJson<DigestGenerateResponse>('/api/mist/digest', {
        method: 'POST',
        body: JSON.stringify({ speak }),
      }),
    setSchedule: (enabled: boolean, cron: string) =>
      ojJson<DigestScheduleSetResponse>('/api/mist/digest/schedule', {
        method: 'POST',
        body: JSON.stringify({ enabled, cron }),
      }),
  },

  // ---- upstream self-update ----
  ojSync: {
    status: () => ojJson<OjSyncStatusResponse>('/api/mist/oj/sync'),
    check: () =>
      ojJson<OjSyncCheckResponse>('/api/mist/oj/sync', {
        method: 'POST',
        body: JSON.stringify({ action: 'check' }),
      }),
    apply: (proposalId: string) =>
      ojJson<OjSyncApplyResponse>('/api/mist/oj/sync', {
        method: 'POST',
        body: JSON.stringify({ action: 'apply', proposal_id: proposalId }),
      }),
    configure: (opts: { interval_min?: number; auto_patch?: boolean }) =>
      ojJson<OjSyncConfigureResponse>('/api/mist/oj/sync', {
        method: 'POST',
        body: JSON.stringify({ action: 'configure', ...opts }),
      }),
  },

  // ---- mlv-rust-3: Mark-LV (the teacher's assistant) anti-rust watch ----
  markLv: {
    check: () =>
      ojJson<MarkLvSyncCheckResponse>('/api/mist/oj/sync', {
        method: 'POST',
        body: JSON.stringify({ action: 'mark_lv_check' }),
      }),
  },

  // ---- w3-notify: the teacher's notices — Clare writes, the creator answers ----
  // (the LIST rides the sync GET status response as `teacher_notices`)
  teacherNotices: {
    decide: (id: string, decision: 'wanted' | 'dismissed') =>
      ojJson<TeacherNoticeDecideResponse>('/api/mist/oj/sync', {
        method: 'POST',
        body: JSON.stringify({ action: 'notice_decide', id, decision }),
      }),
    preview: () =>
      ojJson<TeacherNoticePreviewResponse>('/api/mist/oj/sync', {
        method: 'POST',
        body: JSON.stringify({ action: 'notice_preview' }),
      }),
  },
}
