# Phase 0 — Tool risk & reversibility register (Arbiter seed)

Source: `src/lib/services/tools-service.ts` opened this session by phase0-b (Explore).
Scope: **BASE_TOOLS = 116** (100 inline at tools-service.ts:430–3537 + 16 spread: KNOWLEDGE_TOOLS ×4, OPS_TOOLS ×8, SYNC_TOOLS ×4). Runtime registry additionally merges 9 `OMNI_TOOLS` + one `skill:*` tool per DB skill → **143 tools live** (baseline-2026-10-10.json).

Global wrapper on ALL tools (`executeTool`, tools-service.ts:3592–3744): SSRF guard on http(s) args (`open_url` exempt — an arg-aware hole), injection scan on output (wraps **high/critical only**), error taxonomy, bus/trace events.

Risk classes: `read | sensitive-read | write | network | exec | destructive | persist | egress | self-modify`.
Reversibility: `fully | recoverable | irreversible`.

| # | tool | risk | reversibility | one-line why |
|---|------|------|---------------|--------------|
| 1 | web_search | network | fully | live web search via zai |
| 2 | get_weather | network | fully | Open-Meteo fetch |
| 3 | translate | network | fully | sends text to LLM provider |
| 4 | check_internet | network | fully | connectivity probe |
| 5 | read_file | read → **sensitive-read** (arg: .env*/keys) | fully | reads within home+project incl. secrets |
| 6 | write_file | write → **self-modify** (arg: package.json/.env*/prisma/db) | **irreversible** (overwrite, no backup) | src/+mini-services/ hard-blocked (:607-617), rest raw-writable |
| 7 | list_files | read | fully | dir listing, root-jailed |
| 8 | create_note | write | recoverable | new md note + memory queue |
| 9 | system_info | read | fully | sandbox telemetry |
| 10 | github_status | network | fully | mirror state check |
| 11 | github_sync | **egress** | recoverable | pushes source off-machine, no approval |
| 12 | take_screenshot | sensitive-read | fully | STUB (implemented:false) |
| 13 | bridge_status | read | fully | bridge liveness |
| 14 | subagents_list | read | fully | agent roster |
| 15 | subagent_run | exec | **irreversible** | background mission w/ real tools, unaudited inner actions |
| 16 | subagent_status | read | fully | run check |
| 17 | list_apps | sensitive-read | fully | owner machine app list |
| 18 | open_app | exec | recoverable | launches desktop app |
| 19 | open_url | network | fully | opens in owner's browser; **SSRF-guard exempt** |
| 20 | run_command | exec | **irreversible** | arbitrary shell on owner machine, NO gate |
| 21 | owner_files | **destructive** (op=delete+recursive) / sensitive-read (read) / write | delete = **irreversible** (bridge rmSync, no trash) | full home file ops |
| 22 | bridge_system_info | sensitive-read | fully | owner hardware info |
| 23 | hermes_status | read | fully | Hermes health |
| 24 | hermes_delegate | exec | **irreversible** | terminal/browser/file agent, unaudited |
| 25 | hermes_memory | persist (append) / sensitive-read (read) | recoverable | Hermes MEMORY/USER files |
| 26 | hermes_skills | write | recoverable | skill export to ~/.hermes |
| 27 | hermes_cron | persist (add) / exec (run) | recoverable | unattended job creation/execution |
| 28 | companions | sensitive-read | fully | local agent stack survey |
| 29 | local_voice_status | read | fully | whisper/Piper status |
| 30 | local_voice_setup | exec | recoverable | downloads+installs engines |
| 31 | system_watch | sensitive-read | fully | owner PC health incl. failed logons |
| 32 | run_in_background | exec | depends→irreversible | async wrapper for run_command/ui_automate/hermes_ask |
| 33 | task_status | read | fully | bg task check |
| 34 | mission_start | exec | **irreversible** | persistent autonomous mission, real tools |
| 35 | mission_status | read | fully | mission detail |
| 36 | mission_control | write | recoverable | pause/resume/cancel |
| 37 | ui_automate | exec (set_toggle/click) / sensitive-read (inspect/find) | recoverable | native Windows UI control |
| 38 | run_python | exec | fully | STUB |
| 39 | calculate | read | fully | safe math, no eval |
| 40 | clipboard_read | sensitive-read | fully | STUB |
| 41 | clipboard_write | write | fully | STUB |
| 42 | memory_set | persist | recoverable | long-term fact write, no provenance |
| 43 | memory_get | read | fully | fact recall |
| 44 | memory_all | read | fully | fact list |
| 45 | dream_recall | read | fully | dream recall |
| 46 | dream_compose | persist | recoverable | dream compose+store |
| 47 | generate_image_prompt | network | fully | LLM prompt craft |
| 48 | set_reminder | persist | recoverable | heartbeat-fired reminder |
| 49 | read_page | network | fully | fetch+extract, SSRF-guarded |
| 50 | deep_research | network | fully | multi-query cited pipeline |
| 51 | browser_navigate | network | fully | pilot-controlled page open |
| 52 | browser_elements | read | fully | clickable list |
| 53 | browser_click | network → **egress** (submit/buy/login) | submit = **irreversible** | element click |
| 54 | browser_type | network → egress (submit) | depends | typing, optional Enter |
| 55 | browser_key | network | fully | keypress |
| 56 | browser_scroll | read | fully | scroll |
| 57 | browser_screenshot | read | fully | pilot page capture |
| 58 | browser_extract | read | fully | page text |
| 59 | browser_reset | read | fully | blank page |
| 60 | delegate_task | exec | **irreversible** | external CLI coding agents |
| 61 | list_agents | read | fully | CLI agent probe |
| 62 | llm_pools | network → **self-modify** (action=pick writes env) | recoverable | lane survey/pick; **self-confirmed env write** (:2266,2288) |
| 63 | mist_self_check | read | fully | lint+log self-audit |
| 64 | mist_deep_selfcheck | read → **self-modify** (repair:true auto-applies) | recoverable | 10-probe doctor, applies fixes w/o owner |
| 65 | evolution_scan | read (+persist row) | recoverable | audit + draft proposal |
| 66 | evolution_suggest | persist | recoverable | feature proposals |
| 67 | evolution_list | read | fully | proposal list |
| 68 | evolution_detail | read | fully | proposal diff |
| 69 | evolution_status | read | fully | engine state |
| 70 | mist_self_status | read | fully | self-awareness report |
| 71 | mist_self_read | read | fully | own source, allowlisted |
| 72 | mist_self_patch | self-modify (deferred) | recoverable | **the one gated path** — creator approval + technical gate |
| 73 | mist_self_write | **self-modify** | recoverable | **AUTO-APPLIES** via applyProposal (:2893) — no human approval |
| 74 | mist_self_build | exec | fully | runs lint gate |
| 75 | mist_self_update | read | fully | git freshness |
| 76 | mist_backlog | persist / **destructive** (remove) | remove = irreversible | idea list |
| 77 | check_updates | network | fully | watchlist sweep |
| 78 | capability_check | read | fully | advisory self-assessment |
| 79 | cron_list | read | fully | automation list |
| 80 | cron_create | persist | recoverable | unattended LLM+tool runs; write:true **UI-only** |
| 81 | cron_toggle | persist | recoverable | enable/disable |
| 82 | cron_run_now | exec | recoverable | fires job immediately, no flag |
| 83 | cron_delete | persist/destructive | **irreversible** | job definition gone |
| 84 | autonomy_log | read | fully | autonomous action review |
| 85 | trend_scan | network | recoverable | live trend digest + persisted note |
| 86 | self_upgrade_scan | persist | recoverable | capability-gap proposals |
| 87 | obsidian_status | read | fully | vault state |
| 88 | obsidian_discover | read | fully | vault finder |
| 89 | obsidian_list_notes | sensitive-read | fully | vault listing |
| 90 | obsidian_read_note | sensitive-read | fully | note content (5000c) |
| 91 | obsidian_search | sensitive-read | fully | vault full-text |
| 92 | obsidian_tags | sensitive-read | fully | tag list |
| 93 | obsidian_graph | read | fully | link graph |
| 94 | obsidian_backlinks | sensitive-read | fully | reverse links |
| 95 | obsidian_create_note | write → destructive (overwrite:true) | overwrite = **irreversible** | new/replace note |
| 96 | obsidian_update_note | write | replace = **irreversible** | body replace/append |
| 97 | obsidian_daily_note | write | recoverable | today's note |
| 98 | obsidian_query | read | fully | dataview-lite |
| 99 | search_sessions | sensitive-read | fully | past conversation search |
| 100 | learning_status | sensitive-read | fully | learned skills + user model |
| 101 | knowledge_search | read | fully | BM25+vector hybrid |
| 102 | scan_chunks | read | fully | raw chunk browse |
| 103 | memory_manage | persist / **destructive** (delete) | delete = **irreversible** | fact add/list/delete/quarantine |
| 104 | user_profile_manage | persist / sensitive-read (get) | recoverable | USER.md fields |
| 105 | check_permission | read | fully | advisory tier check (dead spine) |
| 106 | queue_action | persist | recoverable | queues for approval, never performs |
| 107 | get_pending_actions | read | fully | approval queue |
| 108 | record_decision | persist | recoverable | **MODEL-ASSERTED creator decision + always_approve memory** |
| 109 | schedule_task | persist | recoverable | NL cron creation — **no write flag at all** |
| 110 | list_scheduled_tasks | read | fully | cron list |
| 111 | digest_collect | persist | recoverable | sources → digest alert |
| 112 | skill_manage | persist | recoverable | disable genuinely approval-queued |
| 113 | oj_sync_check | network (+persist) | recoverable | upstream sweep, gated proposals |
| 114 | oj_sync_status | read | fully | sync status |
| 115 | oj_sync_apply | **self-modify** | recoverable | **direct applyProposal call** (upstream-sync:1011), no owner |
| 116 | mark_lv_sync_status | read | fully | Mark-LV watch state |

