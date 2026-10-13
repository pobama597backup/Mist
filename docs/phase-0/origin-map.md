# Phase 0 — D5 origin map: every executeTool / bridgeExec call site

No `origin` concept exists in the codebase today. The "origin it would carry" column is the honest
answer for the Phase-2 Arbiter wiring (A1: every site must pass a real origin).

## executeTool (4 sites)

| Site | Trigger path | Origin today | Origin it needs |
|---|---|---|---|
| `src/app/api/mist/tools/execute/route.ts:24` | HTTP POST from browser; `body.confirmed===true` client-asserted | none (unauthenticated) | `owner_chat` — after session auth (Phase 1 step 3) |
| `src/lib/services/llm-service.ts:2761` | LLM tool rounds inside `unified()` — reached from chat, voice, cron (:961), heartbeat, dreams, missions | none — inherits caller's context implicitly but is NOT propagated | propagate caller origin; mark tainted when round consumed web/vault/skill output (S5b) |
| `src/lib/services/mission-service.ts:1598` | mission actor steps | none | `owner_cron`-class (mission origin = initiator), always tainted-capable |
| `src/lib/services/introspection-service.ts:365` | self-check probe (`calculate 2+2`) | none | `system` (harmless, fixed args) |

## bridgeExec (direct — bypasses tool registry entirely: the real side-door list)

| Site | Action(s) | Origin today | Notes |
|---|---|---|---|
| `src/app/api/mist/bridge/route.ts:79` | **ANY action passthrough** (POST {action,args}) | none — unauthenticated HTTP | biggest hole: web-reachable direct bridge proxy |
| `src/app/api/mist/hermes/route.ts:38` | ANY action (delegate form) | none | same class |
| `src/app/api/mist/bridge/signal/route.ts:79` | signal_emit | none | LAN peer signaling |
| `src/app/api/mist/companions/route.ts:28,68,78` | companions, signal_setup, signal_emit | none | LAN mesh |
| `src/app/api/mist/voice/local/{tts,transcribe,status,engines}/route.ts` | voice_tts, voice_stt, voice_status, voice_discover/adopt/voices/select | none | voice lane (S14 adjacency) |
| `src/lib/services/tools-service.ts:422` | generic funnel for BASE_TOOLS bridge actions | none | the owner_files/run_command/ui_automate path |
| `src/lib/services/tools-service.ts:1087` | owner_files executor | none | arg-aware destructive lives here |
| `src/lib/services/heartbeat-service.ts:328,427` | system_watch, hermes_status | none | background 60 s loop (R5) |
| `src/lib/services/bg-tasks-service.ts:172` | background task actions | none | unattended |

**Mandate DoD check `grep executeTool\|bridgeExec … | grep -v arbitrate` → today: 18 sites, 0 arbitrate. Phase 2 must wire all 18 through A1 with real origins; Phase 1 must first put auth on the 8 HTTP-reachable ones.**

## Also-relevant exec surfaces NOT named executeTool/bridgeExec
- `recover/route.ts` spawn/execSync (deleted in Phase 1)
- `evolution-service` file writes under `ALLOWED_PREFIXES=['src/','mini-services/','db/skills/','db/notes/']` (:45) — S8
- bridge internal `spawn` sites: :316, :1042 (`/bin/sh -c`), :1800, plus `xdg-open`/`open`/`cmd /c start` (argv-safe, benign class)
- `github-service` authenticated `git` via http.extraheader (token never in remote URL — verified w8)
- mesh-service `/mcp` `tools/call` (port :3030?→3004) — JSON-RPC tool exec, unauthenticated (S2)
