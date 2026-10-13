# oj-mesh-4 — OpenJarvis interop mesh port (MCP server + A2A card + channels + rate limiting + data-boundary report)

Task ID: oj-mesh-4 · Agent: oj-mesh-4 (full-stack-developer) · Status: DONE

## What was built

### 1. mini-services/mesh-service/ (port 3004, running)
Zero-dependency bun service (`bun --hot index.ts`, no deps → no bun.lock needed; mirrors neural-service's structure):
- **MCP server** (port of `openjarvis/mcp/server.py`): HTTP JSON-RPC 2.0 at `POST /mcp` — `initialize` (protocolVersion `2025-11-25`, capabilities, serverInfo `mist-mesh`), `tools/list` (6 tools with inputSchema + MCP 2025-11-25 annotations), `tools/call` (executes honestly → `{content:[{type:'text',text}], isError}`), protocol-level `ping`, spec notifications, batch arrays, parse error -32700, invalid request -32600, unknown method **-32601**.
- **6 real self-contained tools** (no DB, no SDK): `ping` (latency), `mesh_status` (uptime/tools/requests), `echo_json` (parse+canonicalize, honest error on bad JSON), `time_now` (ISO + timezone/offset), `http_check` (HEAD with full SSRF guard, manual redirects ≤3 each re-validated, 6s timeout), `uuid_new` (crypto v4, count 1–16).
- **SSRF guard** (port of `openjarvis/security/ssrf.py`): blocked cloud-metadata hosts, private/reserved IPv4 CIDRs (0/8, 10/8, 172.16/12, 192.168/16, 127/8, 169.254/16, 224/4, broadcast), IPv6 (::, ::1, fc00::/7, fe80::/10, ff00::/8), IPv4-mapped/compatible IPv6 normalization, **disguised IPv4 forms** (decimal/hex/octal/short-dotted via inet_aton-style parser), fail-closed DNS. Verified blocks: `127.0.0.1`, `169.254.169.254`, `2130706433` (decimal 127.0.0.1).
- **A2A agent card** (port of `openjarvis/a2a/protocol.py` AgentCard): `GET /` and `GET /.well-known/agent-card.json` (plus the OpenJarvis `/.well-known/agent.json` alias) — `{name: 'M.I.S.T. (Clare)', description, url, version, capabilities: {streaming: false, tools: true}, skills: [6 mirroring MCP tools], provider: {organization: 'M.I.S.T.', url}}` + honest mcp/gateway extension fields.
- `GET /health` → `{ok:true,...}`; clean JSON 404 elsewhere; every request logged to stdout (lands in its dev.log); SIGTERM/SIGINT handlers.

### 2. src/lib/oj/rate-limiter.ts
Port of OpenJarvis `security/rate_limiter.py` (token bucket) + sliding-window-log, in-memory, **globalThis-guarded singleton** (hot-reload safe), lazy sweep (no loops/timers):
- `acquire(key, {limit, windowMs})` → `{allowed, remaining, retryAfterMs, limit, windowMs, algorithm}` (sliding window — precise retryAfter/remaining)
- `acquireTokenBucket(key, opts)` — the faithful OpenJarvis TokenBucket port (continuous refill, capacity = limit)
- `checkRateLimit(surface, key)` with frozen presets: **chat 20/min, tools 60/min, research 5/10min, mcp 30/min**
- `peek`, `resetRateLimit`

### 3. src/lib/oj/channels.ts
Honest port of OpenJarvis's **31-channel registry** (30 `@ChannelRegistry.register` adapters + imessage_daemon):
- `webchat` is LIVE (this console — chat + consciousness/voice + synapse websocket)
- Full setup notes + webhook shapes for the 8 first-class adapters: telegram, slack, discord, whatsapp, imessage, sendblue, email, twitter/x — all `connected: false` with `/api/mist/channels/{id}/webhook` shapes where inbound webhooks apply
- Remaining 22 adapters (gmail, signal, twilio, bluebubbles, whatsapp_baileys, google_chat, teams, matrix, mattermost, rocketchat, zulip, feishu, line, viber, messenger, reddit, mastodon, nostr, twitch, irc, xmpp, webhook) as honest stubs
- `listChannels()` → 31 entries; `getChannel(id)`; `sendMessage(channel, content, req)` — canonical send contract (to/replyTo), honest not-connected errors for unconfigured channels, never fakes delivery

### 4. src/app/api/mist/mesh/route.ts (GET, force-dynamic, nodejs)
Frozen contract: `{mcp: {url, tools, status}, a2a: {cardUrl, status}, channels: [...]}`:
- Fresh honest health probe of `http://127.0.0.1:3004/health` (2s timeout) per request
- tools/list JSON-RPC count (2.5s timeout, **cached 30s** — mcp-service.probeGateway pattern)
- Gateway-documented URLs: browser origin uses `/?XTransformPort=3004/mcp` and `/?XTransformPort=3004/.well-known/agent-card.json` (relative, per platform rules); the route proxies status itself so the UI needs no direct mesh access
- Honest degradation verified: mesh killed → HTTP 200 with `status: "down"` everywhere; restart → `up`

### 5. src/app/api/mist/data-boundary/route.ts (GET, force-dynamic, nodejs)
Port of `jarvis scan --data-boundaries` for M.I.S.T.'s actual config — **enumerates the real files/dirs** (existence/size/counts + key NAMES only, never private content): **14 findings** (4 high: chat history db, longterm memory, provider keys, traces; 6 medium; 4 low) with the mitigations actually in place (local SQLite, no third-party analytics, keys restored from local backup via ensureProviderKeysRestored, local TF embeddings, SSRF-guarded mesh, webchat-only channel surface, single gateway port, rate limiter available).

## Verification (all green)
- `bunx tsc --noEmit`: **0 errors project-wide** (my files clean throughout; the 5 transient errors seen mid-run belonged to other agents' in-flight files and are gone)
- `bun run lint`: clean
- Mesh service curl roundtrips: initialize / tools/list (6) / tools/call (ping, mesh_status, echo_json, time_now, http_check, uuid_new) / unknown → -32601 / parse error → -32700 / batch+notification / 404 / SSRF blocks (private IP, metadata, disguised decimal) / public http_check (example.com 200 in 30ms)
- `GET /api/mist/mesh` → 200 `{mcp: up, tools: 6, a2a: up, channels: 31, summary: {total: 31, live: 1, connected: 1}}`
- `GET /api/mist/data-boundary` → 200 `{report: 14 findings, 4 high | 6 medium | 4 low}`
- Degradation: mesh killed → route 200 with down statuses; restart → up. Mesh service RUNNING (nohup, survives shell exit).

## Notes for other agents
- Restart mesh service: `cd /home/z/my-project/mini-services/mesh-service && (nohup bun run dev > dev.log 2>&1 &)` then `curl localhost:3004/health`
- The dev server on :3000 was OOM-killed/restarted several times during this window (6 parallel agents + compile load) — dev-guard recovered it each time; transient 500/empty responses during ~19:59–20:08 were that restart cycle, not route bugs.
- `rate-limiter.ts` is ready for spine/ops wiring: `checkRateLimit('chat' | 'tools' | 'research' | 'mcp', key)`.
- Environment incident: none of my files were affected; I never touched other agents' files.
