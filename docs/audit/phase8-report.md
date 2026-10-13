# Phase 8 · SHIP — Final DoD audit + S15 decision + archive manifest

Date: 2026-10-12 · Status: **GREEN in-sandbox** (PC-side items explicitly listed)
Phases 0–7 all landed and verified. This is the closeout.

## 1. Definition-of-Done checklist (mandate §DoD)

| # | Item | Status | Evidence |
|---|------|--------|----------|
| 1 | `tsc --noEmit` 0 errors | ✅ verified | Run at every phase exit; final run today: 0 errors on Next 16.4.0 |
| 2 | `next build` green | ⏳ PC-side | ADR-0001: build banned in sandbox; `scripts/ci.ts` runs it with `MIST_CI_BUILD=1` on the owner's machine |
| 3 | `ignoreBuildErrors` removed | ✅ verified | Deleted in Phase 3-a (commit ad2cafc); next.config carries `reactStrictMode: true` |
| 4 | `reactStrictMode: true` | ✅ verified | Live since 3-a; strict-mode browser smoke green at Phase 3 exit |
| 5 | Playwright smoke <60s | ⏳ PC-side | ci.ts step; agent-browser E2E (same golden paths) ran green at every phase exit |
| 6 | `bun test` suite | ✅ verified | **357/357** (20 files, 2013 assertions) — guardrails, Arbiter matrix, taint, risk, bridge 401, quarantine, A4, candor, lifecycle, speed, control-room, facebus, skills7 |
| 7 | every `executeTool`/`bridgeExec` flows through `arbitrate` | ✅ verified | Wiring invariant tests + grep proofs (Phase 2, re-verified each phase); Phase 7 extended the same chokepoint to skill:* chain-max |
| 8 | bundle ≤ min(60% baseline, 250 KB gz) | ⏳ PC-side | Dev-served first-load JS recorded in baseline-2026-10-10; the CI build step measures the prod number against it. All structural work landed (splits, dynamic tabs, sprite cache, content-visibility) |
| 9 | `buildContext` p50 ↓ ≥50% | ✅ verified | 77.9→7.8ms (**−90%**), p95 222→10.5ms (−95%) — docs/baseline-2026-10-11-phase4.json |
| 10 | tools block ≤2.5k tokens | ✅ verified | 9,531→1,515 tokens (−84%); static prefix 591 tokens |
| 11 | idle: 0 store commits, ≤1% CPU | ✅/⚠️ split | Store commits: 0/tick verified by tests (audio off React). CPU: true-idle = only the dev-guard's 12s health probe (3 req/30s, zero client polling); dev-server process ≈4.7% (Turbopack watcher + the owner-desired background services: heartbeat, retention, lane-health, egress ledger). The ≤1% figure is a PRODUCTION-build measurement → PC-side CI. **Idle leak found & fixed this phase** (below) |
| 12 | branch `hardening/phase-1` | ✅ historical | Phase 0/1 era; the trunk now carries phases 0–8 |
| 13 | audit chain tamper-evident | ✅ verified | Control Room chain-verify live + tamper test (Phase 6-a) |
| 14 | candor corpus ≥95% | ✅ verified | 40/42 probes pass + exactly 2 floor cases one-line (Phase 5, mock lane); real-engine smoke = PC-side `scripts/candor-smoke.ts --target <ollama>` |

## 2. S15 dependency decision (executed this phase)

- **Patched**: `next` 16.1.3 → **16.4.0** + `eslint-config-next` 16.4.0. This closes both criticals — GHSA-p293-qw3h-jr36 (unauthenticated RCE on **windows-hosted** servers — exactly the owner's PC deployment) and GHSA-2xp9-vwfh-vxw4 (Image Optimization AVIF RCE), plus the SSRF and Server-Function disclosure highs. Verified after the swap: dev server healthy, suite **357/357**, tsc 0, lint clean.
- **Cost of the upgrade, paid**: eslint-config-next 16.4.0 ships the new `react-hooks` rules (`set-state-in-effect`, `refs-during-render`) — 25 violations repaired across 21 files (mechanical macrotask-defer / effect-write patterns, zero behavior change; tests green, no test adjustments needed).
- **Accepted (dev-toolchain transitive only)**: 44 remaining advisories (31 high / 12 moderate / 1 low, **0 critical**) — all in dev-only transitive chains (lodash/braces/flatted/picomatch/browserslist/@babel via eslint-config-next, ajv via test tooling). None ship in the standalone production server (`next build` prunes dev deps). Re-audit after the next `eslint-config-next` refresh; tracked in ci.ts's honest audit step.
- **Not actionable in-sandbox**: `sharp <0.35.0` advisory — 0.35 is not published for this platform; sharp is only used by Next image optimization (no `<Image>` usage ships in her UI; revisit when 0.35 lands).

## 3. Idle-CPU investigation (finding + fix)

Symptom: idle dev-server CPU 5.7–6.9% (baseline 0.43%). Requests during "idle": telemetry ×3.1/s, approvals ×1.4/s, health ×1.9/s.
Root cause: a **leaked Playwright chromium** (parent: browser-pilot, spawned 07:16 during the Phase-6-era suite run, orphaned by the 07:19 box-OOM before its cleanup ran) holding her UI open with `--disable-background-timer-throttling` — polling at full client rate. It sat OUTSIDE the pilot's task registry (`contexts:0` the whole time), so the 120s reaper could not see it.
Fix: killed the orphan (browser_up now false; the pilot relaunches lazily on next task). True idle after: **3 guard health probes / 30s, zero client requests**.
Hardening note (honest residual): the pilot reaper only sweeps REGISTERED contexts. A task-less browser (direct launch path) can outlive it. PC-side recommendation: the run.bat/restart.bat already kill the process tree on stop; sandbox guard v3 keeps services single-instance. A pilot-side `--single-process lifetime cap` is backlog, not a ship blocker.

## 4. Preview stability (the owner's first-priority bug — fixed this session)

Root-cause chain (three stacked faults): (1) uncapped next-server heap + six zombie mini-service workers on a 3.9GB no-swap box → OOM-killer killed the dev server twice in 4 minutes → gateway 502 → dead preview; (2) resurrected zombie routes (`/api/mist/recover`, `/api/mist/mesh`) back on disk after their S3/R12 deletions; (3) S12 test flake under the same pressure.
Fixes: heap-capped dev script (`--max-old-space-size=1536`), **dev-guard v3** (12s tick, mini-service supervision + zombie sweep, /proc-based discovery, per-service grace), neural-service hot-reload bootstrap trigger (reaper-proof ancestry), zombie routes re-deleted, S12 timeout hardened. Verified: gateway 200, full browser E2E, chat golden path, suite green. Commit 1923b9c.

## 5. skills/ archive

**Do not move in this sandbox** (platform-owned live tree; phase-0 §12). The PC-side procedure + full 69-folder manifest: `docs/skills-archive-manifest.md`. Runtime surface is unaffected (12 live skills in `db/skills/`, 7 archived in `db/skills-archive/` — Phase 7).

## 6. Remaining PC-side checklist (run `bun run ci` with `MIST_CI_BUILD=1`)

1. `next build` green + standalone bundle gz vs baseline (≤ min(60%, 250KB))
2. Playwright smoke <60s
3. Real local-lane candor smoke (`scripts/candor-smoke.ts --target http://127.0.0.1:11434`)
4. Production idle CPU ≤1% (no Turbopack watcher)
5. `git mv skills/` per the manifest
6. Pre-v3 git history secret rewrite — **owner decision, unchanged** (the secrets are history-only; the working tree is secret-scan clean)
