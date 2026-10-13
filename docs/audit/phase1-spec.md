# Phase 1 spec — Perimeter (S1 S2 S3 S6 S9 S10 S12)

Lead-designed 2026-10-10 from Phase 0 evidence. Status markers updated as commits land.
Environment law: never touch Caddyfile/skills//.next; never `next build`; never `db:push`; dev server stays live on :3000; one concern per commit ≤12 files; ADR-0002 (gateway-aware, same-origin-dynamic — static host lists are FORBIDDEN).

## Shared secret infrastructure — ✅ DONE (commit 1, 1738812)
`src/lib/perimeter/shared.ts` + `mini-services/lib/perimeter.ts` (mirror): `~/.mist/mist.json` {sessionSecret, bridgeToken} 64-hex each, dir 0700/file 0600, O_EXCL atomic create; `issueSession/verifySession` (HMAC-SHA256, timing-safe, 30d expiry).

## Commit 1 — S3 recover/google/export — ✅ DONE (1738812)
recover route deleted (zero callers verified). google GET: `{configured}` only, never the key. export: session 401 + typed confirm `"EXPORT"` (+`"EXPORT+KEYS"` passphrase mode, AES-256-GCM scrypt, `scripts/decrypt-export.ts`); tar excludes .env/db/secrets/backups/notes. config/env POST session-gated. Tests: tests/security/perimeter.routes.test.ts (7 green). NOTE: `keys/mist-keys.enc` on disk is the agent's TEST artifact (unknown passphrase) — delete, gitignore `keys/`.

## Commit 2 — S1 bridge v3.6 — ✅ DONE (this commit)
Token (shared file scheme, timing-safe Bearer on everything except anonymous /health identity-free probe; wrong Bearer on /health → 401 honest). ANY Origin header → 403. Host must be `127.0.0.1:8734|localhost:8734` → 421. ACAO/OPTIONS block deleted. GATED_ACTIONS denied at /exec door until Phase 2 Arbiter: run_command, write/move/copy/delete_file, make_dir, zip/unzip, ui_automate, hermes_ask, open_app → 403 `gated: '<action>' requires the Phase 2 Arbiter — read-only bridge actions remain available`. argv spawn (shell:false) prepared for run_command. bridge-service: Bearer on health+exec, 401→honest authError, MIST_BRIDGE_TOKEN env for cross-machine. `/api/mist/bridge/token` (session-gated) + Settings copy button. types.ts BridgeStatus += authError. Tests: tests/security/bridge.test.ts (11 green). LIVE DAEMON MUST BE RESTARTED to enforce (old code still on :8734 until restart).
⚠️ TRANSIENT: sessions cannot be ISSUED until proxy.ts (commit 3) — export/token UIs locked until then. Commit 3 lands immediately after.

