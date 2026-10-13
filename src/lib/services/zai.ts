// z-ai-web-dev-sdk — SERVER-ONLY, DYNAMIC-ONLY singleton.
//
// Phase 4-b · S15: the SDK must never load at boot. This module used to
// `import ZAI from 'z-ai-web-dev-sdk'` statically — every service importing
// getZai() (llm, voice, research, learning, trends, oj digest/operator/
// skill-overlay/session-compress, upstream-sync) paid the SDK's module cost
// up front. Now the first getZai() call awaits a dynamic import (memoized),
// so a process that never calls an SDK-backed function never loads it at all.
// The `import type` line is erased at compile time (zero runtime cost) — it
// exists only so call sites keep full typing. All call sites are backend
// services/route handlers — nothing client-side imports this module (the SDK
// is server-only by contract).
import type ZAISdk from 'z-ai-web-dev-sdk'

/** The created SDK client type (chat.completions + functions). */
export type ZaiClient = Awaited<ReturnType<typeof ZAISdk.create>>

let zaiPromise: Promise<ZaiClient> | null = null

/** Memoized creation. The dynamic import means the SDK loads on FIRST use. */
export function getZai(): Promise<ZaiClient> {
  zaiPromise ??= import('z-ai-web-dev-sdk').then((mod) => mod.default.create())
  return zaiPromise
}
