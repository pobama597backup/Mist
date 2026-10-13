// M.I.S.T. Arbiter · the A4 unleash protocol (Phase 5 · A6).
//
// A4 ("Unleashed") is reached ONLY through this ritual — never through the
// settings dial (A0–A3 there), never through a prompt. The ritual:
//
//   POST /api/mist/autonomy/unleash {passphrase?, scope, durationMs}
//     · owner session (the perimeter gate — proxy.ts 403s sessionless POSTs)
//     · passphrase match when one is set (Setting a4_passphrase, min 8 chars)
//     · duration 5min–24h at the ROUTE (default 2h); the SERVICE floor is 5s
//       so tests and short rituals can run (documented honestly)
//   Effects: setAutonomyScope('A4') + an in-memory session record + an
//   append-only audit row 'a4_start' carrying the FULL scope JSON + a
//   lifecycle-registered expiry timer.
//
//   While active: owner_chat/owner_voice UNTAINTED intents INSIDE the scope
//   stop asking (the matrix's A4 branch); still asks for tainted content,
//   voice-exec unless voiceWaived, protected paths (floor 1) and out-of-scope
//   tools (the budget/scope fallback to the A2 matrix).
//
//   KILL: one tap, NO passphrase, ≤1s — aborts every registered turn
//   controller (in-flight unified calls + their bridge execs die through the
//   R1 abort chain), reverts the scope, audits 'a4_kill'.
//
//   EXPIRY: the timer + a lazy check inside resolveArbiterScope/a4Status
//   (now >= expiryAt → revert + audit 'a4_expire') — whichever fires first.
//
// Budget honesty (v1): the session counts ALLOWED calls in-memory against
// scope.budget.maxCalls; spendCapUsd is recorded in the audit scope JSON —
// per-lane price enforcement is future work (documented in the phase report).
import type { Scope } from './arbiter'
import { appendAuditEvent } from './audit'
import { getAutonomyScope, setAutonomyScope } from './wiring'
import { getAutonomyScopeSetting, getA4Passphrase } from '@/lib/services/candor-service'
import { register } from '@/lib/services/lifecycle'

export interface A4BudgetSpec {
  maxCalls?: number
  windowMs?: number
  spendCapUsd?: number
}

export interface A4ScopeSpec {
  tools: string[] // exact tool names, or ['*']
  pathPrefixes: string[] // when non-empty, file-ish args must fall under one
  budget: A4BudgetSpec
  voiceWaived: boolean
}

export interface A4Session {
  id: string
  startedAt: number
  expiryAt: number
  scope: A4ScopeSpec
  usedCalls: number
  /** the scope to revert to when the session ends (the pre-A4 truth) */
  preScope: Scope
}

/** The ROUTE-level ritual window: 5 minutes … 24 hours (default 2h). */
export const A4_ROUTE_MIN_MS = 300_000
export const A4_MAX_MS = 24 * 3_600_000
export const A4_DEFAULT_MS = 2 * 3_600_000
/** The SERVICE floor — short windows are legal for tests/timers; the ritual
 *  route enforces the 5min floor on top of this. */
export const A4_SERVICE_MIN_MS = 5_000

interface A4Store {
  session: A4Session | null
  turnControllers: Set<AbortController>
  timer?: ReturnType<typeof setTimeout>
}

const g = globalThis as unknown as { __mistA4?: A4Store }

function store(): A4Store {
  return (g.__mistA4 ??= { session: null, turnControllers: new Set() })
}

function normalizeScope(raw: Partial<A4ScopeSpec> | undefined): A4ScopeSpec {
  const strArr = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.length > 0).slice(0, 64) : []
  const budget = (raw?.budget ?? {}) as A4BudgetSpec
  return {
    tools: strArr(raw?.tools).length > 0 ? strArr(raw?.tools) : ['*'],
    pathPrefixes: strArr(raw?.pathPrefixes),
    budget: {
      ...(typeof budget.maxCalls === 'number' && budget.maxCalls > 0 ? { maxCalls: Math.floor(budget.maxCalls) } : {}),
      ...(typeof budget.windowMs === 'number' && budget.windowMs > 0 ? { windowMs: budget.windowMs } : {}),
      ...(typeof budget.spendCapUsd === 'number' && budget.spendCapUsd > 0 ? { spendCapUsd: budget.spendCapUsd } : {}),
    },
    voiceWaived: raw?.voiceWaived === true,
  }
}

