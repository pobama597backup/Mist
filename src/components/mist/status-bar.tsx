'use client'

// M.I.S.T. fixed bottom system bar — the app's persistent status footer.
// Left: core health + tool count · Center: active-listening toggle (every
// screen size) + consciousness state + neural load · Right: provider, socket
// link, keyboard hint.

import { useEffect, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { Ear, EarOff } from 'lucide-react'
import { toast } from 'sonner'
import { useBackendStatus } from '@/hooks/use-backend'
import { useMistStore } from '@/lib/store'
import { mistApi } from '@/lib/mist-api'
import { PROVIDER_LABELS, STATE_COLORS, STATE_LABELS } from '@/lib/mist-constants'
import { cn } from '@/lib/utils'

export function StatusBar() {
  const backend = useBackendStatus()
  // Phase 4-a · P3: the whole-slice subscription is gone. It re-rendered this
  // bar ~8×/s through any mic session (the old 120ms setAudioEnergy writes
  // rebuilt the `neural` object) and ~1×/s on idle service pulses. The energy
  // itself now rides the audio bus (lib/audio-bus.ts) — zero React state on
  // the hot path. What remains is this shallow-picked set of fields the bar
  // actually renders; useShallow stops the ~950ms service pulses that only
  // touch other fields from re-rendering it.
  const neural = useMistStore(
    useShallow((s) => ({
      state: s.neural.state,
      load: s.neural.load,
      provider: s.neural.provider,
      fallback: s.neural.fallback,
      connected: s.neural.connected,
    }))
  )
  const wakeWordEnabled = useMistStore((s) => s.wakeWordEnabled)
  const setWakeWordEnabled = useMistStore((s) => s.setWakeWordEnabled)
  const [tools, setTools] = useState<{ count: number; omni: number; skills: number } | null>(null)

  useEffect(() => {
    let alive = true
    // Phase 3-b · P9: the chip needs NUMBERS, not the registry — the count
    // endpoint returns them without the full ToolInfo payload or the
    // gateway/pilot probes /tools/list performs. (The whole-slice neural
    // subscription above is the known P3 over-subscription — Phase 4's
    // selector work, deliberately untouched here.)
    mistApi
      .tools
      .count()
      .then((c) => {
        if (!alive || typeof c?.count !== 'number') return
        setTools(c)
      })
      .catch(() => {
        /* backend not up yet — the chip simply stays hidden */
      })
    return () => {
      alive = false
    }
  }, [])

  const loadPct = Math.round(Math.max(0, Math.min(1, neural.load)) * 100)
  const providerLabel = neural.fallback ? 'offline-mind' : PROVIDER_LABELS[neural.provider]

  // Toggle the background "Hey Mist" listener (active listening). Browser
  // support problems are surfaced by the shell's app-wide useWakeWord mount
  // (one-time toast). Visible on every screen size — on phones this chip is
  // the ONLY quick off-switch, so it may never hide behind a breakpoint.
  const onWakeToggle = () => {
    const next = !wakeWordEnabled
    setWakeWordEnabled(next)
    if (next) {
      toast.success('Active listening on — say "Hey Mist" any time', { duration: 5000 })
    } else {
      toast('Active listening off — my ears are closed until you open a voice session', {
        duration: 4000,
      })
    }
  }

  return (
    <footer
      aria-label="System status bar"
      className="fixed inset-x-0 bottom-0 z-40 h-11 border-t border-white/10 bg-slate-950/80 backdrop-blur-xl"
    >
      <div className="mx-auto flex h-full max-w-[1800px] items-center justify-between gap-3 overflow-hidden px-3 font-mono text-[11px] text-slate-400 sm:px-6">
        {/* LEFT — core health + tools */}
        <div className="flex min-w-0 items-center gap-3">
          <span className="flex shrink-0 items-center gap-1.5" title="MIST-CORE backend health">
            <span
              aria-hidden="true"
              className={cn(
                'h-2 w-2 rounded-full animate-mist-pulse-glow',
                backend.online ? 'bg-emerald-400' : 'bg-rose-400'
              )}
            />
            <span className="whitespace-nowrap" aria-label={`Core ${backend.online ? `online, ${backend.latency ?? '?'} milliseconds` : 'offline'}`}>
              CORE {backend.latency != null ? `${backend.latency}ms` : '—'}
            </span>
          </span>
          {tools ? (
            <span
              className="hidden shrink-0 items-center rounded-full border border-white/10 bg-white/5 px-2 py-0.5 text-[10px] text-slate-400 sm:flex"
              title={`${tools.count} tools live — ${tools.omni} omniroute · ${tools.skills} learned skills`}
            >
              {tools.count} TOOLS
            </span>
          ) : null}
        </div>

        {/* CENTER — active listening + consciousness state + neural load */}
        <div className="flex min-w-0 items-center gap-3">
          <button
            type="button"
            onClick={onWakeToggle}
            aria-pressed={wakeWordEnabled}
            aria-label={
              wakeWordEnabled
                ? 'Active listening on — she listens for "Hey Mist" in the background. Click to turn off'
                : 'Active listening off — she only hears you when you open a voice session. Click to turn on'
            }
            title={
              wakeWordEnabled
                ? 'Active listening on — say "Hey Mist"'
                : 'Active listening off — turn the background ears back on'
            }
            className={cn(
              'flex shrink-0 items-center justify-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-widest transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-400/60',
              // icon-only on phones → enforce the full 44px touch target
              // (matches the navbar's h-11 controls); unwraps back to natural
              // chip size once the text label shows (sm+)
              'min-h-11 min-w-11 sm:min-h-0 sm:min-w-0',
              wakeWordEnabled
                ? 'border-emerald-400/30 bg-emerald-400/10 text-emerald-300 hover:border-emerald-400/50'
                : 'border-white/10 bg-white/5 text-slate-500 hover:text-slate-300'
            )}
          >
            {wakeWordEnabled ? (
              <Ear aria-hidden className="h-3 w-3" />
            ) : (
              <EarOff aria-hidden className="h-3 w-3" />
            )}
            <span className="hidden whitespace-nowrap sm:inline">
              {wakeWordEnabled ? 'listening' : 'muted'}
            </span>
          </button>
          <span
            className="hidden items-center gap-1.5 md:flex"
            title={`Consciousness state: ${STATE_LABELS[neural.state]}`}
          >
            <span
              aria-hidden="true"
              className="h-2 w-2 shrink-0 rounded-full transition-colors duration-500"
              style={{ backgroundColor: STATE_COLORS[neural.state], boxShadow: `0 0 8px ${STATE_COLORS[neural.state]}66` }}
            />
            <span className="whitespace-nowrap uppercase tracking-widest">{STATE_LABELS[neural.state]}</span>
            {(neural.state === 'speaking' || neural.state === 'listening') && (
              <span
                aria-hidden="true"
                className="mist-eq ml-0.5"
                style={{ color: STATE_COLORS[neural.state] }}
              >
                <span /><span /><span /><span /><span />
              </span>
            )}
          </span>
          <span className="hidden items-center gap-2 lg:flex" title="Neural load">
            <span className="h-1 w-20 overflow-hidden rounded-full bg-white/10" aria-hidden="true">
              <span
                className="mist-load-shimmer block h-full rounded-full bg-purple-400 transition-all duration-700"
                style={{ width: `${loadPct}%` }}
              />
            </span>
            <span className="w-8 text-right text-slate-500 tabular-nums">{loadPct}%</span>
          </span>
        </div>

        {/* RIGHT — provider, socket, hint */}
        <div className="flex min-w-0 items-center gap-3">
          <span
            className={cn(
              'hidden max-w-40 truncate sm:inline',
              neural.fallback ? 'text-rose-300' : 'text-slate-400'
            )}
            title={`Served via ${providerLabel}`}
          >
            via {providerLabel}
          </span>
          <span className="flex shrink-0 items-center" title={neural.connected ? 'Neural link established' : 'Neural link down'}>
            <span className="sr-only">{neural.connected ? 'Neural link established' : 'Neural link down'}</span>
            <span
              aria-hidden="true"
              className={cn(
                'h-2 w-2 rounded-full',
                neural.connected ? 'bg-emerald-400 animate-mist-pulse-glow' : 'bg-slate-600'
              )}
            />
          </span>
          <span className="hidden shrink-0 items-center gap-1.5 text-slate-500 lg:inline-flex" title="Hold-to-talk shortcut">
            <kbd className="rounded border border-white/10 bg-white/5 px-1.5 py-0.5 font-mono text-[10px] text-slate-300">Alt+V</kbd>
            <span>voice</span>
          </span>
        </div>
      </div>
    </footer>
  )
}
