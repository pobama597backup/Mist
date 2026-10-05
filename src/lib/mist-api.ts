// M.I.S.T. typed API client — the ONLY way the frontend talks to /api/mist/*
'use client'

import type {
  AlertsResponse,
  Conversation,
  ChatMessage,
  EnvPresenceResponse,
  EnvSetResponse,
  EvolutionActionResult,
  EvolutionListResponse,
  EvolutionScanResponse,
  EvolutionSuggestResponse,
  HealthResponse,
  LlmStatus,
  LlmTestResponse,
  MemoryFact,
  MemoryQueueItem,
  MemoryStats,
  OpenClawStatus,
  ResearchJob,
  ResearchJobSummary,
  CronJobRow,
  AutonomyEventRow,
  AutonomyStats,
  TrendDigest,
  SelfUpgradeResult,
  VaultStatus,
  VaultNoteMeta,
  VaultNote,
  VaultTag,
  VaultGraph,
  VaultQueryResult,
  LearningStatus,
  SkillExecution,
  SkillInfo,
  SttResponse,
  TelemetryResponse,
  ToolCategory,
  ToolExecuteResult,
  ToolInfo,
  UnifiedLlmRequest,
  UnifiedLlmResponse,
  VectorSearchResult,
  WatchlistStatus,
} from './types'

const BASE = '/api/mist'

class ApiError extends Error {
  status: number
  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    cache: 'no-store',
  })
  if (!res.ok) {
    let detail = res.statusText
    try {
      const body = await res.json()
      detail = body.error ?? JSON.stringify(body)
    } catch {
      /* ignore */
    }
    throw new ApiError(detail, res.status)
  }
  return (await res.json()) as T
}

