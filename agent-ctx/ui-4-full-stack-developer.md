# ui-4 · full-stack-developer — VOICE STAGE bottom cluster redesign

**Scope honored:** only `src/components/mist/consciousness/voice-stage.tsx` edited (activity-line.tsx read as reference only; globals.css / neural-core.tsx untouched).

## What changed (voice-stage.tsx, 625 → 642 lines)

1. **Two zones replace the single dense mono row:**
   - Status zone (informational): state dot + `STATE_LABELS[neuralState]` + hint — semantics, `STATE_COLORS`, aria behavior, normal-case subordinate hint all preserved; now `flex-wrap gap-x-3` with breathing room.
   - Controls zone (actionable): ONE `mist-glass-soft rounded-full px-2 py-1.5 gap-2` floating glass pill containing face picker + divider + dream toggle + "type instead".
2. **Touch targets:** face buttons `h-6 w-6` (24px) → `h-9 w-9` (36px), icons `h-3 w-3` → `h-3.5 w-3.5`; dream toggle `h-7 w-7` → `h-9 w-9`. Teal active-glow and fuchsia dream classes kept verbatim; aria-labels/aria-pressed kept verbatim.
3. **"Type instead"** demoted to quiet tertiary text link: bordered pill removed → `text-slate-400 hover:text-purple-200`, `underline-offset-4 hover:underline`, `inline-flex h-9 px-2.5`; collapses to PenLine icon-only under sm (`hidden sm:inline` text / `hidden sm:block` ArrowRight), full text+icons on sm+.
4. Divider `h-4 w-px bg-white/10` aria-hidden added between face picker and dream toggle.
5. Responsive adaptation (measured, not guessed): the pill is ~470px wide at sm (six 36px faces ≈ 236px + dream + full "Type instead" text), so a shared row overflows below ~860px — zones stack centered below lg (`flex-col … lg:flex-row`), share a row at lg+: `justify-between lg:pl-5 xl:pl-7` when browser open (status left / controls right), `justify-center` otherwise. Mobile 390px: status ≈323px + pill ≈345px, both ≤ 358px content width — no overflow. Pill itself is `flex-wrap justify-center` so very narrow screens (<375px) wrap inside the pill instead of clipping.
6. Session controls row: End session `py-2` (~32px) → `h-11` (44px exact target), same visual scale otherwise; hold-to-talk h-16 left untouched (reduced-motion whileHover/whileTap gating untouched).
7. Preserved: all handlers/store calls, voice-session logic, caption logic above the row, STATE_COLORS/STATE_LABELS imports; every interactive element keeps `focus-visible:ring-purple-400/60`; face group keeps `role="group" aria-label="Consciousness face"`.

## Verification (exact commands + results)
- `bunx tsc --noEmit` → exit 0, 0 errors
- `bun run lint` → exit 0, clean
- `bun test tests/security/tabboundary.test.ts tests/security/speed.test.ts` → 23 pass / 0 fail, 103 expect() calls, 182ms
- dev.log: zero voice-stage entries (no compile errors); the notification-feed.ts duplicate-export error in the log is a parallel agent's in-flight file (outside my scope — git status shows it + chat-view/composer/chat-header/threads-sidebar mid-edit by other waves).

Note for lead visual check: rounded-full on the cluster wins over `.mist-glass-soft`'s 0.75rem radius (utilities layer > components layer) — pill shape + soft glass fill/blur confirmed by layer audit.
