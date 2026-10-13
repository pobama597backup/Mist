// M.I.S.T. instrumentation (Phase 3-a).
//
// Next 16 App Router convention: src/instrumentation.ts exports register(),
// called ONCE per server process at boot (before any route compiles). This is
// the ONE place that owns process lifecycle:
//
//   · SIGTERM/SIGINT → lifecycle.shutdown(): stop every registered service
//     loop (heartbeat, scheduler, evolution, openclaw, learning, oj-sync,
//     mark-lv), flush Prisma, exit 0 (5s force-exit inside shutdown()).
//
// Next compiles this file for BOTH the nodejs and the Edge runtime — the
// NEXT_RUNTIME guard is the documented official pattern, and lifecycle.ts
// itself never touches `process` directly (runtime-capability probe — see
// its header) so the Edge compile stays clean.
//
// The service loops THEMSELVES still arm from the health route exactly as
// before (R5 arming is untouched — the once-flags they already carry prevent
// double-arming); each one additionally registers its timer with the
// lifecycle registry when it arms. This file deliberately imports NOTHING
// heavy at boot: the lifecycle module is tiny, and the Prisma disconnect at
// shutdown is a lazy import inside lifecycle.shutdown().
//
// Note: mini-services (neural/mesh/pilot) are separate processes with their
// own SIGTERM handlers (see each mini-service); this file governs the Next
// app process only.

export async function register(): Promise<void> {
  // Skip ONLY the Edge runtime (where signals/process do not exist). Next
  // sets NEXT_RUNTIME='edge' for the edge compile; outside Next (bun tests
  // importing this module directly) the env is unset — installing the
  // handlers is the correct behavior there too.
  if (process.env.NEXT_RUNTIME === 'edge') return
  const { installSignalHandlers } = await import('@/lib/services/lifecycle')
  installSignalHandlers()
}