## Stats (baseline-2026-10-10.json, live registry: 143)

- Risk distribution (116 BASE): read 43 · network 17 · sensitive-read 13 · persist 18 · exec 12 · write 8 · self-modify 3 · destructive 1 · egress 1
- Reversibility: fully 69 · recoverable 33 · **irreversible 14**
- Tool payload: **67,481 bytes** JSON; descriptions ≈ 26,410c (≈7.2K tokens); full serialized block ≈ **13,799 tokens per turn** (38,122c in the built prompt)
- Top-5 heaviest descriptions: mission_start 1396c · ui_automate 1061c · owner_files 1046c · mist_self_read 912c · run_in_background 882c

## Gate findings (what the Arbiter replaces)

1. `checkCapability` (guardrails.ts:237) has **zero call sites** — the tiered spine exists but nothing routes through it.
2. `confirmed` is client-asserted (tools/execute/route.ts:24) and only reaches `executeOmniTool` — base tools ignore it entirely.
3. `write:true` flags are UI decoration (cron_*, obsidian_create/update) — server never enforces.
4. `applyProposal` (evolution-service.ts:1876) checks `status==='pending'` only — `mist_self_write`, `oj_sync_apply`, and `mist_deep_selfcheck(repair)` land source changes **without any human approval**. Only `mist_self_patch` truly waits.
5. `record_decision` lets the LLM assert "creator approved" and persist `always_approve` — no server-side proof.
6. `schedule_task` creates unattended cron with no flag; `run_command`/`owner_files` delete/github_sync run with no gate at all.
7. SSRF exemption keyed on tool name `open_url` (tools-service.ts:3611-3613) — arg-aware hole.
