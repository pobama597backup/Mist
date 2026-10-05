// ============================================================
// M.I.S.T. UNIFIED — FROZEN CONTRACTS (single source of truth)
// Shared by backend routes, neural mini-service and frontend.
// Changing a shape here requires updating both ends simultaneously.
// ============================================================

export type ConsciousnessState =
  | 'dormant'
  | 'awakening'
  | 'listening'
  | 'processing'
  | 'speaking'
  | 'dreaming'

export type ProviderId =
  | 'auto'
  | 'omniroute'
  | 'openai_compatible'
  | 'openrouter'
  | 'qwen'
  | 'anthropic'
  | 'gemini'
  | 'core'
  | 'offline-mind'

export type ToolCategory =
  | 'web'
  | 'file'
  | 'system'
  | 'compute'
  | 'io'
  | 'memory'
  | 'utility'
  | 'omniroute'
  | 'skill'
  | 'browser'
  | 'agent'

export type UnifiedMode =
  | 'consciousness'
  | 'chat'
  | 'studio'
  | 'vision'
  | 'swarm'
  | 'memory_query'

// ---------- REST payloads ----------

export interface HealthResponse {
  status: 'ok'
  service: 'mist-unified'
  version: string
  timestamp: string
}

export interface TelemetryResponse {
  cpu_percent: number
  ram_percent: number
  ram_used_mb: number
  ram_total_mb: number
  disk_percent: number
  disk_used_gb: number
  disk_total_gb: number
  rss_mb: number
  uptime_s: number
  platform: string
  node_version: string
  hostname: string
}

export interface ToolParam {
  name: string
  type: 'string' | 'number' | 'boolean'
  required: boolean
  description: string
  default?: string | number | boolean
}

export interface ToolInfo {
  name: string
  description: string
  category: ToolCategory
  implemented: boolean
  parameters: ToolParam[]
  available?: boolean // omniroute: gateway reachable
  write?: boolean // omniroute: destructive — requires confirmed:true
}

export interface ToolExecuteResult {
  success: boolean
  output: unknown
  error: string | null
  tool: string
  suggest_skill?: boolean
  duration_ms?: number
}

export interface MemoryFact {
  key: string
  value: string
  created_at: string
}

export interface MemoryQueueItem {
  id: string
  content: string
  kind: string
  status: string
  due_at: string | null
  fired_at: string | null
  created_at: string
}

export interface VectorSearchResult {
  text: string
  metadata: Record<string, unknown>
  distance: number
}

export interface MemoryStats {
  longterm_count: number
  queue_count: number
  vector_count: number
}

export interface VoiceStatus {
  whisper_loaded: boolean
  kokoro_loaded: boolean
  sdk_voice: boolean
  status: 'sdk' | 'local' | 'unavailable'
  voices: string[]
  default_voice: string
}

export interface SttResponse {
  transcription: string
  language: string | null
  duration_seconds: number | null
}

export interface ProviderDetail {
  id: ProviderId
  label: string
  available: boolean
  model?: string
  base_url_present?: boolean
  api_key_present?: boolean
  note?: string
}

/** A selectable Mist Core (GLM) model in the catalog. */
export interface CoreModelOption {
  id: string
  label: string
  tier: string
  /** True when this exact model was observed serving from the Z.ai gateway. */
  live_verified: boolean
}

/** Mist Core model catalog + current selection + live gateway-reported models. */
export interface CoreModelsInfo {
  text: CoreModelOption[]
  vision: CoreModelOption[]
  /** 'auto' (gateway routing) | 'text' (mirror text selection, vision only) | model id */
  selected: { text: string; vision: string }
  /** What the gateway actually reported on the last core call of each kind (ground truth). */
  live: { text: string | null; vision: string | null }
}

/** Qwen provider catalog + selection + live endpoint-reported models (no aliases). */
export interface QwenModelsInfo {
  configured: boolean
  base_url: string
  keyless_local: boolean
  text: CoreModelOption[]
  vision: CoreModelOption[]
  /** 'auto' | model id | 'text' (vision mirrors text) */
  selected: { text: string; vision: string }
  /** What the endpoint actually reported on the last qwen call of each kind. */
  live: { text: string | null; vision: string | null }
}