async function auditA4(kind: 'a4_start' | 'a4_kill' | 'a4_expire', session: A4Session | null, extra?: string): Promise<void> {
  await appendAuditEvent({
    tool: 'a4_unleash',
    argsJson: JSON.stringify({ session: session ? { id: session.id, scope: session.scope } : null, extra: extra ?? null }).slice(0, 2000),
    risk: 'self-modify',
    origin: 'owner_chat',
    decision: kind === 'a4_start' ? 'allow' : 'deny',
    reason: `${kind}${extra ? ` — ${extra}` : ''}`,
    turnId: null,
  }).catch(() => undefined)
}

/** End the session: revert scope + abort controllers + clear the timer.
 *  auditKind picks the honest reason string. */
async function endSession(auditKind: 'a4_kill' | 'a4_expire', extra?: string): Promise<void> {
  const s = store()
  const session = s.session
  s.session = null
  if (s.timer) {
    clearTimeout(s.timer)
    s.timer = undefined
  }
  // abort every in-flight turn controller (≤1s — the abort is synchronous;
  // the R1 chain kills the in-flight fetches this tick)
  for (const ac of s.turnControllers) {
    try {
      ac.abort(new Error(`a4_${auditKind === 'a4_kill' ? 'kill' : 'expire'}`))
    } catch {
      /* a dead controller is already aborted */
    }
  }
  s.turnControllers.clear()
  if (session) {
    setAutonomyScope(session.preScope === 'A4' ? 'A2' : session.preScope)
    await auditA4(auditKind, session, extra)
  }
}

/** True when the session exists and is unexpired (lazy expiry inside). */
function activeSession(now = Date.now()): A4Session | null {
  const s = store()
  if (!s.session) return null
  if (now >= s.session.expiryAt) return null
  return s.session
}

// ---------------------------------------------------------------- public surface

export interface A4Status {
  active: boolean
  startedAt?: number
  expiryAt?: number
  remainingMs?: number
  scope?: A4ScopeSpec
  usedCalls?: number
  preScope?: Scope
  passphraseRequired: boolean
}

/** The badge state (lazy expiry — a lapsed session reports inactive and is
 *  ended with its honest audit row on the next call). */
export async function a4Status(): Promise<A4Status> {
  const s = store()
  if (s.session && Date.now() >= s.session.expiryAt) {
    await endSession('a4_expire', 'timer window elapsed')
  }
  const session = activeSession()
  const passphraseRequired = (await getA4Passphrase()) !== null
  if (!session) return { active: false, passphraseRequired }
  return {
    active: true,
    startedAt: session.startedAt,
    expiryAt: session.expiryAt,
    remainingMs: Math.max(0, session.expiryAt - Date.now()),
    scope: session.scope,
    usedCalls: session.usedCalls,
    preScope: session.preScope,
    passphraseRequired,
  }
}

