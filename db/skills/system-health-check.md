---
name: system-health-check
trigger: When the user requests a system self-check or wants to verify system status and evolution gates
created: 2026-09-26T01:38:31.550Z
tool_chain: ["mist_self_check","evolution_status"]
---

# system-health-check

## Steps
1. Run mist_self_check to assess system health including code quality, development log, and general system status 2. Use evolution_status to check the status of evolution gates including proposals, applied changes, pending items, and safety protocols 3. Compile and present a comprehensive summary of both system health and evolution gate status

## Notes
auto-learned after a 2-tool turn (confidence 0.90) — grew out of skill "quick-math"
