---
name: agent-skills-integration
trigger: When requesting capabilities covered by Anthropic's Agent Skills standard
created: 2026-09-24T17:40:27.198Z
tool_chain: ["omni_skills_catalog","memory_set","memory_get"]
---

# agent-skills-integration

## Steps
1. Check if requested skill exists in the Agent Skills catalog
2. Load the skill definition using the standard format
3. Map skill parameters to MIST's tool system
4. Execute the skill and format results according to standard

## Notes
auto-proposed by the self-upgrade cycle — trend: AI agents evolve with skills, security risks rise