/** The ritual itself. Returns the session or an honest error. */
export async function startA4Session(opts: {
  durationMs: number
  scope?: Partial<A4ScopeSpec>
  now?: number
}): Promise<{ ok: boolean; error?: string; session?: A4Session }> {
  const s = store()
  const now = opts.now ?? Date.now()
  const durationMs = Math.floor(opts.durationMs)
  if (!Number.isFinite(durationMs) || durationMs < A4_SERVICE_MIN_MS || durationMs > A4_MAX_MS) {
    return { ok: false, error: `duration must be ${A4_SERVICE_MIN_MS}ms–${A4_MAX_MS}ms` }
  }
  // one session at a time — a second ritual kills the first (honest restart)
  if (s.session) await endSession('a4_kill', 'superseded by a new unleash ritual')
  const session: A4Session = {
    id: `a4-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    startedAt: now,
    expiryAt: now + durationMs,
    scope: normalizeScope(opts.scope),
    usedCalls: 0,
    preScope: getAutonomyScope() === 'A4' ? 'A2' : getAutonomyScope(),
  }
  s.session = session
  setAutonomyScope('A4')
  // the expiry timer (belt) — resolveArbiterScope/a4Status hold the braces
  s.timer = setTimeout(() => {
    void endSession('a4_expire', 'timer window elapsed')
  }, durationMs + 1)
  try {
    s.timer.unref?.()
  } catch {
    /* runtimes without unref */
  }
  register('a4-unleash-expiry', () => {
    if (s.timer) clearTimeout(s.timer)
  })
  await auditA4('a4_start', session)
  return { ok: true, session }
}

/** The kill switch: one tap, no passphrase, ≤1s. Idempotent. */
export async function killA4(reason?: string): Promise<{ ok: boolean; killed: boolean }> {
  const s = store()
  if (!s.session) return { ok: true, killed: false }
  await endSession('a4_kill', reason ?? 'owner kill switch')
  return { ok: true, killed: true }
}

/**
 * Register a turn's AbortController so the kill switch can abort it ≤1s.
 * unified() links one per turn while A4 is active; the returned fn unregisters
 * (the turn ended normally — its controller does not need killing anymore).
 */
export function registerA4TurnController(ac: AbortController): () => void {
  const s = store()
  s.turnControllers.add(ac)
  return () => {
    s.turnControllers.delete(ac)
  }
}

/** Count one ALLOWED call against the session budget (wiring calls this after
 *  an A4-scope allow verdict). No-op without an active session. */
export function noteA4AllowedCall(): void {
  const session = activeSession()
  if (session) session.usedCalls++
}

function pathInScope(session: A4Session, filePath: string | null): boolean {
  const prefixes = session.scope.pathPrefixes
  if (prefixes.length === 0) return true
  if (!filePath) return false
  const norm = filePath.replace(/\\/g, '/').toLowerCase()
  return prefixes.some((p) => norm.startsWith(p.replace(/\\/g, '/').toLowerCase()))
}

/**
 * The scope resolver the tool chokepoint calls before arbitrate():
 *   · A4 session active + tool in scope + path in scope + budget remaining
 *       → { scope: 'A4', budget, voiceWaived } (the matrix stops asking)
 *   · anything else (no session, expired, out-of-scope tool/path, exhausted
 *     budget) → the settings-backed scope (A0–A3, default A2) — the honest
 *     fallback the mandate calls "budget fallback".
 * The lazy expiry check rides every call.
 */
export async function resolveArbiterScope(
  tool: string,
  filePath: string | null
): Promise<{ scope: Scope; budget?: { callsRemaining: number }; voiceWaived?: boolean; a4?: boolean }> {
  const s = store()
  if (s.session && Date.now() >= s.session.expiryAt) {
    await endSession('a4_expire', 'lazy check on arbitration')
  }
  const session = activeSession()
  if (session) {
    const toolOk = session.scope.tools.includes('*') || session.scope.tools.includes(tool)
    const maxCalls = session.scope.budget.maxCalls
    const callsRemaining = typeof maxCalls === 'number' ? Math.max(0, maxCalls - session.usedCalls) : Number.MAX_SAFE_INTEGER
    if (toolOk && pathInScope(session, filePath) && callsRemaining > 0) {
      return {
        scope: 'A4',
        budget: { callsRemaining },
        voiceWaived: session.scope.voiceWaived,
        a4: true,
      }
    }
  }
  // the settings dial (A0–A3) — synced into the module seam so
  // getAutonomyScope() and every other reader stay coherent
  const setting = await getAutonomyScopeSetting()
  if (getAutonomyScope() !== setting && getAutonomyScope() !== 'A4') {
    setAutonomyScope(setting)
  }
  return { scope: getAutonomyScope() === 'A4' ? 'A2' : getAutonomyScope() }
}
