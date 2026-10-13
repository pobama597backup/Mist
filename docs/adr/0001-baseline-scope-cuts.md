# ADR 0001 — Phase 0 baseline: scope cuts for spend/interactive metrics

Date: 2026-10-07 · Status: accepted

1. Problem: the mandate's baseline list includes metrics requiring live LLM spend (TTFT ×3),
   an LLM-stubbed 82-route harness, 20× browser mount/unmount heap sampling, and production
   chunk sizes — all incompatible with "no product edits" Phase 0 and this sandbox (build banned,
   no local model installed).
2. Decision: `scripts/audit/baseline.ts` captures every deterministic local metric now
   (tsc, eslint, tool registry, buildContext p50/p95 + static-prefix, GET-smoke routes, binds,
   UI counts, dead deps, dev-served first-load JS, 60 s idle CPU/network, DB pragmas);
   spend metrics sit behind `--full` for the Phase-1 red-team run; candor corpus = UNVERIFIED
   (no local model — exactly as the mandate allows); heap/mount-unmount deferred to the Phase-3
   listener-count invariant.
3. Why not stdlib-only alternatives: none exist for "measure TTFT without spending" — the cut
   is scope, not tooling; zero new deps added.
4. Risk: first-load JS labeled `dev-server (upper bound of prod)` overstates the prod number —
   accepted; DoD compares against THIS baseline, so the ratio stays meaningful.
5. Rollback: delete `scripts/audit/baseline.ts` + `docs/baseline-*.json` (no product code touched).
