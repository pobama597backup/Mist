# Task ID: guard-1 — M.I.S.T. proactive PC guardian (system_watch + heartbeat warnings + hardware-aware voice)

Agent: guard-1 (Z.ai Code)
Context for later agents: read `/home/z/my-project/worklog.md` sections `voice-1` (bridge v3 local voice) and `pc-ready-1`/`pc-ready-2` (PC portability) before touching the bridge or heartbeat — this task builds directly on both.

## What shipped (final state — fully verified live)

1. **Bridge v3.1** (`db/bridge/mist-bridge.js`, zero npm deps, loopback-only HTTP daemon):
   - New action `system_watch` → `{ok, system:{cpu{loadPct,cores}, ram{usedPct,totalGb}, disk{freePct,totalGb}, thermalC, battery{pct,charging}, security{defender{realTimeProtection,antivirusEnabled,signaturesAgeDays}, failedLogons24h, source}, topProcesses (top-5, FULL — callers trim), gpus, uptimeHours, hostname, platform}}`.
   - Every probe is individually async + try/catch + timeout 8–20s → nulls are graceful (sensor-less laptops still get full reports). Windows probes use `Get-CimInstance` / `Get-MpComputerStatus` / `Get-WinEvent -FilterHashtable @{LogName='Security';Id=4625} -MaxEvents 20` (admin-locked → honest null, never a false 0); linux uses /proc + /sys + `journalctl -u ssh --since "24 hours ago"` (unreadable → null); mac uses sysctl/vm_stat and honest nulls for thermal/battery/security.
   - All PowerShell goes through `psQuery()` = `powershell -NoProfile -NonInteractive -Command` (extractArchive also fixed to include -NonInteractive — the invariant now holds file-wide).
   - GPU probe is a shared cached helper `probeGpus()/probeGpusOnce()` used by BOTH `system_watch` and `voice_status`.
   - `voice_status` hardware now includes `gpus` and `recommended: {tier, reason}` (explains itself); `voice_setup` accepts `tier:'auto'` → the recommended tier for THIS machine.
2. **bridge-service.ts**: `system_watch` in `BRIDGE_ACTIONS` (the /api/mist/bridge proxy gate accepts it) + `ACTION_TIMEOUT_MS.system_watch = 45_000`.
3. **Heartbeat guardian** (`heartbeat-service.ts`): every 5th beat (≈5 min) with bridge connected → `system_watch` → thresholds cpu≥90 / ram≥90 / disk≤10 (≤5 critical) / thermal≥85 (≥95 critical) / defender realTimeProtection===false / failedLogons24h≥10 / battery≤15&&!charging → `raiseSystemAlert()` (Alert kind 'system', ⚠️ title, snapshot meta) → SAME client path as ⏰ reminders (`use-alerts.ts`: toast + persist into chat thread + live render + mark delivered). Debounce per kind ≤1/hour in `db/heartbeat-state.json` (`beat_count`, `last_warned{kind→ISO}`). Bridge down / probe fail → silent skip, never crashes the beat.
4. **LLM tools** (`tools-service.ts`): `system_watch` {detailed?} → compact JSON + summary line ("CPU 12% · RAM 61% · disk 71% free · defender on · 0 failed logons · 46°C"); `local_voice_setup` {engine, tier? 'light'|'balanced'|'auto'} → bridge voice_setup (auto→recommended) — "Mist, upgrade your voice" just works.
5. **Settings** (`settings-view.tsx` + `voice-local.ts`): local-voice card shows one muted line `GPU: <names> — <recommended reason>` when connected; nulls hidden.
6. **Docs**: PC-SETUP.md + download/MIST-ON-YOUR-PC.md local-voice section extended (guardian paragraph + "check my system" / "upgrade your voice"); README heartbeat section one-liner.

## Verification performed (all green)

- `node --check` bridge OK; `bunx tsc --noEmit` → 0; `bun run lint` → clean; dev.log clean.
- Live bridge daemon (started, stale one killed first): `system_watch` direct + via `/api/mist/bridge` proxy → real snapshot on this 2-core/3.9GB sensor-less container (thermal/battery/security nulls, real top-5, gpus []).
- Guardian LIVE: raised real ⚠️ "CPU sustained at 100%" (with top-process names) and ⚠️ "RAM at 92% of 3.9GB" into chat via the alert poller; the CPU re-raise was correctly debounced within the hour; `last_warned` persisted across beats in db/heartbeat-state.json.
- agent-browser 1440×900: boot clean, 0 page/console errors; settings card (BRIDGE CONNECTED, LIGHT TIER, reason line, GPU hidden when empty); chat "check my system — full health snapshot please" → system_watch tool used → reply with real numbers (CPU 100%, RAM 77%, disk 76% free, 5 processes with %, hostname, uptime). Screenshots: `/home/z/guard-e2e/chat-system-watch.png`, `/home/z/guard-e2e/settings-local-voice.png`.
- Bridge KILLED before finish → proxy `system_watch` → `{ok:false, error:'bridge-disconnected'}`, `/voice/local/status` → 503. Natural resting state = bridge off.

## Gotchas for later agents

- The heartbeat loop is globalThis-guarded per dev compile (`ARM_TOKEN`); heartbeat state is `db/heartbeat-state.json` — new fields must be optional with defaults (older files parse fine).
- The bridge answers 200 with `{ok:false, error}` for action failures — check `ok`, not the HTTP status. `bridgeExec` maps daemon-down to `bridgeConnected:false`.
- `system_watch` ignores its args now (full payload always); compact/detailed shaping happens in the TOOL layer.
- Do NOT add npm deps to the bridge; keep PowerShell flags `-NoProfile -NonInteractive`; the voice_stt 17MB body-cap sniff (`RE_VOICE_STT_ACTION` on the stream head) must stay.
- Sandbox box keeps `yes` processes pinned at ~100% CPU (leftover load generator) — expect cpu warnings during E2E; that's real data, not a bug.
