'use client'

// Notification bell — the creator's catch-up panel for everything M.I.S.T.
// surfaced while they were away or looking elsewhere: ⏰ reminders, 📦
// releases, ⚠️ machine-health warnings, briefings. Backed by the shared
// notification feed (written by the alert delivery loop), unread badge from
// lastSeenAt, and the toggles that decide how loud the next alert gets:
// PC notifications (OS panel) + spoken warnings.

import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import {
  Bell,
  BellRing,
  CheckCheck,
  Loader2,
  MonitorSmartphone,
  Sparkles,
  Volume2,
} from 'lucide-react'
import { toast } from 'sonner'
import { formatDistanceToNow } from 'date-fns'
import { useMistStore } from '@/lib/store'
import { alertSeverity, SEVERITY_STYLE } from '@/lib/alert-priority'
import {
  osNotificationPermission,
  osNotificationsSupported,
  requestOsNotifications,
} from '@/lib/os-notifications'
import {
  getNotificationFeed,
  markNotificationsSeen,
  subscribeNotificationFeed,
  unreadNotificationCount,
} from '@/lib/notification-feed'
import { briefMeNow } from '@/lib/welcome-client'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'

function kindLabel(kind: string): string {
  if (kind === 'reminder') return 'reminder'
  if (kind === 'release') return 'release'
  if (kind === 'mark-lv-sync') return 'teacher'
  return 'system'
}

