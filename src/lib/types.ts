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

/**
 * The visual identity of the consciousness stage (v7). 'orb' is Mist's own
 * neural core; the others are the adapted ai-visualizer canvas faces served
 * from /av/faces/* and fed live voice state through window.__mistBus.
 */
export type ConsciousnessFace = 'orb' | 'board' | 'radial' | 'rain' | 'neural' | 'visage'

export type ProviderId =
  | 'auto'
  | 'omniroute'
  | 'hermes'
  | 'theoldapi'
  | 'openai_compatible'
  | 'nvidia'
  | 'openrouter'
  | 'qwen'
  | 'groq'
  | 'github_models'
  | 'cerebras'
  | 'together'
  | 'mistral'
  | 'huggingface'
  | 'anthropic'
  | 'gemini'
  | 'kilo'
  | 'pollinations'
  | 'llm7'
  | 'ovh'
  | 'core'
  | 'offline-mind'
  | 'mist-instant' // w3: instant fast-path (canned smalltalk / cached reply / direct status) — zero cascade

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
  | 'vault'

export type UnifiedMode =
  | 'consciousness'
  | 'chat'
  | 'studio'
  | 'vision'
  | 'swarm'
  | 'memory_query'
  | 'voice'

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
  type: 'string' | 'number' | 'boolean' | 'array'
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
  /** Available TTS engines: 'glm' (cloud) + 'edge'/'gtranslate' (no-auth English). */
  engines?: string[]
  /** No-auth English voice catalog for the settings picker. */
  free_voices?: import('./services/tts-free').FreeVoiceInfo[]
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

/** Which serving lane the Nous/Hermes provider is pointed at. */
export type NousLane = 'nous-portal' | 'hermes-gateway' | 'local' | 'custom'

/** Nous Research / Hermes provider catalog + selection + live endpoint-reported models. */
export interface NousModelsInfo {
  configured: boolean
  base_url: string
  keyless_local: boolean
  /** Which lane the current base URL resolves to. */
  lane: NousLane
  text: CoreModelOption[]
  vision: CoreModelOption[]
  /** 'auto' | model id */
  selected: { text: string; vision: string }
  /** What the endpoint actually reported on the last nous call of each kind. */
  live: { text: string | null; vision: string | null }
}

