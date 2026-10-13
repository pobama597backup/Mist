// M.I.S.T. candor service (Phase 5 · C2) — the persisted candor dial + the
// autonomy-scope setting + the A4 passphrase, all in real Setting rows via
// settings-service (2s cached reads, instant invalidation on route-side
// writes — the outbound-watchers pattern from 4-b).
//
// Resolution order (the mandate): conversation override → global setting →
// Standard. Unfiltered is LOCAL LANES ONLY (llm-service enforces the walk
// order); the dial never silently downgrades — a turn with no reachable local
// lane in Unfiltered fails HONESTLY with the wizard CTA.
//
// The autonomy scope setting: A0–A3 are settable here (A3 needs the
// standing-orders budget view — Phase 6 gets the full UI; today it is the
// setting + the honest scope chip). A4 is NEVER settable through settings —
// only the unleash ritual (src/lib/arbiter/unleash.ts) reaches it.
import type { CandorMode } from '@/lib/candor'
import { isCandorMode } from '@/lib/candor'
import type { Scope } from '@/lib/arbiter/arbiter'
import { getSetting, setSetting } from './settings-service'
import { db } from '@/lib/db'
import { recordActivity } from './activity-service'

export const SETTING_CANDOR_MODE = 'candor_mode'
export const SETTING_AUTONOMY_SCOPE = 'autonomy_scope'
export const SETTING_A4_PASSPHRASE = 'a4_passphrase'

const SCOPES: readonly Scope[] = ['A0', 'A1', 'A2', 'A3'] // A4 excluded by design

// ---------------------------------------------------------------- the dial

/** The global candor mode (default Standard when unset/corrupt). */
export async function getGlobalCandorMode(): Promise<CandorMode> {
  const raw = await getSetting(SETTING_CANDOR_MODE)
  return isCandorMode(raw) ? raw : 'standard'
}

/** Set the global candor mode (owner UI / API). */
export async function setGlobalCandorMode(mode: CandorMode): Promise<{ ok: boolean }> {
  if (!isCandorMode(mode)) return { ok: false }
  const res = await setSetting(SETTING_CANDOR_MODE, mode)
  if (res.ok) {
    recordActivity(
      'settings',
      mode === 'unfiltered'
        ? 'candor dial → UNFILTERED — local lanes only; no cloud, no keyless, no relay, no cloud voice'
        : mode === 'frank'
          ? 'candor dial → FRANK — full candor; cloud lanes only where the owner consented (keyed/local carry context)'
          : 'candor dial → STANDARD'
    )
  }
  return res
}

/** Set (or clear) one conversation's candor override. mode null = inherit. */
export async function setConversationCandor(conversationId: string, mode: CandorMode | null): Promise<{ ok: boolean }> {
  if (mode !== null && !isCandorMode(mode)) return { ok: false }
  try {
    await db.conversation.update({
      where: { id: conversationId },
      data: { candorMode: mode },
    })
    return { ok: true }
  } catch {
    return { ok: false }
  }
}

/**
 * The resolved candor mode for a turn: conversation override → global
 * setting → Standard. Never throws.
 */
export async function resolveCandorMode(conversationId?: string | null): Promise<CandorMode> {
  if (conversationId) {
    try {
      const row = await db.conversation.findUnique({ where: { id: conversationId }, select: { candorMode: true } })
      if (row && isCandorMode(row.candorMode)) return row.candorMode
    } catch {
      /* fall through to the global setting */
    }
  }
  return getGlobalCandorMode()
}

// ---------------------------------------------------------------- autonomy scope (A0–A3 dial)

/** The settings-backed autonomy scope (A0–A3; A4 is the unleash ritual only).
 *  Default A2 (ask-by-default) — the pre-Phase-5 behavior. */
export async function getAutonomyScopeSetting(): Promise<Scope> {
  const raw = await getSetting(SETTING_AUTONOMY_SCOPE)
  return SCOPES.includes(raw as Scope) ? (raw as Scope) : 'A2'
}

/** Set the autonomy scope setting (A0–A3 only — A4 through settings is a
 *  category error and refused here). */
export async function setAutonomyScopeSetting(scope: 'A0' | 'A1' | 'A2' | 'A3'): Promise<{ ok: boolean }> {
  if (!SCOPES.includes(scope)) return { ok: false }
  const res = await setSetting(SETTING_AUTONOMY_SCOPE, scope)
  if (res.ok) {
    recordActivity('settings', `autonomy scope → ${scope} (the Arbiter's ask floor follows on the next decision)`)
  }
  return res
}

// ---------------------------------------------------------------- the A4 passphrase

/** The owner's unleash passphrase (null when unset). Never surfaced raw. */
export async function getA4Passphrase(): Promise<string | null> {
  const raw = await getSetting(SETTING_A4_PASSPHRASE)
  return raw && raw.length >= 8 ? raw : null
}

/** Set or clear the passphrase. Minimum 8 characters — a 2-char passphrase
 *  guarding an unleashed session is decoration, not a gate. */
export async function setA4Passphrase(pass: string | null): Promise<{ ok: boolean; error?: string }> {
  if (pass === null) {
    const res = await setSetting(SETTING_A4_PASSPHRASE, '')
    recordActivity('settings', 'A4 passphrase cleared')
    return { ok: res.ok }
  }
  if (typeof pass !== 'string' || pass.length < 8) {
    return { ok: false, error: 'passphrase must be at least 8 characters' }
  }
  const res = await setSetting(SETTING_A4_PASSPHRASE, pass)
  if (res.ok) recordActivity('settings', 'A4 passphrase set (min 8 chars)')
  return { ok: res.ok }
}