export function NotificationBell() {
  const feed = useSyncExternalStore(subscribeNotificationFeed, getNotificationFeed, getNotificationFeed)
  const osNotificationsEnabled = useMistStore((s) => s.osNotificationsEnabled)
  const setOsNotificationsEnabled = useMistStore((s) => s.setOsNotificationsEnabled)
  const spokenAlertsEnabled = useMistStore((s) => s.spokenAlertsEnabled)
  const setSpokenAlertsEnabled = useMistStore((s) => s.setSpokenAlertsEnabled)
  const [open, setOpen] = useState(false)
  const [permission, setPermission] = useState(osNotificationPermission())
  const [briefing, setBriefing] = useState(false)

  const unread = unreadNotificationCount()

  useEffect(() => {
    // Mark seen when the panel opens AND whenever new items arrive while it
    // stays open. Guarded by unread>0 — markNotificationsSeen() itself bumps
    // feed.revision, so an unguarded effect would loop forever.
    if (open && unread > 0) markNotificationsSeen()
  }, [open, feed.revision, unread])

  const onOsToggle = useCallback(
    async (next: boolean) => {
      if (!next) {
        setOsNotificationsEnabled(false)
        return
      }
      if (!osNotificationsSupported()) {
        toast.error('This browser cannot show PC notifications', {
          description: 'The in-app toasts and spoken warnings still work.',
        })
        return
      }
      let p = osNotificationPermission()
      if (p !== 'granted') p = await requestOsNotifications()
      setPermission(p)
      if (p === 'granted') {
        setOsNotificationsEnabled(true)
        toast.success('PC notifications on', {
          description: 'Important alerts will appear in your notification panel.',
        })
      } else if (p === 'denied') {
        setOsNotificationsEnabled(false)
        toast.error('The browser blocked PC notifications', {
          description: 'Allow notifications for this site in the browser settings, then retry.',
        })
      } else {
        toast('Permission needed', {
          description: 'Click the bell toggle again and accept the browser prompt.',
        })
      }
    },
    [setOsNotificationsEnabled]
  )

  const onBriefMe = useCallback(async () => {
    setBriefing(true)
    try {
      await briefMeNow()
      setOpen(false)
    } catch (err) {
      toast.error('Briefing failed', {
        description: err instanceof Error ? err.message : 'try again in a moment',
      })
    } finally {
      setBriefing(false)
    }
  }, [])

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={unread > 0 ? `Notifications — ${unread} unread` : 'Notifications'}
          className={cn(
            'relative flex h-11 w-10 shrink-0 items-center justify-center rounded-lg transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-400/60',
            unread > 0 ? 'text-amber-200 hover:bg-amber-400/10' : 'text-slate-400 hover:bg-white/5 hover:text-slate-100'
          )}
        >
          {unread > 0 ? (
            <BellRing aria-hidden className="h-4.5 w-4.5 animate-pulse" />
          ) : (
            <Bell aria-hidden className="h-4.5 w-4.5" />
          )}
          {unread > 0 ? (
            <span
              aria-hidden
              className="absolute right-1 top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-amber-400 px-1 font-mono text-[9px] font-semibold text-slate-950"
            >
              {unread > 9 ? '9+' : unread}
            </span>
          ) : null}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        side="bottom"
        className="w-[340px] border-white/10 bg-slate-950/95 p-0 backdrop-blur-xl sm:w-[400px]"
      >
        <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
          <div className="flex items-center gap-2">
            <Bell aria-hidden className="h-4 w-4 text-purple-300" />
            <span className="text-sm font-semibold tracking-wide text-slate-100">Notifications</span>
            {unread > 0 ? (
              <span className="rounded-full bg-amber-400/15 px-2 py-0.5 font-mono text-[10px] text-amber-300">
                {unread} new
              </span>
            ) : null}
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1 px-2 text-[11px] text-slate-400 hover:text-slate-200"
            onClick={() => markNotificationsSeen()}
          >
            <CheckCheck aria-hidden className="h-3.5 w-3.5" />
            all read
          </Button>
        </div>

        {/* the catch-up list */}
        <div className="max-h-80 overflow-y-auto mist-scroll p-2">
          {feed.items.length === 0 ? (
            <div className="px-3 py-8 text-center">
              <Bell aria-hidden className="mx-auto mb-2 h-5 w-5 text-slate-600" />
              <p className="text-xs leading-relaxed text-slate-500">
                Nothing yet — reminders, releases and machine-health warnings land here.
              </p>
            </div>
          ) : (
            feed.items.map((a) => {
              const severity = alertSeverity(a)
              return (
                <div
                  key={a.id}
                  className="mb-1.5 rounded-lg border border-white/5 bg-white/[0.03] p-2.5 transition-colors hover:bg-white/[0.06]"
                >
                  <div className="flex items-start justify-between gap-2">
                    <p className="min-w-0 flex-1 text-xs font-medium leading-snug text-slate-200">
                      {a.title}
                    </p>
                    <span
                      className={cn(
                        'shrink-0 rounded border px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider',
                        SEVERITY_STYLE[severity]
                      )}
                    >
                      {kindLabel(a.kind)}
                    </span>
                  </div>
                  {a.body.trim() ? (
                    <p className="mt-1 line-clamp-3 text-[11px] leading-relaxed text-slate-500">
                      {a.body}
                    </p>
                  ) : null}
                  <div className="mt-1.5 flex items-center justify-between">
                    <span className="font-mono text-[9px] uppercase tracking-wider text-slate-600">
                      {formatDistanceToNow(new Date(a.created_at), { addSuffix: true })}
                      {a.status === 'pending' ? ' · undelivered' : ''}
                    </span>
                    <span
                      className={cn(
                        'font-mono text-[9px] uppercase tracking-wider',
                        severity === 'critical'
                          ? 'text-rose-400/80'
                          : severity === 'important'
                            ? 'text-amber-400/70'
                            : 'text-slate-600'
                      )}
                    >
                      {severity === 'critical' ? 'spoken + pc' : severity === 'important' ? 'pc panel' : 'quiet'}
                    </span>
                  </div>
                </div>
              )
            })
          )}
        </div>

        {/* delivery controls */}
        <div className="space-y-2.5 border-t border-white/10 px-4 py-3">
          <label className="flex cursor-pointer items-center justify-between gap-3">
            <span className="flex min-w-0 items-center gap-2">
              <MonitorSmartphone aria-hidden className="h-3.5 w-3.5 shrink-0 text-slate-400" />
              <span className="text-[11px] leading-tight text-slate-300">
                PC notifications
                <span className="block text-[9px] text-slate-600">
                  {permission === 'granted'
                    ? 'in your OS notification panel'
                    : permission === 'denied'
                      ? 'blocked by the browser'
                      : permission === 'unsupported'
                        ? 'not supported here'
                        : 'permission asked on first enable'}
                </span>
              </span>
            </span>
            <Switch
              checked={osNotificationsEnabled && permission === 'granted'}
              onCheckedChange={onOsToggle}
              aria-label="PC notifications"
              className="data-[state=checked]:bg-purple-500"
            />
          </label>
          <label className="flex cursor-pointer items-center justify-between gap-3">
            <span className="flex min-w-0 items-center gap-2">
              <Volume2 aria-hidden className="h-3.5 w-3.5 shrink-0 text-slate-400" />
              <span className="text-[11px] leading-tight text-slate-300">
                Spoken warnings
                <span className="block text-[9px] text-slate-600">critical alerts said out loud</span>
              </span>
            </span>
            <Switch
              checked={spokenAlertsEnabled}
              onCheckedChange={(b) => setSpokenAlertsEnabled(b)}
              aria-label="Spoken warnings"
              className="data-[state=checked]:bg-purple-500"
            />
          </label>
          <Button
            variant="outline"
            size="sm"
            className="h-8 w-full gap-1.5 border-white/10 bg-white/[0.03] text-[11px] text-slate-300 hover:bg-white/[0.07] hover:text-slate-100"
            onClick={onBriefMe}
            disabled={briefing}
          >
            {briefing ? (
              <Loader2 aria-hidden className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Sparkles aria-hidden className="h-3.5 w-3.5 text-purple-300" />
            )}
            Brief me — recap + news
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}
