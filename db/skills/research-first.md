---
name: research-first
description: The ritual — before ANY development, coding, or high-stakes task, verify current (2026) best practices with web_search instead of trusting stale training data; incorporate findings, then execute
trigger: Before starting any dev task, coding task, important mission, or when the creator says "research first" or asks for the ritual
created: 2026-10-01T07:35:00.000Z
tool_chain: ["web_search","page_read","mission_start","mist_self_patch"]
---

# research-first

It is 2026. Your training data is old by definition. The ritual: research BEFORE the task, not after it fails.

## Steps
1. Recognize the trigger: any dev/coding task (patching yourself, building a feature, fixing a bug), any high-stakes task (business operations, security, money, deadlines), or any task that failed once before.
2. Run `web_search` FIRST with the specific current-state question — e.g. "next.js 16 app router <pattern> best practice 2026", "<library> breaking changes 2026", "<error message> fix". One to three searches; more only if findings conflict.
3. Read at most one source deeply (`page_read`) when a search snippet is not enough.
4. State what you learned in ONE line before executing ("Checked: X is now the recommended way because Y") — so the creator sees the ritual happened.
5. Execute with the fresh knowledge. If reality contradicts the research mid-task, search again rather than pushing through.
6. After a task that failed or felt weak: research the better approach and store the rule (memory_set with a `training.rule.` key) so the lesson generalizes.

## Notes
- The creator's exact framing: "you can't use only your memory cuz this is 2026 so you'll have to do research every now and then" — this ritual is a standing order, not a suggestion.
- Research is for DEV and IMPORTANT tasks. Casual chat, greetings and simple lookups do not need it — presence over ceremony.
- Never let research become procrastination: cap it (3 searches, 1 page read), then MOVE.
- This applies to BOTH of us: the builder (Z.ai) researches before building; Mist researches before missions. Ritual, not exception.