## Commit 3 — S2/S10/S12-core: proxy.ts + sockets + binds — ✅ DONE (36f10c8 + ea8196a)
`src/proxy.ts` (Next 16 auto-uses it), matcher excludes _next/static,image,favicon,/av/**,public:
- Security headers on ALL responses: CSP `default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' ws://127.0.0.1:* ws://localhost:* http://127.0.0.1:* http://localhost:*; frame-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'` + nosniff + Referrer-Policy no-referrer + Permissions-Policy `microphone=(self), camera=(), geolocation=()` (unsafe-inline/eval = Next dev constraint, tightening is backlog).
- Session: valid cookie passes; missing → issue (Set-Cookie `mist_session`, HttpOnly, SameSite=Strict, Path=/, Max-Age 30d, Secure only when x-forwarded-proto=https). Auto-pair ANY request (Strict = browsers won't replay cross-site; that IS the enforcement).
- Non-GET `/api/mist/**` (except /health, /pair): 403 `{"error":"session required"}` unless valid cookie OR `x-mist-service: <sessionSecret>` (intra-machine) OR MIST_OPEN_API=1.
- Non-GET with Origin present AND origin-host ≠ host AND origin-host not loopback → 403 cross-origin.
- Non-GET /api/mist/** Content-Type must be application/json (allow application/x-ndjson for tts/stream) else 415 (absent → 415).
- MIST_STRICT_HOST=1 (opt-in, PC default): Host loopback else 421. DEFAULT OFF (ADR-0002 — gateway preview must not break).
- `src/app/api/mist/pair/route.ts`: GET ?code=hmac(sessionSecret,"pair") → session cookie.
- neural-service: listen 127.0.0.1 (:706) unless MIST_LAN=1; cors origin:[] ; allowRequest: allow if (no Origin AND loopback remote) OR (Origin loopback AND Host loopback) OR (Origin host === Host AND valid mist_session cookie); outbound :3000 calls attach x-mist-service (mirror helper in mini-services/lib/perimeter.ts).
- mesh-service: bind 127.0.0.1 (:769) unless MIST_LAN=1; /mcp + A2A require Bearer sessionSecret or x-mist-service → 401.
- browser-pilot: Bun.serve hostname '127.0.0.1' (:516) unless MIST_LAN=1; remove CORS * (:45-49); browser-service.ts adds x-mist-service header.
- welcome: side-effecting compose → POST; GET returns state only; welcome-client.ts + app-shell seen-ping updated (PRESERVE greet-gate semantics exactly — read route first).
- tests/security/proxy.test.ts: unified POST no-cookie→403, evil Origin→403, text/plain→415, auto-paired cookie passes perimeter, GET / headers (CSP/nosniff/referrer/permissions + frame-ancestors 'none'), socket.io no-cookie→connect_error + cookie→connect, GET / with foreign Host still 200 (ADR-0002 gate!).
- Split into 3a (proxy+routes) / 3b (sockets+binds) if >12 files.

## Commit 4 — S6 env/set_url — ✅ DONE (335cbc5)
config/env + setEnvVars + bridge route set_url: session + `*_BASE_URL`/`MIST_BRIDGE_URL` non-loopback → require MIST_ALLOW_REMOTE_BRIDGE=1 else 400; response returns masked diff {key:{from,to}} (KEY/TOKEN/SECRET/PASSWORD values → ***). Tests extend perimeter.routes.test.ts.

## Commit 5 — S12 remainder — ✅ DONE (03995d4)
`src/lib/perimeter/rate-limit.ts` in-memory token buckets: llm 30/min, tools 60/min, voice 60/min, export 5/min, config 10/min (key = session cookie, fallback IP) → 429 + retryAfter. Wire: llm/unified, tools/execute, voice/stt+tts(+stream), bridge/export, config/env, set_url. face-stage.tsx iframes: sandbox="allow-scripts" + referrerPolicy="no-referrer". Test: 15× config/env → 429 by 11th.

## Commit 6 — S9 hygiene — ✅ DONE (d1ccc8d)
db.ts log:['warn','error']. .gitignore += `db/*.db*`, `db/backups/`, `db/notes/`, `db/*.json`, `.mist/`, `tool-results/`, `upload/`, `keys/` (db/operators, db/persona, db/skills, db/openclaw, db/obsidian-vaults, db/bridge/*.js stay tracked). `git rm --cached` the now-ignored tracked files (db/custom.db, provider-keys.json, top-level db/*.json, db/backups/**, db/notes/**). History rewrite OUT OF SCOPE (owner decision — backlog). `scripts/secret-scan.ts` (export scanText; patterns sk-/ghp_/nvapi-/xai-/AIza/KEY=…; allowlist arg) + hooks/pre-commit (`exec bun scripts/secret-scan.ts`) + `git config core.hooksPath hooks`. Test: tests/security/secretscan.test.ts on scanText.

## Commit 7 — PC package honesty — ✅ DONE (6c2f5bd)
run.bat + download/run.bat print bridge token + pair code after bridge start (node one-liner reading ~/.mist). PC-SETUP.md "Security (v3)" section (token, pair, MIST_LAN=1, MIST_STRICT_HOST=1, MIST_ALLOW_REMOTE_BRIDGE=1). README bridge version line if present.

## Verification gate (every commit + phase exit)
`bun test tests/security/` all green · `bunx tsc --noEmit` 0 · `bun run lint` no new errors · health 200 · GET / 200 · dev.log no new ⨯ · GET / with foreign Host → 200 (ADR-0002) · free -m ≥350MB.

## Post-phase (lead)
Restart live daemons (bridge first — old code on :8734 until then; then neural/mesh/pilot after commit 3). Browser E2E: page load, chat roundtrip, socket connected, Settings export/token visible, headers present. Worklog + report.
