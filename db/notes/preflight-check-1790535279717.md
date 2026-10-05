# preflight-check

- created: 2026-09-27T18:54:39.717Z

## Preflight Self-Certification

### 1. Deep Self-Check (mist_deep_selfcheck)
**Result: ALL GREEN** — 11/11 probes passed in 513ms
- providers: 8 configured (nvidia, openrouter, kilo, pollinations, llm7, ovh, core, offline-mind)
- apis: 8/8 endpoints healthy
- ui: render + tab grid OK
- tools: 114 tools registered
- toolchain-honesty: 6 promise-shapes + 4 answer-shapes tested
- evolution-gates: operational
- db: integrity OK
- devlog: clean
- self-model: v1.1.0 fresh
- dreams: cycle healthy
- missions: system operational

### 2. Brain Probe (llm_pools)
**Primary lane KILO: LIVE**
- Lane: kilo (active)
- Latency: 6615ms
- Model resolved: nvidia/nemotron-3-ultra-550b-a55b:free
- Reply: "online"
- Fallbacks available (not needed): pollinations, llm7, ovh — all keyless lanes

### 3. Setup Guide (PC-SETUP.md)
**VERIFIED** — Document confirms:
- Start via `run.bat` (double-click) after installing Bun
- Bun install: `powershell -c "irm bun.sh/install.ps1 | iex"`
- Brain included: ships with `.env` carrying `MIST_LLM_PROVIDER=kilo` (550B nemotron, 1M context)
- No key needed — three keyless fallback lanes (Pollinations, LLM7, OVHcloud)
- Mist Core (GLM) is sandbox-only; credentials don't ship — keyless lanes take over on PC
- Optional: add API keys in Settings → Providers for higher ceilings
- Bridge (`mist-bridge.js`) unlocks OS-level powers (apps, files, UI automation)
- Local voice (whisper.cpp + Piper) optional, installs via Bridge

### 4. Creator Attention Needed
**Mist Core (GLM brain) is sandbox-only** — its credentials are part of this sandbox infrastructure and do NOT ship with the project. On the creator's PC, the keyless lanes (kilo, pollinations, llm7, ovh) take over automatically. If the creator wants GLM on their PC, they must add a Z.ai API key (or OpenRouter key serving GLM) in Settings → Providers → OpenAI-compatible. This is optional — the keyless cascade works out of the box.
