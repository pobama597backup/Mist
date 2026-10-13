// M.I.S.T. route error helper (Phase 3-a · R12/R8).
//
// The phase-0 audit found six /api/mist routes whose handlers could throw
// straight into Next's DEFAULT error page — an HTML 500 on a JSON API. Every
// /api/mist route must return JSON errors, never an HTML error page: this is
// the shared shape (mirrors the existing per-route catch blocks — unified,
// tools/execute — so the fix is a wrap, not a new convention).
import { NextResponse } from 'next/server'

/** Honest 500 JSON: the error message (never HTML), status 500. */
export function routeError(err: unknown, fallback = 'internal error'): NextResponse<{ error: string }> {
  const message = err instanceof Error ? err.message : fallback
  return NextResponse.json({ error: message }, { status: 500 }) as NextResponse<{ error: string }>
}
