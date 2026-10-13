// Heartbeat alert delivery — Phase 4-a · R11: the 30s poll interval is
// GONE; the shared events channel drives delivery (a change on the `alerts`
// topic → one poll; the poll itself still delivers, persists and marks
// delivered server-side exactly as before). The boot + focus polls stay as
// fallbacks for when the channel is paused (hidden tab) or down.
//
// Pending alerts (⏰ due reminders, 📦 upstream releases, ⚠️ machine health)
// are:
//   1. toasted (always visible, even outside the chat view),
//   2. SPOKEN out loud when the severity is critical (RAM, storage, heat,
//      threats — the creator asked to HEAR these, not just read them),
//   3. fired as OS desktop notifications (PC notification panel) when the
//      severity is critical/important and permission was granted,
//   4. persisted into the chat — the ACTIVE thread, else the most recent
//      thread, else a dedicated "M.I.S.T. Alerts" thread — so every alert
//      lands in history; live-rendered via a 'mist:alert' window event only
//      when it belongs to the thread currently on screen,
//   5. published to the notification feed (the bell's catch-up panel),
//   6. marked delivered server-side (never re-fired).
'use client'

import { useEffect, useRef } from 'react'
import { toast } from 'sonner'
import { useMistStore } from '@/lib/store'
import { mistApi } from '@/lib/mist-api'
import { mistSpeech, stripMarkdownForSpeech } from '@/lib/speech'
import { alertSeverity, wantsOsNotification, wantsSpokenWarning } from '@/lib/alert-priority'
import { showOsNotification } from '@/lib/os-notifications'
import { publishNotificationFeed } from '@/lib/notification-feed'
import { subscribeMistEvents } from '@/hooks/use-events'
import { shouldRefetch } from '@/lib/events-protocol'
import type { AlertInfo, ChatMessage } from '@/lib/types'

function alertToMessage(alert: AlertInfo): string {
  const lines = [alert.title]
  if (alert.body.trim()) lines.push(alert.body.trim())
  return lines.join('\n')
}

/** Speak a warning out loud — newest wins, same as every utterance she owns. */
function speakAlert(alert: AlertInfo): void {
  const spoken = stripMarkdownForSpeech(`${alert.title}. ${alert.body}`).slice(0, 400)
  if (!spoken) return
  void mistSpeech.speak(spoken, { noStream: true })
}

export function useMistAlerts(): void {
  const activeThreadId = useMistStore((s) => s.threads.activeId)
  const bumpThreadsRefresh = useMistStore((s) => s.bumpThreadsRefresh)
  const activeRef = useRef<string | null>(activeThreadId)
  // written in an effect (never during render) per react-hooks/refs — the only
  // reader is resolveThread inside the poll/deliver callbacks, all of which
  // run post-commit, so the post-render mirror is behaviorally identical
  useEffect(() => {
    activeRef.current = activeThreadId
  })
  const inFlight = useRef(false)

  useEffect(() => {
    let alive = true

    /** Alerts must ALWAYS land in chat history — active thread, else latest, else a dedicated one. */
    const resolveThread = async (): Promise<{ id: string | null; is_active: boolean }> => {
      const activeId = activeRef.current
      if (activeId) return { id: activeId, is_active: true }
      try {
        const list = await mistApi.conversations.list()
        const latest = list[0]?.id
        if (latest) return { id: latest, is_active: false }
        const created = await mistApi.conversations.create('M.I.S.T. Alerts')
        return { id: created.id, is_active: false }
      } catch {
        return { id: null, is_active: false }
      }
    }

    const deliver = async (pending: AlertInfo[]): Promise<void> => {
      if (pending.length === 0) return
      const target = await resolveThread()
      let appended = false
      const store = useMistStore.getState()
      for (const alert of pending) {
        const severity = alertSeverity(alert)
        // 1) always toast — the user sees it even outside the chat view
        toast(alert.title, {
          description: alert.body.slice(0, 180) || undefined,
          duration: severity === 'critical' ? 8000 : 5000,
        })
        // 2) spoken warnings — critical machine-health alerts get her voice
        if (wantsSpokenWarning(alert) && store.ttsEnabled && store.spokenAlertsEnabled) {
          speakAlert(alert)
        }
        // 3) OS desktop notification — the PC's notification panel
        if (
          wantsOsNotification(alert) &&
          store.osNotificationsEnabled &&
          showOsNotification(alert.title, alert.body || alert.title, alert.id)
        ) {
          // spoken + OS would double-announce; speech wins when it fires
        }
        // 4) persist into the thread; live-render only when it's on screen
        if (target.id) {
          try {
            const saved = await mistApi.conversations.appendMessage(
              target.id,
              'assistant',
              alertToMessage(alert),
              { provider: 'heartbeat', meta: { alert_kind: alert.kind, alert_id: alert.id, severity } }
            )
            appended = true
            if (target.is_active) {
              window.dispatchEvent(new CustomEvent<ChatMessage>('mist:alert', { detail: saved }))
            }
          } catch {
            // persistence failed — the toast still fired; mark delivered anyway
            // so the alert is not lost to retry storms
          }
        }
      }
      // 5) mark delivered
      try {
        await mistApi.alerts.deliver(
          pending.map((a) => a.id),
          target.id
        )
        if (appended && !target.is_active) bumpThreadsRefresh()
      } catch {
        // server will re-offer them on the next poll — harmless
      }
    }

    const poll = async () => {
      if (inFlight.current) return
      inFlight.current = true
      try {
        const res = await mistApi.alerts.list()
        if (!alive) return
        publishNotificationFeed(res.pending, [...res.recent, ...(res.history ?? [])])
        await deliver(res.pending)
      } catch {
        // backend offline — next poll retries
      } finally {
        inFlight.current = false
      }
    }

    // first poll slightly delayed so the app shell settles (the events
    // channel usually delivers the alerts snapshot sooner — inFlight dedups)
    const boot = setTimeout(poll, 4000)
    // Phase 4-a · R11: the events channel replaces the 30s interval — a
    // change on the `alerts` topic (or the post-reconnect snapshot) polls
    // ONCE. Heartbeats never trigger a poll (shouldRefetch).
    const unsubEvents = subscribeMistEvents((ev) => {
      if (shouldRefetch(ev, 'alerts')) void poll()
    })
    window.addEventListener('focus', poll)
    return () => {
      alive = false
      unsubEvents()
      clearTimeout(boot)
      window.removeEventListener('focus', poll)
    }
  }, [bumpThreadsRefresh])
}
