# Task ID: oj-spine-1 — OpenJarvis core spine port

Agent: oj-spine-1 (full-stack-developer)
Scope: port OpenJarvis's core "spine" into M.I.S.T. — event bus, trace store,
complexity router, loop guards, error taxonomy, guardrails + instrumentation of
the LLM cascade / tool executor / mission loop + 3 API routes.

## Files created (all mine, under src/lib/oj/ + api routes)
- `src/lib/oj/event-bus.ts` — typed pub/sub (port of core/events.py): 11 event
  types (trace_started/step/completed, tool_call/result, llm_call/result,
  guardrail_trip, approval_requested, loop_guard_trip, complexity_routed),
  emit/once/on/off/onAny, globalThis singleton, every subscriber isolated in
  try/catch.
- `src/lib/oj/complexity.ts` — 0-1 complexity scorer (port of
  learning/routing/complexity.py, weights verbatim: length .20, domain .25,
  reasoning .25, multi-part .15, creative .15) → M.I.S.T. tiers
  instant<0.25 / standard<0.55 / deep<0.8 / research≥0.8 (OpenJarvis aliases
  trivial..very_complex exported too) → token budgets 1024-16384 (×2 thinking
  models) + lane recommendation + `complexityPolicyNote()` for UI explanations
  + routeQuery() emitting complexity_routed.
- `src/lib/oj/error-taxonomy.ts` — 10 categories (auth, rate_limit, network,
  timeout, context_length, parse, tool_error, upstream, guardrail, unknown) +
  retry policy per category (retry/backoff/escalate/fail) + exponential
  backoff min(10·2^n,300) + user-facing messages in the house voice (warm,
  one concrete next step, no lectures — BRIDGE_OFFLINE_PAYLOAD tone).
  Context-length fails fast, fatal patterns checked before retryable (port of
  agents/errors.py ordering).
- `src/lib/oj/guardrails.ts` — SSRF guard (port of security/ssrf.py: blocked
  metadata hosts, v4/v6 private ranges incl. IPv4-mapped, disguised IPv4
  decimal/hex/octal/short-dotted with inet_aton semantics, DNS-resolve check
  of every address, fail-closed on unresolvable); checkCapability() tiered
  action gate reading PermissionMemory + pending Approvals (read-only,
  approval-service owns the queue); scanToolResult() injection heuristics
  (10 patterns ported from injection_scanner.py) + wrapUntrusted().
- `src/lib/oj/loop-guard.ts` — createLoopGuard(tier, tuning) (port of
  agents/loop_guard.py): SHA-256 identical-call tracking (max 3), similar-args
  repeat (Jaccard ≥0.8), ping-pong period-2/3 detection, per-tool poll budget
  (5), tier-derived maxTurns/wallClockMs/tokenBudget (instant 6/60s/4k →
  research 40/30min/512k), warn-before-block, loop_guard_trip events.
- `src/lib/oj/trace-service.ts` — trace store (port of traces/store.py +
  collector.py + analyzer.py): async startTrace → Trace row (outcome=running)
  → TraceHandle.addStep (JSON-serialized, 4KB truncated input/output) /
  complete (outcome, tokens, latency, costUsd, honest attribution);
  AsyncLocalStorage ambient scope so executeTool/cascadeComplete inside a
  scope auto-attach (never two traces per logical run); listTraces/getTrace/
  efficiencyAnalytics (totals + perProvider + perAgent + perDay) with honest
  chars/4 token estimates (marked in meta.tokenBasis) + documented per-provider
  price table (core + keyless lanes = $0); reapStaleTraces() for restarts.
  Every path self-guarded — a trace failure NEVER breaks a completion.

## Files edited (surgical, additive)
- `src/lib/services/tools-service.ts`:
  1. **BaseToolDef exported as a type** (FIRST PRIORITY — unblocked
     knowledge-tools.ts + ops-tools.ts imports).
  2. executeTool is now an instrumented wrapper around the untouched
     executeToolCore: tool_call/tool_result bus events, ambient-trace steps,
     SSRF guard on every http(s) arg (open_url carved out — creator's own
     desktop browser, their LAN is their machine), injection scan on outputs
     (high/critical → string wrapped UNTRUSTED / object gets _untrusted_content
     key), error taxonomy mapping (unknown-tool errors stay VERBATIM for the
     mission capability-gap detector), + errorCategory field on results.
