# Phase 0 — D3 timer / listener ledger

`useSyncExternalStore` + module-singleton socket pattern (use-neural) intentionally survives unmounts — keep (mandate: "do not regress").

| Site | Kind | Cleanup | Verdict |
|---|---|---|---|
| `use-neural.ts:111` heartbeat `setInterval(ping, 25 s)` | module singleton | never (by design, 1/session) | OK — document, don't "fix" |
| `use-neural.ts:129+` socket `useEffect` | module-singleton socket | intentional no-cleanup (comment present) | OK (mandated keep) |
| `use-voice.ts:436` keepalive interval | ref | cleared :428-430 before re-arm + on end | OK |
| `use-backend.ts:26` health poll | interval | clearInterval (1 match) | OK |
| `use-telemetry.ts:33` poll | interval | clearInterval | OK |
| `use-alerts.ts:139` poll | interval | clearInterval | OK |
| `use-face-bus.ts:36` waveform emit @80 ms | interval | clearInterval | OK (rAF-class work; Phase 4 moves off React) |
| `use-interval.ts:22` generic | interval | clearInterval | OK |
| `chat-panel.tsx:444,449` thinking secs + typing dots | interval | cleared :458-459 | OK |
| `chat-panel.tsx:472` response watchdog | interval | cleared :477 + :500 return | OK |
| `chat-panel.tsx:1085` / `voice-stage.tsx:116` energy interval | ref | cleared :1101/:1116 and :132 | OK |
| `research-console.tsx:333` | interval | cleared :336 | OK |
| `speech.ts:498,555,663,839` `createObjectURL` | blob URLs | single-slot `currentUrl` revoked in `stop()` :301 | **PARTIAL LEAK** — superseded playback URL overwritten without revoke when a new speak starts without `stopAudioOnly()` first (`playBlob` :498 path). Bounded (≤1 URL per supersede). R7 confirmed, fix in Phase 3 |
| `speech.ts` `currentAudio` | HTMLAudio | superseded-sequence guard (`ctx.mySeq !== speakSeq`) | OK |
| `app-shell.tsx` wake-word engine | recogniser | disarmed via pref sync | OK (w5 toggle verified live) |
| canvas/orb rAF | rAF | cancel + `visibilitychange` present (mandate keep) | OK |

HMR double-arm: `use-neural` socket + heartbeat are `globalThis`-guarded module singletons → safe under HMR. No listener-count invariant test exists yet (Phase 3 deliverable).

**NO CLEANUP rows: 1 partial (speech.ts supersede leak). Everything else CLEANUP or singleton-by-design.**
