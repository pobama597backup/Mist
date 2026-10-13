# ui-5+6b · full-stack-developer — NOTIFICATIONS + NAVBAR + STATUS BAR wave

**Scope honored:** exactly four files edited — `src/lib/notification-feed.ts`, `src/components/mist/notification-bell.tsx`, `src/components/mist/navbar.tsx`, `src/components/mist/status-bar.tsx`. `use-alerts.ts`, `globals.css` and everything else read as reference only.

## Field-name homework done first (as mandated)

- **Feed item shape** (`AlertInfo`, src/lib/types.ts): `id, kind, title, body, status('pending'|'delivered'), meta, conversation_id, created_at, delivered_at`.
- **Severity source:** items do NOT carry a raw severity field — severity is DERIVED by the shared classifier `alertSeverity()` (src/lib/alert-priority.ts: explicit `meta.severity` wins → guardian machine-health rows → kind). Returns `'critical' | 'important' | 'info'`. I map critical→`bg-rose-400`, important→`bg-amber-400` (the "warning" lane), info→`bg-slate-400`. No neutral fallback needed.
- **Thread reference field:** `conversation_id` — set server-side by `markAlertsDelivered(ids, conversationId)` (heartbeat-service), i.e. the thread the alert was persisted into. Delivered rows carry it; pending rows may not.
- **Thread-select path:** store has `setActiveThread(id)` (store.ts:161/474) — the exact action threads-sidebar uses on row click; chat-panel has an `activeId` effect that loads thread messages. Clean path exists, no hack needed.
- **Dismissal naming pattern:** in-chat heartbeat cards persist `mist-dismissedAlertIds` (chat-panel.tsx). My new key is the SEPARATE `mist:dismissedFeedIds` — the two dismissal systems never touch each other.
- **Swipe idiom:** mirrored from the in-repo heartbeat-card pattern (message-list.tsx): `drag="x"`, ±120 constraints, 80px threshold — plus `dragSnapToOrigin` for the mandated spring-back and a `|offset.y| < 40` guard. framer-motion sets `touch-action: pan-y` automatically on x-draggables, so vertical list scroll still works on touch (same proven pattern).

## notification-feed.ts (103 → 174 lines)

- Module-level `dismissedIds: Set<string>` loaded from `localStorage['mist:dismissedFeedIds']` at boot (SSR-guarded, corrupted-payload-safe).
- `dismissFeedItem(id)`: adds (cap 200, insertion-ordered — oldest dropped so memory and disk always agree), persists, REMOVES the item from the live snapshot, emits. Pure UI-level: no API call, DB alert rows never mutated.
- `publishNotificationFeed` / `pushLocalNotification` now filter dismissed ids — a dismissed alert never re-enters the panel on the next poll.
- **Exclusion model chosen** (per mandate): dismissed = gone from the panel. Unread/read semantics stay time-based via `lastSeenAt`, untouched.
- `unreadNotificationCount()` guards against dismissed ids in both branches (badge stays truthful); new `feedUndismissedCount()` exported.
- useSyncExternalStore contract intact: same `subscribeNotificationFeed` / `getNotificationFeed` shapes, same snapshot object identity discipline (snapshot replaced only inside emit paths — getSnapshot stays referentially stable between emits), same item shape. Welcome briefing (`pushLocalNotification`) and the delivery loop (`publishNotificationFeed`) needed zero changes.

## notification-bell.tsx (284 → ~440 lines)

