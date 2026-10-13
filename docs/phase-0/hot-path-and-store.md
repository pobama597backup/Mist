# Phase 0 — D1 hot-path graph + D2 store subscription audit

## D1 Hot path (`/` first load)

```
src/app/page.tsx
└─ MistAppShell (app-shell.tsx, 33 imports — EVERYTHING eager, zero dynamic())
   ├─ useBackendStatus (poll :3000/api/mist/health)
   ├─ useWakeWord (use-voice.ts, 1200+ L)        [always-on recogniser]
   ├─ useAlerts (poll interval)                    [w4 notification feed]
   ├─ MistNavbar (s.neural.state, s.neural.connected)
   ├─ view switch:
   │   chat → ChatView → ChatPanel (consciousness/chat-panel.tsx, 2183 L, 20 effects, 19 store subs)
   │                 └→ ThreadsSidebar (consciousness/threads-sidebar.tsx — fine-grained subs)
   │   voice → VoiceStage → NeuralCore (s.neural.state/load/provider/model/fallback — fine-grained)
   ├─ SettingsView (2040 L) — EAGER import even when never opened
   ├─ DiagnosticsDrawer (15 tabs) — EAGER
   ├─ StatusBar (s.neural WHOLE SLICE ← P3 over-subscription)
   ├─ BrowserWindow, FloatingOrb, Starfield, SystemPulse, ApprovalBell,
   │  MistPowerPalette, NotificationBell — all EAGER
   └─ welcome-client (w4: fires /api/mist/welcome 2.2 s after iris-open)
```

Dead: `consciousness/hub.tsx` (imports NeuralCore+ChatPanel) — **zero importers** (R12).

## D2 Subscription audit

| Component / hook | Subscription | Verdict |
|---|---|---|
| `status-bar.tsx:19` | `useMistStore((s) => s.neural)` whole slice | **OVER-SUBSCRIBED** — `setAudioEnergy` @120 ms builds a new `neural` object (store.ts:376) → StatusBar re-renders ~8×/s through any mic session (P3) |
| `chat-panel.tsx` (19 subs) | all fine-grained (`s.neural.state`, …) | OK |
| `neural-core.tsx:208-212` | `s.neural.state/load/provider/model/fallback` separately | OK |
| `navbar.tsx:51,97` | `.state`, `.connected` separately | OK |
| `voice-stage.tsx:64`, `chat-panel.tsx:306`, `system-pulse.tsx:62`, `use-face-bus.ts:19` | `.state` | OK |
| `threads-sidebar.tsx:28-35` | `s.threads.*` slice — `setThreads` replaces the array only on real refresh | OK (refresh-seq pattern) |
| `app-shell.tsx:162-174` | `view`, `reducedMotion`, prefs — discrete | OK |
| `use-backend.ts:8` | `s.backend` whole slice — replaced only on health poll change | OK |
| `use-alerts.ts:43-44` | `threads.activeId`, `bumpThreadsRefresh` | OK |

Single over-subscriber found: StatusBar (whole `neural` slice). Fix lands in Phase 4 (P3: `useShallow` or two atomic selectors).
