# mlv-rust-3 — Mark-LV anti-rust watcher (work record)

Task: "make the Mark-LV anti rust" — a forever watch over the teacher FatihMakes' assistant
repo (github.com/FatihMakes/Mark-LV, clone /home/z/Mark-LV @ c3e795a), mirroring the OpenJarvis
self-update engine's discipline with knowledge-first absorption.

## What was built (additive only — the OJ engine paths are untouched)

1. **src/lib/oj/upstream-sync.ts** (+760 lines appended after the OJ section):
   - Mark-LV constants: url https://github.com/FatihMakes/Mark-LV.git, dir /home/z/Mark-LV,
     branch main, state db/mark-lv-sync.json (NEVER db/oj-sync.json).
   - `markLvIntervalMin()` — SAME interval source as OJ: reads the OJ watch's
     runtime-configured interval (READ ONLY) falling back to the shared
     MIST_OJ_SYNC_INTERVAL_MIN env resolution (envIntervalMin/clampInterval). The OJ engine
     has no disable env — documented in the section header.
   - `detectMarkLvHead()` — `git ls-remote` probe (same as OJ); `markLvLocalHead()`;
     `markLvCommitsBehind()` (local rev-list, no network).
   - `runMarkLvSweepInner()` — rate-limit gate (MIN_SWEEP_GAP_MS), pending-digest flush,
     clone sanity + once-only alerts (clone-unusable / diverged, keys cleared on recovery),
     first-sighting silent baseline, on change: `git fetch origin main` →
     `git merge --ff-only origin/main` (exact OJ mechanics); ff failure ⇒ status 'diverged',
     one-shot alert, SKIP (never force, clone never broken), retried next scan.
   - Absorb: `git log OLD..NEW --oneline --stat` capped ~100 lines + changed-file list →
     ONE knowledge doc via the SAME dynamic-import ingestKnowledge call the OJ Tier K uses,
     with stable sourceId 'mark-lv-upstream' (each update replaces the previous digest),
     title `Mark-LV update <short-sha> — <date>`, honest teacher's-assistant note. Failure ⇒
     pendingDigest stored, retried next scan (mirrors OJ pending_knowledge).
   - Alerts: same mechanism as the OJ watch — db.alert rows (kind 'mark-lv-sync', rendered
     as a system alert by the heartbeat poller exactly like 'oj-sync' does) +
     recordActivity('mark-lv-sync', …); "🔄 Mark-LV updated: N commits — absorbed as knowledge".
   - State: { lastHead, localHead, lastScanAt, lastUpdateAt, status watching|updated|diverged|error,
     sweeps, history (capped 20, {head,at,filesChanged,commits}), lastDigest, pendingDigest, error, alerted }.
   - `markLvSyncCheck()` (manual, in-flight lock), `getMarkLvSyncStatus()`,
     `ensureMarkLvSyncWatch()` — own globalThis guard `__mistMarkLvSyncWatch`, own ARM token,
     unref'd self-swallowing timer, BOOT_DELAY_MS first scan.

2. **src/lib/oj/sync-tools.ts** — one additive tool `mark_lv_sync_status` (ToolDef shape
   identical to SYNC_TOOLS; the three OJ tools untouched).

3. **src/app/api/mist/oj/sync/route.ts** (surgical): GET now also returns `mark_lv`
   (additive field) + arms ensureMarkLvSyncWatch; POST accepts `mark_lv_check` (force
   honored, default true) and `mark_lv_status`.

4. **src/lib/oj/lab-api.ts** (additive mlv- section): MarkLv types, optional `mark_lv`
   on OjSyncStatusResponse, `ojApi.markLv.check()` client fn (relative fetch).

5. **src/components/mist/diagnostics/upstream-tab.tsx** — compact "mark-lv · the teacher's
   assistant" card after the port map: repo, status chip (watching/updated/diverged/error),
   StatCells (head, clone, commits behind, interval, last scan, last update), last-digest
   collapsible (HistoryCard brief pattern), honest error/ knowledge-pending banners,
   "check mark-lv now" button → POST mark_lv_check → honest toasts. No blue/indigo
   (amber accent). Honest "not reported" fallback if mark_lv is absent.

6. **src/app/api/mist/health/route.ts** — one import + one call: ensureMarkLvSyncWatch()
   beside ensureOjSyncWatch().

## Verification (all live on the :3000 dev server)

- `bunx tsc --noEmit` → 0 errors project-wide; `bun run lint` → 0 errors (1 pre-existing
  warning in src/lib/interrupt-bus.ts — another agent's file).
- Health route hit → db/mark-lv-sync.json created; contents (first scan):
  `{"lastHead":"c3e795af71bff38bb406c62a2e7a63869cdc8eb2","localHead":"c3e795a…","lastScanAt":"2026-09-29T23:16:17.684Z","lastUpdateAt":null,"status":"watching","sweeps":1,…}` — correct head c3e795a…, silent baseline, no ingest on first sighting.
- POST {"action":"mark_lv_check"} → `{"ok":true,"changed":false,"head":"c3e795af…","message":"up to date — the teacher's assistant repo is quiet"}`.
- POST {"action":"mark_lv_check","force":false} → honest rate limit: "scanned 3 min ago — 5-min minimum gap; force to override".
- OJ sync proven untouched: GET /api/mist/oj/sync before vs after — status+mapping shape
  identical (byte-level shape diff), head still 5e5f5ef…, only the additive mark_lv field
  was added; OJ sweeps advanced 13→14 by its own untouched loop.
- Tools registry: 137 tools (was 136), mark_lv_sync_status live, the three oj_sync tools intact.
- Mark-LV clone untouched: still c3e795a, clean tree, no git push/commit ever run.
- dev.log clean of my code; home page compiles 200 (client tab included).
- The dev server OOM-died once mid-verification (same parallel-agent pattern the worklog
  documents) — dev-guard respawned it; both watches re-armed from the health route and the
  Mark-LV state file survived the restart intact.

## Honest notes / not exercised live

- The full change path (fetch → ff → digest → knowledge ingest → alert) awaits a real
  upstream commit by the teacher — the machinery is code-verified but unexercised live,
  same as the OJ engine's change path was at oj-sync-7 time.
- No LLM brief for Mark-LV digests (deliberate — the spec's digest is the git log itself;
  simpler, zero LLM dependency, no brief lane to fail).
- knowledge sourceId is stable ('mark-lv-upstream') so each update REPLACES the previous
  knowledge doc — deliberate anti-bloat; the state file keeps the full history and the doc
  carries a "previously absorbed updates" appendix.
