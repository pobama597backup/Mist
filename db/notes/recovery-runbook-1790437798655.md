# recovery-runbook

- created: 2026-09-26T15:49:58.656Z

# Full Recovery Runbook

## Dev-Server Wedge Recovery
**Signature:** 1.7GB RAM usage + held port + unresponsive
**Action:** Kill the wedged process and let dev-guard respawn automatically.
**Do NOT:** Manual restart — dev-guard handles respawn.

## Offline-Mind Fallthrough Recovery
**Root Cause:** Chat path aborted 550B brain at 30s timeout while premium lanes remained healthy. Fallback mechanism failed to route to healthy premium lanes within timeout window.
**Action:**
1. Verify premium lane health (should be healthy)
2. Check fallback routing configuration
3. Increase timeout threshold or add circuit breaker
4. Test fallback path with synthetic load

## Self-Modification Protocol
**Rule:** Never write source directly — evolution gate only.
**Blocked:** Bridge edits to health/route.ts are now blocked.
**Process:** All code changes must go through the evolution gate process.
**If blocked:** Submit evolution proposal via evolution_suggest or evolution_scan.

## General Recovery Principles
1. **Observe first** — check memory facts for known signatures
2. **Trust automation** — dev-guard, Hermes, and other guardians handle respawn
3. **Route through gates** — never bypass evolution gate for code changes
4. **Document incidents** — store facts in memory, create runbook entries
5. **Compose lessons** — use dream_compose to integrate learnings

## Emergency Contacts
- Dev-guard: auto-respawn monitor
- Hermes: local agent for system tasks
- Evolution gate: all source modifications
- Memory system: long-term fact storage

---
*Generated from today's incidents. Update after each new incident pattern.*
