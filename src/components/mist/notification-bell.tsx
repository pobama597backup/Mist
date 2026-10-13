'use client'

// Notification bell — the creator's catch-up panel for everything M.I.S.T.
// surfaced while they were away or looking elsewhere: ⏰ reminders, 📦
// releases, ⚠️ machine-health warnings, briefings. Backed by the shared
// notification feed (written by the alert delivery loop), unread badge from
// lastSeenAt, and the toggles that decide how loud the next alert gets:
// PC notifications (OS panel) + spoken warnings.
//
// ui-5+6b · feed cards: every row is a card with a severity left-accent
// (rose / amber / slate via the shared alert-priority classifier), a relative
// timestamp, and a distinct unread treatment (brighter surface + teal dot —
// judged against the seen-boundary frozen at panel-open, so the dots survive
// the session even though the badge clears on open). Dismissal is per-item
// and UI-level ONLY (the DB alert row is never mutated — a swipe never
// falsely "resolves" a machine-health error), with a visible X button
// (keyboard-accessible) AND a touch swipe: horizontal drag past 80px — under
// 40px of vertical drift — translates + fades the card, release past the
// threshold dismisses, else it springs back. Calm mode skips the gesture
// entirely. Rows that carry a thread reference are actionable: click → chat
// view with that thread selected.