export interface LlmStatus {
  configured: boolean
  provider: ProviderId
  model: string
  base_url_present: boolean
  api_key_present: boolean
  available_providers: ProviderId[]
  providers_detail: ProviderDetail[]
  core_models?: CoreModelsInfo
  qwen_models?: QwenModelsInfo
}

export interface LlmTestResponse {
  text: string
  provider: ProviderId
  model: string
  fallback: boolean
}

export interface MemoryContext {
  facts_recalled: number
  vectors_searched: number
  tools_available: number
}

export interface HistoryMessage {
  role: 'user' | 'assistant'
  content: string
}

export interface UnifiedLlmRequest {
  message: string
  mode?: UnifiedMode
  history?: HistoryMessage[]
  extra?: Record<string, unknown>
  provider?: ProviderId
}

export interface SkillHint {
  tool: string
  args: Record<string, unknown>
}

export interface UnifiedLlmResponse {
  text: string
  provider: ProviderId
  model: string
  fallback: boolean
  emotion: string
  memory_context: MemoryContext
  tools_used: string[]
  skills_used: string[]
  skill_hint: SkillHint | null
  elapsed_ms: number
  mode: UnifiedMode
  // ---- v2 agent-grade extensions (optional, additive) ----
  citations?: Citation[]
  attachments?: MediaAttachment[]
  suggestions?: string[]
  capability_request?: CapabilityRequest | null
  remembered?: string[]
}

// ---------- v2 agent-grade structures ----------

export interface Citation {
  n: number
  url: string
  title: string
  domain: string
  quality: 'high' | 'medium' | 'low'
  verified: boolean
}

export type MediaKind = 'video' | 'article' | 'link'

export interface MediaAttachment {
  type: MediaKind
  url: string
  title: string
  note?: string
  seek_to?: number // seconds — jump point for videos
  source?: string // web_search | research | browser | conversation
}

export interface CapabilityOption {
  id: string
  label: string
  description?: string
  kind: 'alternative' | 'workaround' | 'enable' | 'clarify' | 'later'
}

export interface CapabilityRequest {
  missing: string
  summary: string
  options: CapabilityOption[]
}

export interface ResearchReport {
  question: string
  report: string
  citations: Citation[]
  sources_read: number
  queries_used: string[]
  elapsed_ms: number
}

export interface Conversation {
  id: string
  title: string
  created_at: string
}

export interface ChatMessage {
  id: string
  conversation_id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  provider?: string
  model?: string
  fallback?: boolean
  created_at: string
  meta?: Record<string, unknown> // v2: citations / attachments / suggestions / capability_request
}

export interface SkillInfo {
  name: string
  trigger: string
  steps: string
  tool_chain: string[]
  notes: string
  uses: number
  created_at: string
}

export interface EnvVarPresence {
  name: string
  present: boolean
  value?: string // ONLY for non-secret keys (never for *_API_KEY)
}

export interface EnvPresenceResponse {
  vars: EnvVarPresence[]
}

export interface EnvSetResponse {
  success: boolean
  applied: string[]
  error?: string
}

// ---------- WebSocket /ws/neural protocol (FROZEN) ----------

export type NeuralClientMessage =
  | {
      type: 'thought'
      content: string
      provider?: ProviderId
      model?: string
      conversation_id?: string
      history?: HistoryMessage[]
    }
  | { type: 'set_provider'; provider: ProviderId }
  | { type: 'voice_chunk'; energy: number }
  | { type: 'ping' }

export type NeuralServerMessage =
  | {
      type: 'consciousness_state'
      state: ConsciousnessState
      neural_load: number
      memory_active: boolean
      voice_ready: boolean
      provider: ProviderId
      model: string
      timestamp: string
    }
  | {
      type: 'neural_state'
      state: ConsciousnessState
      neural_load: number
      synapse_activity?: number[]
      audio_energy?: number
      provider?: ProviderId
      model?: string
      timestamp: string
    }
  | {
      type: 'consciousness_response'
      text: string
      emotion: string
      neural_load: number
      memory_context: MemoryContext
      provider: ProviderId
      model: string
      fallback: boolean
      tools_used: string[]
      skills_used: string[]
      skill_hint: SkillHint | null
      timestamp: string
      // v2 additive passthrough fields
      citations?: Citation[]
      attachments?: MediaAttachment[]
      suggestions?: string[]
      capability_request?: CapabilityRequest | null
    }
  | { type: 'provider_set'; provider: ProviderId; model?: string; timestamp: string }
  | {
      type: 'synapse'
      channels: { name: string; value: number }[]
      log: string[]
      timestamp: string
    }
  | { type: 'pong'; timestamp: string }
  | { type: 'error'; message: string; timestamp: string }

