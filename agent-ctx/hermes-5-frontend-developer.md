# Task ID: hermes-5-settings — Companions (local agent stack) settings section

Agent: frontend-developer
Scope: single file — `src/components/mist/settings/settings-view.tsx` (nothing else touched; no changes in src/lib/)

## What was added

A new "companions (local agent stack)" section in SettingsView, placed immediately AFTER the "Local bridge" section, rendered from the Mist Bridge v2 daemon's `/companions` payload via the pre-existing `mistApi.companions.get()` / `.signalTest()` client methods.

### Local types (top of file, lines 304–348 — src/lib/types.ts NOT touched)
`CompanionHermesInfo`, `CompanionDirInfo`, `CompanionCliInfo`, `CompanionSignalInfo`, `CompanionMcpInfo`, `CompanionsPayload` — all fields optional for defensive casting; the API's `Record<string, unknown>` is cast once through `as CompanionsPayload` and every read uses optional chaining + typeof checks (faces array additionally runtime-guarded with `Array.isArray` + per-item `typeof f === 'string'` filter).

### CompanionRow helper component (lines 350–391)
Shared row: icon chip (dimmed when not installed) + name + one-line description + optional truncated `detail` line (with `title` attr) + right-side status slot ("not detected" gray text when missing).

### State (lines 430–437)
`companionsLoading`, `companionsData: CompanionsPayload | null`, `companionsError: string | null`, `companionsScanAt: Date | null`, `companionsAutoScannedRef` (useRef once-guard), `signalPerforming`, `mcpCopied`.

### Logic (lines 638–712)
- `scanCompanions` (useCallback): GET /companions → on connected+payload sets data+scanAt, else clears (toast.info "bridge offline…" when endpoint says not connected), catch sets error.
- Auto-scan effect: fires once when `bridge` is non-null AND connected (reuses the Local bridge section's `bridge: BridgeStatus | null` state); never auto-scans while the bridge is offline/null; once-guard is a ref and the scan is deferred via `setTimeout(0)` + cleanup to satisfy `react-hooks/set-state-in-effect` (first attempt with setState in the effect body failed lint — fixed by ref + deferral).
- `performSignalTest`: POST signal_test (~6s) → toast success ("performed on faces — <performed>") / error; button disables + spins for the duration.
- `copyMcpCommand`: `navigator.clipboard.writeText` in try/catch, toast "Copied", Check/Copy icon toggle reset after 2s.

### Section JSX (lines 1129–1321)
`<motion.section {...sectionMotion(7)} aria-label="Companions" className="mist-glass p-5 sm:p-6">` matching the Local bridge visual language (SectionLabel, font-mono text-[10px], StatusDot, MonoBadge, rounded-xl border-white/5 bg-white/[0.02] cards):
- SectionLabel "companions (local agent stack)" with Refresh outline button (RotateCw, spins while loading, always enabled).
- Status card: error → amber "scan failed — …" ; loading → "scanning…" ; data → green dot + "scanned · <relTime>"; bridge null/offline → amber "connect the bridge above to scan this machine's agent stack."; rare fallback → amber "bridge not responding…".
- Skeleton while first scan runs (loading && no data).
- One card with 5 rows: hermes agent (Bot — version MonoBadge, gateway green/gray dot, "N skills" badge), backtalk (Mic — emerald "installed" badge + truncated path w/ title), ai-visualizer (Monitor — face badges from payload, e.g. board/radical/rain/neural), barehands (Hand — emerald "installed"), claude code (Terminal — version badge). Not-installed rows dim + "not detected".
- Signal bus card: "every companion face performs mist's live voice" + dir (truncated, title attr) + source badge (teal) + "Perform on faces" button (Play ↔ Loader2 spin).
- MCP wiring card (only when hermes installed && registerCommand present): "let hermes call mist back" + registerCommand in `break-all bg-black/30 rounded p-2 border border-white/5 font-mono text-[10px]` code block + Copy button (Copy/Check toggle, toast "Copied").

### sectionMotion renumbering
New section = 7. Telemetry 7→8, Skills 8→9, About 9→10 (aria-labels unchanged: "Telemetry", "Skills", "About"). Sections 0–6 untouched.

### Icons added to the lucide import (all valid exports)
Bot, Copy, Hand, Mic, Monitor, Play, RotateCw, Terminal (Check/Loader2 were already imported). Also added `useCallback`, `useRef`, `type ReactNode` to the react import. `toast` (sonner), Button, Skeleton, StatusDot, MonoBadge, relTime were already imported.

## Verification
- `bunx tsc --noEmit` → CLEAN (0 errors)
- `bunx eslint src/components/mist/settings/settings-view.tsx` → CLEAN (0 errors, 0 warnings; one `react-hooks/set-state-in-effect` error during development was fixed via ref once-guard + setTimeout deferral, verified with a scratch probe that the rule accepts deferred callbacks)
- dev.log: root page compiles and serves HTTP 200, no errors/warnings
- `bun run build` NOT run (per constraints); no other files modified

## Behavior summary
- Bridge offline/null: amber "connect the bridge above to scan this machine's agent stack." — no auto-scan, rows/signal/mcp hidden; Refresh still works.
- Bridge online: auto-scan once → "scanning…" → green "scanned · <time>" + 5 rows + signal bus card (+ MCP card when hermes installed).
- Scan error: amber "scan failed — <message>"; manual refresh always re-scans.
