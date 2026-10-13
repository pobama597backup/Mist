# ADR 0001 — Baseline measurement constraints in the sandbox

- **Problem**: The mandate's DoD requires production build metrics (`next build`, chunk sizes, build time), but this sandbox forbids `next build` (the dev server owns `.next` on :3000 and must stay live).
- **Decision**: `scripts/audit/baseline.ts` measures a dev-mode first-load payload as a proxy and marks production-only metrics `UNVERIFIED` with the PC measurement method attached; no number is faked.
- **Why**: R2 doctrine — honest measurement beats theater; killing the dev server to measure a build would cost more than the number is worth.
- **Consequence**: Bundle/DoD comparisons vs `min(60% baseline, 250KB gz)` must be re-baselined on the owner's PC before Phase 4 exit; sandbox numbers are directional only.
- **Revisit**: Phase 4 entry (re-run on PC: `bun run build` + `@next/bundle-analyzer` before/after).
