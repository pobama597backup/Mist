// M.I.S.T. lifecycle registry (Phase 3-a · mandate: "instrumentation.ts owns
// timers + SIGTERM").
//
// ONE place owns process lifecycle: services that arm intervals/timeouts
// REGISTER their stop handles here when they arm (they keep their existing
// self-arming logic and once-flags — this is additive, not a rewire), and
// src/instrumentation.ts installs the SIGTERM/SIGINT handlers that call
// shutdown(). Before this, every service loop was unref'd and immortal: a
// SIGTERM killed the process mid-write with zero cleanup.
//
// EDGE-RUNTIME NOTE (why `process` is never touched directly): Next 16
// compiles src/instrumentation.ts for BOTH the nodejs and the Edge runtime,
// and the Edge compile statically REJECTS direct Node APIs (process.once /
// process.exit — it warned on every dev compile until this was shaped).
// Signal handling therefore goes through a runtime-capability probe of
// globalThis: on the Edge runtime (no process object) the probe returns null
// and every entry point is an honest no-op. This is the Node-only feature it
// claims to be — probed, not assumed.
//
// Registry semantics:
//   register(name, stop)     — ADD/REPLACE by name (an HMR re-arm that clears
//                              the old interval and arms a new one simply
//                              re-registers; the old entry is replaced)
//   registerInterval(name, i)— convenience for setInterval handles
//   unregister(name)         — drop an entry (service stopped itself)
//   registeredNames()        — introspection (tests, /health surfaces)
//   __testShutdown()         — run every stop WITHOUT exiting (test mode)
//   shutdown(reason)         — stops + prisma.$disconnect + exit(0), with a
//                              5s force-exit timer in case a stop hangs
//
// The registry lives on globalThis so dev hot-reload (a fresh module instance)
// keeps one shared set of entries instead of forking the registry.

export interface LifecycleEntry {
  /** stable service name, e.g. 'heartbeat-watch' */
  name: string
  /** clears the timers / flushes / closes what this service armed */
  stop: () => void
}

interface LifecycleGlobal {
  __mistLifecycle?: {
    entries: Map<string, LifecycleEntry>
    shuttingDown: boolean
    handlersInstalled: boolean
  }
}

const g = globalThis as unknown as LifecycleGlobal
const state = (g.__mistLifecycle ??= {
  entries: new Map<string, LifecycleEntry>(),
  shuttingDown: false,
  handlersInstalled: false,
})

/** The Node process object, or null where it does not exist (Edge runtime). */
interface NodeProcessLike {
  once(sig: string, fn: () => void): unknown
  exit(code: number): unknown
}
function nodeProcess(): NodeProcessLike | null {
  const p = (globalThis as { process?: unknown }).process
  if (p && typeof (p as NodeProcessLike).once === 'function' && typeof (p as NodeProcessLike).exit === 'function') {
    return p as NodeProcessLike
  }
  return null
}

/** Register (or replace) a service's stop handle. */
export function register(name: string, stop: () => void): void {
  state.entries.set(name, { name, stop })
}

/** Convenience: register an armed setInterval handle by name. */
export function registerInterval(name: string, handle: ReturnType<typeof setInterval>): void {
  register(name, () => {
    try {
      clearInterval(handle)
    } catch {
      /* already cleared */
    }
  })
}

/** Drop an entry (a service that stopped itself). */
export function unregister(name: string): void {
  state.entries.delete(name)
}

/** Names currently registered (introspection). */
export function registeredNames(): string[] {
  return [...state.entries.keys()].sort()
}

/** Run every registered stop, exactly once. Never throws past a misbehaving
 *  stop — one bad service must not block the rest of the shutdown. */
async function runStops(): Promise<void> {
  if (state.shuttingDown) return
  state.shuttingDown = true
  for (const entry of state.entries.values()) {
    try {
      entry.stop()
    } catch {
      /* a failing stop must not block the others */
    }
  }
}

/** Test seam: run every stop WITHOUT process.exit (bun test would die on
 *  exit(0) — the suite asserts clears, not process death). Resets the
 *  once-guard so a later test can shutdown again. */
export async function __testShutdown(): Promise<void> {
  state.shuttingDown = false
  await runStops()
  state.shuttingDown = false
}

/** Graceful shutdown: stop every service loop, disconnect Prisma, exit 0.
 *  A 5s force-exit timer guarantees the process dies even if a stop or the
 *  disconnect hangs (the mandate's "5s force-exit"). No-op (logged) where no
 *  Node process exists (Edge runtime). */
export async function shutdown(reason: string): Promise<void> {
  const proc = nodeProcess()
  console.log(`[lifecycle] shutdown requested (${reason}) — stopping ${state.entries.size} service loop(s)`)
  await runStops()
  try {
    // lazy import: instrumentation must not pay for Prisma at boot, only at exit
    const { db } = await import('@/lib/db')
    await db.$disconnect()
  } catch {
    /* best effort — the process exits regardless */
  }
  console.log('[lifecycle] all stops complete — exiting')
  if (!proc) return // Edge runtime: nothing to exit (and this never runs there)
  // 5s force-exit: if anything above hung a promise, the timer still ends us
  setTimeout(() => proc.exit(0), 5_000)
  proc.exit(0)
}

/** Install the SIGTERM/SIGINT handlers (idempotent — called from
 *  src/instrumentation.ts's register(), guarded against double-install for
 *  HMR and for test processes that import the module repeatedly). Honest
 *  no-op on the Edge runtime (no process object to receive signals). */
export function installSignalHandlers(): void {
  if (state.handlersInstalled) return
  const proc = nodeProcess()
  if (!proc) return // Edge runtime — there is no process to own signals of
  state.handlersInstalled = true
  proc.once('SIGTERM', () => {
    void shutdown('SIGTERM')
  })
  proc.once('SIGINT', () => {
    void shutdown('SIGINT')
  })
}
