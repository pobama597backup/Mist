// Alert priority — ONE shared classifier for every delivery surface.
//
// Mark-LV's system_monitor.py speaks [SYSTEM_ALERT]s the moment a threshold
// trips; our guardian (heartbeat-service) already raises the same warnings as
// Alert rows. This module decides, for every alert, HOW LOUD it deserves to
// be on each surface:
//
//   severity 'critical' → toast + OS notification + SPOKEN out loud
//   severity 'important' → toast + OS notification
//   severity 'info' → toast + chat only (presence over chatter)
//
// Client-safe (no server imports) — used by use-alerts delivery and the
// notification bell alike.

import type { AlertInfo } from '@/lib/types'

export type AlertSeverity = 'critical' | 'important' | 'info'

/** Guardian warning kinds — machine health always earns a voice. */
const GUARDIAN_KINDS = new Set([
  'cpu',
  'ram',
  'disk',
  'thermal',
  'defender',
  'logons',
  'battery',
  'virus',
  'threat',
  'security',
])

/** Kinds that matter on the desktop even when they are not machine health. */
const IMPORTANT_KINDS = new Set(['system', 'mark-lv-sync', 'evolution'])

export function alertSeverity(alert: Pick<AlertInfo, 'kind' | 'title' | 'meta'>): AlertSeverity {
  const meta = (alert.meta ?? {}) as Record<string, unknown>
  // explicit severity wins — services can tag their own rows
  const explicit = typeof meta.severity === 'string' ? (meta.severity as string) : null
  if (explicit === 'critical' || explicit === 'important' || explicit === 'info') {
    return explicit
  }
  // guardian rows (source: 'guardian' or a machine-health meta.kind) are the
  // warnings the creator asked to hear out loud: ram, storage, threats…
  const metaKind = typeof meta.kind === 'string' ? (meta.kind as string) : null
  if (meta.source === 'guardian' || (metaKind !== null && GUARDIAN_KINDS.has(metaKind))) {
    // disk critical / thermal critical / defender off / logons → speak now
    const title = alert.title ?? ''
    if (/critical|OFF|failed logon/i.test(title) || metaKind === 'defender' || metaKind === 'logons') {
      return 'critical'
    }
    return 'critical'
  }
  if (alert.kind === 'system' || IMPORTANT_KINDS.has(alert.kind)) return 'important'
  return 'info'
}

/** Should this alert fire a desktop (OS) notification? */
export function wantsOsNotification(alert: Pick<AlertInfo, 'kind' | 'title' | 'meta'>): boolean {
  const s = alertSeverity(alert)
  return s === 'critical' || s === 'important'
}

/** Should this alert be SPOKEN out loud while the app is open? */
export function wantsSpokenWarning(alert: Pick<AlertInfo, 'kind' | 'title' | 'meta'>): boolean {
  return alertSeverity(alert) === 'critical'
}

/** Small color token per severity (notification bell chips). */
export const SEVERITY_STYLE: Record<AlertSeverity, string> = {
  critical: 'border-rose-400/30 bg-rose-400/10 text-rose-300',
  important: 'border-amber-400/30 bg-amber-400/10 text-amber-300',
  info: 'border-white/10 bg-white/5 text-slate-400',
}
