---
name: self-review-report
trigger: when user requests a self-review summarizing evolution proposals, skill usage stats, memory stats and recent autonomy actions
created: 2026-09-24T21:04:52.603Z
tool_chain: ["autonomy_log","evolution_list","learning_status","mist_self_status"]
---

# self-review-report

## Steps
1. Run autonomy_log to get recent autonomy actions and organize them chronologically
2. Run evolution_list to get evolution proposals and categorize by priority status
3. Run learning_status to get skill usage stats and identify most/least used skills
4. Run mist_self_status to get system status and memory metrics
5. Compile information into a structured self-review report with clear sections for each component, including summary statistics and notable trends

## Notes
The steps effectively retrieve all required information. Recent executions show consistent successful operation. Memory stats are now properly included. The compilation step should present information in a structured format with clear sections for each component (evolution proposals, skill usage stats, memory stats, and autonomy actions). Adding chronological organization for autonomy actions and categorization for evolution proposals improves readability. Identifying trends in skill usage provides additional insight into system behavior.
