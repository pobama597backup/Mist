# ADR 0002 — Gateway-aware perimeter (do not break the sandbox preview)

- **Problem**: Phase 1 perimeter rules (Host allowlist → 421, same-origin enforcement, socket.io `allowRequest`, CSP) would 421/403 the owner's own preview if hardcoded to `localhost:3000`, because the app is reached through the platform gateway (`Caddyfile :81` → `XTransformPort` reverse proxy, external Host, same-origin sockets).
- **Decision**: All origin checks are **dynamic same-origin** (compare `Origin`/`Sec-Fetch-Site` against the request's own `Host`), never a static host list; strict loopback-only mode is opt-in via `MIST_STRICT_HOST=1` (default ON in the PC package, OFF in the sandbox). The sandbox `Caddyfile` is platform infrastructure — never moved or edited; the "move Caddy XTransformPort to ops/sandbox/" item applies to the PC package only.
- **Why**: The threat model is third-party origins commanding her — same-origin-through-gateway IS the owner; a static allowlist would block the owner, not the attacker.
- **Consequence**: socket.io `allowRequest` reflects same-origin upgrades; CSP uses `connect-src 'self'` + explicit loopback entries; `MIST_LAN=1` widens for PC LAN use with a visible warning.
- **Revisit**: Phase 1 exit tests must include a gateway-path socket upgrade + page load through the proxy (not just direct :3000).
