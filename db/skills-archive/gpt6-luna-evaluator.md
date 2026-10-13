---
name: gpt6-luna-evaluator
archivedAt: 2026-10-12T08:21:23.457Z
archiveReason: phase7-audit MERGE — folded into `model-selector` (docs/phase-0/prisma-and-skills.md §D7: three model-selector skills with overlapping triggers and conflicting tool probes)
---

# gpt6-luna-evaluator (ARCHIVED)

Archived by scripts/skills-audit-7.ts — M.I.S.T. Sovereign Hardening Mandate,
Phase 7 (skills deep audit), executing the Phase 0 triage recorded in
docs/phase-0/prisma-and-skills.md §D7.

## Trigger

When evaluating whether to use GPT-6 Luna for a specific task based on its capabilities

## Steps

1. Analyze task requirements against GPT-6 Luna's documented capabilities
2. Check current quota and availability for the model
3. Assess if Luna's specific features (e.g., improved reasoning) would benefit the task
4. Consider cost-performance ratio compared to other available models
5. Make recommendation with justification

## Tool chain (as stored)

["omni_list_models","omni_usage_quota","capability_check","memory_set"]

## Chain-max effective risk at archive time

- risk class: persist
- dead tools (unknown to the frozen TOOL_RISK register, counted at the conservative unknown default 'write'): omni_list_models, omni_usage_quota
- unresolved nested entries: none

## Notes

auto-proposed by the self-upgrade cycle — trend: AI agents evolving rapidly with security concerns

## Provenance (as stored on the live row)

- uses: 0
- origin: auto
- trust: owner
- source: (null)
- createdByTurn: (null)
- pinned: false
- createdAt: 2026-09-24T17:43:50.792Z

## Archive reason

phase7-audit MERGE — folded into `model-selector` (docs/phase-0/prisma-and-skills.md §D7: three model-selector skills with overlapping triggers and conflicting tool probes)
