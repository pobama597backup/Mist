# Task oj-mind-2 — OpenJarvis memory/learning/knowledge layer port

> NOTE: /agent-ctx at filesystem root is not writable from this sandbox (root-owned, no sudo);
> this project-local agent-ctx/ directory is the shared equivalent.

## What I built (all under /home/z/my-project)

**NEW files (owned):**
- `src/lib/oj/knowledge-service.ts` — knowledge store port: heading-aware semantic chunker (~800-char cap, 100-char non-compounding overlap, port of connectors/chunker.py), `ingestKnowledge()` (dedupes by source+sourceId so re-sync replaces), `searchKnowledge()` hybrid retrieval — BM25 (k1=1.5, b=0.75, IDF over the ≤1500-row candidate scan) + M.I.S.T.'s existing TF-cosine vector score (imported via the new memory-service `lexicalSimilarity` hook), fused with RRF (k=60, port of connectors/hybrid_search.py) → frozen shape {id, source, title, content, score, bm25, vector}; `listChunks()` + `knowledgeStatus()` (per-source chunk/doc counts via $queryRaw).
- `src/lib/oj/connectors.ts` — 14 connectors: LIVE upload (db/upload + upload/, text-only, binary-sniff skip), obsidian (via existing obsidian-service), notes (db/notes), github (api.github.com public, README+metadata, honest 403 rate-limit reporting), hackernews (firebase API, no auth); CONFIG-GATED reddit (public .json, needs subreddit); HONEST-UNCONFIGURED gmail/gdrive/gcal/slack/notion/linear/discord/twitter (available:false, connected:false, never faked). State+config in db/connectors/state.json (globalThis-cached). items = distinct ingested docs per source.
- `src/lib/oj/persona.ts` — SOUL/MEMORY/USER.md three-layer persona (db/persona/): seeds created on first load (Clare identity consistent with app tone; the journey: amnesia fixed via 8 self-repair runs, lessons ledger, OpenJarvis absorption; USER template). `getPersonaContext()` = one compact block (~2250 chars ≈ 560 tokens), OpenJarvis head_tail truncation (70/20 + omission marker), 30s cache. `appendPersonaMemory(kind, text, {trusted})` trust-gated: SOUL refuses untrusted; MEMORY [auto]/[verified]/[quarantined] tiers (quarantine section excluded from prompts); USER blocks untrusted writes. Structured field get/set for USER.md.
- `src/lib/oj/session-compress.ts` — `compressForContext()`/`compressHistory()`: keeps system + first user + tail-that-fits; middle → z-ai LLM summary (120-word cap prompt, 30s timeout); fallback = rule-based tiered one-liners (port of sessions/compression.py TieredSummaries) with honest note. VERIFIED: 14109→771 tokens, method 'llm', first-user kept.
- `src/lib/oj/skill-overlay.ts` — DSPy/GEPA → "llm-fewshot" honest adaptation: ≥1 successful SkillExecution required (min_traces gate) else overlay=null; one cheap LLM call distills 3 input→output pairs from skill description + top-5 executions; cached db/skills/overlays/{skillId}.json; robust JSON-array parsing; LLM failure → null.
- `src/lib/oj/knowledge-tools.ts` — `KNOWLEDGE_TOOLS: BaseToolDef[]` (imported from tools-service — spine-1's export landed): knowledge_search, scan_chunks, memory_manage (add/list/delete/trust with auto→trusted|untrusted quarantine), user_profile_manage (get/set USER.md fields).

**EDITED (surgical, additive):**
- `src/lib/services/memory-service.ts` — trust-tier quarantine: latestFacts now excludes untrusted + prefers trusted (prompt path); listFactsWithTrust() audit view; setFactTrust() promote/quarantine; upsertFact(key, value, trust='auto') (quarantined facts never vector-indexed); `export { similarity as lexicalSimilarity }` hook for the knowledge layer. All existing exports preserved.
- `src/lib/services/context-builder.ts` — persona block injection (after self-model), knowledge-store hits block (top-3, score ≥0.2 threshold, cite-source instruction), skill-block overlay few-shot injection; BuiltContext + optional persona_loaded/knowledge_hits.
- `src/lib/services/skills-service.ts` — additive `overlayExamplesFor(skillName)` (60s TTL cache, dynamic import, null = no change).

**NEW routes (all force-dynamic, nodejs):**
- `src/app/api/mist/knowledge/ingest/route.ts` — POST {source, title?, text | files:[{name, base64}]} → {chunks: n}; binary sniff (NUL/control-chars) → honest skip note; 8MB/2MB caps.
- `src/app/api/mist/knowledge/search/route.ts` — POST {query, filters?{source,docType}, topK?} → frozen {results:[{id,source,title,content,score,bm25,vector}]}.
- `src/app/api/mist/connectors/route.ts` — GET frozen listing; POST {id, action:'sync', config?} honest sync (config persists).

## Curl-verified (live server :3000)
- ingest text: `{"ok":true,"chunks":1}`; ingest base64 file: 1 chunk; binary: honest skip note
- search "five primitive assistant framework": ranked hits, exact frozen shape
- connectors GET: 14 connectors; connected only [upload, obsidian, notes, hackernews]
- sync obsidian: 9 vault notes ingested; sync notes: 34 notes (402 chunks); sync hackernews: 5 stories (live API); sync github (vercel/next.js): honest `HTTP 403 (rate limited)` — sandbox IP exhausted the 60 req/h unauth quota; sync gmail: honest refusal
- memory_manage: add → trust untrusted (quarantined, excluded from latestFacts prompt path) → delete all ok
- user_profile_manage set/get ok; persona block in buildContext prompt: persona_loaded=true, knowledge_hits=3

## Notes for other agents
- tools-service `export type BaseToolDef` (spine-1) is used by knowledge-tools.ts — lead wires KNOWLEDGE_TOOLS into BASE_TOOLS.
- The dev server OOM-died once mid-verification (6 parallel agents compiling) — system supervisor brought it back; if every route 500s with a stale Turbopack error, hit the failing route once to force recompile.
- GitHub API from this sandbox IP is rate-limited right now — github connector honestly reports it; retry later or wire a token.

## Verification
- `bunx tsc --noEmit`: clean project-wide at finish. `bun run lint`: exit 0.
- Test scripts used during verification were deleted; persona seeds restored to pristine after trust-gating tests.