// Extract concrete message types for frontend listeners
export interface ConsciousnessResponseMsg extends UnifiedLlmResponse {
  type: 'consciousness_response'
  neural_load: number
  timestamp: string
}

export interface SynapseMsg {
  type: 'synapse'
  channels: { name: string; value: number }[]
  log: string[]
  timestamp: string
}

// ---------- v3: self-evolution (MIST codes itself) + OpenClaw watchtower ----------

/** One deterministic file change step inside an evolution proposal. */
export interface EvolutionChange {
  path: string
  action: 'create' | 'patch'
  /** For patch: the exact text to find (must occur exactly once). */
  find?: string
  /** For patch: the replacement text; for create: the full file content. */
  content?: string
  note?: string
}

export type EvolutionKind = 'feature' | 'fix' | 'suggestion'
export type EvolutionStatus = 'pending' | 'applied' | 'rejected' | 'rolled_back' | 'failed'
export type EvolutionOrigin = 'self-audit' | 'self-idea' | 'openclaw' | 'user'

/** A self-coding proposal — stored, reviewed, then applied behind an approval gate. */
export interface EvolutionProposal {
  id: string
  kind: EvolutionKind
  title: string
  summary: string
  rationale: string
  status: EvolutionStatus
  origin: EvolutionOrigin
  changes: EvolutionChange[]
  /** Target files for not-yet-developed suggestions. */
  target_files: string[]
  lint_output: string | null
  error: string | null
  created_at: string
  updated_at: string
  applied_at: string | null
}

export interface EvolutionListResponse {
  proposals: EvolutionProposal[]
  stats: { pending: number; applied: number; rolled_back: number; total: number }
  openclaw: OpenClawStatus
  auto: { suggest_interval_hours: number; next_run_at: string | null }
}

export interface EvolutionScanResponse {
  ok: boolean
  issues: { source: 'lint' | 'devlog'; detail: string }[]
  proposal: EvolutionProposal | null
  message: string
}

export interface EvolutionSuggestResponse {
  ok: boolean
  proposals: EvolutionProposal[]
  message: string
}

export interface EvolutionActionResult {
  ok: boolean
  proposal: EvolutionProposal | null
  message: string
}

/** OpenClaw watchtower state — tracks upstream releases, auto-updates the digest. */
export interface OpenClawStatus {
  tracked: boolean
  latest_version: string | null
  published_at: string | null
  head_summary: string | null
  checked_at: string | null
  last_sync_at: string | null
  last_changed_at: string | null
  digest_files: string[]
  history_count: number
  auto_update: boolean
  upstream_url: string
  note: string
}

// ---- v4 heartbeat + watchlist (proactive freshness) ----

/** A proactive alert waiting to land in the chat (⏰ reminder, 📦 release, system). */
export interface AlertInfo {
  id: string
  kind: 'reminder' | 'release' | 'system'
  title: string
  body: string
  status: 'pending' | 'delivered'
  meta: Record<string, unknown>
  conversation_id: string | null
  created_at: string
  delivered_at: string | null
}

export interface AlertsResponse {
  pending: AlertInfo[]
  recent: AlertInfo[]
  heartbeat: HeartbeatStatus
}

/** One repo MIST watches so it never builds on rusty stuff. */
export interface WatchlistEntry {
  repo: string // e.g. "openclaw/openclaw"
  channel: 'npm' | 'atom' // npm registry | GitHub commits atom feed
  label: string
  version: string | null // npm version or commit sha
  version_label: string | null // human-readable (commit title for atom)
  updated_at: string | null // upstream publish/commit time
  first_seen: boolean // true until the baseline is established (silent)
  checked_at: string | null
  changed: boolean // version moved since last check
  last_change_at: string | null
  error: string | null
  note: string
}

export interface WatchlistStatus {
  entries: WatchlistEntry[]
  last_sweep_at: string | null
  next_sweep_at: string | null
  sweep_interval_hours: number
  auto_update: boolean
  alerts_raised: number
}

export interface HeartbeatStatus {
  beating: boolean
  interval_s: number
  last_beat_at: string | null
  reminders_fired: number
  pending_alerts: number
  note: string
}
