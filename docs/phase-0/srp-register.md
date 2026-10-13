# Phase 0 — D9 defect register: confirm / refute / drift + new findings

Verdicts cite lines opened this session. Drift = code moved since snapshot `a50825e` (HEAD `22f2813`, waves w3–w8).

## S (security)
| ID | Verdict | Evidence |
|---|---|---|
| S1 Bridge RCE | ✅ CONFIRMED (core) | ACAO `*` :4042 · `/exec` no auth :4149 · `exec(string)` :3345 · `/bin/sh -c` :1042. **Drift+: bridge binds 127.0.0.1 ONLY :115** — remote exposure nil, but any local web page can POST (no Origin check, no token) |
| S2 No auth / binds / cors | ✅ CONFIRMED | `ss`: 3003+3004 on 0.0.0.0, 3030+3000 on `*`; neural cors `origin:'*'` (:384); 82 routes unauthenticated; mesh `/mcp` tools/call open |
| S3 Export/env/google/recover | ✅ CONFIRMED | google GET returns raw key :21 · export INCLUDE_DIRS=['db',…] + portable .env, no secret-strip · recover "TEMPORARY…DELETE" :1 |
| S4 checkCapability never called | ✅ CONFIRMED | `isActionAllowed` zero callers; `confirmed` client-asserted (tools/execute:24) |
| S5 Persona authority + scanner wraps only high | ✅ CONFIRMED | context-builder :33 "You NEVER refuse", :378 "you are authorized" · wrap threshold `high‖critical` (tools-service:3689) |
| S5b Taint keystone | ✅ CONFIRMED ABSENT | no taint concept anywhere (rg taint → none). Phase 2 builds it |
| S6 env writes unauth | ✅ CONFIRMED | config/env POST takes `body.confirmed` (client-asserted); `*_BASE_URL` writable |
| S7 browser-pilot | ✅ CONFIRMED | `--no-sandbox` :97; shared module-global context :125; binds `*` |
| S8 Evolution can edit src/ | ✅ CONFIRMED | `ALLOWED_PREFIXES=['src/','mini-services/','db/skills/','db/notes/']` evolution-service:45; BLOCKED_EXACT misses prisma/, bridge, Arbiter-to-be |
| S9 db hygiene | ✅ CONFIRMED | `log:['query']` db.ts; `db:push --accept-data-loss` in package.json:10; journal_mode=delete measured live |
| S10 relay_offer socket hijack | ❌ REFUTED at HEAD | `relay_offer` absent from entire codebase (rg → 0). Neural :713 is now `httpServer.listen('0.0.0.0')`. Keep a regression test anyway when relay-class features return |
| S11 Persistence poisoning | ✅ CONFIRMED | auto `upsertFact` no provenance :2813 · cron → unified() unattended :961 · persona `db/persona/*.md` injected every turn · skills lack trust fields |
| S12 No CSP/headers | ✅ CONFIRMED | next.config.ts: zero `headers()`, `ignoreBuildErrors:true`, `reactStrictMode:false` |
| S13 sensitive-read to cloud | ✅ CONFIRMED (arch) | no redaction anywhere (rg redact → github token-scrub only). Drift: clipboard_read/write + take_screenshot currently `implemented:false` — owner_files read, Obsidian read, system_watch ARE live |
| S14 voice exec trusted | ✅ CONFIRMED | no tool-mode distinction for voice; wake word has no speaker verification |
| S15 dead deps/supply chain | ✅ CONFIRMED | 10 dead deps verified 0 importers (@mdxeditor, @dnd-kit×3, @tanstack×2, @reactuses, next-auth, next-intl, react-syntax-highlighter, uuid, zod) + unused shadcn; z-ai-web-dev-sdk = 7 live files (keep+gate) |

