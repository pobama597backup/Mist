# M.I.S.T. UNIFIED — MIGRATION STATE

**Build root:** `/home/z/my-project` (platform sandbox — see Conflicts below)
**Current phase:** PROJECT COMPLETE (all 12 phases verified — see Acceptance below)
**Updated:** final, at completion

---

## Environment conflicts (spec 0.9 — spec preferred, runtime reality noted)

| Spec assumption | Runtime reality (this sandbox) | Resolution |
|---|---|---|
| Windows + PowerShell, `C:\Users\HP\Downloads\MIST-UNIFIED\` | Linux sandbox `/home/z/my-project` | Build root = project root. `run.bat/stop.bat/restart.bat` still created (adapted to bun), untested here |
| FastAPI + uvicorn on :3000 serving API + static dist | Platform mandates Next.js 16 App Router on :3000, served by dev server; **never** `bun run build` | All `/api/mist/*` endpoints are Next.js route handlers. App served with HMR (spec 0.7 production-build rule waived by platform) |
| Python 3.14, psutil, SQLite raw, ChromaDB | Bun 1.3.14 / Node 24.21.0 / Python 3.12 present but platform is TS-native | Prisma + SQLite (`db/custom.db`); vector memory = local lexical TF-cosine engine ("mist_vectors") that degrades gracefully — no ONNX/Chroma deps |
| Whisper + Kokoro local models (~3GB approval gate, Phase 9) | `z-ai-web-dev-sdk` provides ASR (`zai.audio.asr.create`) + TTS (`zai.audio.tts.create`) backend-side with **zero installs** | Voice loop fully active via SDK (mic → WAV → STT → thought → response → TTS → Web Audio). Local-model path documented as future option; no 3GB download performed (nothing >100MB downloaded) |
| LLM via env-configured providers only; zero-key → offline-mind | SDK LLM ("core") is always available server-side | Cascade: omniroute → openai_compatible → openrouter → anthropic → gemini → **core** → offline-mind. Zero env keys still yields a working brain via core; offline-mind catches total failure |
| WS `/ws/neural` on the main process | Platform: realtime must be a socket.io mini-service | `mini-services/neural-service` on :3003, client `io("/?XTransformPort=3003")`, `path:'/'` (frozen) |
| New dependency installs need approval | `socket.io-client` (+`socket.io` in mini-service) required by the platform's realtime mandate | Installed and disclosed here; no other deps added |
| OmniRoute gateway at :20128 | Not running in sandbox | mcp_service probes with 2.5s timeout, caches 30s, lists curated tools with `available:false`; write tools gated behind `confirmed:true`; proven degradation |

## Phase status

- [x] PHASE 1 — Scaffold & serve — PASS (`/health` ok; app served on :3000; launchers created)
- [x] PHASE 2 — Memory — PASS (fact POST→GET→DELETE round-trip; vector search graceful empty + live recall distance 0)
- [x] PHASE 3 — Tools — PASS (21 base tools: 16 live + 5 stubs; system_info returns real numbers; stubs return clean messages)
- [x] PHASE 4 — LLM brain — PASS (status leaks no secrets; zero-key path works via Mist Core; offline-mind deterministic; tool loop proven: "21*2" → tools_used ["calculate"])
- [x] PHASE 5 — Neural streams — PASS (WS handshake on :3003 through gateway; thought → consciousness_response with memory_context; SSE emits events)
- [x] PHASE 6 — Frontend shell — PASS (chat E2E over WS with provider badges; drawer functional; zero horizontal scroll at 1280×720 and 390×844)
- [x] PHASE 7 — Conversations persistence — PASS (create thread → chat → reload → click thread → full history with badges)
- [x] PHASE 8 — Premium redesign — PASS (VLM review: "exceptionally premium and polished… top-tier AI console"; hydration mismatch + autoplay-toast + mobile padding fixed)
- [x] PHASE 9 — Voice activation — PASS via SDK route (TTS `POST /voice/tts` 200 audio/wav ~64KB, autoplay fired in UI; STT endpoint round-trips WAV; no 3GB download performed)
- [x] PHASE 10 — OmniRoute MCP — PASS (9 curated tools listed; gateway-off → available:false, clean error, no retry-storm; write tools gated behind confirmed:true)
- [x] PHASE 11 — Learning loop — PASS (skill "quick-math" saved from real execution; trigger "quick math calculation" → skills_used ["quick-math"] + tools_used ["calculate"] → "9 cubed is 729")
- [x] PHASE 12 — Hardening & demo — PASS (lint exit 0; browser E2E: 0 console errors, 0 page errors; README + demo script written; this file final)

**Definition of done (Section 1): MET.** Premium dark glassmorphic app on :3000 · three surfaces only · living NeuralCore with all six states · persisted threads · self-managing providers · self-growing skills · zero-key operation · local-only binding.

## File inventory (foundation — owned by lead)

- `prisma/schema.prisma` — Conversation, Message, LongtermMemory, MemoryQueue, VectorMemory, Skill
- `src/lib/types.ts` — **FROZEN** REST + WS contracts (single source of truth)
- `src/lib/mist-constants.ts` — provider labels, state colors, TTS voices
- `src/lib/mist-api.ts` — typed API client (only frontend↔backend path)
- `src/lib/store.ts` — zustand shell state (view/drawer/neural mirror/threads/prefs)
- `src/lib/audio-utils.ts` — mic recorder + 16k mono WAV encoder
- `src/hooks/use-neural.ts` — singleton socket.io session + listener registry
- `src/hooks/use-backend.ts`, `src/hooks/use-telemetry.ts` — health/telemetry pollers
- `src/app/globals.css` — dark-native tokens, glass system, scrollbars, keyframes, reduced-motion
- `src/app/layout.tsx` — Inter + JetBrains Mono fonts, metadata
- `src/components/mist/synapse/synapse-monitor.tsx` — stub (Task 3-c overwrites)
- `mini-services/neural-service/` — socket.io :3003, frozen protocol, relays to `/api/mist/llm/unified`
- `db/custom.db` (SQLite), `db/skills/`, `db/notes/`

## Decisions

1. WS protocol extended (documented in types.ts): `provider_set`, `synapse`, `error` server events; `thought` may carry `conversation_id` + `history`. Both ends shipped together, so the contract is frozen as shipped.
2. Skills: Prisma `Skill` table is source of truth; service also mirrors SKILL.md files into `db/skills/` per spec format.
3. `vision` unified mode currently text-only (no image attach UI per spec Section 4).
4. Explicit selection of an unconfigured provider falls through to `core` (badge shows what actually served).
5. Frontend consumes synapse events over the same socket.io connection; the SSE endpoint `/api/mist/synapse/stream` exists for spec contract compliance.

## Quirks

- `db.ts` logs Prisma queries in dev (template default) — noisy but harmless.
- Next dev may warn about cross-origin `allowedDevOrigins` — cosmetic.
- Neural service holds no DB access; all persistence flows through Next.js API.

---

## Post-completion upgrades (evidence ledger)

### v2 — Agent Grade (Tasks 8-11)

- **E2.1** browser-pilot mini-service (:3030, Playwright 1.57 headless Chromium, 10 endpoints, mutex-serialized, crash-relaunching) — verified: navigate/click/type/scroll/screenshot on wikipedia.
- **E2.2** Deep research pipeline (query planning → multi-query web_search → credibility scoring → page_reader → cited synthesis) — `POST /research` maxDuration 300.
- **E2.3** Capability negotiation (capability_check tool + capability_request option cards) — "post a tweet" test passed with real alternatives, never a flat refusal.
- **E2.4** Agent bridge (Claude Code / Codex / Gemini CLI / Aider) — which-probe + headless argv spawn, honest not-installed reports (all 4 not installed here, reported honestly).
- **E2.5** In-app browser window (video embeds with seek, reader articles, live cockpit with click-to-act) + auto-open media tabs.
- **E2.6** Chat v2: citations chips (quality-colored, verified ✓), media cards, suggestion chips, meta persistence; 6-round tool loop with envelope sanitizers + parseJsonLenient.
- **E2.7** E2E via agent-browser through the :81 gateway: 0 console/page errors, mobile 390px + desktop 1280px clean, persistence verified in DB.

### v3 — Qwen + OpenClaw + self-evolution (Task v3-1)

- **E3.1** Gateway probes: qwen-max / qwen3-235b / qwen2.5-72b ALL served glm-4-plus → gateway cannot serve Qwen → real-endpoint provider designed instead (DashScope default, any base URL, keyless local Ollama). No aliases.
- **E3.2** `qwen-models.ts`: 19 text + 8 vision REAL Qwen ids newest→oldest; env keys live-applied; honest attribution of `response.model`.
- **E3.3** OpenClaw research: full README (113KB) fetched; shallow clone measured 897MB → REJECTED; digest approach (npm registry + CHANGELOG release notes ≈50KB) chosen. Watchtower syncs every 12h.
- **E3.4** Evolution engine (self-coding): deterministic policy, LLM self-repair rounds, in-memory atomic apply, backup → lint gate → auto-rollback. LIVE PROOF: "Enhanced Agent Status Monitoring" applied to agents-tab.tsx (lint-clean, hot-reloaded); earlier attempts correctly blocked/rolled-back (overlap guard 0 disk writes; JSX brace lint failure restored).
- **E3.5** Proactive ideation loop (6h, paused at ≥4 pending) + navbar amber badge + 7th drawer tab (Evolve).
- **E3.6** Qwen cascade verified honest: dummy key → auth failure → fell through to core · glm-4-plus with truthful badges.

### models-1 — Real GLM attribution + selectable Mist Core models

- **EM.1** Live probes: text endpoint reports `glm-4-plus`, vision `glm-5v-turbo`, TTS `glm-tts`; gateway OVERRIDES client model param (5 distinct requested models all served glm-4-plus); no /models listing (404); aggressive rate limits (429 after ~5 rapid calls).
- **EM.2** `core-models.ts` catalogs (16 text + 9 vision newest→oldest, tier labels, live_verified badges); callCore forwards selection, routes vision mode through createVision, captures the gateway-reported model per completion; messages attributed with the REAL model (unified API → WS → chat bubble → persisted Message.model).
- **EM.3** Settings section (two selects + live-serving chips with amber override warnings); env keys MIST_CORE_TEXT_MODEL / MIST_CORE_VISION_MODEL live-applied. Browser-verified end-to-end.

### v4 — Heartbeat + watchlist + self tools (Task v4-1)

- **E4.1** Prisma: MemoryQueue.dueAt/firedAt + Alert model; `set_reminder` upgraded (when_iso → real due time; honest "will NOT auto-fire" without one).
- **E4.2** heartbeat-service: 60s globalThis-guarded loop — due reminders → ⏰ Alert rows; watchlist sweep every 6h; liveness state file. LIVE PROOF: reminder armed via the real tool path (due 06:11:37Z) → beat at 06:11:59 fired it (reminders_fired: 1) → the frontend poller delivered it (toast + thread persistence).
- **E4.3** watchlist-service: db/watchlist.json seeded openclaw/openclaw (npm channel) + anthropics/skills (GitHub commit Atom feed — no API rate limits, that repo has no tags); silent first-sighting baseline; real changes → 📦 alerts + openclaw digest refresh. LIVE: baselines recorded (2026.9.5 / 34040c9c5685) on first sweep.
- **E4.4** 7 new chat tools (registry 39 → 46 base, 56 total with omni + skills): mist_self_status, mist_self_read (policy-confined + ledger allowlist), mist_self_patch (planUserPatch → developed proposal, apply stays UI-gated), mist_self_build (lint gate), mist_self_update (read-only git freshness — honest "no upstream remote" here), mist_backlog (idea list/add/remove), check_updates (forced sweep + per-repo report).
- **E4.5** openclaw_agent added to the agent bridge (registry entry `openclaw agent exec "task"` — the documented headless entry point; honest not-installed report in this sandbox).
- **E4.6** Skills ecosystem importer: OpenClaw/Anthropic-style SKILL.md frontmatter (name + description) in db/skills/ loads natively on the next listing (60s scan guard, first-sighting import).
- **E4.7** Frontend: use-alerts poller (30s + focus) — toast + always-lands-in-history persistence (active thread → else latest → else dedicated "M.I.S.T. Alerts" thread) + 'mist:alert' live render; watchlist card + heartbeat line in the Evolve tab; alerts + watchlist API routes; health route bootstraps all three watch loops.
- **E4.8** Type hygiene: fixed pre-existing strict errors (qwen label in PROVIDER_LABELS; globalThis watch guards in evolution/openclaw; OpenClawStatus.last_changed_at; llm-service SDK message typing; tsconfig excludes non-app dirs) — `bunx tsc --noEmit` now exits 0 project-wide for the app; lint clean.
- **E4.9** Ledgers: CAPABILITIES.md created (honest CAN/CAN'T), README fully refreshed, this file extended.

### v5 — OpenJarvis full integration (Tasks oj-master-plan → wave 3)

**Reference clone:** /home/z/OpenJarvis @ 5e5f5ef (dissect-only; only the sync engine fetches into it, ff-only)

- **OJ.1 Dissection:** 4 parallel agents mapped all 683 Python files + frontend + configs + docs; CHANGELOG top-10 + pyproject extras digested into the integration plan (worklog lines 1816–2043).
- **OJ.2 Prisma layer:** Trace, TraceStep, KnowledgeChunk, Approval, PermissionMemory, Operator, Digest + LongtermMemory.trust — pushed before wave 1 (schema lead-frozen after).
- **OJ.3 Wave 1 (4 agents):** spine (event bus, complexity router w/ OJ weights, loop guard, error taxonomy, SSRF/injection guardrails, trace service — llm cascade + executeTool + missions instrumented additively) · mind (knowledge store BM25+vector RRF, 14 connectors, 3-layer persona, session compression 14109→771 tokens, skill overlays) · ops (4 operators on the heartbeat tick, tiered approvals + permission memory, digests, workflow DAG) · mesh (mini-service :3004 — MCP JSON-RPC 6 tools + A2A card, 31-channel registry, rate limiter, data-boundary scan 14 findings).
- **OJ.4 Upstream self-update (oj-sync-7, creator's order):** 5-stage pipeline DETECT→FETCH→MAP→ADAPT→SURFACE; 30-min ls-remote sweeps; ff-only clone sync; 32-prefix port map (db/oj-port-map.json); knowledge deltas auto-ingested + LLM brief + alert; structural changes → evolution backlog proposals (gated apply; MIST_OJ_AUTO_PATCH=on auto-develops); oj_sync_check/status/apply chat tools + /api/mist/oj/sync + Upstream tab. Baseline: open-jarvis/OpenJarvis@5e5f5ef, honest no-change reports.
- **OJ.5 Wave 2 (2 agents):** chat UX (XRay per-message telemetry + trace timeline, tool-call cards, research timeline, system pulse, approval bell, Ctrl+Shift+P power palette) + lab tabs (Upstream/Traces/Stats/Knowledge/Operators in the diagnostics drawer — 15 tabs total).
- **OJ.6 Wave 3 (lead):** KNOWLEDGE_TOOLS + OPS_TOOLS + SYNC_TOOLS wired into BASE_TOOLS (registry 121 → 136); tsc 0 errors; lint clean; ledgers updated.
- **OJ.7 E2E (agent-browser):** home clean (0 console/page errors); chat golden path — she answered "what is OpenJarvis" USING the new knowledge_search tool with citations [1][2]; XRay expanded live: step 00 knowledge_search 66ms → nvidia 503 → openrouter 429 → kilo success 12.5s, $0.00 est; Upstream tab live sweep (Check now → LAST SWEEP 9s ago); mobile 390px zero horizontal overflow.
- **Compulsory exclusions (documented honestly):** local model runtimes (no GPU — the 21-lane cascade IS the engine layer, the routing brain is what ported), hardware energy telemetry (tokens/cost/latency instead), Pearl mining + LoRA/DSPy training (LLM-driven optimization instead), 31 messaging channels (architecture + webchat live + honest adapters), OAuth connectors (local ones live), Tauri desktop + Rust crates (web-only), 42-model benchmark suite (personal regression gate instead).


### v6 — Mark-LV speed layer (Task marklv-1)

- **ML.1 Dissection:** FatihMakes/Mark-LV cloned to /home/z/Mark-LV — PyQt6 voice assistant; the wins worth porting were TTS chunk-streaming (producer/consumer), measured model ladders with typed cooldowns, instant acknowledgment, silence compression.
- **ML.2 Lane cooldowns:** src/lib/services/lane-cooldowns.ts + cascade wiring — 429→5min, 503/504→30min, auth→6h (error-taxonomy typed); cooling lanes demoted to last-resort rungs; "refusing to connect is never the better answer."
- **ML.3 Streaming TTS:** /api/mist/voice/tts/stream (NDJSON) + synthesizeSpeechStream with LEAD-chunk strategy (first ≤220 chars → speech starts ~2× sooner; follow-ups ≤400) + compressWavSilence (10ms RMS frames, 500ms pause cap) + mid-stream rescue of the REMAINING text. Client: speech.ts speakStreamed — per-chunk Audio queue, onStart only when the first chunk is audible, blob-path fallback.
- **ML.4 Instant ack:** use-voice.ts LONG_TASK_RE → short spoken ack the instant a long task starts thinking; honest state machine (ack→processing→reply speaking).
- **ML.5 Guard recalibration (pre-existing bug found by live probe):** degenerate-audio floor was 4 chars/sec; real GLM speech measures 13-17.6 chars/sec → every utterance silently rescued to Edge. Floor now 20 chars/sec (240wpm ceiling). GLM serves directly again.
- **ML.6 Live-verified:** 887-char reply → 3 chunks, first audio 20.4s→11.3s, 4.2s pauses trimmed, engine=glm direct; browser: 4× stream 200, zero console errors; tsc 0, lint clean.
- **Not ported (honest):** echo guard (mic is never open during her speech), Kokoro/EdgeTTS/ElevenLabs engines (rescue chain already present; Kokoro = future local option), viseme lip-sync (no mouth on the orb).

### v7 — Mark-LV wave-2: the creator's six fixes (Tasks mlv-recon-0 → mlv-lead-4)

- **MLV.1 Recon:** Google key live-probed — valid, but sandbox egress is HK = region-blocked for ALL live Gemini models; browser egress from the creator's region works. Architecture set: browser-direct Gemini, server cascade stays Google-free.
- **MLV.2 Real voice selection (mlv-voice-1):** new engine 'gemini' — 10 REAL Google prebuilt voices (Charon/Puck/Kore/Fenrir/Aoede/Zephyr/Leda/Orus/Sao/Iapetus), synthesized browser-direct via /api/mist/google (same-origin key) + src/lib/google-direct.ts (probe → PCM L16 24k → WAV, lead-220/follow-400 chunked producer/consumer). Honest region probe status in Settings; automatic fallback to the glm→edge→gtranslate server chain when Google is unreachable. Settings Voice select is engine-aware; voice choice finally changes her voice.
- **MLV.3 Back-end speed (mlv-voice-1):** sticky-success cascade ordering (the lane that answered last turn leads this turn — live proof: quick check served by nvidia in 4.1s / 1 step / zero dead-lane walks vs the old nvidia 503→openrouter 429→kilo crawl); chat path now ALSO has cooldowns (it had none — the E2E dead-lane trace was the chat path); gemini lane wired (gemini-3.8-flash default; one location-block hit = 6h auth-class rest).
- **MLV.4 Tap-to-interrupt + cancel (mlv-ux-2):** Mark-LV's 3-part interrupt web edition — orb tap while speaking silences her instantly (mistSpeech.stop now bumps speakSeq so in-flight synthesis chunks are discarded, not zombified); Stop button + Escape + orb tap while thinking cancels the sent message end-to-end (socket cancel_thought → AbortController kills the /llm/unified fetch → no offline-mind fallback on user abort → client drops any late reply). Live-verified: "— cancelled —", composer unlocks, essay never rendered.
- **MLV.5 Fullscreen escape (mlv-ux-2 + lead):** the 4 ai-visualizer faces now show "× exit fullscreen (F)" whenever they take the screen (in-app iframe round-trip verified live); face-stage iframe got allowFullScreen.
- **MLV.6 The thread-tab-covers-everything bug (lead, root-caused live):** chat-view's docked threads <aside> had NO width class — flex max-content sizing blew it to 21,703px at 1280px (conversation width 0, collapse button offscreen). Fixed with a w-60/xl:w-64/2xl:w-72 + overflow-hidden ladder → 256px aside, 976px conversation, X visible.
- **MLV.7 Chrome flicker (mlv-ux-2):** grain overlay lost mix-blend-mode: overlay (the 8×/sec background-position steps over dozens of backdrop-filter panels forced full-screen recomposites — the classic Chrome flicker; Brave's compositing path masked it), gained translateZ(0)+will-change; mist-word-in dropped the per-word blur filter animation (opacity+transform only); aurora blobs got will-change-transform.
- **MLV.8 Anti-rust (mlv-rust-3):** Mark-LV watcher — same discipline as the OJ engine (30-min ls-remote via shared interval config, ff-only pulls, never force; diverged → alert+skip), changes auto-ingested as knowledge (sourceId mark-lv-upstream, replace-on-update), db/mark-lv-sync.json state (OJ's db/oj-sync.json untouched — verified), mark_lv_sync_status tool (137 tools), /api/mist/oj/sync actions mark_lv_check/mark_lv_status, Upstream tab "the teacher's assistant" card. Watching c3e795a, 5 sweeps, next scan scheduled.
- **MLV.9 E2E (lead, agent-browser):** threads aside 21,703px→256px w/ X visible; chat reply via sticky nvidia 4.1s/1 step; Stop cancels mid-think with no late reply; Gemini engine + 10 voices listed, honest region-blocked status line, read-aloud falls back to server chain (stream 200); fullscreen → exit button visible → click exits clean; mobile 390px zero overflow; grain blend=normal computed; 0 console/page errors; tsc 0 errors; lint clean.
- **Honest limitation:** the sandbox preview browser is ALSO region-blocked by Google — Gemini-direct voices engage on the creator's own browser (supported region); everywhere else the rescue chain speaks. The key never enters the JS bundle (same-origin fetch).

### v8 — Mark-LV wave-3: full-parity sprint (Tasks w3-audit → w3-close)

- **W3.0 Sandbox-reset recovery (lead):** both reference clones were wiped by a snapshot reset — re-cloned Mark-LV (c3e795a) + OpenJarvis (5e5f5ef) at EXACTLY the watcher baselines (no false alerts). Exhaustive 39-file feature audit completed (the porting blueprint preserved in the w3-audit dispatch): mouth-HUD mechanism fully specified (formant visemes + tau physics + face-as-status), 25-item ranked gap list, 12 unported speed tricks.
- **W3.1 Spine (lead):** unified route speaks two protocols (JSON default unchanged; stream:true → NDJSON activity lines + result); ActivitySink threaded through unified→unifiedCore with toolActivityLabel() before every executeTool; fast-path hook + FastReply/SpokenCache/TeacherNotice Prisma tables (one db:push); 'mist-instant' provider attribution.
- **W3.2 Speed (w3-speed):** fast-path.ts full implementation (phrase-table classifier w/ hard guards, Clare-voice canned catalog, FastReply replay, live-telemetry status answers); SpokenCache on both TTS routes with background warm; tiny-context smalltalk lane. MEASURED: hello 86-194ms HTTP / 164ms socket; TTS cache 2.64s→0.12s; status ~100ms live data; controls verified (tool intent never fast-pathed).
- **W3.3 Activity (w3-activity):** neural-service streamUnified (NDJSON → throttled socket 'activity' events, cancel-safe, defensive fallback); ActivityLine shared component (pulsing teal dot, 300ms swap keyframe, aria-live, local state); wired in chat thinking-row + under the consciousness orb. Lead upgraded toolActivityLabel to 30+ real-registry tool mappings (op-aware owner_files labels etc.).
- **W3.4 Mouth (w3-mouth):** audio-bus fftSize 1024 + mistAudioFormants (F1/F2 band analysis, per-voice peak normalization, fricative closure); face-bus ships LIVE mouth frames while speaking; clean-room /av/faces/visage/ (549 lines — abstract glass face, state-aware eyes/gaze/blink, morphing bezier lips w/ teeth-hint + throat glow, Mark-LV's exact taus, Chrome-flicker-safe, fs-exit pill); speech.ts playback all routed through the analyser. PROVEN: 137 live mouth frames mid-speech (openness 0.13→0.81/syllable, width −0.33→+0.77). Lead closed the picker seam (ConsciousnessFace union + FACES list + ScanFace icon).
- **W3.5 Notify (w3-notify):** composeTeacherNotice (cascade-written note in her voice: what changed + honest opinion + the ask; degraded fallback honest; ONE mark-lv-sync alert carrying her message); notice_decide/notice_preview API actions; Upstream tab "NOTICES FROM HER" cards (PORT IT / NOT NOW, queued/muted states, preview). Live round-trip verified to DB.
- **W3.6 E2E (lead, agent-browser):** boot 200 w/ visage active; face picker all 6 faces; VLM verdict on visage "clean and sophisticated"; DORMANT→SPEAKING transition + mouth aperture confirmed visually; deterministic bus-sampling proof of per-syllable tracking; chat instant reply + Instant Recall chip; live activity labels sampled through a real tool turn (thinking → calling owner files → calling mist self read); voice-stage activity line during processing; teacher notice card + PORT IT round-trip; mobile 390px zero overflow; 0 console/page errors; tsc 0; lint clean.
- **Honest limits:** Gemini-direct voices still engage only from the creator's own (non-blocked) browser region — unchanged by design; the mouth face is a 2D abstract design (not the teacher's 3D head — deliberate, ours is ours); status answers report the HOST the sandbox runs on (the bridge extends this to the creator's real PC when connected); FastReply caches only conversational-class answers (never tool replies — a cached tool answer would be a stale lie).

### v9 — Wave 4: the creator's standing orders (voice barge-in, always listening, briefings, spoken warnings, PC notifications, Hermes command, training grounds, research ritual)

- **W4.0 Recovery + research ritual (lead):** third sandbox reset wiped both clones — re-cloned Mark-LV (c3e795af, exact baseline) + OpenJarvis (absorbed 1 housekeeping commit f0ecea0→c4da16e honestly, 0 proposals); watchers quiet, zero false alerts. RESEARCH BEFORE BUILDING (the new ritual, practiced by the builder): barge-in/VAD pattern (Gemini Live model: detect speech while TTS → stop audio → re-arm; AEC ON by default in getUserMedia strips speaker output from the mic signal) + Web Notifications API state validated via live web_search before a line was written.
- **W4.1 Byte-by-byte audit:** Mark-LV's 39-file blueprint re-grounded — core/echo.py (band-projection echo subtraction, learned floor/head percentiles, warmup/relearn discipline), actions/proactive.py (ProactiveEngine 2.0: time-aware, rotating focus, silence-gated), actions/system_monitor.py (threshold watchdog, 3-streak CPU, 5-min cooldowns), readme capability table (morning briefing, self-echo guard, real confirmation, undo, runtime self-knowledge). OJ modules cross-checked against oj-port-map.json (learning/evals/channels/a2a all previously ported; mining/bench excluded by design).
- **W4.2 Notification system:** alert-priority.ts (ONE severity classifier: critical=guardian machine-health → spoken+OS+toast; important → OS+toast; info → toast+chat); os-notifications.ts (permission lifecycle, tag-dedup, silent:true OS toasts — her voice is the sound, click focuses the app); notification-feed.ts (module store shared by the delivery loop and the bell); heartbeat listAlerts += history (40); use-alerts delivery upgraded (toast + SPOKEN via mistSpeech newest-wins + OS + chat persist + feed publish); navbar NotificationBell (unread badge from mist:notifLastSeen, 40-item catch-up panel with kind chips/severity colors/delivery labels, all-read, PC-notifications + spoken-warnings toggles, Brief me). CRASH FIXED LIVE: mark-seen effect looped on its own revision bump → guarded by unread>0.
- **W4.3 Welcome-back briefing:** /api/mist/welcome (GET greet-gate: never-greeted OR away>20min OR server-restart<5min+away>2min; POST seen (5-min ping) + brief (force)); composition = time-of-day (creator tz, client-sent) + DB-proven recap (alerts/missions/autonomy/teacher notices since last seen) + live news (web_search, 30-min LongtermMemory cache) through the LLM cascade in her voice, honest deterministic fallback + honest news-lane-down clause; welcome-client.ts delivers (thread append + mist:alert live-render + feed + toast + SPEAK); app-shell fires it 2.2s after the iris opens. LIVE: two distinct briefings delivered (restart-aware recap one; real-news one — Washington infrastructure + Raleigh-Durham AI cluster items).
- **W4.4 Voice barge-in:** echo-guard.ts — the teacher's echo.py ported faithfully (ECHO_BAND_EDGES 200..7000Hz log-spaced; MIN_LEVEL 0.06, MIN_USER 0.15, HEAD_Q 97 ×1.15, UNRELIABLE_FLOOR 0.22 → BLOCKS_NORMAL 5 / BLOCKS_NOISY 12, FLOOR_WINDOW 60, WARMUP 16, RELEARN_RUN 28; two-stage learning: warm-up learns from every block, then only below-bar blocks); audio-bus += mistAudioBandEnergies (float-dB → linear band magnitudes, her output reference); BargeInProbe (own getUserMedia with echoCancellation+noiseSuppression+autoGainControl, 64ms sampling, fires once per speaking turn); use-voice wires start/stop into the speaking phase (onStart arms, onEnd/onError/session-end disarms; barge-in stops speech + jumps to listening + re-arms whichever capture path the session uses).
- **W4.5 Always listening:** wake word default flipped ON with a one-time honest migration (mist:wakeFlipW4; afterwards the persisted choice is honored either way); mic-denied no longer switches the pref off (engine waits with guidance, re-arms on permission); self-echo guard — wakeHit drops hits while mistSpeech.speaking (her own tail can never wake her).
- **W4.6 Local-host watchdog:** guardian bridge-down fallback — getTelemetry (CPU/RAM/disk of the machine the sandbox runs on) feeds the SAME threshold evaluator + 1-hour re-warn, honestly labeled sampledFrom:'local-host'. PROVEN LIVE DURING E2E: CPU 100% (chrome+bun) raised "⚠️ CPU sustained at 100% — heaviest: chrome, bun, chrome" through the full delivery path.
- **W4.7 Hermes command center:** /api/mist/hermes (GET cached status 60s; POST status/delegate/skills/cron via bridgeExec, honest bridge-disconnected payload with connect hint); HermesCard in Diagnostics → Agents (status strip, one-line delegation form, skills/cron peeks); heartbeat step 7 — hermesWatchTick every 10th beat probes hermes_status, baselines to db/hermes-watch.json, alerts on CHANGE only (gateway down = critical/spoken, back up = info, skills count/version moves = info); db/skills/hermes-operator.md (the command protocol she follows: status first, self-contained delegation, start_async for slow jobs, never fake bridge data).
- **W4.8 Training grounds:** src/lib/training-missions.ts — 12 missions distilled from the audit (research-first, answer-first, work-while-chatting, spoken-warnings, confirmation-discipline, undo-discipline, self-knowledge, proactive-checkin, teach-one-learn-ten, mistake-postmortem, hermes-command, memory-hygiene), each naming its source behavior; TrainingCard UI (expandable rows: source + full prompt + copy-prompt + run-as-mission) in Sub-agents; missions route accepts origin:'training'; MISSION_PLANNER += RESEARCH RITUAL (all origins) + TRAINING_PLANNER_ADDENDUM (generalize into training.rule.*, no petting, no repeated identical failures, research first); trainingRulesBlock() injects past training.rule.* memories into every training plan; actorSystem carries TRAINING_ACTOR_ADDENDUM.
- **W4.9 E2E (lead, one agent-browser session — no swarms, server protected):** boot 200; bell opens cleanly post-fix with 9-unread badge → 40-item history + toggles + Brief me (VLM: "dark-themed notification panel… ✗ all read… severity chips"); Hermes card renders honestly; Training Grounds renders the 12 drills with copy/run actions; Brief me round-trip: 9.7s compose → thread append (provider 'welcome') + real news; chat golden path intact ("hello" → mist-instant reply); mobile 390px zero overflow; wake pref survives reload + mic denial; 0 console/page errors; tsc 0; lint clean; memory steady (no crash, no dev-guard respawn under solo load).
- **Honest limits:** OS notifications require the browser permission grant (headless/preview denies — in-app toast + spoken warning still fire; the bell panel carries the enable path); barge-in quality depends on the room (the guard itself is honest about bad rooms — BLOCKS_NOISY + relearn); the briefing's news lane can be unreachable (honest clause, cached 30 min); Hermes control is real only through the creator's connected bridge — the sandbox probe honestly reports installed:false; a flagged execSync defect in the health route remains pending in the creator's own drill-#13 approval flow (their pipeline, not silently patched).

## v10 — WAVE 5: voice in milliseconds (2026-10-02)

- **W5.0 Research ritual (practiced before building):** web_search on streaming-voice latency (AssemblyAI/Retell/pipecat converge: sentence-stream LLM into TTS; first-token latency is the metric; ~0.5s LLM→TTS gap is the norm) + direct gateway probes (z-ai SSE: first token 933ms, continuous chunks; explicit-model variant 495ms).
- **W5.1 Wake phrases:** regex widened to `/\b(?:hey\s+(?:mist|miss|m)|mist)\b/i` — "hey mist", "hey miss", "hey m", bare "mist"; word boundaries keep "hey mom"/"misty" quiet.
- **W5.2 Streaming core (llm-service):** DeltaSink + ReplyStreamFilter state machine (probing → envelope string | prose | suppressed; narration guard holds the first sentence and sniffs before any audio; commit/discard driven by unifiedCore's round verdicts); streaming variants of callCore (z-ai SDK SSE, DUCK-TYPED body check — instanceof fails across Next's patched-fetch realm, which cost one debug round), callOpenAiCompatible, callKeylessLane; idle-based timeouts; partial-on-stream-break returns the streamed prefix as the answer (what was spoken is what she said); per-lane-attempt fresh filters so a failed lane emits nothing.
- **W5.3 Protocol (additive, frozen contracts honored):** ConsciousnessChunkMsg type; unified(req, onActivity, onChunk); route emits NDJSON `{"type":"chunk"}`; neural service forwards `consciousness_chunk` (FIFO ordering with the response); use-neural onChunk registry.
- **W5.4 Voice routing:** voice-mode cascade leads with core (~1s first token, probe-verified) ahead of the keyless lanes' 4-6s prefill; chat order untouched (cost-first).
- **W5.5 Incremental speaker + subtitles (speech.ts):** subtitle bus (chunks + activeIndex, __mistSubs observability mirroring __mistBus); speakIncremental — sentence-level chunks, synth starts at feed time (chunk N+1's audio downloads while N plays), degenerate-sniff, engine-aware synth fn (local/gemini-direct/server chain), tts-off = captions-only, 'streamed'|'replaced' reconciliation with the canonical final text; use-voice wiring (handleChunk, streamedThisTurn via incrementalRef, shared phase handlers, abort on new utterance/session end).
- **W5.6 UI:** voice stage — streaming text under the activity line while thinking (never blank), karaoke subtitles while speaking (active sentence bold + bright + 500ms color transition, past dim, queued waiting, auto-scroll, reduced-motion honored); chat panel — progressive preview bubble with pulsing caret, cleared by the final message.
- **W5.7 E2E (lead, solo — no swarms; one socket probe set + one agent-browser session):** socket probes — cold cascade 12.0s first chunk / 23.5s response (11.5s lead, 28 chunks, clean prose, streamed==final-prefix); sticky warm kilo 5.9s; core-first voice 2.38s first chunk (the duck-typing fix, verified via DB trace that the earlier zero-chunk turn was a correctly-suppressed tool turn + a realm-broken instanceof); browser — complex chat prompt preview grew 258→425 chars live then the final message replaced it; "hello" 29ms fast-path intact; voice session in headless hits the honest mic-denied path with the session UI + subtitle bus live; mobile 390px zero overflow; 0 console/page errors; tsc 0; lint clean; RAM steady all session.
- **Honest limits:** the voice-stage subtitle VISUAL could not be driven with real speech in the headless sandbox (no microphone) — verified instead at the socket level (real chunks + timings), in the chat preview (same stream, same UI family), and via the bus observability + the honest mic path; on the creator's machine the full path (mic → stream → TTS → bold subtitles) runs. Streaming is an accelerator, never a requirement: non-streaming lanes, tool turns and the fast-path fall back to the whole-text speak unchanged. The narration guard can false-positive on exotic openers (loses streaming, keeps correctness — the final text still speaks whole).
