// M.I.S.T. abort linking (Phase 3-a · R1/R8 — AbortSignal end-to-end).
//
// The mandate: a client-owned AbortSignal (NextRequest#signal — fires when the
// caller's TCP connection dies or the fetch is aborted) must reach every
// provider fetch and every bridge exec. Each site already owns a timeout
// AbortController; linking the owner signal INTO that controller (abort the
// controller when the owner's signal fires) keeps every call site a two-line
// change instead of a composite-signal refactor. Runtime note: Bun and Node
// ≥20 both ship AbortSignal.any, but a listener bridge is behaviorally
// identical here and keeps the helper free of realm/casting edge cases.

/** Bridge an optional owner signal into a timeout controller: when the owner
 *  aborts, the controller aborts and the in-flight fetch using
 *  `controller.signal` dies. Returns the unlink fn for the call site's
 *  `finally` (a missing unlink would only leak a dead listener — but we are
 *  tidy). An already-aborted owner signal aborts immediately. */
export function linkOwnerSignal(
  ac: AbortController,
  owner?: AbortSignal | null
): () => void {
  if (!owner) return () => {}
  if (owner.aborted) {
    ac.abort()
    return () => {}
  }
  const onAbort = () => ac.abort()
  owner.addEventListener('abort', onAbort, { once: true })
  return () => owner.removeEventListener('abort', onAbort)
}

/** True when the OWNER cancelled (as opposed to a per-attempt timeout firing).
 *  This is the discriminator callers use to choose honest semantics: an
 *  owner abort must never count as a lane failure (no cooldown, no sticky
 *  demotion) and never returns a partial as success. */
export function ownerAborted(owner?: AbortSignal | null): boolean {
  return owner?.aborted === true
}

/** True for the DOMException/Error fetch throws on abort (name 'AbortError'
 *  in undici and Bun; some paths throw a bare Error with the word in it). */
export function isAbortError(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.name === 'AbortError' || /aborted/i.test(err.message))
  )
}
