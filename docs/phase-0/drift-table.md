# Phase 0 — Citation drift table (14 clusters, spot-checked this session)

Brief snapshot `a50825e` vs HEAD `22f2813` (repo moved on: waves w3–w8 landed after the snapshot).

| # | Citation | Verdict | Evidence this session |
|---|----------|---------|----------------------|
| 1 | bridge `:4042` ACAO `*` | ✅ EXACT | `db/bridge/mist-bridge.js:4042` `setCors` sets `Access-Control-Allow-Origin: '*'` |
| 2 | bridge `:3341` `exec(string)` | ✅ (+4 lines) | `run_command` handler at :3341, `exec(command, …)` at :3345; shell path also via `spawn('/bin/sh', ['-c', cmd])` :1042 |
| 3 | `/exec` no token | ✅ | :4149 `POST /exec → handleExec` — zero auth in whole file (rg `token|Bearer|authorization` → no matches) |
| 4 | tools-service `:3733` | ✅ | inside `executeTool` logging (`appendToolStep`); file 3824 L (brief: 3810) |
| 5 | guardrails `:150` guardUrl | ✅ EXACT | `src/lib/oj/guardrails.ts:150` (path drift: brief said `src/lib/guardrails.ts`) |
| 6 | guardrails `:237,:271` | ✅ EXACT | :237 `checkCapability`, :271 `isActionAllowed` alias — **zero callers** (S4 confirmed) |
| 7 | `llm/unified/route.ts` ignores `req.signal` | ✅ | 175 L, zero `signal|abort` matches (R1) |
| 8 | `google/route.ts` raw key | ✅ | GET returns `{ key: GEMINI_API_KEY }` :19-22 (S3) |
| 9 | export tars `.env`+db | ✅ | `INCLUDE_DIRS=['src','prisma','db',…]` :26 — `db/` includes `custom.db` + `provider-keys.json`; builds portable `.env` :48+; **no secret-strip anywhere in file** (rg KEY/TOKEN/SECRET → 0) |
| 10 | `recover/route.ts` TEMPORARY | ✅ | :1 "TEMPORARY recovery route — DELETE AFTER USE"; spawn+execSync, 80 L |
| 11 | `store.ts:376` `setAudioEnergy` | ✅ EXACT | `src/lib/store.ts:376` — `set({neural:{…}})` new object per tick (P3) |
| 12 | `status-bar.tsx:19,27` | ✅ EXACT | :19 `useMistStore((s) => s.neural)` whole-slice; :27 `mistApi.tools.list()` full list for a count (P9) |
| 13 | browser-pilot `:95,125` | ✅ | `--no-sandbox` :97 (S7); shared module-global `browser`/`page` :125 `ensureBrowser` |
| 14 | neural-service `:401,:713` | ⚠️ SPLIT | :401 ✅ (dormTimer). :713 = `httpServer.listen('0.0.0.0')` — **`relay_offer` absent from entire codebase → S10 REFUTED at HEAD** (feature removed since snapshot) |
| 15 | llm-service `~2870` auto-upsertFact | ✅ (drift −57) | `:2813` `upsertFact(key, value)` from `envelope.remember` — no provenance/trust field (S11) |
| 16 | scheduler `:960` cron `unified()` | ✅ (+1) | :961 `unified({message: job.prompt, mode:'chat', history:[]})` unattended (S11) |
| 17 | context-builder `225-432` | ✅ (region 225-413) | 10 sequential awaits + one `Promise.all` (skillBlocks) (P7); file 413 L |
| 18 | `db.ts` `log:['query']` | ✅ EXACT | `src/lib/db.ts` — live in dev.log today (S9) |

Extra drift found: bridge binds **127.0.0.1 only** (:115 `const HOST='127.0.0.1'`) — S2's "bind all interfaces" is true for :3003/:3004/:3030 (`ss` output) but NOT the bridge. Route count 82 (brief: 83). Runtime skills 18 (brief: 21). Tool registry 143 live / 139 implemented (brief: 100).
