# M.I.S.T. — CAPABILITIES LEDGER

The honest, always-current answer to *"what can this thing actually do?"*
Every CAN claim below was proven live in this build. Every CAN'T is a real limit, stated plainly — never hidden behind a fake success.

**Build**: M.I.S.T. UNIFIED · sovereign local-first AI companion · Next.js 16 + socket.io mini-services + SQLite
**Registry**: 46 base tools (+9 curated OmniRoute + learned `skill:*` tools) · 21-lane LLM cascade (4 keyless zero-auth)

---

## ✅ CAN — always (zero configuration, zero keys)

| Capability | Evidence |
|---|---|
| **Think** — full LLM brain via Mist Core (the Z.ai gateway's GLM) | Every chat reply, attributed `via Mist Core · glm-4-plus` (text) / `glm-5v-turbo` (vision) — the REAL model that served, never an alias |
| **Think keyless** — 4 ZERO-AUTH lanes live the moment Mist boots (no key, no signup, nothing to configure): Kilo Code (550B nemotron reasoning brain, 200 req/hr), Pollinations (gpt-oss-20b), LLM7.io turbo (GLM-5.3-Flash etc., live-picked by availability), OVHcloud AI EU (Qwen3.5-397B, 2 RPM/model) | Live-probed 2026-09-27 with real keyless chats; browser E2E: "Kilo lane confirmed — I'm running." `via Kilo Code · nvidia/nemotron-3-ultra-550b-a55b:free`; catalogs re-discovered every 30 min so lanes keep working as providers rotate models; model-level fallback + cascade; `MIST_KEYLESS=0` opts out |
| **Never crash** — total provider failure degrades to deterministic `[offline-mind]` | Proven by pulling the plug on every provider in tests |
| **Choose its own GLM** — Settings → Mist Core models: text + vision selectors, 16 text + 9 vision catalog newest→oldest | Selection is REQUESTED on every call; live chips show what the gateway actually served (it currently overrides — MIST reports that honestly, amber warning included) |
| **Remember** — long-term facts (SQLite) + lexical vector impressions + auto-remember from conversations | Fact round-trips, vector recall distance 0, `memory_set/get/all` tools |
| **Remind** — REAL due-time reminders fired into the chat | `set_reminder` with ISO due time → 60s heartbeat fires ⏰ alert → toast + persisted thread message (proven live E2E) |
| **Act** — agentic multi-round tool loop (6 rounds, envelope protocol, anti-echo) | "21\*2" → `⚡ calculate` chip → correct answer |
| **Research with citations** — query planning → multi-query web search → domain credibility scoring → page reading → cited synthesis | `deep_research` tool; junk domains never cited; `verified ✓` marks actually-read sources |
| **Read the web** — page_reader extraction, clean text | `read_page` tool |
| **Browse + computer-use** — own headless Chromium (Playwright pilot :3030): navigate, click (ref/selector/coords), type, scroll, screenshot, extract | Proven live: wikipedia.org → Main Page → AI article; cockpit click-to-act maps screen coordinates to real clicks |
| **Proactively open media** — videos/articles auto-open as in-app glass tabs with seek support | YouTube results → tab + embed + "queued this for you" |
| **Never dead-end** — capability_check + option cards before any refusal | "Post a tweet" → real alternatives offered, never a flat no |
| **Learn skills** — save any successful tool run as a reusable skill; trigger-matched injection; chain tools | `quick-math` skill saved from real execution → retriggered → `9 cubed is 729` |
| **Import the skills ecosystem** — OpenClaw/Anthropic-style SKILL.md (frontmatter `name` + `description`) dropped into `db/skills/` loads natively | Ecosystem importer in skills-service (first-sighting import, DB stays source of truth) |
| **Voice loop** — mic → WAV → STT → thought → reply → TTS → Web Audio autoplay | Hold mic or **Alt+V**; `glm-tts` voices |
| **Streaming voice (Mark-LV port)** — replies speak chunk-by-chunk: a small lead chunk starts the audio while the rest still synthesizes (measured 20.4s → 11.3s to first word on a long reply, then continuous speech); long pauses trimmed (500ms cap); GLM failure mid-sentence → the REMAINING text rescues on keyless engines without repeating what played | Automatic for every spoken reply; longest pauses gone |
| **Instant acknowledgment (Mark-LV port)** — long-task voice requests (research/search/write/…) get a spoken "On it — give me a moment" the instant thinking starts — no silent waiting | Voice loop, automatic |
| **Lane cooldowns (Mark-LV port)** — a 429'd/503'd provider lane is rested (5min/30min/6h by failure type) instead of retrying at full cost on every call; all lanes cooling → tries anyway | Automatic in the cascade; skips counted |
| **Sticky-success lanes (Mark-LV wave-2)** — the lane that answered last turn leads this turn (chat AND mission cascades), so dead lanes are never re-walked | Live: quick check served via nvidia in 4.1s / 1 step / zero failed-lane attempts |
| **Real voice selection (Mark-LV wave-2)** — 10 REAL Google prebuilt voices (Charon · Puck · Kore · Fenrir · Aoede · Zephyr · Leda · Orus · Sao · Iapetus) synthesized BROWSER-DIRECT with the creator's own Google key (same-origin key route; probe-first; region-blocked browsers honestly fall back to the glm→edge→gtranslate chain) | Settings → Voice engine → Gemini direct; engine-aware voice catalog; probe status line; live fallback verified |
| **Tap to interrupt / cancel (Mark-LV wave-2)** — tap the orb while she speaks → instant silence (in-flight synthesis chunks discarded, not zombified); Stop button / Escape / orb tap while she thinks → the sent message is cancelled end-to-end (socket abort kills the LLM fetch; no zombie reply ever renders) | Live: "— cancelled —" note, composer unlocks, late reply dropped |
| **Voice barge-in — talk over her (Mark-LV wave-4)** — the teacher's echo.py ported to TypeScript: while she speaks, a mic probe with the browser's acoustic echo cancellation listens; band-projection subtraction + a learned echo floor/head (self-calibrating per room, honest BLOCKS_NOISY in bad rooms) decide "a different voice, not her echo" — and cut her off mid-sentence back to listening, once per speaking turn | src/lib/echo-guard.ts (faithful port: MIN_USER 0.15, HEAD_Q 97, warmup 16 blocks, relearn run 28); wired into the voice session speaking phase |
| **Always listening (wave-4)** — "Hey Mist" wake word defaults ON (one-time migration flips the old default-off), survives mic-permission denial (engine waits, guidance shown), and ignores wake hits in her own voice tail (self-echo guard) | Live: pref persists true through reloads; wakeHit drops hits while mistSpeech.speaking |
| **Welcome-back briefing (Mark-LV wave-4)** — open her after a restart or >20 min away and she is NEVER dormant: she greets (time-aware), recaps what actually happened (alerts, missions, autonomy events, teacher notices — DB-proven), brings fresh news (web_search, 30-min cache), and SPEAKS it; a 5-min seen-ping keeps same-session reloads quiet; "Brief me" button re-triggers on demand | Live: two briefings delivered in-voice ("07:25 — back online after the restart…"; news lane worked on the second: real Washington/Raleigh items), honest degraded fallback when lanes are down |
| **Spoken warnings + PC notifications (wave-4)** — critical machine-health alerts (RAM, disk, heat, Defender, failed logons, Hermes gateway down) are SPOKEN out loud (her voice, newest-wins) AND fired as OS desktop notifications (Web Notifications API, permission from the bell panel, click focuses the app); important alerts reach the PC panel silently; info stays in-app | Severity classifier in src/lib/alert-priority.ts; delivery in use-alerts (toast + speech + OS + chat + feed); silent:true on OS toasts — her voice is the sound |
| **Notification bell + catch-up panel (wave-4)** — navbar bell with unread badge; the panel lists the last 40 alerts (kind chips, severity colors, relative time, "spoken + pc / pc panel / quiet" delivery labels), mark-all-read, both delivery toggles, and the Brief me button; missed notifications are catchable forever | Live: 9-unread badge, 40-item history rendered, toggles round-trip |
| **Local-host machine watchdog (Mark-LV wave-4)** — when the creator's bridge is disconnected, the guardian samples the machine the sandbox actually runs on (CPU/RAM/disk via telemetry) with the same thresholds + 1-hour re-warn — RAM/storage warnings are REAL everywhere, honestly labeled sampledFrom:local-host | PROVEN LIVE during E2E: "⚠️ CPU sustained at 100% — heaviest: chrome, bun, chrome" raised + delivered through the alert path |
| **Hermes command center (wave-4)** — the creator's business agent, front and center in Diagnostics → Agents: live status (installed/version/gateway/skills), one-line delegation (hermes_ask), skills + cron peeks, 60s cache; a 10-min heartbeat watch alerts on STATE CHANGES (gateway down = spoken critical); hermes-operator skill teaches her the command protocol (status first, self-contained delegation, async for slow jobs, never fake bridge data) | Bridge-connected probe honest (installed:false reported as-is); /api/mist/hermes + hermes-card.tsx + heartbeat step 7 |
| **Training grounds (wave-4)** — 12 training missions distilled from the byte-by-byte OJ + Mark-LV study (research-first, answer-first, work-while-chatting, spoken warnings, confirmation discipline, undo discipline, self-knowledge, proactive check-in, teach-1-learn-10, mistake postmortem, Hermes command, memory hygiene): copy the prompt into chat (the creator's way) or run as origin:'training' missions — the pedagogy rides the planner/actor prompts (generalize into training.rule.* memories, no petting, no repeated failures, research first) and past rules ride every new training plan | Diagnostics → Sub-agents → Training Grounds; missions route accepts origin:'training' |
| **Research ritual (wave-4)** — standing order wired into the mission planner (ALL origins): dev/coding/high-stakes plans MUST open with a web_search verifying current 2026 best practice; research-first skill documents the ritual for her chat self; the builder applies the same discipline (validated: barge-in/AEC + Notifications API researched before building) | MISSION_PLANNER research rule + db/skills/research-first.md |
| **Escape every fullscreen (Mark-LV wave-2)** — any ai-visualizer face that takes the whole screen shows a visible "× exit fullscreen (F)" pill | Live round-trip in-app: F → button visible → click exits clean |
| **Watch her teacher's repo (Mark-LV wave-2 anti-rust)** — FatihMakes/Mark-LV watched forever like OpenJarvis: 30-min scans, ff-only pulls (never forced), changes auto-ingested as knowledge + 🔄 alert, Upstream tab card | Live: watching c3e795a, sweeps counted, `mark_lv_sync_status` tool |
| **Chrome-stable glass (Mark-LV wave-2)** — grain/blur compositing hardened for Chrome specifically (blend-mode removed from the animated grain, per-word blur animation dropped, aurora layers GPU-isolated) — the Chrome-only flicker is gone at the source | Computed styles verified live; Brave/Firefox unaffected |
| **Milliseconds fast-path (Mark-LV wave-3)** — simple prompts (hello / how are you / thanks / who are you / what's my PC status) answer from the instant layer: authored Clare-voice canned lines + FastReply replay cache + LIVE telemetry status reports — ZERO cascade, ZERO tokens, honest "Instant Recall" attribution | Live: "hello" 86-194ms HTTP · 164ms via socket · status ~100ms with live CPU/RAM/disk · tool-intent never fast-pathed |
| **Instant VOICE (Mark-LV wave-3)** — SpokenCache (sha256 engine+voice+speed+text → wav) makes every spoken reply instant on repeat; the canned catalog is background-pre-warmed so "hello" speaks immediately even the first time | Live: TTS 2.64s first → 0.12s cached (byte-identical); stream route 0.25s steady-state |
| **Live activity display (Mark-LV wave-3)** — she shows what she is doing RIGHT NOW: "thinking" → "reading package.json" → "searching the web — query" → "delegating to hermes" — real labels from her actual tool args, streamed over the neural socket to the chat thinking-row and under the consciousness orb | Live: tool turns observed verbatim thinking → calling owner files → calling mist self read |
| **Mouth-tracking Visage face (Mark-LV wave-3)** — M.I.S.T.'s own clean-room 5th face: Mark-LV's formant viseme physics (F1/F2 band analysis of her REAL audio + tau-based mouth dynamics 22/12/55/18ms) driving a sophisticated abstract face — blinking state-aware eyes, gaze behavior, morphing lips with teeth-hint and throat glow | Live: 137 mouth frames sampled mid-speech, openness 0.13→0.81 per syllable, width −0.33→+0.77; VLM: "clean and sophisticated" |
| **Teacher-update notices (Mark-LV wave-3)** — when the teacher's repo moves, CLARE writes the creator a note herself (what changed · her honest opinion · the ask) and it lands in the Upstream tab + alert flow with PORT IT / NOT NOW answer buttons | Live: notice generated verbatim in her voice; decide flow round-trips to the DB |
| **Token-conserving smalltalk lane (Mark-LV wave-3)** — conversational simple prompts that miss the cache ride a tiny 3-sentence persona context instead of the full persona+136-tools+memory prompt | Automatic; thousands of tokens saved per small-talk turn |
| **Speak its mind** — 60s heartbeat: due reminders → ⏰ chat alerts; liveness state surfaced in Evolve tab + `mist_self_status` | Live: beating=true, reminders fired counter, delivery trail |
| **Stay fresh (anti-rust)** — watchlist (openclaw/openclaw via npm + anthropics/skills via commit Atom feed) swept every 6h + on demand; silent first-sighting baseline; 📦 chat alerts on real changes; OpenClaw digest auto-sync every 12h feeds the evolution engine | Live: openclaw 2026.9.5 + anthropics/skills 34040c9 baselined; `check_updates` forces a sweep |
| **See itself** — `mist_self_status` (heartbeat, reminders, evolution stats, watchlist, registry), `mist_self_read` (own source + ledgers, policy-confined) | Tools live in the registry |
| **Check its own build** — `mist_self_build` runs the same lint gate every self-patch must pass | ESLint + Next rules, exit-status honest |
| **Report its own repo state** — `mist_self_update`: local HEAD, last commit, dirty files; read-only (never pulls/deploys) | Honest "no upstream remote" in this sandbox |

## 🧬 CAN — the OpenJarvis layer (ported from github.com/open-jarvis/OpenJarvis, full dissection → 6-agent port)

| Capability | Where / how |
|---|---|
| **Show its thinking receipt** — per-message XRay telemetry: complexity score → routing tier, tokens, latency, cost estimate, full step timeline (every provider attempt, tool call, honest failure) | Expand the **xray** strip under any chat reply |
| **Route by complexity** — 0–1 scorer (OpenJarvis's exact weights) → instant/standard/deep/research lanes with token budgets; loop guards stop runaway agent turns, repeats, ping-pong | Automatic on every thought; policy note in XRay |
| **Own a knowledge base** — hybrid BM25 + vector search (RRF fusion), heading-aware chunking, ingest via chat or API; she cites it | `knowledge_search` tool · Diagnostics → Knowledge · POST /api/mist/knowledge/* |
| **Connect sources** — 14 connectors: live upload/obsidian/notes/hackernews (+github when not IP-rate-limited), honest-unconfigured gmail/gdrive/slack/notion/etc with setup notes | Diagnostics → Knowledge · POST /api/mist/connectors |
| **Carry a persona** — SOUL/MEMORY/USER markdown layers (trust-gated: quarantined memory never reaches prompts) | db/persona/*.md — auditable plain files |
| **Compress long sessions** — LLM summary of the middle, first user + recent tail kept (14109→771 tokens measured) | Automatic in context building |
| **Grow skill overlays** — few-shot examples synthesized per skill from past executions (DSPy-style, LLM not GPU) | db/skills/overlays/ · activates after a skill executes |
| **Run operators** — 4 always-on scheduled agents: morning-brief (08:00), repo-watch (6h), memory-curator (24h), skill-hygiene (24h); budgets + honest statuses | Diagnostics → Operators · POST /api/mist/operators/[id] |
| **Gate risky actions** — tiered approvals (auto/standard/destructive) with permission memory ("always allow/deny" fingerprints) | Approval bell in the shell · POST /api/mist/approvals/[id] |
| **File digests** — LLM-written brief of watchlist/alerts/operators/notes; scheduleable via cron | Diagnostics → Operators · POST /api/mist/digest |
| **Speak MCP + A2A** — mesh-service on :3004: JSON-RPC MCP server (6 real SSRF-guarded tools) + A2A agent card | GET /api/mist/mesh · localhost:3004 direct |
| **Rate-limit itself** — token bucket + sliding window per surface (chat 20/min, tools 60/min, research 5/10min) | src/lib/oj/rate-limiter.ts |
| **Audit its data boundary** — 14 real findings across db/notes/vaults/keys/traces with mitigations | GET /api/mist/data-boundary |
| **Trace everything** — every LLM call + mission lands in Trace/TraceStep with outcome attribution | Diagnostics → Traces · GET /api/mist/traces |
| **Count its own efficiency** — requests/tokens/latency/cost per provider/agent/day (honest chars/4 estimates; core lane $0) | Diagnostics → Stats · GET /api/mist/analytics/efficiency |
| **Auto-update itself from OpenJarvis upstream** — 5-stage pipeline: DETECT (git ls-remote, 30-min sweeps) → FETCH (commits/diff/changelog + ff-only clone sync) → MAP (32-prefix port map → module impact) → ADAPT (knowledge deltas auto-ingested + LLM brief + alert; structural changes auto-file evolution proposals through the gated pipeline; `MIST_OJ_AUTO_PATCH=on` auto-develops them) → SURFACE (Upstream tab, `oj_sync_check/status/apply` chat tools, alerts) | Diagnostics → Upstream · GET/POST /api/mist/oj/sync · baseline open-jarvis/OpenJarvis@5e5f5ef |
| **Wield 136 tools** — 15 new OpenJarvis-ported chat tools live in the registry (knowledge_search, scan_chunks, memory_manage, user_profile_manage, check_permission, queue_action, get_pending_actions, record_decision, schedule_task, list_scheduled_tasks, digest_collect, skill_manage, oj_sync_check, oj_sync_status, oj_sync_apply) | She used knowledge_search unprompted in E2E with citations |

## 🛠 CAN — code itself (with your finger on the trigger)

Ask in chat (`mist_self_patch`) or via **Diagnostics → Evolve**: M.I.S.T. inspects its own source → plans exact change steps (LLM self-repair rounds verify every `find` against real file contents) → **you approve** → in-memory atomic patch compute (overlapping edits abort before a byte hits disk) → backup → apply → **lint gate** → auto-rollback if broken.

- **Proven live**: proposal "Enhanced Agent Status Monitoring" → 2 surgical patches to `agents-tab.tsx` → applied + lint-clean + hot-reloaded (M.I.S.T. modified its own running code).
- **Proven safe**: escape attempts outside the build root blocked; `.env`/`package.json`/`prisma/`/`Caddyfile`/`worklog.md` hard-blocked; unconfirmed patches refused; broken patches auto-roll back with nothing left behind.
- **Proactive**: ideation every 6h (openclaw-release-inspired first, else self-ideas) surfaces as pending proposals + navbar amber badge; `mist_backlog` collects "what should we build next?" ideas from you and from M.I.S.T.
- **It never restarts or deploys itself.** It tells you when a restart would help.

## ⚙️ CAN — when configured on your machine

| Capability | Unlocks with |
|---|---|
| **Qwen brain** (real models — 19 text + 8 vision, newest→oldest; never an alias: the Z.ai gateway cannot serve Qwen, so MIST uses real OpenAI-compatible endpoints) | `MIST_QWEN_API_KEY` (DashScope) or `MIST_QWEN_BASE_URL` (any compatible endpoint / local Ollama) |
| **OmniRoute MCP tools** (9 curated; write tools confirm-gated) | OmniRoute gateway on :20128 |
| **Delegate to external coders** — OpenClaw CLI (`openclaw agent exec "task"` — the documented headless entry point), Claude Code, Codex, Gemini CLI | Install the CLI on the deployment machine; honest not-installed reports otherwise |
| **Local Whisper/Kokoro voice models** | Future option (SDK voice is already fully active with zero installs) |

## ❌ CAN'T — honest limits

- **Serve Qwen through the Z.ai gateway** — probed live: every request returns glm-4-plus. MIST will not relabel GLM as Qwen. Use the real Qwen provider above.
- **Honor your GLM pick if the gateway overrides it** — the selection is always REQUESTED; the gateway currently routes everything to glm-4-plus/glm-5v-turbo. Settings shows ground truth with amber override warnings; if the gateway starts honoring the param, the picker takes effect with zero changes.
- **Post to social media / send email autonomously** — no such write credentials exist here; MIST offers capability_request options (drafts, browser-assisted flows) instead.
- **Run arbitrary shell commands from chat** — commands are whitelisted; tool executions are argv-spawned (no shell); OmniRoute + self-patch writes are confirm-gated.
- **Apply self-modifications silently** — every mutation needs your approval; the apply path is UI-gated by design.
- **Restart or deploy itself** — it reports; you decide.
- **Guarantee upstream availability** — npm registry / GitHub / Atom feeds / the gateway can be unreachable; every watcher records errors per-entry and retries on schedule (silent, never crashes).
- **Watch rate-limited GitHub API from this IP** — the watchlist's atom channel (commit feeds) is used instead; no auth, no limits.

## 🔒 Security model (adopted from OpenClaw: trusted gateway, untrusted execution)

- Chat can CREATE evolution proposals but never APPLY them (deterministic policy).
- Writes confined to `src/`, `mini-services/`, `db/skills/`, `db/notes/` — everything else hard-blocked.
- In-memory compute → backup → apply → lint gate → auto-rollback; every step reason-logged.
- Secrets never leave the machine; presence booleans only; file tools root-confined; web calls time out.
- Heartbeat/watch loops: one per process (globalThis-guarded), unref'd, errors swallowed per-beat.

*Ledger maintained by the build agents; updated with every capability change (see `worklog.md` and `MIGRATION_STATE.md`).*

## Wave 5 — voice in milliseconds (2026-10-02)

- Wake phrases widened: "hey mist" · "hey miss" · "hey m" · bare "mist" (word-boundary guarded — "hey mom"/"misty" never fire).
- STREAMED REPLY PIPELINE (end-to-end): unified route emits NDJSON `{"type":"chunk"}` lines of clean prose while the model still generates → neural service forwards them as `consciousness_chunk` socket events (same ordering guarantees as the response) → clients stream.
- ReplyStreamFilter (llm-service): raw model deltas → clean spoken prose live. Envelope-aware (streams the `{"reply":…}` string content, never the JSON/citations), tool-call-suppressing, intent-narration-guarded (a "Sure, I'll check that" the service would reject is never spoken), with honest partial-on-stream-break semantics (the spoken prefix is always the truth).
- Streaming lanes: Mist Core (z-ai SDK SSE), every OpenAI-compatible keyed lane, all keyless lanes — with idle-based timeouts and graceful non-stream fallback when a server ignores stream:true.
- VOICE-mode routing: core leads the cascade for voice turns (probe-verified ~1s first token vs 4-6s keyless prefill); chat keeps the cost-first order.
- Incremental speaker (speech.ts): sentence-chunked TTS that starts synthesizing the moment a sentence completes — chunk N+1's audio downloads while chunk N plays. First words audible at ≈ first-token + first-sentence + one short-sentence synth, instead of after the FULL completion.
- Live subtitles (voice stage): the sentence she is speaking is BOLD and bright with a minimal 500ms color transition; spoken ones dim back, queued ones wait; auto-scrolls to the active sentence. During generation the reply text streams onto the stage (under the activity line) — never a blank stage.
- Chat progressive preview: complex replies stream into a live preview bubble under the thinking row; the final message replaces it whole.
- Verified latencies (socket probes, real provider round trips — not caches): voice-mode first chunk 2.38s via core (was: full-completion wait 5-25s + full-utterance TTS); complex chat lead up to 11.5s (23.5s reply, first chunk at 12.0s cold-walk); "hello" fast-path unchanged at 29ms.
