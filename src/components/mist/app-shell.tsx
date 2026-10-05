// M.I.S.T. app shell — the single surface. Boots through a staged BIOS-style
// sequence (typed diagnostics → segmented bar → iris-open reveal), then mounts
// the navbar, the multi-tab view switch (Consciousness voice stage · Chat ·
// Self · Settings), the diagnostics drawer, status bar, ambient FX, the
// app-wide "Hey Mist" wake engine and the floating companion orb.
'use client'

import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { motion } from 'framer-motion'
import { toast } from 'sonner'
import { useMistStore } from '@/lib/store'
import { useBackendStatus } from '@/hooks/use-backend'
import { useMistAlerts } from '@/hooks/use-alerts'
import { useWakeWord } from '@/hooks/use-voice'
import { welcomeCheck, pingSeen } from '@/lib/welcome-client'
import { useFaceBusEmitter } from '@/hooks/use-face-bus'
import { useKeyboardShortcuts } from '@/hooks/use-keyboard-shortcuts'
import { MistNavbar } from '@/components/mist/navbar'
import { VoiceStage } from '@/components/mist/consciousness/voice-stage'
import { ChatView } from '@/components/mist/chat/chat-view'
import { SelfView } from '@/components/mist/self/self-view'
import { SettingsView } from '@/components/mist/settings/settings-view'
import { DiagnosticsDrawer } from '@/components/mist/diagnostics/drawer'
import { StatusBar } from '@/components/mist/status-bar'
import { BrowserWindow } from '@/components/mist/browser-window'
import { FloatingOrb } from '@/components/mist/floating-orb'
import { Starfield } from '@/components/mist/starfield'
// oj-face-5 — OpenJarvis UX surfaces: ambient activity pulse, the tiered
// approval gate chip and the Ctrl+Shift+P power palette
import { SystemPulse } from '@/components/mist/system-pulse'
import { ApprovalBell } from '@/components/mist/approval-bell'
import { MistPowerPalette } from '@/components/mist/command-palette'

function BackgroundFX() {
  return (
    <div aria-hidden className="pointer-events-none fixed inset-0 -z-10 overflow-hidden">
      {/* deep space base */}
      <div className="absolute inset-0 bg-slate-950" />
      {/* drifting aurora — consciousness (top left). will-change-transform
          hints layer promotion BEFORE the first paint (Chrome flicker fix
          2026-09-30) — the transform keyframes already run on the compositor. */}
      <div className="animate-mist-aurora-1 will-change-transform absolute -top-44 -left-44 h-[36rem] w-[36rem] rounded-full bg-purple-500/[0.09] blur-[110px]" />
      {/* system aurora (bottom right) */}
      <div className="animate-mist-aurora-2 will-change-transform absolute -bottom-52 -right-36 h-[38rem] w-[38rem] rounded-full bg-emerald-500/[0.06] blur-[120px]" />
      {/* dreaming streak (mid right) */}
      <div className="animate-mist-aurora-3 will-change-transform absolute top-1/3 right-[-12rem] h-[24rem] w-[24rem] rounded-full bg-fuchsia-500/[0.05] blur-[110px]" />
      {/* parallax data-motes — drift speed follows the consciousness state */}
      <Starfield />
      {/* fine grid, masked to center */}
      <div className="mist-grid-bg absolute inset-0" />
      {/* living film grain */}
      <div className="mist-grain-overlay" />
      {/* vignette to focus the core */}
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_120%_90%_at_50%_40%,transparent_55%,rgba(2,6,23,0.85)_100%)]" />
    </div>
  )
}

/** Staged boot sequence — deterministic markup (identical SSR/client), all
 *  choreography via CSS animation delays. Click or the skip button proceeds. */
