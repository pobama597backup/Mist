---
name: agent-skills-integration
archivedAt: 2026-10-12T08:21:23.460Z
archiveReason: phase7-audit ARCHIVE — docs/phase-0/prisma-and-skills.md §D7: chains DEAD omni_skills_catalog (the omni tools exist only via the mesh gateway probe; the chain breaks when the gateway is down)
---

# agent-skills-integration (ARCHIVED)

Archived by scripts/skills-audit-7.ts — M.I.S.T. Sovereign Hardening Mandate,
Phase 7 (skills deep audit), executing the Phase 0 triage recorded in
docs/phase-0/prisma-and-skills.md §D7.

## Trigger

When requesting capabilities covered by Anthropic's Agent Skills standard

## Steps

1. Check if requested skill exists in the Agent Skills catalog
2. Load the skill definition using the standard format
3. Map skill parameters to MIST's tool system
4. Execute the skill and format results according to standard

## Tool chain (as stored)

["omni_skills_catalog","memory_set","memory_get"]

## Chain-max effective risk at archive time

- risk class: persist
- dead tools (unknown to the frozen TOOL_RISK register, counted at the conservative unknown default 'write'): omni_skills_catalog
- unresolved nested entries: none

## Notes

auto-proposed by the self-upgrade cycle — trend: AI agents evolve with skills, security risks rise

## Provenance (as stored on the live row)

- uses: 0
- origin: auto
- trust: owner
- source: (null)
- createdByTurn: (null)
- pinned: false
- createdAt: 2026-09-24T17:40:27.198Z

## Archive reason

phase7-audit ARCHIVE — docs/phase-0/prisma-and-skills.md §D7: chains DEAD omni_skills_catalog (the omni tools exist only via the mesh gateway probe; the chain breaks when the gateway is down)
