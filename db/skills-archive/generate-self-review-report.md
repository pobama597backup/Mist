---
name: generate-self-review-report
archivedAt: 2026-10-12T08:21:23.465Z
archiveReason: phase7-audit ARCHIVE — docs/phase-0/prisma-and-skills.md §D7: strict duplicate of the self-review-report chain
---

# generate-self-review-report (ARCHIVED)

Archived by scripts/skills-audit-7.ts — M.I.S.T. Sovereign Hardening Mandate,
Phase 7 (skills deep audit), executing the Phase 0 triage recorded in
docs/phase-0/prisma-and-skills.md §D7.

## Trigger

When the user asks for a self-review summarizing evolution proposals, skill usage stats, memory stats and recent autonomy actions

## Steps

1. Use the learning_status tool to get skill usage stats 2. Use the mist_self_status tool to get memory stats 3. Use the autonomy_log tool to get recent autonomy actions 4. Use the evolution_list tool to get evolution proposals 5. Use the skill:self-review-report tool to generate a structured self-review report with clear sections for each data component

## Tool chain (as stored)

["skill:self-review-report","autonomy_log","evolution_list","learning_status","mist_self_status"]

## Chain-max effective risk at archive time

- risk class: sensitive-read
- dead tools: none
- unresolved nested entries: none

## Notes

The reordering of steps to gather all data before report generation has resolved the incomplete report issue. Recent executions show consistent success. The skill now properly aggregates all required data before synthesis. The report generation would benefit from more structured formatting to improve readability and highlight key insights that require user attention.

## Provenance (as stored on the live row)

- uses: 7
- origin: auto
- trust: owner
- source: (null)
- createdByTurn: (null)
- pinned: false
- createdAt: 2026-09-28T21:02:41.112Z

## Archive reason

phase7-audit ARCHIVE — docs/phase-0/prisma-and-skills.md §D7: strict duplicate of the self-review-report chain