function BootSequence({ onSkip }: { onSkip: () => void }) {
  const lines = [
    { label: 'neural link :3003', delay: 300 },
    { label: 'cortex providers 8', delay: 520 },
    { label: 'synapse channels 6', delay: 740 },
    { label: 'memory vault', delay: 960 },
    { label: 'tool registry 21+', delay: 1180 },
  ]
  const segments = Array.from({ length: 22 }, (_, i) => i)

  return (
    <div
      role="status"
      aria-label="M.I.S.T. booting"
      onClick={onSkip}
      className="relative flex min-h-screen cursor-pointer flex-col items-center justify-center gap-7 overflow-hidden bg-slate-950 px-6"
    >
      {/* grain + faint grid keep the BIOS screen alive */}
      <div aria-hidden className="mist-grid-bg absolute inset-0 opacity-60" />
      <div aria-hidden className="mist-grain-overlay" />

      <div className="relative flex flex-col items-center gap-3">
        <div className="relative">
          <div className="absolute -inset-3 animate-mist-pulse-glow rounded-full bg-purple-400/25 blur-2xl" />
          { }
          <img
            src="/mist-logo-192.png"
            alt="M.I.S.T. consciousness emblem"
            width={88}
            height={88}
            className="relative h-[88px] w-[88px] rounded-full object-cover shadow-[0_0_56px_rgba(192,132,252,0.45)]"
          />
        </div>
        <div className="text-center">
          <p className="text-sm font-semibold tracking-[0.35em] text-slate-200">M.I.S.T.</p>
          <p className="mt-1.5 font-mono text-[10px] uppercase tracking-[0.3em] text-slate-500">
            unified consciousness kernel
          </p>
        </div>
      </div>

      {/* diagnostic lines — [ OK ] in emerald */}
      <div className="w-full max-w-xs space-y-1.5 font-mono text-[11px]">
        {lines.map((l) => (
          <p
            key={l.label}
            className="mist-boot-line flex items-baseline justify-between gap-3 text-slate-400"
            style={{ animationDelay: `${l.delay}ms` }}
          >
            <span className="truncate">{l.label}</span>
            <span className="shrink-0 text-emerald-400/90">[ OK ]</span>
          </p>
        ))}
      </div>

      {/* segmented progress bar */}
      <div className="flex w-full max-w-xs items-end gap-1" aria-hidden>
        {segments.map((i) => (
          <span
            key={i}
            className="mist-boot-seg h-1.5 flex-1 rounded-sm bg-purple-300/80"
            style={{ animationDelay: `${500 + i * 52}ms` }}
          />
        ))}
      </div>

      <p
        className="mist-boot-line font-mono text-[10px] uppercase tracking-[0.3em] text-teal-300/90 text-glow-emerald"
        style={{ animationDelay: '1750ms' }}
      >
        consciousness online
      </p>

      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation()
          onSkip()
        }}
        className="absolute bottom-6 right-6 rounded-lg border border-white/10 px-3 py-1.5 font-mono text-[10px] uppercase tracking-widest text-slate-500 transition-colors hover:border-white/25 hover:text-slate-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-400/60"
      >
        skip
      </button>
    </div>
  )
}

// Mounted gate via useSyncExternalStore — false during SSR, true on the client.
// No effects, no cascading renders, deterministic hydration.
const emptySubscribe = () => () => {}
function useMounted() {
  return useSyncExternalStore(
    emptySubscribe,
    () => true,
    () => false
  )
}

