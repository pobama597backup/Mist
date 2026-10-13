---
name: model-selector
trigger: When selecting or evaluating the best model for a task or capability
created: 2026-10-13T01:15:37.759Z
tool_chain: ["memory_get","memory_set","capability_check"]
---

# model-selector

## Steps
1. Analyze task requirements and complexity
2. Check available models, their capabilities, and current quota
3. Review historical performance and cost-efficiency metrics
4. Select the best model with a short justification (weighted criteria)
5. Monitor performance and update the selection criteria

## Notes
Phase 7 skills deep audit (docs/phase-0/prisma-and-skills.md §D7 MERGE): unified from adaptive-model-selector + gpt6-luna-evaluator + optimal-model-selector — three overlapping model-selection skills with conflicting tool probes. Dead omni_* chain entries dropped; the merged chain is the live TOOL_RISK-verified subset (memory_get, memory_set, capability_check). (Row restored by .zscripts/repair-db-wipe.ts after the 2026-10-12 DB wipe.)
