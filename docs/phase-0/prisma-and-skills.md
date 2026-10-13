# Phase 0 — D6 Prisma query/index map + D7 runtime skills audit

## D6 Prisma (26 models, 15 indexed; full stats in docs/baseline-2026-10-07.json → database)

Hot unindexed models (per-turn / per-minute lookups, no `@@index` in schema.prisma):
- `LongtermMemory` — 8 findUnique + 7 upsert + 6 findMany (identity, persona, memory_get/set per turn)
- `MemoryQueue` — pending-fact scans
- `VectorMemory` — recall scans (P6: lexical, English-only `[a-z0-9]`)
- `FastReply` — every inbound chat message (w3 fast-path)
- `SpokenCache` — every TTS chunk (w5)
- `PermissionMemory`, `Operator`, `SubAgent` — moderate frequency

Indexed and fine: Conversation, Message, Alert, SkillExecution, EvolutionProposal, CronJob, AutonomyEvent,
SubAgent(×1), AgentRun, Mission, MissionLesson, Dream, Trace, TraceStep, KnowledgeChunk, Approval, Digest, TeacherNotice.

Config facts: `db/custom.db`; journal mode measured **delete** (no WAL in code — R9 confirmed); `log:['query']`
live (S9); `db:push` script carries `--accept-data-loss` (banned by mandate); gitignore misses `db/*.db*` (verify Phase 1 step 7).

## D7 Runtime `db/skills/*.md` — 18 files (brief said 21 — 3 removed since snapshot; overlays/*.json = sandbox residue, not skills)

### KEEP (11) — live chains, owner-crafted, referenced by her tool registry
- `hermes-operator.md` (w4 Hermes protocol) · `research-first.md` (w4 ritual) · `quick-math.md` · `pdf-extract.md` ·
  `get-latest-version.md` · `read-package-version.md` · `count-images-downloads.md` · `research-ai-agents.md` ·
  `self-review-report.md` · `system-health-check.md` · `system-status-with-weather.md`

### MERGE (3 → 1) — three model-selector skills with overlapping triggers
- `optimal-model-selector` + `adaptive-model-selector` + `gpt6-luna-evaluator` → one `model-selector` skill
  (they also disagree with each other on which tools to probe)

### ARCHIVE (4) — chains reference DEAD tools
- `agent-skills-integration` (omni_skills_catalog — omni tools exist only via mesh gateway probe; chain breaks when gateway is down),
  `security-threat-monitor` (trigger "during system interactions" is over-broad + duplicates the oj spine),
  `exec-proof` (test-generated — mandate Phase 7 says audit; keep archived copy for the ledger test),
  `generate-self-review-report` (strict duplicate of `self-review-report` chain)

Provenance note (S11): all 18 have `created` dates but **zero** `source/trust/createdByTurn/pinned` fields —
the Phase-2 schema migration adds them; imports land in the quarantine inbox until accepted.

`skills/` (69 folders, 61 MB) = Z.ai sandbox, NOT runtime (runtime reads `db/skills/*.md` only — skills-service.ts:9 equivalent
`SKILLS_DIR`). Phase 8 archives it; not audited as live surface.
