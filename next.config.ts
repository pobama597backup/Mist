import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // Phase 3-a (mandate "next.config: reactStrictMode:true + remove
  // ignoreBuildErrors"): strict mode is ON — the phase-0 timer ledger cleared
  // every client effect for double-invocation (module-singleton socket +
  // per-effect cleanup everywhere; the two edge-case leaks were fixed in
  // Phase 3-b's speech.ts work or are documented in docs/phase-0/timer-ledger.md).
  reactStrictMode: true,
  // typescript.ignoreBuildErrors is DELETED (mandate DoD): `bun x tsc
  // --noEmit` is 0 errors and MUST stay 0 — nothing may hide it.
  // NOTE: `next build` itself is NOT run in this sandbox (RAM limits —
  // ADR-0001); build verification is a PC-side step (see scripts/ci.ts,
  // which runs it only when MIST_CI_BUILD=1).
};

export default nextConfig;
