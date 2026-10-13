---
name: adaptive-model-selector
archivedAt: 2026-10-12T08:21:23.450Z
archiveReason: phase7-audit MERGE — folded into `model-selector` (docs/phase-0/prisma-and-skills.md §D7: three model-selector skills with overlapping triggers and conflicting tool probes)
---

# adaptive-model-selector (ARCHIVED)

Archived by scripts/skills-audit-7.ts — M.I.S.T. Sovereign Hardening Mandate,
Phase 7 (skills deep audit), executing the Phase 0 triage recorded in
docs/phase-0/prisma-and-skills.md §D7.

## Trigger

When selecting optimal AI model for specific tasks based on performance history

## Steps

1. Analyze task requirements and complexity
2. Review historical performance data for available models
3. Consider cost and efficiency metrics
4. Select best model based on weighted criteria
5. Monitor performance and update selection criteria

## Tool chain (as stored)

["omni_list_models","omni_usage_quota","memory_set","memory_get","omni_switch_model"]

## Chain-max effective risk at archive time

- risk class: persist
- dead tools (unknown to the frozen TOOL_RISK register, counted at the conservative unknown default 'write'): omni_list_models, omni_usage_quota, omni_switch_model
- unresolved nested entries: none

## Notes

auto-proposed by the self-upgrade cycle — trend: OpenClaw & Agent Skills Lead AI Agent Evolution

## Provenance (as stored on the live row)

- uses: 0
- origin: auto
- trust: owner
- source: (null)
- createdByTurn: (null)
- pinned: false
- createdAt: 2026-09-24T17:45:25.113Z

## Archive reason

phase7-audit MERGE — folded into `model-selector` (docs/phase-0/prisma-and-skills.md §D7: three model-selector skills with overlapping triggers and conflicting tool probes)