export function MistAppShell() {
  const mounted = useMounted()
  const [bootDone, setBootDone] = useState(false)
  const view = useMistStore((s) => s.view)
  const hydrateUI = useMistStore((s) => s.hydrateUI)
  const setReducedMotion = useMistStore((s) => s.setReducedMotion)
  const adoptOsReducedMotion = useMistStore((s) => s.adoptOsReducedMotion)
  const storeReduced = useMistStore((s) => s.reducedMotion)
  const motionChoice = useMistStore((s) => s.motionChoice)
  const motionToastShown = useRef(false)

  // App-wide "Hey Mist" wake engine — module-singleton (the voice stage mounts
  // its own refcount too; double-mount safe by design). Its mere mounting runs
  // the listener while the pref is on and no voice session owns the mic.
  const wake = useWakeWord()
  const wakeWordEnabled = useMistStore((s) => s.wakeWordEnabled)
  const wakeErrorToasted = useRef(false)
  const wakeUnsupportedToasted = useRef(false)

  // v7 — bridge Mist's live consciousness state into the embedded faces AND
  // (when connected) out to the OWNER's machine via the Mist Bridge signal bus,
  // so every companion face on their PC performs her voice.
  useFaceBusEmitter()

  // Initialize keyboard shortcuts
  useKeyboardShortcuts()

  // single backend health poll for the whole app (navbar + statusbar read store)
  useBackendStatus(10000)
  // heartbeat alert delivery — ⏰ reminders + 📦 releases land in the chat
  useMistAlerts()

  // Surface a wake-engine failure (e.g. mic permission) once, loudly enough
  // to read but without nagging — the status-bar chip stays the source of truth.
  useEffect(() => {
    if (!mounted || !wake.error || wakeErrorToasted.current) return
    wakeErrorToasted.current = true
    toast.error('Wake word error', { description: wake.error, duration: 5000 })
  }, [mounted, wake.error])

  // Pref ON in a browser without live speech recognition — say so once
  // instead of listening in silence.
  useEffect(() => {
    if (!mounted || !wakeWordEnabled || wake.supported) return
    if (wakeUnsupportedToasted.current) return
    wakeUnsupportedToasted.current = true
    toast.error('Wake word unavailable', {
      description:
        "This browser doesn't support live speech recognition — 'Hey Mist' needs a Chromium-based browser.",
      duration: 5000,
    })
  }, [mounted, wakeWordEnabled, wake.supported])

  // Hold the boot sequence long enough for the choreography, then open.
  useEffect(() => {
    if (!mounted || bootDone) return
    let reducedNow = storeReduced
    try {
      reducedNow = reducedNow || window.matchMedia('(prefers-reduced-motion: reduce)').matches
    } catch {
      /* matchMedia unavailable — ignore */
    }
    const t = setTimeout(() => setBootDone(true), reducedNow ? 300 : 2150)
    return () => clearTimeout(t)
  }, [mounted, bootDone, storeReduced])

  useEffect(() => {
    hydrateUI()
    // Honor the system reduced-motion preference for THIS session when the
    // user has never made an explicit choice. The adoption is runtime-only:
    // a one-off OS setting can never silently freeze the app forever, and the
    // toast below makes the state visible with a one-click escape.
    try {
      const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
      adoptOsReducedMotion(mq.matches)
      const onChange = (e: MediaQueryListEvent) => adoptOsReducedMotion(e.matches)
      mq.addEventListener('change', onChange)
      return () => mq.removeEventListener('change', onChange)
    } catch {
      /* matchMedia unavailable — ignore */
    }
  }, [hydrateUI, adoptOsReducedMotion])

  // Transparent escape hatch: when motion is calmed purely by the OS (no
  // explicit user choice), say so once per session and offer full motion in
  // one click — the choreography is never silently disabled.
  useEffect(() => {
    if (motionToastShown.current) return
    if (!mounted || !bootDone) return
    if (!storeReduced || motionChoice !== null) return
    motionToastShown.current = true
    toast('Motion calmed to match your system preference', {
      description: 'M.I.S.T. switched to gentle calm-mode animation.',
      action: {
        label: 'Enable full motion',
        onClick: () => setReducedMotion(false),
      },
      duration: 5000,
    })
  }, [mounted, bootDone, storeReduced, motionChoice, setReducedMotion])

  // Mirror the motion preference onto <html data-motion> so CSS movers can
  // honor the user's explicit choice over the OS media query (the canvas
  // orb reads the store directly; this is for the CSS half of the system).
  useEffect(() => {
    document.documentElement.dataset.motion = storeReduced ? 'calm' : 'full'
  }, [storeReduced])

  // Welcome-back briefing (w4 — Mark-LV's morning-briefing pattern, ours):
  // once the console has iris-opened, she checks whether a greeting is
  // warranted (away > 20 min, or a server restart) and — never dormant —
  // greets, recaps what happened, brings fresh news, and SPEAKS it. The
  // 5-min `seen` ping keeps same-session reloads quiet.
  useEffect(() => {
    if (!bootDone) return
    const greetTimer = setTimeout(() => {
      void welcomeCheck()
    }, 2200)
    const seenTimer = setInterval(pingSeen, 5 * 60_000)
    return () => {
      clearTimeout(greetTimer)
      clearInterval(seenTimer)
    }
  }, [bootDone])

  if (!mounted || !bootDone) {
    return <BootSequence onSkip={() => setBootDone(true)} />
  }

  // Iris-open reveal: the console expands from the center of consciousness.
  const reducedNow = storeReduced

  return (
    <motion.div
      initial={
        reducedNow
          ? { opacity: 0 }
          : { opacity: 0.4, clipPath: 'circle(0% at 50% 42%)', scale: 0.985 }
      }
      animate={
        reducedNow
          ? { opacity: 1 }
          : { opacity: 1, clipPath: 'circle(142% at 50% 42%)', scale: 1 }
      }
      transition={reducedNow ? { duration: 0.25 } : { duration: 0.85, ease: [0.83, 0, 0.17, 1] }}
      className="relative flex min-h-screen min-w-0 flex-col overflow-x-hidden"
    >
      <BackgroundFX />
      <MistNavbar />
      {/* OpenJarvis UX layer (oj-face-5): ambient pulse strip above the
          status bar + the floating approval-gate chip under the navbar */}
      <SystemPulse />
      <ApprovalBell />
      {/* View switch — the Consciousness stage owns the screen edge-to-edge
          (no horizontal padding, no max-width, height fills the viewport under
          the navbar); Chat is a roomy full-height surface; Self and Settings
          keep the classic scrollable page layout. */}
      <main
        className={
          view === 'consciousness'
            ? 'relative h-[calc(100vh-4rem)] min-w-0 w-full flex-1 pb-14'
            : view === 'chat'
              ? 'mx-auto h-[calc(100vh-7.5rem)] min-w-0 w-full max-w-[1800px] flex-1 px-3 pt-3 pb-14 sm:px-4'
              : 'mx-auto min-w-0 w-full max-w-[1800px] flex-1 px-3 pb-20 pt-4 sm:px-4 lg:px-6'
        }
      >
        {view === 'consciousness' ? (
          <VoiceStage className="h-full" />
        ) : view === 'chat' ? (
          <ChatView />
        ) : view === 'self' ? (
          <SelfView />
        ) : (
          <SettingsView />
        )}
      </main>
      <StatusBar />
      <DiagnosticsDrawer />
      <BrowserWindow />
      {/* Ctrl+Shift+P power palette — models · tools · actions */}
      <MistPowerPalette />
      {/* mini companion orb — floats above the status bar on every view except
          Consciousness (self-hiding) and while the browser window is open */}
      <FloatingOrb />
    </motion.div>
  )
}