## R (robustness)
| R1 Stop doesn't abort | ✅ CONFIRMED | unified route: zero signal/abort handling (175 L) |
| R2 fake boot/load | ✅ CONFIRMED | app-shell :102-111 static `[ OK ]` theatrics; load numbers not health-derived |
| R3 residue/non-portable | ✅ CONFIRMED (spot) | /home/z/my-project paths in scripts; z-ai lane present; upload/, download/, postmortem.txt, oj-verify2.ts, drill-11c report at root |
| R4 listSkills rescans | ⚠️ PARTIAL (drift) | 60 s module-global cache added (skills-service importEcosystemSkills) — rescan ≤1/min, not per call. DB findMany still every call (cheap) |
| R5 dormant outbound | ✅ CONFIRMED | heartbeat 60 s loop (heartbeat-service:663) runs watchers (git fetch) regardless of state; system_watch via bridge :328 |
| R6 keyless lanes get memory | ✅ CONFIRMED (arch) | context (persona+memory) built before lane pick; no local-first lane; keyless in cascade |
| R7 strict-mode/leaks | ✅ CONFIRMED | reactStrictMode:false; speech.ts supersede-URL leak (bounded); no listener invariant test |
| R8 stream races | ✅ CONFIRMED (arch) | consciousness_chunk/final/cancel paths unguarded per-thought-id (w5 added FIFO but no late-chunk guard on cancel) |
| R9 no PRAGMAs/WAL | ✅ CONFIRMED | journal_mode=delete measured; no busy_timeout/foreign_keys in code |
| R10 no TTFT deadline | ✅ CONFIRMED | LLM_TIMEOUT_MS/CHAT_LLM_TIMEOUT_MS only; no first-token deadline |
| R11 UI↔backend desync/pollers | ✅ CONFIRMED | 5 pollers counted (backend, telemetry, alerts, face-bus emit, status tools fetch) + welcome ping |
| R12 dead files | ✅ CONFIRMED | hub.tsx zero importers; 4 unimplemented tools registered; 6 GET routes 404 on smoke (dynamic [id] without arg — expected class); R12 exit audit needs the dead-export sweep |

## P (performance)
| P1 bundle | ✅ CONFIRMED | zero dynamic()/lazy() app-wide; dev-served first-load JS 1.86 MB raw / 436 KB gz (docs/baseline-2026-10-07.json) |
| P2 tool-desc tokens | ✅ CONFIRMED | 143 tools, desc corpus ≈ 46k chars ≈ 11.6k tokens/turn worst case (baseline JSON) |
| P3 StatusBar energy | ✅ CONFIRMED | store.ts:376 + status-bar:19 whole-slice sub |
| P7 buildContext awaits | ✅ CONFIRMED (drift) | 10 sequential awaits + 1 Promise.all, region 225-413; measured p50 45 ms / p95 57 ms — fast in dev, but 10 round-trips × cold DB will spike |
| P9 status bar full tool list | ✅ CONFIRMED | status-bar.tsx:27 |
| P6/P10-P13 | ✅ CONFIRMED (arch) | lexical "vector" memory; eager everything (P13); idle 60 s sample: 0.4 % CPU, 1.6 MB non-lo rx (watchers) — full idle targets are Phase 4 |

## New findings this session (not in the brief)
1. **N1** `db/bridge/mist-bridge.js` health-checks `:8642` (:458) — a port not in the known service map (5 ports). UNKNOWN listener/feature — verify in Phase 1 before sealing the perimeter.
2. **N2** export tarball includes `db/provider-keys.json` (provider API keys) via `INCLUDE_DIRS=['db',…]` — sharper than the brief's `.env` claim: keys leak even if `.env` were excluded.
3. **N3** `github_sync` tool + `/api/mist/github` POST are unauthenticated — a web page can trigger a repo push (egress+self-modify without owner).
4. **N4** `guardrails.ts` lives at `src/lib/oj/` — Phase-1 proxy/middleware imports must use the oj path.
5. **N5** 4 registered tools are `implemented:false` (take_screenshot, run_python, clipboard_read/write) — they still occupy schema tokens (P2) and will silently gain risk surfaces when implemented (S13/S14) — add risk fields BEFORE flipping them on.
6. **N6** eslint has a repo-local JSON-parse lint rule (my own script tripped it) — the rule set is stricter than the brief's "~25 rules off" snapshot; re-audit rule state in Phase 3.
7. **N7** `write_file` already refuses `src/`+`mini-services/` (defect-#11 gate, tools-service:610) — mandate's arg-aware row is a REFUSAL today, not a self-modify hole; evolution-service remains the real S8 surface.
