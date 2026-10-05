# M.I.S.T. UNIFIED

**M**aster **I**ntelligence & **S**ystem **T**opology — a sovereign, local-first AI companion.
One web app. One local process. Zero cloud lock-in.

> It **listens** (mic → STT) · **thinks** (21-lane LLM cascade with auto-fallback — 4 lanes zero-auth keyless, works with no key at all) · **remembers** (SQLite facts + lexical vector impressions) · **acts** (46-tool registry, headless browser, deep research) · **speaks** (TTS in-browser) · **browses** (own Playwright pilot + in-app media tabs) · **watches upstream** (anti-rust watchlist + OpenClaw watchtower) · **codes itself** (evolution engine behind your approval) · **fires ⏰ reminders into the chat** (60s heartbeat) · and **shows state**: dormant / awakening / listening / processing / speaking / dreaming.

---

## Quickstart

```bash
bun install                 # deps (socket.io-client included)
bun run db:push             # init SQLite schema (db/custom.db)
bun run dev                 # M.I.S.T. core on http://localhost:3000
bun run dev --cwd mini-services/neural-service    # /ws/neural stream on :3003
bun run dev --cwd mini-services/browser-pilot     # headless browser pilot on :3030
```

Windows launchers: `run.bat` (starts everything + opens browser) · `stop.bat` · `restart.bat`.

> **Running her on your own PC?** Read **[PC-SETUP.md](./PC-SETUP.md)** — 5-minute
> guide (Bun, API keys, the Bridge for system powers, fully **offline voice** via
> whisper.cpp + Piper, Hermes/companion integration).

In this sandbox all processes are already running — open the **Preview Panel** (or "Open in New Tab") to meet M.I.S.T.

## The surfaces (and nothing else)

| Surface | What it does |
|---|---|
| **Consciousness** (home) | The NeuralCore orb — a living canvas presence — plus thread sidebar, glass chat with provider/model badges, citations, media cards, suggestion chips, capability-request option cards, provider router (incl. Qwen), push-to-talk mic, TTS autoplay, SynapseMonitor, and ⏰/📦 heartbeat alerts landing live in the thread. |
| **Settings** | Provider cards (OmniRoute / OpenAI-compatible / OpenRouter / Anthropic / Gemini / **Qwen**) with masked key inputs written only to local `.env`, connection tests, **Mist Core model selectors** (text + vision, GLM catalog newest→oldest with live-serving chips), animation intensity, reduced-motion, voice preferences, telemetry sparklines, skills manager. |
| **Diagnostics** (slide-in drawer) | **System** (live gauges + sparkline) · **Tools** (46-tool arsenal + OmniRoute console with write-confirmation gating + save-as-skill) · **Memory** (fact CRUD, vector search, queue) · **Voice** (STT/TTS test benches) · **Skills** (learning loop registry — imports OpenClaw/Anthropic-style SKILL.md frontmatter natively) · **Agents** (OpenClaw / Claude Code / Codex / Gemini CLI / Aider bridge with honest installed badges) · **Evolve** (M.I.S.T. codes itself: proposals, diffs, Approve & apply with lint gate + auto-rollback, OpenClaw watchtower, anti-rust watchlist, heartbeat health). |
| **Browser window** (floating, in-app) | Tabbed glass browser: YouTube embeds with seek/jump-to-key-moment, reader-mode articles, and a live **cockpit** — screenshot view with click-to-act coordinates, elements panel, smart-target type bar. |
| **StatusBar** (fixed bottom) | Backend dot + latency, tools count, neural state + load %, provider, `Alt+V` voice hint. |

Global hotkey: **Alt+V** — hold-to-talk with the mic from anywhere in Consciousness.

## Architecture

```
src/app/page.tsx → app-shell.tsx        one surface, view switch + ambient FX
src/components/mist/
  navbar · consciousness/{hub, neural-core, chat-panel, threads-sidebar}
  browser-window · status-bar
  diagnostics/{drawer, 7 tabs, skill dialog} · settings/{view, qwen, core-models}
src/app/api/mist/**                     30+ REST endpoints (Next.js route handlers)
src/lib/services/**                     llm cascade · context builder · 46-tool registry
                                        memory + lexical vectors · skills (ecosystem import)
                                        browser pilot proxy · deep research · agent bridge
                                        evolution engine (self-coding) · openclaw watchtower
                                        watchlist (anti-rust) · heartbeat (60s proactive)
mini-services/neural-service            socket.io :3003 — frozen /ws/neural protocol
mini-services/browser-pilot             Playwright headless Chromium :3030 (mutex-serialized)
prisma/schema.prisma                    SQLite: conversations, messages, facts, queue,
                                        vectors, skills, evolution proposals, alerts
db/skills/*.md · db/notes/*.md          SKILL.md ecosystem dir + notes vault
db/openclaw/* · db/watchlist.json       upstream digests + watchlist state
```

**LLM cascade**: `omniroute → hermes → theoldapi → openai_compatible → nvidia → openrouter → qwen → groq → github_models → cerebras → together → mistral → huggingface → anthropic → gemini → kilo → pollinations → llm7 → ovh → core → offline-mind`.
**Zero API keys still yields a fully working brain**: four **keyless zero-auth lanes** sit right before core — Kilo Code (550B nemotron reasoning model, 1M-token context, 200 req/hr), Pollinations (gpt-oss-20b), LLM7.io turbo (live-picked by availability), OVHcloud AI EU — no key, no signup, out of the box. Her own pick travels in `.env` (`MIST_LLM_PROVIDER`, chosen via her `llm_pools` survey tool). In the sandbox preview the Z.ai gateway's GLM (**Mist Core**) also serves; on your PC it's skipped honestly (sandbox-only) and the keyless lanes take over. Every reply honestly attributes the model that actually served it. Total failure degrades to the deterministic `[offline-mind]` reply — never a crash (strict law 3).

