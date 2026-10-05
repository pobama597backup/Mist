---
name: generate-self-review-report
trigger: When the user asks for a self-review summarizing evolution proposals, skill usage stats, memory stats and recent autonomy actions
created: 2026-09-28T21:02:41.112Z
tool_chain: ["skill:self-review-report","autonomy_log","evolution_list","learning_status","mist_self_status"]
---

# generate-self-review-report

## Steps
1. Use the learning_status tool to get skill usage stats 2. Use the mist_self_status tool to get memory stats 3. Use the autonomy_log tool to get recent autonomy actions 4. Use the evolution_list tool to get evolution proposals 5. Use the skill:self-review-report tool to generate the self-review report

## Notes
Reordered steps to gather all data components before generating the report. This ensures all information is available before synthesis. The original order was causing potential incomplete reports when tools returned data at different speeds. Note: The skill consistently executes successfully but the report generation could benefit from more structured data aggregation.