- `src/lib/services/llm-service.ts`:
  1. unified() → wrapper: scores complexity, opens chat/voice trace, runs the
     untouched core inside runWithTrace, completes with success | degraded
     (offline-mind served) + honest attribution. Never throws differently.
  2. cascadeComplete() → wrapper: standalone calls get their own mission
     trace; calls inside an ambient trace attach to it. Cascade order and all
     exports unchanged. Core loop instrumented: per-attempt noteLlmCall +
     appendGenerateStep (provider, model, ok, duration, estimated tokens,
     attempt idx, errorCategory).
  3. callWithCascade in the chat loop instrumented the same way.
- `src/lib/services/mission-service.ts`:
  1. runMission wraps each mission RUN in a trace (agent='mission', complexity
     of the goal) and completes it with the honest final status mapping
     (done/partial→success, failed/stuck/crash→failure, paused/cancelled/
     awaiting_creator→degraded).
  2. actLoop: tier-aware loop guard created from the goal's complexity with
     maxTurns riding the mission's own step budget (never pre-empts a
     creator-set budget); hard-stop verdicts (max_turns/wall_clock/token_budget)
     → existing 'budget' path; teaching verdicts → system step; warnings →
     next cycle's advisories.

## Routes (frozen contracts, verified via curl)
- `GET /api/mist/traces?agent=&outcome=&limit=` → `{traces:[{id, query, agent,
  model, provider, outcome, tier, complexity, tokensIn, tokensOut, latencyMs,
  steps, createdAt}]}` — default limit 50, cap 500; reaps >1h-stale running
  traces. VERIFIED: real chat + mission traces returned, filters work.
- `GET /api/mist/traces/[id]` → `{trace:{...full, steps:[{idx, type, name, ok,
  durationMs, tokens, input, output}]}}` — VERIFIED: real trace with 3 generate
  steps showing lane attempts (nvidia 503→network, openrouter 429→rate_limit,
  kilo success with model attribution); 404 on unknown id.
- `GET /api/mist/analytics/efficiency` → `{totals:{requests, tokensIn,
  tokensOut, avgLatencyMs, costUsd}, perProvider:[...], perAgent:[...],
  perDay:[{day, requests, tokens}]}` — VERIFIED with 2 real traces; cost table
  documented in comments (core/keyless lanes $0, keyed lanes estimated at
  public list prices for their model class).

## Verified end-to-end (curl against the live dev server)
- Chat turn "what is 2+2?" → tier=instant, complexity=0.06, 9 steps, outcome
  success, provider nvidia, calculate tool step recorded.
- Mission run (her self-repair mission) → tier=deep, complexity=0.725, 3
  generate steps with honest failure categories, outcome success via kilo.
- SSRF: 169.254.169.254 (metadata), 192.168.1.1 (private), 2130706433
  (decimal-disguised), 127.1 (short-dotted), localhost (DNS-resolved ::1) all
  BLOCKED with honest guardrail messages; https://example.com passes.
- Injection: file with "ignore all previous instructions" + exfiltration URL →
  read_file output preserved but flagged `_untrusted_content` (prompt_override/
  high, exfiltration/high).
- `bunx tsc --noEmit` → 0 errors; `bun run lint` → 0 errors.

## Notes for other agents
- Import `BaseToolDef` from `@/lib/services/tools-service` (type-only import).
- Ambient traces: any code running inside `runWithTrace(trace, fn)` gets its
  executeTool/cascadeComplete steps auto-recorded — no plumbing needed.
- Bus: `import { bus } from '@/lib/oj/event-bus'` then
  `bus.emit('approval_requested', {...})` etc. — never throws.
- If Turbopack serves a stale module after a mid-flight export fix, append a
  real content change (a comment) to force re-read — `touch` alone is not
  enough (observed live).
