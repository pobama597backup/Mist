# ui-6 · full-stack-developer — CHAT + THREADS wave (sidebar / overlay / composer / header)

**Scope honored:** exactly the four mandated files edited — `chat-view.tsx`, `consciousness/threads-sidebar.tsx`, `consciousness/composer.tsx`, `consciousness/chat-header.tsx`. git status cross-checked: the other modified files (voice-stage, navbar, notification-bell, status-bar, notification-feed) belong to parallel waves, untouched by me. globals.css / message-list.tsx / chat-panel.tsx untouched.

## Payload shape decision (read BEFORE editing)

`mistApi.conversations.list()` (src/lib/mist-api.ts:226) → `Conversation[]`; `Conversation` (src/lib/types.ts:582) = `{ id, title, created_at }` — verified against the live route (`/api/mist/conversations` GET maps only id/title/createdAt). **No `updatedAt`, no `lastMessageAt`, no message counts in the payload** → per the brief: the relative time (from `created_at`, via the existing `timeAgo`) stays as the sole secondary metadata; **no "N messages" line, no new API calls** (documented in a row-level comment so the next agent doesn't "fix" it into an N+1).

## threads-sidebar.tsx (139 → 155 lines)

1. **Active thread row:** `border-l-2 border-purple-400 bg-white/[0.06]` + title `text-slate-100 font-medium` — a real left accent bar + tint instead of the old all-corner border that read as "identical to inactive". Inactive: `border-l-2 border-transparent` (transparent spacer keeps left edges aligned), title `text-slate-400`, hover `bg-white/[0.04]` + title `group-hover:text-slate-200` (row stays ONE button; `group` added at row level).
2. **Truncation:** rows gain `min-w-0` (title already had `truncate`) — long titles can no longer blow the fixed-width column.
3. **New thread = primary action:** the old 8×8 `+` chip is replaced by a full-width `h-10` button at the very top: `rounded-xl border border-purple-400/30 bg-purple-400/15 text-purple-200 hover:bg-purple-400/25`, Plus icon + "New thread" label, existing `aria-label="New thread"` + `create()` handler + `creating` disabled state kept verbatim. Pinned above the list by structure (the list is its own `overflow-y-auto` flex child below it), so it never scrolls away.
4. THREADS micro-label kept (now the list's section header under the button). Skeleton/error/empty states and the `threadsRefreshSeq` macrotask-deferred reload kept byte-for-byte.

## chat-view.tsx (163 → 217 lines) — mobile overlay a11y

The overlay had Escape + backdrop close but **no focus trap, no scroll lock, no aria-modal** (verified: no `body.style.overflow` write exists anywhere in src/). The Escape effect was merged into one open-scoped effect that now:
- captures `document.activeElement` on open and **restores focus to it on close**;
- moves focus INTO the dialog on open (deferred one macrotask; container `tabIndex={-1}` + `outline-none`);
- **traps Tab** inside the panel using the exact mandated selector (`a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])`) — wraps first⇄last on Shift+Tab/Tab off the ends and re-captures when focus drifted outside the dialog;
- **locks body scroll** (`overflow:hidden` save/restore — none existed despite the critique assuming one);
- keeps Escape-close and backdrop-click-close semantics verbatim; adds `aria-modal="true"` to the existing `role="dialog"`.
Strict-mode safe (capture is idempotent; ref writes live in the effect body — the lint rule's established pattern). lg+ docked layout, `threadsCollapsed`, and all handlers untouched.

## composer.tsx (1-line diff)

Placeholder `placeholder:text-slate-500` → `placeholder:text-slate-400`. Verified (no change needed): send + hold-to-talk already `h-11 w-11` (44px); textarea radius comes from `.mist-glass-soft`'s 0.75rem (= the buttons' `rounded-xl`); focus-visible rings present on textarea + both buttons. Auto-grow/drag-resize/PTT logic untouched.

## chat-header.tsx (polish only)

Controls row `gap-1.5` → `gap-2` (uniform spacing between pickers and actions); thinking button rebuilt in `cn()` at `h-9` (aligns with the h-9 icon buttons; was ~30px py-based), gains `focus-visible:ring-purple-400/60` + `aria-hidden` icon — the only control that lacked both. No behavior change.

## Verification (exact results)

- `bunx tsc --noEmit` → **0 errors** (run twice, before and after parallel-wave edits landed)
- `bun run lint` → **exit 0, clean** (twice)
- `bun test tests/security/` → first run **327 pass / 30 fail** while the dev server recompiled the parallel waves' in-flight edits (failure sets differed every run: 30 → 1 → 6, ALL live-route tests — voice/status, tools/categories, research, synapse, A10/A11 autonomy, W3, CR-5, P17, L2 — none import my four files); `a4.test.ts` isolated → **13/13**; final full run: **357 pass / 0 fail**, 2019 expects, 85.93s
- dev.log: no compile errors (text-mode grep for Failed-to-compile/Syntax/Type-error/Module-not-found → none); `/api/mist/health` 200; GET / 200

Note for lead visual check: active-row `rounded-xl` was kept (continuity with skeleton/error/New-thread shapes) — the 2px purple accent curves with the 12px radius; if the lead prefers a flat left edge, swap row radius to `rounded-r-xl rounded-l-md`.
