# Hermes Agent vs M.I.S.T. — Deep Research Dossier
- researched: 2026-09-23 (awaiting user's repo link)
- subject: NousResearch/hermes-agent v0.21.4 (v2026.9.21) — "The agent that grows with you"

## Hermes Agent — verified facts (docs + README + third-party)

**Identity**: Open-source (MIT) self-improving agent by Nous Research. 214K GitHub stars in 6 months — fastest-growing OSS agent framework of 2026. Launched Feb 2026. Install: curl one-liner (Linux/macOS/WSL2/Termux), PowerShell (native Windows), Desktop apps (macOS 12+, Win 10/11).

**The Learning Loop (crown jewel — "only agent with a built-in learning loop")**:
- Autonomous skill creation after complex tasks (distills solution paths into reusable skills)
- Skills SELF-IMPROVE during use (patch drift)
- Agent-curated memory with periodic NUDGES to persist knowledge
- FTS5 session search + LLM summarization for cross-session recall
- Honcho dialectic user modeling ("deepening model of who you are")
- agentskills.io open standard (SKILL.md compatible — same format family as MIST's importer!)

**Memory system**: bounded curated memory — MEMORY.md (2,200 chars agent notes) + USER.md (1,375 chars user profile). Frozen snapshot injected at session start (preserves prefix cache). Agent self-manages via memory tool; hard limits force consolidation (no silent bloat). Per-profile scope. Pluggable memory providers (Honcho = plugin).

**Curator** (skill maintenance): background pass tracking views/uses/patches → active→stale→archived lifecycle; auxiliary-model review proposes consolidations; NEVER auto-deletes (archival recoverable); idle-triggered (default 7d interval, 2h idle).

**Skills**: on-demand knowledge docs, progressive disclosure (token-minimal), auto slash-commands, chain up to 5 per message, skill bundles, Skills Hub (agentskills.io) + external skill dirs; agent can modify/delete any skill.

**Messaging gateway**: Telegram, Discord, Slack, WhatsApp, Signal, Email, Teams + CLI — ONE gateway process; voice-memo transcription; cross-platform conversation continuity; Bot Mode = named bots each with own model/memory/skills/routines/chats.

**Cron**: natural-language scheduling; create/list/update/pause/resume/run/remove; delivery to any platform (cron delivery + hermes send + gateway notifier).

**Delegation**: isolated subagents (own conversations + terminals); Python scripts call tools via RPC = "zero-context-cost" pipelines; parallel workstreams.

**Sandboxing**: 7 terminal backends — local, Docker, SSH, Singularity, Modal, Daytona, Vercel Sandbox; container hardening + namespace isolation; serverless persistence (hibernates idle, ~$0). Browser 5 backends, Web 4 backends.

**Tools**: 70+ tools / 28 toolsets (README says 60+; arch doc says 70+ registry). Toolsets per-platform toggles + presets (hermes-cli, hermes-telegram). Tool Gateway (Nous Portal sub): web search (Firecrawl), image gen (FAL), TTS (OpenAI), cloud browser (Browser Use). Signal-death annotations in tool results. X search via xAI (opt-in). Home Assistant, Spotify integrations.

**MCP**: connect any MCP server, filter tools, dynamic mcp-<server> toolsets.

**MoA (Mixture of Agents)**: virtual model provider; reference models advise once per turn, aggregator runs the whole tool loop (billed); presets selectable like models everywhere.

**Voice mode**: real-time voice in CLI, Telegram, Discord, Discord VC.

**Personality**: SOUL.md global persona; personalities; skins/themes.

**Context engineering**: context files (project), context references, micro-compaction, compression+caching, prompt assembly, 3 API modes (chat/codex/anthropic).

**Research-ready**: batch trajectory generation + trajectory compression for training tool-calling models.

**Stack**: Python (uv, 3.11) + Node; SQLite + FTS5 state DB; gateway multiplexing, completion backlogs, recovery; ACP adapter, API server, Python lib. Providers: Nous Portal (300+ models), OpenRouter, OpenAI, any OpenAI-compatible. OpenClaw migration (memories, skills, keys, SOUL.md).

**Documented weaknesses (critiques)**:
1. "Doesn't learn — it mutates strings": self-improvement = artifact accumulation (skills/memory/user-model deltas), no runtime gradient/RL; GEPA evolutionary prompt search lives OUTSIDE the runtime
2. FTS5 retriever MISSES rephrased queries — keyword-only, no semantic/vector recall (Milvus article proposes hybrid fix)
3. Memory caps are TINY (3,575 chars total) — bounded by design, loses detail
4. No visual UI beyond terminal TUI / desktop chat — zero visualization layer

## M.I.S.T. — verified current capabilities (from code + worklog)

- Web OS interface (Next.js 16): consciousness hub, living orb (FFT dance, mouth, comets, tick dial, glints), boot sequence, starfield/aurora, CRT drawer, synapse monitor (brain regions), diagnostics drawer 7 tabs, in-app browser windows, threads, settings
- 46 base tools (57 w/ omni + skills); OmniRoute MCP gateway (curated reads, gated writes, probe cache)
- Multi-provider LLM (GLM via Z.ai, Qwen, offline fallback), provider badges, model picker
- EVOLUTION/self-coding: lint-gated self-patch (planUserPatch via chat), scanForIssues, suggestFeatures (self-idea origin), backlog, approve/reject — Hermes has NOTHING like this (it never patches its own code)
- Skills: SKILL.md ecosystem importer (OpenClaw/Anthropic frontmatter), Prisma source of truth, execution ledger — but NO auto-creation from experience, NO in-use self-improvement, NO curator lifecycle
- Memory: longterm KV + SEMANTIC VECTOR index + queue + stats — beats Hermes FTS5 keyword-only recall
- Heartbeat: 60s loop, reminder delivery into threads, watchlist (npm + GitHub Atom), alerts
- Voice: TTS (SDK voices) + STT (mic WAV), push-to-talk Alt+V, orb dances to real audio FFT
- Agent bridge: probeAgents + delegateTask (openclaw headless exec)
- Neural mini-service (:3003 socket.io consciousness stream), browser-pilot (:3030)
- Conversation persistence (Prisma), alert threads, telemetry

## Head-to-head verdicts (15 dimensions)

| # | Dimension | M.I.S.T. | Hermes | Winner |
|---|-----------|----------|--------|--------|
| 1 | Visual UI/UX, "AI OS" experience | full sci-fi web OS, living orb, states | terminal TUI + desktop chat | **MIST** (massive) |
| 2 | Install/access | zero-install web | curl/desktop installers | **MIST** |
| 3 | Consciousness state system | 6 visualized states + realtime | none | **MIST** |
| 4 | Learning loop (skill auto-creation, in-use self-improvement, persist-nudges) | ❌ none | ✅ core feature | **HERMES** (killer gap) |
| 5 | Skill maintenance lifecycle (curator) | ❌ | ✅ active→stale→archived + aux review | **HERMES** |
| 6 | Memory recall quality | semantic VECTOR search | FTS5 keyword only (critiqued) | **MIST** |
| 7 | Bounded curated "essence" memory + user modeling | ❌ (raw KV) | ✅ MEMORY.md/USER.md + Honcho | **HERMES** |
| 8 | Self-coding / self-evolution of own source | ✅ lint-gated pipeline | ❌ never patches own code | **MIST** (unique!) |
| 9 | Messaging gateway (TG/Discord/Slack/WA/Signal/email) | ❌ web-only | ✅ single gateway, continuity, Bot Mode | **HERMES** (big gap) |
| 10 | Scheduling | reminders + watchlist sweeps | full cron CRUD + pause/resume + platform delivery | **HERMES** (slightly) |
| 11 | Delegation/subagents | delegateTask (openclaw) | isolated subagents + terminals + RPC zero-context pipelines | **HERMES** |
| 12 | Sandboxing/isolation | in-process tools | 7 backends, containers, namespace isolation | **HERMES** |
| 13 | MCP | OmniRoute gateway (curated) | any MCP server + tool filtering | **HERMES** (moderately) |
| 14 | Multi-model | provider switch + fallback | 300+ models, switch, **MoA presets** | **HERMES** (MoA edge) |
| 15 | Tools breadth | 57 | 70+ / 28 toolsets | **HERMES** (slightly) |
| 16 | Voice UX | TTS+STT+push-to-talk, orb dances to FFT | voice mode CLI/TG/Discord VC | **tie** (MIST more visual, Hermes more platforms) |
| 17 | Research/trajectory generation | ❌ | ✅ batch runner | **HERMES** |
| 18 | Persistence/threads | Prisma conversations + alerts | SQLite+FTS5 sessions + gateway recovery | **tie** |

Score: MIST 5, Hermes 9, tie 2 (by dimension count) — but dimensions 1–3 are MIST's founding purpose (the wow OS interface), and 4/9 are the two truly structural gaps.

## Combine plan (what we take from Hermes into M.I.S.T.)

**P0 — The Learning Loop (the reason Hermes has 214K stars):**
1. Auto-skill creation: after complex multi-tool tasks, distill the solution path into a new SKILL.md (agentskills.io-compatible = matches our existing importer format!)
2. In-use self-improvement: skills record uses; on failure/patch, skill text updates itself
3. Persist-nudges: heartbeat periodically nudges the agent to consolidate learnings into memory
4. Curator: skill lifecycle (active→stale→archived) + auxiliary-model review proposing consolidations — new Diagnostics tab UI

**P1 — Bounded curated memory:** MEMORY.md + USER.md pattern (frozen snapshot at session start, char caps, agent-managed) layered on top of our vector store — essence + recall

**P2 — Messaging gateway:** Telegram first (then Discord) mini-service bridging into MIST's neural stream — one agent, one memory, every surface

**P3 — MoA:** llm-service virtual provider — reference models advise, GLM aggregates (we already have multi-provider routing)

**P4 — Cron upgrades:** pause/resume/manage scheduled jobs UI (we have the delivery path already via heartbeat alerts)

**P5 — Delegation upgrades:** isolated subagent contexts (own conversation thread), report back into parent thread

Skipped (honest): container sandbox backends (no Docker in this sandbox), desktop apps (web is the point), trajectory training (out of scope for now).

## Sources
- github.com/NousResearch/hermes-agent (README, v0.21.4)
- hermes-agent.nousresearch.com + /docs (skills, memory, curator, moa, tools, architecture)
- startupfortune.com (214K stars), fastino.ai guide, NVIDIA blog (RTX PCs)
- Critiques: pub.towardsai.net "Doesn't Learn. It Mutates Strings" (GEPA outside runtime), milvus.io (FTS5 misses rephrased queries), levelup (artifact accumulation)