import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { AnimatePresence, motion, useMotionValue, useTransform, type PanInfo } from 'framer-motion'
import {
  ArrowUpRight,
  Bell,
  BellRing,
  CheckCheck,
  ChevronDown,
  Loader2,
  MonitorSmartphone,
  Sparkles,
  Volume2,
  X,
} from 'lucide-react'
import { toast } from 'sonner'
import { useMistStore } from '@/lib/store'
import { alertSeverity, type AlertSeverity } from '@/lib/alert-priority'
import {
  osNotificationPermission,
  osNotificationsSupported,
  requestOsNotifications,
} from '@/lib/os-notifications'
import {
  dismissFeedItem,
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
import type { AlertInfo } from '@/lib/types'

function kindLabel(kind: string): string {
  if (kind === 'reminder') return 'reminder'
  if (kind === 'release') return 'release'
  if (kind === 'mark-lv-sync') return 'teacher'
  return 'system'
}

/** Compact relative time — "just now" / "3m ago" / "2h ago" / "1d ago". */
function relTime(iso: string): string {
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return ''
  const s = Math.max(0, (Date.now() - t) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  if (s < 7 * 86400) return `${Math.floor(s / 86400)}d ago`
  return new Date(t).toLocaleDateString()
}

/** Severity left-accent — 2px rounded bar. 'important' reads as warning (amber). */
const SEVERITY_ACCENT: Record<AlertSeverity, string> = {
  critical: 'bg-rose-400',
  important: 'bg-amber-400',
  info: 'bg-slate-400',
}

/** One feed card — actionable (opens its thread) when it carries a reference. */
function FeedRow({
  item,
  unread,
  reduced,
  onOpenThread,
}: {
  item: AlertInfo
  unread: boolean
  reduced: boolean
  onOpenThread: (threadId: string) => void
}) {
  const threadId =
    typeof item.conversation_id === 'string' && item.conversation_id ? item.conversation_id : null
  const severity = alertSeverity(item)
  // swipe fade — x + opacity only (transform/opacity, zero layout work)
  const dragX = useMotionValue(0)
  const dragOpacity = useTransform(dragX, [-140, 0, 140], [0.35, 1, 0.35])
  // spans throughout (phrasing content) — the whole block may live inside a
  // <button> when the row is actionable
  const content = (
    <>
      <span className="flex items-start gap-1.5 pr-10">
        {unread ? (
          <span
            aria-hidden
            className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-teal-300 shadow-[0_0_6px_rgba(94,234,212,0.6)]"
          />
        ) : null}
        <span
          className={cn(
            'min-w-0 flex-1 text-xs font-medium leading-snug',
            unread ? 'text-slate-200' : 'text-slate-300'
          )}
        >
          {item.title}
        </span>
      </span>
      {item.body.trim() ? (
        <span
          className={cn(
            'mt-1 block line-clamp-2 text-[11px] leading-relaxed',
            unread ? 'text-slate-400' : 'text-slate-500'
          )}
        >
          {item.body}
        </span>
      ) : null}
      <span
        className={cn(
          'mt-1.5 flex items-center justify-between gap-2 font-mono text-[10px]',
          unread ? 'text-slate-500' : 'text-slate-600'
        )}
      >
        <span className="flex min-w-0 items-center gap-1.5">
          <span>{relTime(item.created_at)}</span>
          <span aria-hidden className="text-slate-700">
            ·
          </span>
          <span className="uppercase tracking-wider">{kindLabel(item.kind)}</span>
          {item.status === 'pending' ? (
            <>
              <span aria-hidden className="text-slate-700">
                ·
              </span>
              <span className="uppercase tracking-wider text-amber-300/60">pending</span>
            </>
          ) : null}
        </span>
        {threadId ? (
          <ArrowUpRight aria-hidden className="h-3 w-3 shrink-0 text-slate-600" />
        ) : null}
      </span>
    </>
  )

  return (
    <motion.div
      initial={reduced ? false : { opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, x: reduced ? 0 : -32, transition: { duration: 0.18 } }}
      transition={{ duration: 0.18 }}
      className="mb-1.5"
    >
      {/* swipe-to-dismiss (touch): horizontal drag past 80px — with under 40px
          of vertical drift so list-scroll gestures never misfire — translates +
          fades the card; release past the threshold dismisses, else it springs
          back to origin. Calm mode (reduced motion) skips the drag entirely —
          the X button stays the direct dismiss. */}
      <motion.div
        {...(reduced
          ? {}
          : {
              drag: 'x' as const,
              dragConstraints: { left: -120, right: 120 },
              dragSnapToOrigin: true,
              dragElastic: 0.6,
              style: { x: dragX, opacity: dragOpacity },
              onDragEnd: (_e: unknown, info: PanInfo) => {
                if (Math.abs(info.offset.x) > 80 && Math.abs(info.offset.y) < 40) {
                  dismissFeedItem(item.id)
                }
              },
            })}
      >
        <article
          className={cn(
            'relative rounded-xl border p-3',
            unread ? 'border-white/10 bg-white/[0.06]' : 'border-white/5 bg-white/[0.03]'
          )}
        >
          {/* severity left-accent — the shared classifier decides the color */}
          <span
            aria-hidden
            className={cn(
              'absolute bottom-3 left-0 top-3 w-0.5 rounded-full',
              SEVERITY_ACCENT[severity]
            )}
          />
          {threadId ? (
            <button
              type="button"
              onClick={() => onOpenThread(threadId)}
              aria-label={`Open in chat: ${item.title}`}
              className="block w-full rounded-lg text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-400/60"
            >
              {content}
            </button>
          ) : (
            <div>{content}</div>
          )}
          <button
            type="button"
            aria-label="Dismiss notification"
            onClick={() => dismissFeedItem(item.id)}
            className="absolute right-1.5 top-1.5 flex h-8 w-8 items-center justify-center rounded-lg text-slate-500 transition-colors hover:bg-white/10 hover:text-slate-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-400/60"
          >
            <X aria-hidden className="h-3.5 w-3.5" />
          </button>
        </article>
      </motion.div>
    </motion.div>
  )
}

/** Grouping (v-redesign · the mandate's "grouping for repeated events"):
 * same-titled alerts collapse into ONE card with a ×N chip — a burst of
 * identical approvals or reminders reads as one line, not a wall. Groups
 * keep the newest item's timestamp; expanding reveals the individual rows
 * (full FeedRow behavior: per-item swipe/X/thread-open); the group's own X
 * dismisses every id in it at once. */
interface FeedGroup {
  key: string
  items: AlertInfo[] // newest-first within the group
  unread: boolean // any item past the seen boundary
}

function groupFeed(items: AlertInfo[]): FeedGroup[] {
  const byTitle = new Map<string, AlertInfo[]>()
  for (const a of items) {
    const list = byTitle.get(a.title)
    if (list) list.push(a)
    else byTitle.set(a.title, [a])
  }
  // order groups by their NEWEST item (items arrive newest-first)
  return [...byTitle.values()]
    .map((group) => ({
      key: group[0].id,
      items: group,
      unread: group.length > 1 ? false : false, // computed by the caller (needs seenBoundary)
    }))
    .sort((a, b) => Date.parse(b.items[0].created_at) - Date.parse(a.items[0].created_at))
}

function GroupRow({
  group,
  seenBoundary,
  reduced,
  onOpenThread,
}: {
  group: FeedGroup
  seenBoundary: number
  reduced: boolean
  onOpenThread: (threadId: string) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const newest = group.items[0]
  const unread = group.items.some((a) => Date.parse(a.created_at) > seenBoundary)
  // the group accent = the most severe member (critical > important > info)
  const rank: Record<AlertSeverity, number> = { critical: 0, important: 1, info: 2 }
  const severity = group.items.reduce<AlertSeverity>(
    (worst, a) => (rank[alertSeverity(a)] < rank[worst] ? alertSeverity(a) : worst),
    'info'
  )

  return (
    <div className="mb-1.5">
      <article
        className={cn(
          'relative rounded-xl border p-3',
          unread ? 'border-white/10 bg-white/[0.06]' : 'border-white/5 bg-white/[0.03]'
        )}
      >
        <span
          aria-hidden
          className={cn('absolute bottom-3 left-0 top-3 w-0.5 rounded-full', SEVERITY_ACCENT[severity])}
        />
        <div className="flex items-start gap-1.5 pr-20">
          {unread ? (
            <span
              aria-hidden
              className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-teal-300 shadow-[0_0_6px_rgba(94,234,212,0.6)]"
            />
          ) : null}
          <span
            className={cn(
              'min-w-0 flex-1 text-xs font-medium leading-snug',
              unread ? 'text-slate-200' : 'text-slate-300'
            )}
          >
            {newest.title}
          </span>
          <span
            aria-label={`${group.items.length} similar notifications`}
            className="mt-0.5 shrink-0 rounded-full bg-white/10 px-1.5 py-px font-mono text-[10px] font-semibold text-slate-300"
          >
            ×{group.items.length}
          </span>
        </div>
        <div
          className={cn(
            'mt-1.5 flex items-center justify-between gap-2 font-mono text-[10px]',
            unread ? 'text-slate-500' : 'text-slate-600'
          )}
        >
          <span className="flex min-w-0 items-center gap-1.5">
            <span>{relTime(newest.created_at)}</span>
            <span aria-hidden className="text-slate-700">·</span>
            <span className="uppercase tracking-wider">{kindLabel(newest.kind)}</span>
          </span>
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            aria-expanded={expanded}
            aria-label={expanded ? 'Collapse grouped notifications' : `Expand ${group.items.length} grouped notifications`}
            className="flex h-6 items-center gap-1 rounded-md px-1.5 text-slate-400 transition-colors hover:bg-white/10 hover:text-slate-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-400/60"
          >
            <ChevronDown
              aria-hidden
              className={cn('h-3 w-3 transition-transform duration-200', expanded && 'rotate-180')}
            />
            {expanded ? 'less' : 'all'}
          </button>
        </div>
        {/* group dismiss — one X clears every id in the burst */}
        <button
          type="button"
          aria-label={`Dismiss ${group.items.length} grouped notifications`}
          onClick={() => {
            for (const a of group.items) dismissFeedItem(a.id)
          }}
          className="absolute right-1.5 top-1.5 flex h-8 w-8 items-center justify-center rounded-lg text-slate-500 transition-colors hover:bg-white/10 hover:text-slate-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-400/60"
        >
          <X aria-hidden className="h-3.5 w-3.5" />
        </button>
      </article>
      {expanded ? (
        <div className="mt-1 ml-3 border-l border-white/10 pl-2">
          <AnimatePresence initial={false}>
            {group.items.map((a) => (
              <FeedRow
                key={a.id}
                item={a}
                unread={Date.parse(a.created_at) > seenBoundary}
                reduced={reduced}
                onOpenThread={onOpenThread}
              />
            ))}
          </AnimatePresence>
        </div>
      ) : null}
    </div>
  )
}

export function NotificationBell() {
  const feed = useSyncExternalStore(subscribeNotificationFeed, getNotificationFeed, getNotificationFeed)
  const osNotificationsEnabled = useMistStore((s) => s.osNotificationsEnabled)
  const setOsNotificationsEnabled = useMistStore((s) => s.setOsNotificationsEnabled)
  const spokenAlertsEnabled = useMistStore((s) => s.spokenAlertsEnabled)
  const setSpokenAlertsEnabled = useMistStore((s) => s.setSpokenAlertsEnabled)
  const reduced = useMistStore((s) => s.reducedMotion)
  const [open, setOpen] = useState(false)
  const [permission, setPermission] = useState(osNotificationPermission())
  const [briefing, setBriefing] = useState(false)
  // The seen-boundary frozen at panel-open — the unread DOTS are judged
  // against this, not the live lastSeenAt (which markNotificationsSeen bumps
  // the moment the panel opens: the badge must clear on open, but the dots
  // survive the session so the creator can still see WHICH rows were new).
  const [seenBoundary, setSeenBoundary] = useState(0)

  const unread = unreadNotificationCount()

  useEffect(() => {
    // Mark seen when the panel opens AND whenever new items arrive while it
    // stays open. Guarded by unread>0 — markNotificationsSeen() itself bumps
    // feed.revision, so an unguarded effect would loop forever.
    if (open && unread > 0) markNotificationsSeen()
  }, [open, feed.revision, unread])

  const onOpenChange = useCallback((next: boolean) => {
    if (next) {
      // snapshot the PRE-open boundary before the mark-seen effect fires
      const seen = getNotificationFeed().lastSeenAt
      const t = seen ? Date.parse(seen) : 0
      setSeenBoundary(Number.isFinite(t) ? t : 0)
    }
    setOpen(next)
  }, [])

  /** Row click on a thread-carrying item → chat view with that thread open. */
  const onOpenThread = useCallback((threadId: string) => {
    const store = useMistStore.getState()
    store.setView('chat')
    store.setActiveThread(threadId)
    setOpen(false)
  }, [])

  const onAllRead = useCallback(() => {
    markNotificationsSeen()
    setSeenBoundary(Date.now())
  }, [])

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
    <Popover open={open} onOpenChange={onOpenChange}>
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
            onClick={onAllRead}
          >
            <CheckCheck aria-hidden className="h-3.5 w-3.5" />
            all read
          </Button>
        </div>

        {/* the catch-up list — swipe or X to dismiss, click a thread row to open it */}
        <div className="mist-scroll max-h-80 overflow-y-auto p-2">
          {feed.items.length === 0 ? (
            <div className="flex flex-col items-center gap-2.5 px-3 py-8">
              <span className="mist-glass-soft flex h-10 w-10 items-center justify-center rounded-full">
                <Bell aria-hidden className="h-4.5 w-4.5 text-slate-500" />
              </span>
              <p className="text-xs text-slate-500">You&apos;re all caught up</p>
            </div>
          ) : (
            <AnimatePresence initial={false}>
              {(() => {
                // v-redesign: repeated events collapse into groups (×N);
                // single occurrences render as plain cards
                const groups = groupFeed(feed.items)
                return groups.map((g) =>
                  g.items.length > 1 ? (
                    <GroupRow
                      key={g.key}
                      group={g}
                      seenBoundary={seenBoundary}
                      reduced={reduced}
                      onOpenThread={onOpenThread}
                    />
                  ) : (
                    <FeedRow
                      key={g.items[0].id}
                      item={g.items[0]}
                      unread={Date.parse(g.items[0].created_at) > seenBoundary}
                      reduced={reduced}
                      onOpenThread={onOpenThread}
                    />
                  )
                )
              })()}
            </AnimatePresence>
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
