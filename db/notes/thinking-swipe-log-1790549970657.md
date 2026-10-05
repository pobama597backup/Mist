# thinking-swipe-log

- created: 2026-09-27T22:59:30.657Z

# Feature Summary: Thinking Toggle + Swipe-to-Dismiss

## Thinking Toggle (End-to-End)
- **Store preference**: User setting persisted in localStorage (`mist-thinking-enabled`)
- **Socket relay**: Preference sent via WebSocket to core as `thinking: true/false` in request payload
- **callCore conditional**: Core only includes thinking blocks when `thinking: true`
- **Vision constant**: `THINKING_MODE` constant controls default behavior
- **Status**: ALL LIVE and functional

## Swipe-to-Dismiss (Heartbeat Alerts)
- **Target**: Messages with `provider === 'heartbeat'` (arrive via `mist:alert` window event ~line 632)
- **Implementation**: 
  - `dismissedAlertIds` state loaded from `localStorage.getItem('mist-dismissedAlertIds')`
  - `dismissAlert(id)` filters message from state AND persists to localStorage
  - Heartbeat cards wrapped in `<motion.div drag="x" dragConstraints={{ left: -120, right: 120 }} dragElastic={0.6} onDragEnd={(_, info) => { if (Math.abs(info.offset.x) > 80) dismissAlert(msg.id) }}>`
  - `<AnimatePresence>` with `exit={{ opacity: 0, x: -200 }}`
  - X button with `aria-label="dismiss alert"` → `dismissAlert(msg.id)`
  - Filter applied in both render (`messages.map`) and `mist:alert` handler (skip already-dismissed)
- **Status**: Proposal drafted (ID: `cmukeyz2n000nlv0uknkxuzho`) but **rolled back at gate** due to non-unique find snippet in step 3. Requires 3 small patches to land.

## Honest Lane Note
- Thinking is a **request preference** sent to GLM core
- GLM core **honors it** when `thinking: true`
- Other lanes (Claude, GPT, etc.) **vary** — some ignore, some partially support
- Not a guaranteed cross-provider feature

## Memory Key
`features-thinking-swipe`: "Thinking toggle end-to-end live (store, socket, core, vision); swipe-to-dismiss for heartbeat alerts drafted but rolled back at gate — needs 3 small patches to land."