- **FeedRow card** (`rounded-xl border border-white/5 bg-white/[0.03] p-3`): severity left-accent (2px `w-0.5` rounded bar, inset `top-3 bottom-3`, rose/amber/slate), title (`text-xs font-medium`), body (`text-[11px] line-clamp-2`), meta row (`font-mono text-[10px]`: local `relTime()` — "just now" / "Nm ago" / "Nh ago" / "Nd ago" / date fallback — · kind label · `pending` tag when undelivered). Date-fns `formatDistanceToNow` import dropped for the local helper.
- **Unread treatment:** unread rows get `bg-white/[0.06] border-white/10` + a 6px teal dot (glow shadow) before the title; read rows stay one step dimmer (title slate-300 / body slate-500 / time slate-600). Unread = `created_at > seenBoundary` — see the session-boundary note below.
- **Actionable rows:** when `conversation_id` exists, the whole content block is a `<button>` (spans throughout — phrasing-content-valid inside a button) → `useMistStore.getState().setView('chat')` + `setActiveThread(threadId)` + popover closes. Subtle ArrowUpRight affordance in the meta row. Non-actionable rows render the same content in a plain div.
- **Dismiss — 3 ways:** (1) X button top-right (`h-8 w-8`, `aria-label="Dismiss notification"`, focus-visible ring, title row reserves `pr-10`); (2) swipe: `motion.div drag="x"` + `dragSnapToOrigin` — drag translates + fades the card (x motion value → `useTransform` opacity, transform/opacity only, zero layout work), release past |x|>80 with |y|<40 dismisses, else springs back; (3) calm mode (`reducedMotion`): drag gesture disabled entirely, X button dismisses directly without exit animation. Rows mount/unmount through `AnimatePresence` (exit: fade + x-slide, skipped in calm).
- **Session-frozen unread boundary (design call, documented):** the module's mark-seen effect stamps `lastSeenAt` the moment the panel opens (badge must clear on open — unchanged behavior). If rows were judged against the live value, the dots would vanish on the same flush. So `onOpenChange(true)` snapshots the PRE-open `lastSeenAt` into `seenBoundary` (read directly from `getNotificationFeed()` before the effect can fire — no effect-ordering games), and the "all read" button resets it too. Result: badge clears instantly, but the dots survive the session so the creator can still see WHICH rows were new; items arriving while the panel is open show as unread until the next reopen.
- **Empty state:** Bell icon in a `mist-glass-soft` circle + "You're all caught up" (`text-xs text-slate-500`), centered.
- Kept verbatim: trigger button + badge, header ("Notifications", "N new" chip, "all read" — now also resets the boundary), footer delivery controls (PC notifications + spoken warnings switches), "Brief me". Dropped per the mandated row anatomy: the old per-row loudness hint ("spoken + pc / pc panel / quiet") and the severity-styled kind chip (severity now lives in the accent bar; loudness lives in the footer toggles).

## navbar.tsx (2 edits)

- Primary view pills nav wrapped in a segmented control: `mist-glass-soft flex shrink-0 items-center gap-0.5 rounded-xl p-1 md:gap-1` — pills now read as ONE control group. `aria-label="Primary views"`, h-11 buttons, aria-current, purple pill + underline indicator all preserved.
- Brand subtitle legibility: `tracking-widest text-slate-500` → `tracking-[0.18em] text-slate-400` (lg:block gating kept).
- Nothing else touched.

## status-bar.tsx (light polish)

- Ear toggle touch target: `min-h-8 min-w-8` (32px) → `min-h-11 min-w-11` (44px, matches the navbar's h-11 controls) on phones, still unwrapping to natural chip size at sm+. Comment updated to match.
- Focus-visible ring was already the house pattern (`ring-2 ring-purple-400/60`) — left as-is. No behavior changes.

## Verification (exact commands + results)

- `bunx tsc --noEmit` → exit 0, **0 errors**.
- `bun run lint` → exit 0, **clean**.
- `bun test tests/security/` → **357 pass / 0 fail**, 2002 expect() calls, 77s (final settled run).
- dev.log: no compile errors from my final files; `GET /` 200 (~290ms warm), `GET /api/mist/alerts` 200, health 200.

### Test-suite flakiness witnessed + root cause (important for the lead)

The suite needed FOUR runs to go green, with **moving-target failures** (4 → 3(subset) → 29 → 2 → 0), all on LIVE dev-server-dependent tests (W1/W3/W7, CR-6/CR-13, P17, S6/S12, L1–L3, welcome). Root causes, evidenced:
1. Parallel-agent churn: git status shows chat-view / chat-header / composer / threads-sidebar / voice-stage modified at 17:07–17:08 (12 min before my first run) — the resulting recompile storms had `GET /` serving in **37 seconds** mid-window, and live tests polling routes inside fixed timeouts died.
2. Cold-route first-hit compiles inside test timeout windows (the welcome test timed out at exactly 60s on a route that serves in 60ms once warm).
3. None of the failing tests import any of my four files (they import arbiter/perimeter/tools-service/db/proxy) — my diff is client-side UI only; the failures could not be caused by it. After warming the routes and letting the server settle: **357/357**.
4. Honest own-goal note: my notification-feed.ts MultiEdit sequence transiently produced a duplicate `getNotificationFeed` export that 500'd `GET /` for a short mid-edit window (the lines in dev.log that the ui-4 agent flagged as "a parallel wave's in-flight file" — that was me). Fixed within minutes; the final file is clean and tsc/lint/suite all pass against it.

## Notes for the lead's visual pass

- Calm-mode interpretation: "skip the drag animation and dismiss on tap directly" — implemented as drag disabled in calm mode with the X button as the direct unanimated dismiss (a tap-anywhere dismissal would collide with the row's primary thread-navigation action).
- The unread dot sits inline before the title (top-left of the card content) rather than absolutely positioned — stable card geometry, Linear/Slack-style.
- mist-glass-soft's own 0.75rem radius is overridden by `rounded-full` (utilities layer wins) on the empty-state circle; on the segmented nav `rounded-xl` matches the component radius exactly.
- The segmented nav adds 8px of width to the navbar's right cluster — worth a glance at 390px in the visual pass (the row had breathing room at last measure; no overflow observed in dev).