export const mistApi = {
  // ---- system ----
  health: () => json<HealthResponse>('/health'),
  telemetry: () => json<TelemetryResponse>('/telemetry'),

  // ---- tools ----
  tools: {
    list: () => json<ToolInfo[]>('/tools/list'),
    categories: () => json<ToolCategory[]>('/tools/categories'),
    info: (name: string) => json<ToolInfo>(`/tools/${encodeURIComponent(name)}/info`),
    execute: (
      tool: string,
      args: Record<string, unknown>,
      confirmed = false
    ) =>
      json<ToolExecuteResult>('/tools/execute', {
        method: 'POST',
        body: JSON.stringify({ tool, args, confirmed }),
      }),
  },

  // ---- memory ----
  memory: {
    longterm: {
      list: () => json<MemoryFact[]>('/memory/longterm'),
      set: (key: string, value: string) =>
        json<{ success: boolean }>('/memory/longterm', {
          method: 'POST',
          body: JSON.stringify({ key, value }),
        }),
      remove: (key: string) =>
        json<{ success: boolean }>(`/memory/longterm/${encodeURIComponent(key)}`, {
          method: 'DELETE',
        }),
    },
    queue: () => json<MemoryQueueItem[]>('/memory/queue'),
    vectorSearch: (query: string, nResults = 5) =>
      json<{ results: VectorSearchResult[] }>('/memory/vector/search', {
        method: 'POST',
        body: JSON.stringify({ query, n_results: nResults }),
      }),
    stats: () => json<MemoryStats>('/memory/stats'),
  },

  // ---- voice ----
  voice: {
    status: () => json<import('./types').VoiceStatus>('/voice/status'),
    stt: async (audio: Blob, filename = 'speech.wav') => {
      const fd = new FormData()
      fd.append('audio_file', audio, filename)
      const res = await fetch(`${BASE}/voice/stt`, { method: 'POST', body: fd })
      if (!res.ok) throw new ApiError('STT failed', res.status)
      return (await res.json()) as SttResponse
    },
    tts: async (
      text: string,
      voice = 'tongtong',
      speed = 1.0,
      engine?: 'glm' | 'edge' | 'gtranslate'
    ) => {
      const res = await fetch(`${BASE}/voice/tts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(engine ? { text, voice, speed, engine } : { text, voice, speed }),
      })
      if (!res.ok) throw new ApiError('TTS failed', res.status)
      return (await res.blob()) as Blob & { type: string }
    },
    // -- local offline engines (whisper.cpp + piper via the Mist Bridge) --
    localStatus: () =>
      json<{
        ok: boolean
        voice: import('./services/voice-local').LocalVoiceDetail | null
        bridgeConnected: boolean
      }>('/voice/local/status'),
    /** Same response contract as tts() (audio/wav blob) — player code is shared. */
    localTts: async (text: string, voice?: string) => {
      const res = await fetch(`${BASE}/voice/local/tts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(voice ? { text, voice } : { text }),
      })
      if (!res.ok) throw new ApiError('Local TTS failed', res.status)
      return (await res.blob()) as Blob & { type: string }
    },
    localTranscribe: async (wavB64: string) => {
      const res = await fetch(`${BASE}/voice/local/transcribe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ wav_b64: wavB64 }),
      })
      if (!res.ok) {
        let detail = 'Local STT failed'
        try {
          const body = (await res.json()) as { error?: unknown }
          if (body && typeof body.error === 'string') detail = body.error
        } catch {
          /* ignore */
        }
        throw new ApiError(detail, res.status)
      }
      return (await res.json()) as {
        transcription: string
        elapsedMs: number | null
        model: string | null
        bridgeConnected: boolean
      }
    },
    /** Install an offline engine (~25-85MB, can take minutes) via the bridge. */
    localSetup: (engine: 'stt' | 'tts', tier?: 'light' | 'balanced') =>
      json<{ ok: boolean; result: import('./types').BridgeExecResult }>('/bridge', {
        method: 'POST',
        body: JSON.stringify({
          action: 'voice_setup',
          args: { engine, ...(tier ? { tier } : {}) },
        }),
      }),
  },

  // ---- llm ----
  llm: {
    status: () => json<LlmStatus>('/llm/status'),
    test: (message: string, provider?: string) =>
      json<LlmTestResponse>('/llm/test', {
        method: 'POST',
        body: JSON.stringify({ message, provider }),
      }),
    unified: (req: UnifiedLlmRequest) =>
      json<UnifiedLlmResponse>('/llm/unified', {
        method: 'POST',
        body: JSON.stringify(req),
      }),
  },

  // ---- conversations ----
  conversations: {
    list: () => json<Conversation[]>('/conversations'),
    create: (title?: string) =>
      json<Conversation>('/conversations', {
        method: 'POST',
        body: JSON.stringify({ title }),
      }),
    messages: (id: string) => json<ChatMessage[]>(`/conversations/${id}/messages`),
    appendMessage: (
      id: string,
      role: 'user' | 'assistant' | 'system',
      content: string,
      meta?: {
        provider?: string
        model?: string
        fallback?: boolean
        meta?: Record<string, unknown>
      }
    ) =>
      json<ChatMessage>(`/conversations/${id}/messages`, {
        method: 'POST',
        body: JSON.stringify({ role, content, ...meta }),
      }),
  },

  // ---- in-app browser (v2) ----
  browser: {
    status: () =>
      json<{
        available: boolean
        page_open: boolean
        current_url: string | null
        title: string | null
      }>('/browser/status'),
    command: <T = Record<string, unknown>>(action: string, args: Record<string, unknown> = {}) =>
      json<T & { ok?: boolean; error?: string }>('/browser/command', {
        method: 'POST',
        body: JSON.stringify({ action, args }),
      }),
  },

  // ---- external agents (v2) ----
  agents: {
    list: () =>
      json<{
        agents: Array<{
          id: string
          label: string
          cmd: string
          installed: boolean
          version: string | null
          delegate: 'headless' | 'interactive-only'
          install_hint: string
        }>
      }>('/agents'),
    delegate: (agent: string, task: string, timeoutMs = 120000) =>
      json<{
        agent: string
        installed: boolean
        ok: boolean
        output: string
        exit_code: number | null
        duration_ms: number
        error?: string
      }>('/agents', {
        method: 'POST',
        body: JSON.stringify({ agent, task, timeout_ms: timeoutMs }),
      }),
  },

  // ---- deep research (v5 — async job-based with live phases) ----
  research: {
    start: (query: string, depth: 1 | 2 = 1) =>
      json<{ ok: boolean; jobId: string }>('/research', {
        method: 'POST',
        body: JSON.stringify({ query, depth }),
      }),
    job: (id: string) => json<ResearchJob>(`/research/${encodeURIComponent(id)}`),
    list: () => json<{ jobs: ResearchJobSummary[] }>('/research'),
  },

  // ---- v5 autonomy: scheduled automations (Hermes-style cron) ----
  cron: {
    list: () => json<{ jobs: CronJobRow[] }>('/cron'),
    create: (payload: {
      name: string
      prompt: string
      schedule: string
      delivery?: 'alert' | 'silent'
    }) =>
      json<{ ok: boolean; job?: CronJobRow; explanation?: string; error?: string }>('/cron', {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    update: (id: string, patch: { enabled?: boolean; name?: string; prompt?: string }) =>
      json<{ ok: boolean; job?: CronJobRow; error?: string }>(`/cron/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      }),
    remove: (id: string) =>
      json<{ ok: boolean; error?: string }>(`/cron/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      }),
    run: (id: string) =>
      json<{ ok: boolean; result?: string; error?: string }>(
        `/cron/${encodeURIComponent(id)}/run`,
        {
          method: 'POST',
          body: JSON.stringify({}),
        }
      ),
  },

  // ---- v5 autonomy ledger ----
  autonomy: {
    list: (limit = 60, type?: string) =>
      json<{ events: AutonomyEventRow[]; stats: AutonomyStats }>(
        `/autonomy?limit=${limit}${type ? `&type=${encodeURIComponent(type)}` : ''}`
      ),
  },

  // ---- v5 trends + self-upgrade ----
  trends: {
    get: () =>
      json<{ last: TrendDigest | null; history: Array<{ generatedAt: string; headline: string }> }>(
        '/trends'
      ),
    digest: () =>
      json<{ ok: boolean; digest: TrendDigest }>('/trends', {
        method: 'POST',
        body: JSON.stringify({ mode: 'digest' }),
      }),
    upgrade: () =>
      json<{ ok: boolean; result: SelfUpgradeResult }>('/trends', {
        method: 'POST',
        body: JSON.stringify({ mode: 'upgrade' }),
      }),
  },

  // ---- v5 Obsidian vault ----
  obsidian: {
    status: () => json<VaultStatus>('/obsidian?action=status'),
    discover: () =>
      json<{ found: Array<{ path: string; noteCount: number }>; demoAvailable: boolean }>(
        '/obsidian?action=discover'
      ),
    list: (folder?: string) =>
      json<{ notes: VaultNoteMeta[] }>(
        `/obsidian?action=list${folder ? `&folder=${encodeURIComponent(folder)}` : ''}`
      ),
    read: (path: string) =>
      json<{ ok: true; note: VaultNote } | { ok: false; error: string }>(
        `/obsidian?action=read&path=${encodeURIComponent(path)}`
      ),
    search: (q: string) =>
      json<{ results: Array<{ path: string; title: string; snippet: string; score: number }> }>(
        `/obsidian?action=search&q=${encodeURIComponent(q)}`
      ),
    tags: () => json<{ tags: VaultTag[] }>('/obsidian?action=tags'),
    graph: () => json<VaultGraph>('/obsidian?action=graph'),
    backlinks: (path: string) =>
      json<{ backlinks: Array<{ from: string; snippet: string }> }>(
        `/obsidian?action=backlinks&path=${encodeURIComponent(path)}`
      ),
    daily: (date?: string) =>
      json<{ ok: boolean; path?: string; content?: string; created?: boolean; error?: string }>(
        `/obsidian?action=daily${date ? `&date=${date}` : ''}`
      ),
    query: (q: string) =>
      json<VaultQueryResult>(`/obsidian?action=query&q=${encodeURIComponent(q)}`),
    setPath: (path: string | 'demo' | null) =>
      json<VaultStatus>('/obsidian', {
        method: 'POST',
        body: JSON.stringify({ action: 'set_path', path }),
      }),
    create: (path: string, content: string, overwrite = false) =>
      json<{ ok: boolean; path?: string; error?: string }>('/obsidian', {
        method: 'POST',
        body: JSON.stringify({ action: 'create', path, content, overwrite }),
      }),
    update: (path: string, content: string, mode: 'replace' | 'append' = 'append') =>
      json<{ ok: boolean; path?: string; error?: string }>('/obsidian', {
        method: 'POST',
        body: JSON.stringify({ action: 'update', path, content, mode }),
      }),
    ensureDemo: () =>
      json<{ ok: boolean; path?: string; error?: string }>('/obsidian', {
        method: 'POST',
        body: JSON.stringify({ action: 'ensure_demo' }),
      }),
  },

  // ---- v5 learning loop ----
  learning: {
    status: () => json<{ status: LearningStatus }>('/learning'),
    curate: () =>
      json<{ action: string; result: { factsLearned: number; notes: string } }>('/learning', {
        method: 'POST',
        body: JSON.stringify({ action: 'curate_memory' }),
      }),
    rebuildUserModel: () =>
      json<{ action: string; result: string }>('/learning', {
        method: 'POST',
        body: JSON.stringify({ action: 'rebuild_user_model' }),
      }),
    reflect: (payload: {
      threadId: string
      userText: string
      replyText: string
      toolsUsed: string[]
      success: boolean
    }) =>
      json<{
        action: string
        result: {
          considered: boolean
          created: boolean
          reason: string
          proposal: { name: string; trigger: string; steps: string; toolChain: string[]; confidence: number } | null
          skillName: string | null
        }
      }>('/learning', {
        method: 'POST',
        body: JSON.stringify({ action: 'reflect', ...payload }),
      }),
  },

  // ---- skills ----
  skills: {
    list: () => json<SkillInfo[]>('/skills/list'),
    save: (payload: {
      name: string
      trigger: string
      steps?: string
      tool_chain?: string[]
      notes?: string
    }) =>
      json<{ success: boolean; skill: SkillInfo }>('/skills/save', {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    remove: (name: string) =>
      json<{ success: boolean }>(`/skills/${encodeURIComponent(name)}`, {
        method: 'DELETE',
      }),
    executions: (skillName?: string) =>
      json<SkillExecution[]>(
        `/skills/executions${skillName ? `?skill=${encodeURIComponent(skillName)}` : ''}`
      ),
  },

  // ---- config (env presence — never secrets) ----
  config: {
    env: () => json<EnvPresenceResponse>('/config/env'),
    setEnv: (vars: Record<string, string>, confirmed: boolean) =>
      json<EnvSetResponse>('/config/env', {
        method: 'POST',
        body: JSON.stringify({ vars, confirmed }),
      }),
  },

  // ---- self-evolution (v3 — MIST codes itself) ----
  evolution: {
    list: () => json<EvolutionListResponse>('/evolution'),
    scan: () =>
      json<EvolutionScanResponse>('/evolution/scan', {
        method: 'POST',
        body: JSON.stringify({}),
      }),
    suggest: (origin: 'self-idea' | 'openclaw' | 'user' = 'self-idea') =>
      json<EvolutionSuggestResponse>('/evolution/suggest', {
        method: 'POST',
        body: JSON.stringify({ origin }),
      }),
    develop: (id: string) =>
      json<EvolutionActionResult>(`/evolution/${encodeURIComponent(id)}/develop`, {
        method: 'POST',
        body: JSON.stringify({}),
      }),
    approve: (id: string) =>
      json<EvolutionActionResult>(`/evolution/${encodeURIComponent(id)}/approve`, {
        method: 'POST',
        body: JSON.stringify({}),
      }),
    reject: (id: string) =>
      json<EvolutionActionResult>(`/evolution/${encodeURIComponent(id)}/reject`, {
        method: 'POST',
        body: JSON.stringify({}),
      }),
    openclaw: () => json<OpenClawStatus>('/evolution/openclaw'),
    openclawSync: () =>
      json<{ ok: boolean; sync: { message: string; changed: boolean; version: string | null }; openclaw: OpenClawStatus }>(
        '/evolution/openclaw',
        {
          method: 'POST',
          body: JSON.stringify({ action: 'sync' }),
        }
      ),
  },

  // ---- heartbeat alerts (v4 — ⏰ reminders + 📦 releases land in the chat) ----
  alerts: {
    list: () => json<AlertsResponse>('/alerts'),
    deliver: (ids: string[], conversationId: string | null) =>
      json<{ ok: boolean; delivered: number }>('/alerts', {
        method: 'POST',
        body: JSON.stringify({ action: 'deliver', ids, conversation_id: conversationId }),
      }),
  },

  // ---- watchlist (v4 — anti-rust freshness) ----
  watchlist: {
    status: () => json<WatchlistStatus>('/watchlist'),
    sync: () =>
      json<{
        ok: boolean
        sweep: { checked: number; changed: number; message: string }
        watchlist: WatchlistStatus
      }>('/watchlist', {
        method: 'POST',
        body: JSON.stringify({ action: 'sync' }),
      }),
  },

  // ---- local bridge (v6 — owner-side system control via the Mist Bridge daemon) ----
  bridge: {
    status: () => json<{ ok: boolean; status: import('./types').BridgeStatus }>('/bridge'),
    setUrl: (url: string) =>
      json<{ ok: boolean; status: import('./types').BridgeStatus }>('/bridge', {
        method: 'POST',
        body: JSON.stringify({ action: 'set_url', url }),
      }),
    exec: (action: string, args?: Record<string, unknown>) =>
      json<{ ok: boolean; result: import('./types').BridgeExecResult }>('/bridge', {
        method: 'POST',
        body: JSON.stringify({ action, args: args ?? {} }),
      }),
  },

  // ---- companions (v7 — the owner's local agent stack via the bridge) ----
  companions: {
    get: () =>
      json<{
        ok: boolean
        connected: boolean
        companions: Record<string, unknown> | null
      }>('/companions'),
    signalSetup: (dir?: string) =>
      json<{ ok: boolean; result?: unknown; error?: string }>('/companions', {
        method: 'POST',
        body: JSON.stringify({ action: 'signal_setup', ...(dir ? { dir } : {}) }),
      }),
    signalTest: () =>
      json<{ ok: boolean; performed?: string; error?: string }>('/companions', {
        method: 'POST',
        body: JSON.stringify({ action: 'signal_test' }),
      }),
  },

  // ---- introspection (self-doctor v1.0 — she catches her own shortcomings) ----
  introspection: {
    last: () =>
      json<
        | {
            never_ran: true
            note: string
          }
        | IntrospectionReportResponse
      >('/introspection'),
    run: (repair = true) =>
      json<IntrospectionReportResponse>('/introspection', {
        method: 'POST',
        body: JSON.stringify({ repair }),
      }),
  },
}

// ---- introspection report contract (mirrors introspection-service) ----
export interface IntrospectionFinding {
  fingerprint: string
  severity: 'warn' | 'fail'
  area: string
  title: string
  detail: string
  repair_class: 'auto' | 'evolution' | 'creator' | 'none'
  repair_hint: string
}

export interface IntrospectionReportResponse {
  ran_at: string
  source: 'manual' | 'heartbeat' | 'chat'
  duration_ms: number
  probes: Array<{
    id: string
    status: 'pass' | 'warn' | 'fail'
    ms: number
    findings: IntrospectionFinding[]
    note?: string
  }>
  findings: IntrospectionFinding[]
  new_findings: IntrospectionFinding[]
  repairs: Array<{ finding: string; lane: string; outcome: string }>
  summary: string
  all_green: boolean
}

export { ApiError }
