// Welcome briefing — client delivery (shared by the boot greeting and the
// bell's "Brief me" button). One path: append to the thread, live-render,
// join the notification feed, toast, and SPEAK it — she greets with her
// voice, never a dormant wall of text.

'use client'

import { toast } from 'sonner'
import { useMistStore } from '@/lib/store'
import { mistApi } from '@/lib/mist-api'
import { mistSpeech, stripMarkdownForSpeech } from '@/lib/speech'
import { pushLocalNotification } from '@/lib/notification-feed'
import type { AlertInfo, ChatMessage } from '@/lib/types'

export interface WelcomeResponse {
  greet: boolean
  text?: string
  provider?: string
  recap?: string[]
  news?: string[]
  error?: string
}

/** Resolve where a briefing lands — active thread, else latest, else the
 *  dedicated alerts thread (same semantics as alert delivery). */
async function resolveThread(): Promise<{ id: string | null; is_active: boolean }> {
  const activeId = useMistStore.getState().threads.activeId
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

/** Deliver a composed briefing: chat + feed + toast + voice. NEVER throws. */
export async function deliverBriefing(res: WelcomeResponse): Promise<boolean> {
  const text = (res.text ?? '').trim()
  if (!text) return false
  const store = useMistStore.getState()
  const target = await resolveThread()
  let saved: ChatMessage | null = null
  if (target.id) {
    try {
      saved = await mistApi.conversations.appendMessage(target.id, 'assistant', text, {
        provider: 'welcome',
        meta: { briefing: true, provider_lane: res.provider ?? 'unknown' },
      })
      if (target.is_active && saved) {
        window.dispatchEvent(new CustomEvent<ChatMessage>('mist:alert', { detail: saved }))
      } else {
        store.bumpThreadsRefresh()
      }
    } catch {
      // persistence failed — toast + voice still fire; the briefing is not lost
    }
  }
  // the briefing joins the notification feed like any other surfaced event
  pushLocalNotification({
    id: saved?.id ?? `welcome-${Date.now()}`,
    kind: 'system',
    title: 'Welcome-back briefing',
    body: text,
    status: 'delivered',
    meta: { severity: 'info', briefing: true },
    conversation_id: target.id,
    created_at: new Date().toISOString(),
    delivered_at: new Date().toISOString(),
  } satisfies AlertInfo)
  toast('Welcome back', { description: text.slice(0, 180), duration: 9000 })
  if (store.ttsEnabled) {
    void mistSpeech.speak(stripMarkdownForSpeech(text).slice(0, 700))
  }
  return true
}

/** The bell's button: compose NOW (no greet gate) and deliver. */
export async function briefMeNow(): Promise<boolean> {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
  const res = (await fetch('/api/mist/welcome', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'brief', tz }),
  }).then((r) => r.json())) as WelcomeResponse
  if (!res.greet || !res.text) throw new Error(res.error ?? 'briefing failed')
  return deliverBriefing(res)
}

/** The boot check: greet when the server says it is warranted. */
export async function welcomeCheck(): Promise<boolean> {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
    const res = (await fetch(`/api/mist/welcome?tz=${encodeURIComponent(tz)}`).then((r) =>
      r.json()
    )) as WelcomeResponse
    if (!res.greet || !res.text) return false
    return await deliverBriefing(res)
  } catch {
    return false // a failed greeting must never break the boot
  }
}

/** The open app pings this every 5 min — same-session reloads never re-greet. */
export function pingSeen(): void {
  void fetch('/api/mist/welcome', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'seen' }),
  }).catch(() => undefined)
}