**Qwen provider** — real model names, never aliases: the Z.ai gateway categorically cannot serve Qwen (probed live — every request returns glm-4-plus), so MIST talks to REAL OpenAI-compatible endpoints (DashScope default, any base URL, keyless local Ollama). 19 text + 8 vision Qwen models, newest→oldest, honest attribution of whatever `response.model` reports.

**Tool arsenal (46 base)**: web research (web_search, read_page, deep_research) · browser computer-use (9 pilot tools) · agent bridge (delegate_task, list_agents — OpenClaw/Claude Code/Codex/Gemini CLI) · self-coding (evolution_scan/suggest/list/status) · **self tools (mist_self_status / mist_self_read / mist_self_patch / mist_self_build / mist_self_update / mist_backlog / check_updates)** · files · compute · memory · set_reminder (REAL due times — the heartbeat fires them) · capability_check (never dead-end) · + 9 curated OmniRoute MCP tools + learned `skill:*` tools.

**Self-coding (M.I.S.T. codes itself)**: ask in chat or Diagnostics → Evolve. Inspect its own source → plan exact changes (LLM self-repair rounds against real file contents) → **you approve** → in-memory atomic patch compute → backup → apply → **lint gate** → auto-rollback on failure. Deterministic policy: writes confined to `src/`, `mini-services/`, `db/skills/`, `db/notes/`; `.env`/`package.json`/`prisma/`/configs hard-blocked; never restarts or deploys itself.

**Heartbeat + freshness (never build on rusty stuff)**: a 60s loop fires due reminders into the chat as ⏰ alerts (toast + persisted thread message). Every 5 minutes the same loop samples the PC's health through the Mist Bridge (CPU/RAM/disk/temperature/Defender/failed logons) and raises ⚠️ warnings in the chat *before* things go wrong — say "check my system" for the live snapshot. A watchlist (`db/watchlist.json` — openclaw/openclaw via npm, anthropics/skills via commit Atom feed) is swept every 6h + on demand (`check_updates`); first sighting is a silent baseline, real changes raise 📦 alerts — "openclaw released X — want me to review the changelog and propose improvements to adopt?" — and refresh the OpenClaw digest the evolution engine studies. OpenClaw watchtower auto-syncs every 12h (`MIST_OPENCLAW_AUTO_UPDATE=off` disables).

**Learning loop**: any successful tool execution can be saved as a skill; trigger-matched skills are injected into future context and chain their tools. Ecosystem **SKILL.md** files (OpenClaw/Anthropic frontmatter: `name` + `description`) dropped into `db/skills/` load natively.

## API (all under `/api/mist`)

`health` · `telemetry` · `tools/list|categories|{name}/info|execute` · `memory/longterm[/{key}]` · `memory/queue` · `memory/vector/search` · `memory/stats` · `voice/status|stt|tts` · `voice/local/status|transcribe|tts` (offline whisper.cpp + Piper via the Bridge) · `llm/status|test|unified` · `conversations[/{id}/messages]` · `skills/list|save|{name}` · `config/env` · `synapse/stream` (SSE) · `browser/status|command` · `agents` · `research` · `evolution[/scan|suggest|openclaw|{id}/develop|approve|reject]` · `alerts` (heartbeat) · `watchlist` — plus WebSocket `/ws/neural` on port 3003 (frozen contract in `src/lib/types.ts`).

Secrets are **never** logged, echoed, or sent to the frontend (presence booleans only). File tools are home/project-root restricted. Web calls time out at 10s. Heartbeat/watch loops are globalThis-guarded (one per process, unref'd).

## Demo script (3 minutes)

1. **Awakening** — open the app: orb breathes, SynapseMonitor streams live channels, StatusBar shows `CORE ~Xms`.
2. **Agentic tool loop** — *"Use the calculate tool to compute 21\*2, then greet me."* → `⚡ calculate` chip, reply with `via Mist Core · glm-4-plus` badge, spoken aloud.
3. **Real reminder** — *"Remind me in 2 minutes to stretch"* → the tool arms it (ISO due time) → keep the tab open → ⏰ toast + the reminder lands in the chat when it's due.
4. **Self-awareness** — *"Run mist_self_status"* → heartbeat health, armed reminders, watchlist versions, registry size, self-coding policy.
5. **M.I.S.T. codes itself** — *"Add a footer timestamp to the agents tab"* (mist_self_patch) → proposal with exact steps → Diagnostics → Evolve → review diff → **Approve & apply** → lint gate → hot-reload.
6. **Freshness** — Evolve tab → watchlist card → "Sweep now" → live versions of openclaw + anthropics/skills; or in chat: *"check updates"* → 📦 alert if anything moved.
7. **Browser computer-use** — *"Open wikipedia.org and explore artificial intelligence"* → the pilot navigates, extracts, and can click/type on the real web; media results auto-open as in-app tabs.
8. **Never dead-end** — *"Post a tweet for me"* → capability_check + option cards (compose draft, open browser to twitter.com, …) — never a flat refusal.
9. **Sovereignty** — Settings → Providers: every key absent, yet everything above worked. The Qwen card waits for a real DashScope key or local Ollama — honest, never faked.
10. **Persistence** — reload → threads, skills, proposals, reminders, alerts all intact.

## Adaptation notes

Built to the M.I.S.T. UNIFIED specification; environment-driven adaptations (Next.js API routes instead of FastAPI, SDK voice instead of the ~3GB local Whisper/Kokoro gate, lexical vector engine instead of ChromaDB) are fully documented in `MIGRATION_STATE.md`. The honest capability ledger lives in `CAPABILITIES.md`.

Bound to 127.0.0.1 · secrets never leave this machine.
