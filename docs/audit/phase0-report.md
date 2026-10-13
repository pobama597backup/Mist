# Phase 0 — Verify + baseline (Sovereign Hardening Mandate)

Date: 2026-10-10 · Repo: `pobama597backup/Mist` · Branch: `hardening/phase-1` (created at end of phase)
Evidence: all `path:line` below opened this session (lead + 4 Explore agents phase0-a/b/c/d). Baseline machine-measured: `docs/baseline-2026-10-10.json`.

## 1. Citation drift table (mandate ground-truth vs code)

| Citation | Actual | Verdict |
|---|---|---|
| bridge ACAO `*` at mist-bridge.js:4042 | :4042 exact | CONFIRMED |
| bridge `/exec` ~:3341 `exec(string)` no token | run_command exec at :3347; `/exec` route at :4149; **no auth on any endpoint**; HOST=127.0.0.1:115; readBody ignores Content-Type (:4084) → simple-request CSRF works despite loopback | CONFIRMED (route at :4149) |
| tools-service:3733 checkCapability never called | executeTool at :3592; checkCapability def guardrails.ts:237, alias :271 — **zero call sites**; route trusts `body.confirmed` (tools/execute/route.ts:24) | CONFIRMED (line drift) |
| guardrails:150 SSRF disguised-IPv4 + post-DNS | :150 + :179-208, fail-closed on DNS | CONFIRMED |
| guardrails:237/:271 = project-tree/markdown guards | both are the dead capability gate; those guards live in tools-service :959-979 + markdown-message.tsx | REFUTED (misattributed, guards exist elsewhere) |
| llm/unified ignores req.signal | route.ts:88,:118-125; unified() takes no signal; comment :72 admits it. (synapse/stream DOES use req.signal — the pattern to copy) | CONFIRMED |
| google route returns raw key | google/route.ts:18-24 GET only | CONFIRMED |
| export tars .env+db | export/route.ts:26,48-76,97-103 — also ships **db/provider-keys.json + db/backups/** (worse than claimed) | CONFIRMED+ |
| recover TEMPORARY | recover/route.ts:1 — unauth PID-kill + respawn; **zero callers repo-wide** (safe to delete) | CONFIRMED |
| store.ts:376 setAudioEnergy@120ms | :376-377; fired at voice-stage:116-120 + chat-panel:1085-1089, each tick also emits a socket message | CONFIRMED |
| status-bar:19,27 full tool list for count | :19 whole `s.neural` slice; :26-33 full list fetch → `.length` (payload measured **67,481 bytes**) | CONFIRMED |
| browser-pilot:95,125 | :95-98 `--no-sandbox` shared browser; :125 shared page; CORS `*` :45-49; URL check = scheme-only :236-251; binds all interfaces :516 | CONFIRMED |
| neural:401 `thought`→LLM→tools | handler at **:418** (401=dormTimer); any socket → unified() w/ tools | CONFIRMED (drift) |
| neural:713-719 `relay_offer` hijack | :713-715 = SIGINT handler; **`relay_offer` does not exist anywhere** — real exposure: unauth `thought`/`set_provider`/`voice_chunk` on cors-`*` 0.0.0.0:3003 socket | **REFUTED** (mechanism; socket exposure confirmed) |
| llm-service ~2870 upsertFact no provenance | :2804-2818 (call :2813), trust 'auto', then vector-indexed; also tools-service:1776 | CONFIRMED (drift ~57) |
| scheduler:960 cron unified() full tools | :959-963 exact | CONFIRMED |
| context-builder 225-432, 12 awaits, 1 Promise.all | buildContext spans :207-413; 10-12 sequential awaits, 1 Promise.all (:327) | CONFIRMED (range drift) |
| db.ts log:['query'] | :10 (and it floods dev.log + every script) | CONFIRMED |
| SOUL.md "NEVER refuse/authorized" | SOUL.md:3 "authorizes everything"; "NEVER refuse" lives in **context-builder:33** + :378 + tools-service:3093 | CONFIRMED (split location) |
| "100 BASE_TOOLS" | **116** BASE_TOOLS; **143 live** (incl. 9 omni + 18 skill:*) | DRIFT |
| "83 /api/mist routes" | **82** under /api/mist + 1 scaffold `/api` root = 83 total files | CONFIRMED |
| "21 runtime db/skills/*.md" | **18** | DRIFT |
| "12KB tool list, 4.1k tokens" | 67.5KB payload, **13,799 tokens** full block | DRIFT (worse) |
| "~24k chars context" | **62,506 chars ≈ 15,627 tokens**; TOOLS block 38,122c | DRIFT (worse) |

## 2. Defect register verdicts

- **S1 CONFIRMED** (bridge RCE via browser drive-by). **S2 CONFIRMED** (0/83 routes auth; binds 0.0.0.0:3003/:3004, *:3030, *:3000; only bridge is loopback). **S3 CONFIRMED+** (also ships provider-keys.json; unauth github save-token/sync; recover). **S4 CONFIRMED** (dead gate). **S5 CONFIRMED** (persona authority + fail-open scanner :3716 + SSRF guard ALSO fail-open :3657-3660). **S6 CONFIRMED** (env POST unauth → arbitrary key writes incl. BASE_URLs; `set_url` lives in **app route** bridge/route.ts:48-71, not the daemon). **S7 CONFIRMED** (pilot). **S8 CONFIRMED** (`src/` in ALLOWED_PREFIXES evolution-service:45; PROTECTED_PATHS doesn't exist; lint gate is tsc-only; OOM-degrade keeps commits :2004-2016). **S9 CONFIRMED-CRITICAL** (gitignore misses all five; **151 tracked db/ files incl. custom.db + provider-keys.json — secrets in history**). **S10 PARTIAL/REFUTED** (relay_offer absent; unauth socket path real). **S11 CONFIRMED** (provenance-less fact writes + cron full-tools + persona every turn). **S12 CONFIRMED** (no CSP anywhere; side-effecting GET: welcome; unsandboxed iframes in-app). **S13 PARTIAL** (clipboard/screenshot are stubs; owner_files/Obsidian/browser_screenshot/system_watch DO ship to cloud+keyless lanes unredacted, 6000c truncation only, llm-service:2765-2771). **S14 CONFIRMED** (voice → same trust path, no speaker verification). **S15 CONFIRMED** (12 dead deps verified by harness; no audit gate).
- R1 CONFIRMED · R2 CONFIRMED (synapse/stream synthetic :10-31; neural_load theater neural-service:340-366; boot `[ OK ]` static markup app-shell:62-113) · R3 (residue: `/api` scaffold route, oj-verify2.ts, postmortem.txt, tool-results/, examples/ — sandbox-scoped) · R4 PARTIAL (rescan throttled 60s but listSkills runs per turn, no cache) · R5 CONFIRMED (watchlist→npmjs/github every 6h, oj-sync, evolution suggest, scheduler unified — all armed via health route) · R7 CONFIRMED (2 edge-case interval leaks: chat-panel:1085, voice-stage:116; 3-4× duplicated health pollers) · R8 (stream races: route comment admits client-gone-continues) · R9 CONFIRMED (zero PRAGMAs, zero VACUUM/backup in code) · R10 CONFIRMED (LLM_TIMEOUT 30s/150s, no TTFT deadline) · R11 CONFIRMED (950ms/1.3s pulses + per-mount pollers) · R12 CONFIRMED (dead routes: data-boundary, mesh, /api root, recover; HTML-500s: google, voice/status, voice/local/status, tools/categories, research/[id], cron/[id]/run).
- P1 CONFIRMED (0 dynamic/lazy — zero code splitting; dev first-load proxy 13.1MB raw/1.89MB gz, prod TBD on PC) · P2 CONFIRMED (13.8K tokens/turn) · P3 CONFIRMED · P4 (canvas per-frame getBoundingClientRect neural-core:864; gradient/shadow in tick) · P5 CONFIRMED (MemoryQueue + VectorMemory **no indexes**; VectorMemory full scan every turn vector-service:86; retention only SpokenCache) · P6 CONFIRMED (lexical `[a-z0-9]`) · P7 CONFIRMED · P8 = R10 · P9 CONFIRMED (67KB for a count) · P10 UNVERIFIED (needs live mic) · P11 CONFIRMED (dual rAF always-on + timers) · P12 partial-measured (41 safe GETs: agg p50 6ms/p95 9ms dev-warm; slowest missions 165ms) · P13 CONFIRMED (55 'use client' files eager; heavy services imported at boot).

## 3. New findings (not in the mandate)

1. **Unauth bridge action proxy chain**: `POST /api/mist/bridge` (:74-80) relays ANY bridge action incl. run_command/write_file/delete_file + unauth `set_url` (:48-71) = full RCE relay without needing direct :8734 access. **Worse than S1 alone.**
2. Export ships `db/provider-keys.json` (all live provider keys) + `db/backups/`.
3. Unauth `POST /api/mist/github` save-token writes a PAT to disk; `sync` pushes the repo.
4. `mist_self_write`/`oj_sync_apply`/`deep_selfcheck(repair)` auto-apply source edits with zero human approval (only `mist_self_patch` is owner-gated).
5. `record_decision` = model-asserted creator approval + `always_approve` persistence.
6. `schedule_task` creates unattended cron with no write flag (inconsistent with cron_create).
7. `llm/unified` writes on the reply path (FastReply upserts route:144/167) — every turn is a DB write.
8. **hub.tsx is dead code** (zero importers — whole alternative layout, incl. 2 of the 5 `100vh` uses).
9. shadcn `<Toaster/>` in layout is dead weight (app is 100% sonner; use-toast has zero real users).
10. useWakeWord arms the mic during the boot animation (before first paint).
11. Face iframes (neural/rain/radial/board) lack visibilitychange pause (only visage has it).
12. Boot `[ OK ]` lines claim "tool registry 21+" — stale even as theater (143 tools).

## 4. Frontend audit (phase0-c)

Hot path: `page.tsx → app-shell → {VoiceStage → NeuralCore(canvas) | FaceStage(iframe)}` on consciousness view; ChatView → {ThreadsSidebar, ChatPanel} on chat view. 55/55 mist files `'use client'`; **0 dynamic/lazy**. One socket singleton + 3-4 duplicated health pollers + ~8 boot fetches.

Store: 1 OVER-SUBSCRIBED (`status-bar.tsx:19` whole `s.neural` — re-renders every 120ms energy tick + 950ms pulse). All other 130+ subscriptions atomic/stable. chat-panel has 20 useEffects (all individually cleaned; 2 edge-case interval leaks on mid-recording unmount).

Timer/listener ledger: 24 client interval sites — 21 CLEANUP, 2 edge-case NO CLEANUP (energy intervals), 1 intentional singleton heartbeat. All 28 listeners cleaned. All object URLs/Audio tracked + revoked (speech.ts:288-304). Canvas guards: neural-core (rAF cancel :287-291 + visibility :292-299 + reduced-motion :868) and starfield (:132-151) both guarded; floating-orb is pure CSS.

UI cost: **797** text-[9-11px] (top: settings-view 94, evolution-tab 62, self-view 60) · 26 direct + 156 glass = ~182 blur surfaces · 5×100vh · **0** safe-area · 0 dvh.

## 5. Origin map (23 call sites — the A1 wiring list)

executeTool ×4: llm-service:2761 (funnel for chat/voice/welcome/cron/teacher — indistinguishable today), mission-service:1598 (Mission.origin exists but never passed), introspection-service:365 (heartbeat), tools/execute/route.ts:24 (HTTP, unauth).
bridgeExec ×19: heartbeat:328,427 · bg-tasks:172 · tools-service:422 (all bridge tools), :1087 (owner_files) · hermes route:38 · bridge route:79 (action proxy) · bridge/signal:79 · companions:28,68,78 · voice/local engines:39,53,55,68,88 · transcribe:26 · status:14 · tts:39.
**No bypass paths** (no runTool/dispatch/callTool; executeOmniTool/executeSkillTool only called inside tools-service). Approval spine toothless — see tools-risk.md §Gates.

## 6. Prisma map

26 models · 20 @@index · 11 @@unique. **Un-indexed hot queries**: VectorMemory (findMany orderBy createdAt take 500 — **full scan+sort every chat turn**), MemoryQueue (reminder due-check every 60s), Message/Trace createdAt-only filters (dream/learning/trace). **Zero PRAGMAs** (no WAL/busy_timeout/foreign_keys via $queryRaw). Retention: only SpokenCache (cap 400). Zero VACUUM/backup logic in code.

## 7. Runtime db/skills triage (18 files; deep audit is Phase 7)

- **KEEP**: hermes-operator (her command protocol), research-first (research ritual), agent-skills-integration, pdf-extract (UNVERIFIED content), system-health-check (UNVERIFIED).
- **MERGE**: adaptive-model-selector + optimal-model-selector (duplicates) · generate-self-review-report + self-review-report (duplicates) · read-package-version + get-latest-version (version-check family).
- **ARCHIVE (test-generated/trivial — read this session)**: exec-proof ("reply with the exact phrase: ledger proven"), quick-math (5-line calculate wrapper), security-threat-monitor (**claims capabilities she doesn't have** — actively misleading), system-status-with-weather (trivial 2-tool chain), gpt6-luna-evaluator, count-images-downloads, research-ai-agents (superseded by research-first).

## 8. Baseline (machine-measured, docs/baseline-2026-10-10.json)

tsc **0 errors** (14s) · tests **0** · tools 143 live (13,799-token block) · buildContext p50 **78ms**/p95 222ms, prompt **62,506c ≈ 15,627 tokens** · tools/list payload **67.5KB** · routes: 41 safe GETs agg p50 6ms/p95 9ms (dev-warm; slowest missions 165ms) · dev first-load JS 13.1MB raw/1.89MB gz (dev-mode proxy — prod TBD on PC, ADR-0001) · UI 797 micro-type · dead deps 12 (+sharp keep) · **151 tracked db/ files incl. custom.db + provider-keys.json** · idle: next-server 0.43% CPU, **0 non-loopback established conns** in 60s · binds: 0.0.0.0:3003/:3004, *:3030/*:3000, 127.0.0.1:8734 · local models: none (candor corpus UNVERIFIED) · Prisma query-log floods dev.log (S9).

## 9. Mandate review — "this prompt might break some things" (read before Phase 1)

**Sandbox-critical (would break the owner's preview):**
1. **Caddyfile is platform infrastructure here** — "move Caddy XTransformPort to ops/sandbox/" applies to the PC package ONLY; never touch the live Caddyfile (ADR-0002).
2. **Host allowlist → 421 must be same-origin-dynamic, not a static list** — preview arrives via the :81 gateway with an external Host; hardcoding localhost blocks the owner. `MIST_STRICT_HOST=1` opt-in for PC.
3. **socket.io `allowRequest` + cors must reflect same-origin** (gateway Origin ≠ localhost) — else sockets die in preview.
4. **CSP `connect-src 'self'` + loopback entries** — gateway-proxied ws/fetch are same-origin; explicit `ws://127.0.0.1:3003` etc. needed only for PC-direct mode.
5. **POST Content-Type 415 rule**: audit every client fetch first (mist-api.ts sends JSON; raw fetches in components must be checked) before enforcing.
6. **welcome GET→POST** must change route + welcome-client.ts in one commit.
7. **Bridge Bearer token**: graceful degradation when absent (honest 401 + setup hint, no crashes); run.bat prints it on PC.
8. **Deny-until-Arbiter** for shell/write/delete/ui_automate will surface in Hermes console + tools tab — honest denial copy, not 500s.
9. **mesh /mcp token**: /api/mist/mesh is a dead route (no callers) — safe; mesh-service (:3004) takes the token.
10. **S9 `git rm --cached`** removes from index only; **history still contains secrets** — history rewrite is an owner decision (backlogged, not silently done).
11. **reactStrictMode:true** stays deferred to Phase 3 (20 chat-panel effects — mandate already sequences it); `ignoreBuildErrors` removal is safe now (tsc=0).
12. **Phase 8 `git mv skills/`**: skills/ is the Z.ai platform's live sandbox in THIS environment — moving it may break host tooling. Archive via manifest on PC; **do not move skills/ in this sandbox** (verify platform impact first).
13. Rate-limit buckets must exempt/SSE-stream TTS + LLM streaming paths (generous defaults, flag-tunable).

**Mandate drift corrections adopted**: 116 BASE tools (not 100) · tool block 13.8K tokens (not 4.1K) · S10 mechanism replaced by unauth-socket finding · S6 set_url is in the app route · 18 runtime skills (not 21) · `checkCapability` guardrails:237/:271 (not 3733).

## 10. Queued (Phase 1 order, tests-first)

S1 S2 S3 S6 S9 S10 S12 per mandate Phase 1 items 1-7; ADR-0002 constraints honored throughout. Backlog noticed: R2 fake boot numbers, dead `/api` root route, dead hub.tsx, Toaster dup, OOM-degrade evolution commit, FastReply write-per-turn, per-frame getBoundingClientRect.
