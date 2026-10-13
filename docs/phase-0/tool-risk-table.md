# Phase 0 — D4 tool risk & reversibility table (143 registry entries, 139 implemented)

Legend — risk: `read` `sensitive-read` `write` `network` `exec` `destructive` `persist` `egress` `self-modify`.
Reversibility: `fully` (no state change) · `recoverable` (undo/rollback exists) · `irreversible` (no built-in undo).
Arg-aware rows are marked `†`. "unimpl" = registered but `implemented:false` today.

## web
| tool | risk | reversibility | why |
|---|---|---|---|
| web_search | network | fully | outbound query, results are data |
| get_weather | network | fully | keyless Open-Meteo GET |
| translate | network | fully | outbound text — owner text leaves machine (egress-adjacent) |
| check_internet | network | fully | latency probe |
| read_page | network+taint | fully | fetches untrusted content into context |
| deep_research | network+taint | fully | multi-hop web → high taint surface |

## file (project-scoped)
| read_file | read | fully | allowed-roots read |
| list_files | read | fully | dir listing |
| write_file † | write (self-modify refused) | recoverable | `src/`+`mini-services/` blocked at tools-service.ts:610-618 → gated self-tools; no backup for data writes |
| create_note | persist | recoverable | writes notes vault + stages memory |

## system
| system_info | read | fully | telemetry |
| take_screenshot (unimpl) | sensitive-read | fully | screen pixels — S13 when live |
| bridge_status / bridge_system_info | read | fully | bridge health |
| subagents_list / subagent_status / task_status | read | fully | registry reads |
| subagent_run / delegate_task / list_agents | exec (chain) | recoverable | spawns agent loops that call tools — chain-max risk |
| list_apps | read | fully | app inventory |
| open_app | exec | fully (benign) | launches desktop app via bridge |
| open_url | egress | fully | opens site in owner's browser — outbound + phishing surface |
| run_command | exec | recoverable | shell `exec(string)` on bridge (argv NOT enforced, :3345) |
| owner_files † | op-aware: read→sensitive-read, write/copy/mkdir/zip→write, move→write, **delete→destructive-irreversible** | delete irreversible, rest recoverable | real owner home FS; `recursive:true` deletes folders; **no trash** (mandate: route to `~/.mist/trash/`) |
| ui_automate | exec | recoverable | drives native Windows apps (bridge) |
| companions | read | fully | bridge LAN peer list |
| local_voice_status/setup | write (config) | recoverable | local STT/TTS engine config |
| system_watch | sensitive-read | fully | continuous system telemetry (R5: runs while dormant) |
| run_in_background | exec | recoverable | detached processes survive session |
| mission_start / mission_status / mission_control † | exec (chain) | recoverable | multi-step actor loops; steps call tools (mission-service.ts:1598 executeTool) |
| github_status | network | fully | API read (token-guarded) |
| github_sync | egress+self-modify | recoverable | commits+pushes her own source to GitHub |
| hermes_status/memory/skills/cron | read/persist | fully/recoverable | business agent introspection; hermes_cron writes remote schedules |
| hermes_delegate | exec (remote) | recoverable | runs task on creator's Hermes box via bridge |

## compute
| calculate | read | fully | safe expression evaluator (no eval) |
| run_python (unimpl) | exec | recoverable | sandbox-gated python — S-class when live |

## io
| clipboard_read (unimpl) | sensitive-read | fully | owner clipboard — S13/S14 when live |
| clipboard_write (unimpl) | write | recoverable | owner clipboard |

## memory
| memory_set | persist | recoverable | long-term fact upsert — S11: no provenance |
| memory_get / memory_all | read | fully | fact recall |
| memory_manage † | persist/destructive (op-aware) | recoverable | edit/delete facts |
| knowledge_search / scan_chunks | read | fully | KnowledgeChunk lexical recall (P6: not vectors) |
| queue_action / get_pending_actions / record_decision / check_permission | read+persist | recoverable | oj capability spine (approval queue) |
| user_profile_manage | persist | recoverable | owner profile |
| set_reminder | persist | recoverable | reminder row |
| schedule_task / list_scheduled_tasks | persist/read | recoverable | scheduler rows |
| digest_collect | persist | recoverable | digests |
| dream_recall | read | fully | dream journal |
| dream_compose | persist | recoverable | writes dream entries (A4: proposal-only per mandate) |
| search_sessions | read | fully | history search |
| learning_status | read | fully | learning stats |
| autonomy_log | read+persist | recoverable | AutonomyEvent rows |
| trend_scan | read | fully | trend analysis |

## self (evolution) — the S8 surface
| mist_self_check / mist_deep_selfcheck / mist_self_status / mist_backlog / evolution_scan/list/detail/status | read | fully | introspection |
| mist_self_read | read (source incl. src/) | fully | reads own source |
| evolution_suggest | read | fully | drafts proposals |
| mist_self_patch | self-modify | recoverable | proposal → owner approval (gate exists) |
| mist_self_write | self-modify | recoverable | direct write through gate: backup+typecheck+lint+rollback |
| mist_self_build / mist_self_update | self-modify+exec | recoverable | build + hot-reload self |
| self_upgrade_scan | read | fully | upgrade proposals |
| check_updates | network | fully | upstream check |
| capability_check | read | fully | tier gate probe (isActionAllowed still never called by callers) |
| oj_sync_check/status | read | fully | upstream watcher |
| oj_sync_apply | self-modify | recoverable | applies ported upstream code |
| mark_lv_sync_status | read | fully | teacher repo watcher |

## browser (pilot :3030)
| browser_navigate | network+taint | fully | loads untrusted page into shared context (S7) |
| browser_elements/click/type/key/scroll/extract | exec(remote page)+taint | fully | acts on page content — injection surface C |
| browser_screenshot | sensitive-read | fully | page pixels |
| browser_reset | write (context) | fully | fresh context |

## vault (Obsidian)
| obsidian_status/discover/list_notes/tags/graph/backlinks | read | fully | vault metadata |
| obsidian_read_note / query / search | read+taint | fully | untrusted note content into prompt |
| obsidian_create_note / update_note / daily_note | write | recoverable | vault writes (path-escape guarded) |

## skill
| skill_manage † | persist | recoverable | enable/disable/save skills — S11: saved skills re-enter prompts |
| 19× `skill:<name>` | chain-max | chain | effective risk = max of chained tools (mandate Phase 7); 4 of them chain DEAD omni_* tools (see skills-audit) |

## omniroute (9, via mesh gateway)
| omni_gateway_health/list_models/provider_status/usage_quota/current_route/agent_card/skills_catalog | network+read | fully | gateway introspection |
| omni_switch_model / omni_set_default_provider | persist (config) | recoverable | reroutes LLM traffic — lane integrity surface |

## utility
| generate_image_prompt | read | fully | prompt crafting |
| cron_list | read | fully | jobs |
| cron_create / cron_toggle / cron_delete † | persist / destructive(row) | recoverable | unattended loops → S11 (cron runs unified() with tools, scheduler:961) |
| cron_run_now | exec (chain) | recoverable | immediate unattended run |
| llm_pools | read | fully | lane status |

**Gaps vs mandate A1:** zero tools carry a `risk` field; `executeTool(body.tool, args, confirmed===true)` trusts the client (tools/execute/route.ts:24); no origin anywhere. Every row above feeds the Phase-2 Arbiter matrix.
