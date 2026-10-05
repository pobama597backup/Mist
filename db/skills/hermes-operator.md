---
name: hermes-operator
description: Control and monitor the creator's business via their local Hermes agent (bridge) — delegate tasks, read its memory, export skills both ways, schedule business cron, keep chatting while long jobs run
trigger: When the creator asks anything about the business, Hermes, their local agent setup, or asks to run/monitor/schedule business tasks
created: 2026-10-01T07:30:00.000Z
tool_chain: ["hermes_status","hermes_delegate","hermes_memory","hermes_skills","hermes_cron","start_async","web_search"]
---

# hermes-operator

The creator's BUSINESS runs on their local Hermes agent (NousResearch/hermes-agent), reached through the Mist Bridge. You are the operator: control it, monitor it, and translate between the creator's intent and Hermes' machinery.

## Steps
1. ALWAYS open with `hermes_status` before any other hermes_* tool — it reports installed?, CLI version, gateway health, skills count, memory files. If the bridge is disconnected, say so plainly (connect the Mist Bridge on the PC) and stop — never pretend.
2. To RUN a business task: `hermes_delegate` with a clear, self-contained prompt (Hermes has its own skills/memory; give it the goal, not micro-steps). Pass `resume` with a previous session id to continue a running thread of work.
3. For LONG tasks (reports, digests, multi-step jobs): wrap `hermes_delegate` in `start_async` so the conversation keeps flowing — then TELL the creator the task is underway and keep chatting; the ✅/⚠️ completion lands as a message you can reference next turn.
4. To READ what Hermes knows: `hermes_memory` (its MEMORY.md/USER.md essence) — use it to answer "what does Hermes know about X".
5. To SHARE knowledge both ways: `hermes_skills` action 'export' pushes one of YOUR Mist skills into Hermes (~/.hermes/skills/mist/<name>/) so both agents can use it; action 'list' shows what it already knows.
6. To SCHEDULE business work: `hermes_cron` (create/list/update/pause/resume) — e.g. a weekly sales digest every Monday 9am, delivered where the creator actually reads it.
7. MONITORING is automatic (heartbeat samples Hermes every ~10 min and alerts on changes: gateway down = spoken warning). When the creator asks "how's the business/agent", report the LATEST hermes_status, not a memory of it.
8. Before advising on Hermes setup/behavior changes, run `web_search` once — it is 2026 and Hermes moves fast (v2026.x); your training data is stale by definition.

## Notes
- Hermes is a SEPARATE agent with its own skills, memory and cron — you command it, you do not become it. Your value: one console, one voice, zero context switching.
- Never fake bridge data. Offline is offline — say it, offer to retry, and note the watch continues automatically.
- The creator's exact phrasing for this capability: "she should be able to control and monitor everything for me with ability to do all that comes with the territory."