/** One researched unlimited/top-model access lane, with live status. */
export interface FreeLaneInfo {
  id: string
  label: string
  /** subscription | free-tier | credits | local | gateway | keyless */
  kind: 'subscription' | 'free-tier' | 'credits' | 'local' | 'gateway' | 'keyless'
  /** ProviderId when the lane is wired into the cascade, else null. */
  provider: ProviderId | null
  baseUrl: string | null
  keyEnv: string | null
  modelEnv: string | null
  defaultModel: string
  pricing: string
  limits: string
  signupUrl: string | null
  /** True when the lane works with zero configuration (local runtime). */
  outOfBox: boolean
  /** active (key set / local up) | ready (needs key) | custom (user gateway) */
  status: 'active' | 'ready' | 'custom'
  models?: string[]
  notes: string
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
  nous_models?: NousModelsInfo
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
  thinking?: boolean
  /** w3 activity spine: when true the route answers NDJSON — one
   * {type:'activity'} line per thing she is doing, then {type:'result'}.
   * Opt-in so every existing JSON caller keeps its contract. */
  stream?: boolean
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
  /** True when the final text is a salvaged REASONING TRACE (content:null,
   *  reasoning_content non-empty — the reasoning model spent its whole budget
   *  thinking). The voice session refuses to speak raw thinking aloud and
   *  says a graceful line instead. (Drill #6b: "never speak gibberish".) */
  salvaged?: boolean
  /** w3 fast-path: set when the answer came from the instant layer
   * (canned smalltalk, cached reply, or direct system snapshot) — zero
   * cascade, zero tokens. Honest attribution for the UI chip. */
  fast_path?: { kind: 'smalltalk' | 'status' | 'cached'; saved_ms: number }
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

// ---------- v5 autonomy structures (Hermes absorption) ----------

/** Async deep-research job (POST /research → poll GET /research/:id). */
export interface ResearchJob {
  id: string
  query: string
  depth: number
  status: 'running' | 'done' | 'error'
  phase: string | null
  phaseIndex: number
  phases: Array<{ name: string; status: 'pending' | 'active' | 'done' | 'error' }>
  queries: string[]
  sources: Array<{
    title: string
    url: string
    host: string
    credibility: 'high' | 'medium' | 'low'
    read: boolean
  }>
  pagesRead: number
  startedAt: string
  elapsedMs: number
  report?: string
  citations?: Citation[]
  suggestions?: string[]
  savedTo?: string
  error?: string
}

export interface ResearchJobSummary {
  id: string
  query: string
  depth: number
  status: string
  phase: string | null
  startedAt: string
  elapsedMs: number
  sourcesFound: number
  pagesRead: number
  error?: string
}

export type CronJobKind = 'cron' | 'fixed_rate' | 'one_time'

export interface CronJobRow {
  id: string
  name: string
  prompt: string
  kind: CronJobKind
  expr: string
  intervalMin: number
  runAt: string | null
  timezone: string
  delivery: 'alert' | 'silent'
  enabled: boolean
  lastRunAt: string | null
  nextRunAt: string | null
  lastStatus: string | null
  lastResult: string
  runCount: number
  origin: 'user' | 'auto'
  createdAt: string
  updatedAt: string
}

export interface AutonomyEventRow {
  id: string
  type: string
  summary: string
  meta: string
  createdAt: string
}

export interface AutonomyStats {
  total: number
  last24h: number
  byType: Record<string, number>
  lastEventAt: string | null
}

export interface TrendItem {
  title: string
  summary: string
  source: string
  url: string
  relevance: 'high' | 'medium' | 'low'
  actionable?: string
}

export interface TrendDigest {
  generatedAt: string
  headline: string
  items: TrendItem[]
  watchlist: Array<{ topic: string; note: string }>
}

export interface UpgradeProposalLite {
  title: string
  kind: string
  rationale: string
  target: string
}

export interface SelfUpgradeResult {
  digest: TrendDigest
  proposals: UpgradeProposalLite[]
  skillsProposed: string[]
  summary: string
}

export interface VaultStatus {
  connected: boolean
  vaultPath: string | null
  noteCount: number
  folderCount: number
  tagCount: number
  linkCount: number
  orphanCount: number
  lastScanAt?: string
  demo?: boolean
}

export interface VaultNoteMeta {
  path: string
  title: string
  mtime: string
  size: number
  tags: string[]
  links: number
}

export interface VaultNote extends VaultNoteMeta {
  frontmatter: Record<string, string>
  content: string
  outgoingLinks: string[]
  backlinks: string[]
}

export interface VaultTag {
  tag: string
  count: number
  notes: string[]
}

export interface VaultGraph {
  nodes: Array<{ id: string; title: string; degree: number }>
  edges: Array<{ source: string; target: string }>
  orphans: string[]
  hubs: string[]
}

export interface VaultQueryResult {
  kind: string
  rows: Array<Record<string, string>>
  explanation: string
}

export interface LearningStatus {
  autoSkills: number
  lastCuration: string | null
  lastUserModel: string | null
  userModelPreview: string
  learningActive: boolean
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
  origin?: 'user' | 'auto' | string
  version?: number
  confidence?: number
}

export interface SkillExecution {
  id: string
  skill_name: string
  input: string | null
  output: Record<string, unknown>
  timestamp: string
  success: boolean
  error: string | null
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

// ---------- v6 local bridge (Mist Bridge — owner-side system control) ----------

/** Live state of the user's Mist Bridge daemon (db/bridge/mist-bridge.js). */
export interface BridgeStatus {
  connected: boolean
  url: string
  version?: string
  platform?: string
  hostname?: string
  checkedAt: number
}

/** Result of one bridge action; bridgeConnected distinguishes daemon-down from action failure. */
export interface BridgeExecResult {
  ok: boolean
  data?: unknown
  error?: string
  bridgeConnected: boolean
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

/**
 * w5 voice-speed — one incremental piece of her reply, streamed WHILE the
 * model still generates (socket event `consciousness_chunk`, emitted by the
 * neural service from the unified route's NDJSON `{"type":"chunk"}` lines).
 * The text is already envelope-filtered server-side: it is clean prose —
 * never raw `{"reply":` JSON, never tool-call routing, never citations
 * metadata. Consumers append `text` to their turn buffer; the turn ends with
 * the regular ConsciousnessResponseMsg (which carries the canonical full
 * text + provider/tools meta). Chunks may never arrive (non-streaming lane,
 * tool turns, fast-path) — consumers must treat streaming as an
 * ACCELERATOR, never a requirement.
 */
export interface ConsciousnessChunkMsg {
  type: 'consciousness_chunk'
  text: string
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
  /** Newest-first catch-up list for the notification bell (≤40). */
  history: AlertInfo[]
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

// v6 sub-agents — specialized workers under MIST's command
export interface SubAgent {
  id: string
  name: string
  role: string
  description: string
  systemPrompt: string
  status: 'active' | 'paused'
  runCount: number
  lastRunAt: string | null
  createdAt: string
  updatedAt: string
  runs?: AgentRun[]
}

export interface AgentRun {
  id: string
  agentId: string
  goal: string
  status: 'queued' | 'running' | 'done' | 'failed'
  result: string
  log: string
  toolsUsed: string
  triggeredBy: 'user' | 'mist' | 'scheduler'
  error: string | null
  startedAt: string | null
  finishedAt: string | null
  durationMs: number
  createdAt: string
  agent?: SubAgent
}
